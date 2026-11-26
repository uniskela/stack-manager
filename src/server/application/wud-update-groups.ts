import { parseDocument } from 'yaml';
import { z } from 'zod';
import { ValidationError } from '@/server/domain/errors';
import { planComposeImageEdits, planComposeImageReferenceEdit } from '@/shared/compose-image-edits';
import { imageReference } from '@/shared/image-updates';
import { isSecretPath, normalizeRepoPath } from '@/shared/source/paths';

export const WUD_UPDATE_GROUPS_PATH = 'docs/wud-update-groups.json';

const MAX_POLICY_BYTES = 64 * 1024;
const MAX_RULES = 100;
const placeholder = /\{(current|target)\}/g;

const identifier = z
  .string()
  .max(255)
  .regex(/^[a-zA-Z0-9._-]+$/);
const sourcePath = z.string().refine((path) => {
  try {
    return normalizeRepoPath(path) === path && !/^[a-z]:/i.test(path) && !isSecretPath(path);
  } catch {
    return false;
  }
});
const member = z.strictObject({ path: sourcePath, service: identifier });
const template = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !/[{}\p{Cc}\u2028\u2029]/u.test(value.replace(placeholder, '')));
const dependent = z.strictObject({
  path: sourcePath,
  service: identifier.optional(),
  old: template,
  new: template,
  image_ref: z.boolean().optional(),
});
const group = z.strictObject({
  id: identifier,
  description: z.string().optional(),
  require_all_members: z.boolean().default(false),
  members: z.array(member).min(1).max(MAX_RULES),
  dependents: z.array(dependent).max(MAX_RULES).default([]),
});
const policy = z.strictObject({
  version: z.literal(1),
  description: z.string().optional(),
  groups: z.array(group).max(MAX_RULES),
});

type Member = z.infer<typeof member>;
type Dependent = z.infer<typeof dependent>;
export type WudUpdateGroupPolicy = z.infer<typeof policy>;
export type WudGroupImageChange = Member & { before: string; after: string };
type Patch = { start: number; end: number; replacement: string };

const memberKey = ({ path, service }: Member) => `${path}\0${service}`;

function render(value: string, current: string, target: string): string {
  return value.replace(placeholder, (_match, field) => (field === 'current' ? current : target));
}

function changedTags(before: string, after: string) {
  const current = imageReference(before);
  const target = imageReference(after);
  if (
    !current?.tag ||
    !target?.tag ||
    !target.explicitTag ||
    current.name !== target.name ||
    current.digest ||
    target.digest ||
    current.tag === target.tag
  ) {
    return null;
  }
  return { current: current.tag, target: target.tag };
}

export function parseWudUpdateGroups(text: string | null): WudUpdateGroupPolicy {
  if (text === null) return { version: 1, groups: [] };
  if (Buffer.byteLength(text, 'utf8') > MAX_POLICY_BYTES) {
    throw new ValidationError('Repository WUD update groups policy is too large.');
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new ValidationError('Repository WUD update groups policy must be valid JSON.');
  }
  const document = parseDocument(text, { schema: 'json', uniqueKeys: true, prettyErrors: false });
  if (document.errors.length) {
    throw new ValidationError('Repository WUD update groups policy must be valid JSON with unique keys.');
  }
  const result = policy.safeParse(input);
  if (!result.success) throw new ValidationError('Repository WUD update groups policy has invalid fields.');

  const ids = new Set<string>();
  const members = new Set<string>();
  for (const { id, members: entries, dependents } of result.data.groups) {
    if (ids.has(id)) throw new ValidationError('Repository WUD update groups must have unique IDs.');
    ids.add(id);
    for (const entry of entries) {
      const key = memberKey(entry);
      if (members.has(key)) throw new ValidationError('Each service can be a member of only one WUD group.');
      members.add(key);
    }
    for (const rule of dependents) {
      const before = render(rule.old, '1.0.0', '2.0.0');
      const after = render(rule.new, '1.0.0', '2.0.0');
      if (
        Boolean(rule.service) !== Boolean(rule.image_ref) ||
        before === after ||
        (rule.image_ref && !changedTags(before, after))
      ) {
        throw new ValidationError('Repository WUD update groups policy has an unsupported dependent edit.');
      }
    }
  }
  return result.data;
}

function activeGroups(config: WudUpdateGroupPolicy, selections: ReadonlySet<string>) {
  return config.groups.filter(({ members }) => members.some((entry) => selections.has(memberKey(entry))));
}

export function wudGroupPaths(config: WudUpdateGroupPolicy, selections: readonly Member[]): string[] {
  const groups = activeGroups(config, new Set(selections.map(memberKey)));
  return [
    ...new Set([
      ...selections.map(({ path }) => path),
      ...groups.flatMap(({ dependents }) => dependents.map(({ path }) => path)),
    ]),
  ];
}

function requiredFile(files: ReadonlyMap<string, string>, path: string): string {
  const text = files.get(path);
  if (text === undefined) throw new ValidationError('A committed WUD update group file is unavailable.');
  return text;
}

function exactLinePatch(text: string, before: string, after: string): Patch | null {
  let match: Patch | null = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    if (line === before || line === before + '\r') {
      if (match) return null;
      match = { start: offset, end: offset + before.length, replacement: after };
    }
    offset += line.length + 1;
  }
  return match;
}

function dependentPatch(text: string, rule: Dependent, before: string, after: string): Patch {
  let patch: Patch | null;
  try {
    patch = rule.service
      ? planComposeImageReferenceEdit(text, rule.service, before, after)
      : exactLinePatch(text, before, after);
  } catch {
    patch = null;
  }
  if (!patch) throw new ValidationError('A WUD dependency must match exactly one committed value.');
  return patch;
}

function applyPatches(text: string, patches: Patch[]): string {
  let offset = 0;
  const parts: string[] = [];
  let previous: Patch | undefined;
  for (const patch of patches.toSorted((a, b) => a.start - b.start)) {
    if (
      previous &&
      patch.start === previous.start &&
      patch.end === previous.end &&
      patch.replacement === previous.replacement
    )
      continue;
    if (patch.start < offset) throw new ValidationError('WUD update group edits overlap.');
    parts.push(text.slice(offset, patch.start), patch.replacement);
    offset = patch.end;
    previous = patch;
  }
  parts.push(text.slice(offset));
  return parts.join('');
}

export function wudGroupPlan(
  config: WudUpdateGroupPolicy,
  selections: readonly WudGroupImageChange[],
  files: ReadonlyMap<string, string>,
): {
  files: Map<string, string>;
  imageChanges: WudGroupImageChange[];
  groups: { id: string; members: Member[] }[];
} {
  const selected = new Map<string, NonNullable<ReturnType<typeof changedTags>>>();
  const byFile = new Map<string, WudGroupImageChange[]>();
  const imageChanges = new Map<string, WudGroupImageChange>();
  const addImageChange = (change: WudGroupImageChange) =>
    imageChanges.set(JSON.stringify([change.path, change.service, change.before, change.after]), change);
  for (const { path, service, before, after } of selections) {
    const change = { path, service, before, after };
    const tags = changedTags(before, after);
    const key = memberKey(change);
    if (!tags || selected.has(key) || !member.safeParse({ path, service }).success) {
      throw new ValidationError('The selected WUD image changes are invalid or ambiguous.');
    }
    selected.set(key, tags);
    const list = byFile.get(path) ?? [];
    list.push(change);
    byFile.set(path, list);
    addImageChange(change);
  }

  const groups = activeGroups(config, new Set(selected.keys()));
  const patches = new Map<string, Patch[]>();
  for (const { id, members, require_all_members: requireAll, dependents } of groups) {
    const tags = members.flatMap((entry) => selected.get(memberKey(entry)) ?? []);
    if (requireAll && tags.length !== members.length) {
      throw new ValidationError(`Select every member of the ${id} WUD update group together.`);
    }
    const first = tags[0]!;
    if (tags.some(({ current, target }) => current !== first.current || target !== first.target)) {
      throw new ValidationError(`Members of the ${id} WUD update group must share current and target tags.`);
    }
    for (const rule of dependents) {
      const before = render(rule.old, first.current, first.target);
      const after = render(rule.new, first.current, first.target);
      if (before === after || (rule.image_ref && !changedTags(before, after))) {
        throw new ValidationError('A WUD dependency could not be expanded to a valid edit.');
      }
      const { path, service } = rule;
      const list = patches.get(path) ?? [];
      list.push(dependentPatch(requiredFile(files, path), rule, before, after));
      patches.set(path, list);
      if (service) addImageChange({ path, service, before, after });
    }
  }

  for (const [path, changes] of byFile) {
    const text = requiredFile(files, path);
    const edits = changes.map(({ service, after }) => ({ service, targetTag: imageReference(after)!.tag! }));
    const plan = planComposeImageEdits(text, edits);
    if (plan.failures.length) throw new ValidationError('A selected Compose image cannot be edited safely.');
    const list = patches.get(path) ?? [];
    for (const [index, patch] of plan.patches.entries()) {
      const change = changes[index];
      if (patch.change.before !== change?.before || patch.change.after !== change.after) {
        throw new ValidationError('A selected Compose image has changed in the committed file.');
      }
      list.push(patch);
    }
    patches.set(path, list);
  }

  return {
    files: new Map(
      [...patches].map(([path, edits]) => [path, applyPatches(requiredFile(files, path), edits)]),
    ),
    imageChanges: [...imageChanges.values()],
    groups: groups.map(({ id, members }) => ({ id, members })),
  };
}
