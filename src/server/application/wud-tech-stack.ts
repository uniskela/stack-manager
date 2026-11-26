import { fromMarkdown } from 'mdast-util-from-markdown';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { ValidationError } from '@/server/domain/errors';
import { imageReference } from '@/shared/image-updates';
import { normalizeRepoPath } from '@/shared/source/paths';

type Files = { markdown: string; json: string };
type Update = { path: string; service: string; before: string; after: string };
type Edit = { start: number; end: number; value: string };
type Pin = { repository: string; tag: string };

function taggedImage(image: string): Pin | null {
  const ref = imageReference(image);
  return ref?.explicitTag && !ref.digest && ref.tag ? { repository: ref.repository, tag: ref.tag } : null;
}

function matchesPin(image: string, pin: Pin): boolean {
  const ref = taggedImage(image);
  return ref?.repository === pin.repository && ref.tag === pin.tag;
}

function requireOne<T>(matches: readonly T[], file: string): T {
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) {
    throw new ValidationError(`${file} must contain exactly one matching stack and service entry.`);
  }
  return match;
}

function applyEdits(source: string, edits: Edit[], file: string): string {
  let end = source.length;
  let result = '';
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    if (edit.end > end) throw new ValidationError(`${file} has overlapping image updates.`);
    result = edit.value + source.slice(edit.end, end) + result;
    end = edit.start;
  }
  return source.slice(0, end) + result;
}

function markdownEdit(
  source: string,
  body: ReturnType<typeof fromMarkdown>['children'],
  stack: string,
  service: string,
  composeDir: string | undefined,
  oldPin: Pin,
  newTag: string,
): Edit {
  const file = 'docs/TechStack.md';
  const sectionIndices: number[] = [];
  for (const [index, node] of body.entries()) {
    if (node.type !== 'paragraph' || !node.position) continue;
    const title = source
      .slice(node.position.start.offset, node.position.end.offset)
      .split(/\r\n?|\n/)
      .at(-1)
      ?.trimEnd();
    if (title === stack || (title?.startsWith(`${stack} (`) && title.endsWith(')'))) {
      sectionIndices.push(index);
    }
  }

  const list = body[requireOne(sectionIndices, file) + 1];
  if (list?.type !== 'list' || list.ordered) {
    throw new ValidationError(`${file} stack must be followed by a service list.`);
  }
  const entries: Array<{ start: number; text: string }> = [];
  for (const item of list.children) {
    const offset = item.position?.start.offset;
    if (offset === undefined) continue;
    const itemText = source.slice(offset, item.position?.end.offset);
    const row = /^[-*+][ \t]+([^:\r\n]+):[ \t]*([^\r\n]*)/d.exec(itemText);
    const text = row?.[2];
    const start = row?.indices?.[2]?.[0];
    if (text === undefined || start === undefined) continue;
    const label = row?.[1]?.trimEnd();
    if (label === service || (composeDir && label === `${composeDir} ${service}`)) {
      entries.push({ text, start: offset + start });
    } else if (composeDir && label === composeDir) {
      // Older versions also list several service/version pairs in one bullet.
      for (const member of text.matchAll(/(?:^|,)[ \t]*([^,]+)/dg)) {
        const value = member[1];
        const memberStart = member.indices?.[1]?.[0];
        if (value?.split(/[ \t]/, 1)[0] === service && memberStart !== undefined) {
          entries.push({ text: value, start: offset + start + memberStart });
        }
      }
    }
  }

  const { text, start } = requireOne(entries, file);
  const ref = /^(?:`([^`]+)`|([^\s`,;)]+))(?=$|[ \t,;)])/.exec(text);
  const image = ref?.[1] ?? ref?.[2];
  let tagEnd = 0;
  if (image && matchesPin(image, oldPin)) {
    tagEnd = start + (ref?.[1] ? 1 : 0) + image.length;
  } else {
    const abbreviated = /^(\S+)[ \t]+`([^`]+)`(?=$|[ \t,;)])/d.exec(text);
    if (abbreviated?.[1] === service && abbreviated[2] === oldPin.tag) {
      tagEnd = start + (abbreviated.indices?.[2]?.[1] ?? 0);
    }
  }
  if (!tagEnd) throw new ValidationError(`${file} service image differs from the committed pin.`);
  return { start: tagEnd - oldPin.tag.length, end: tagEnd, value: newTag };
}

function parseInventory(source: string) {
  try {
    // JSON.parse enforces strict JSON syntax. The YAML tree also checks key uniqueness and gives
    // source ranges, so image changes need not reformat the document.
    JSON.parse(source);
    const document = parseDocument(source, { schema: 'json', uniqueKeys: true, prettyErrors: false });
    const stacks = isMap(document.contents) ? document.contents.get('stacks', true) : null;
    if (document.errors.length === 0 && isSeq(stacks)) return stacks.items;
  } catch {
    // Keep parser excerpts out of the operator-facing error.
  }
  throw new ValidationError('docs/TechStack.json must be a JSON inventory with unique keys.');
}

function jsonEdit(
  source: string,
  stacks: ReturnType<typeof parseInventory>,
  stack: string,
  service: string,
  composeDir: string | undefined,
  oldPin: Pin,
  newTag: string,
): Edit {
  const file = 'docs/TechStack.json';
  const stackNode = requireOne(
    stacks.filter(isMap).filter((node) => node.get('stack') === stack),
    file,
  );
  const services = stackNode.get('services', true);
  if (!isSeq(services)) throw new ValidationError(`${file} stack must contain a service list.`);
  const serviceNode = requireOne(
    services.items.filter(isMap).filter((node) => {
      const name = node.get('name');
      return name === service || (composeDir && name === `${composeDir} ${service}`);
    }),
    file,
  );
  const image = serviceNode.get('image', true);
  if (
    !isScalar(image) ||
    typeof image.value !== 'string' ||
    !image.range ||
    !matchesPin(image.value, oldPin)
  ) {
    throw new ValidationError(`${file} service image differs from the committed pin.`);
  }
  const [start, end] = image.range;
  // Locate the tag in the original scalar, including any JSON escapes in the separator or tag.
  const rawTag = /(?::|\\u003a)((?:[\w.-]|\\u00[\da-f]{2})+)"$/i.exec(source.slice(start, end))?.[1];
  if (!rawTag) throw new ValidationError(`${file} service image must contain a literal tag.`);
  const tagEnd = end - 1;
  return { start: tagEnd - rawTag.length, end: tagEnd, value: newTag };
}

export function editWudTechStack(files: Files, updates: readonly Update[]): Files {
  if (updates.length === 0) return files;
  const { markdown, json } = files;
  const body = fromMarkdown(markdown).children;
  const stacks = parseInventory(json);
  const markdownEdits: Edit[] = [];
  const jsonEdits: Edit[] = [];

  for (const { path, service, before, after } of updates) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeRepoPath(path);
    } catch {
      throw new ValidationError('TechStack update requires a repository-relative Compose path.');
    }
    const [stack, ...parts] = normalizedPath.split('/');
    if (path !== normalizedPath || !stack || parts.length === 0 || !service) {
      throw new ValidationError('TechStack update requires a repository-relative Compose path and service.');
    }
    const oldPin = taggedImage(before);
    const newPin = taggedImage(after);
    if (!oldPin || !newPin || oldPin.repository !== newPin.repository) {
      throw new ValidationError('TechStack update requires two explicit tags for the same image repository.');
    }
    const composeDir = parts.at(-2);
    markdownEdits.push(markdownEdit(markdown, body, stack, service, composeDir, oldPin, newPin.tag));
    jsonEdits.push(jsonEdit(json, stacks, stack, service, composeDir, oldPin, newPin.tag));
  }

  return {
    markdown: applyEdits(markdown, markdownEdits, 'docs/TechStack.md'),
    json: applyEdits(json, jsonEdits, 'docs/TechStack.json'),
  };
}
