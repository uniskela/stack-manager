import { createHash } from 'node:crypto';
import { structuredPatch } from 'diff';
import { ConflictError, ValidationError } from '@/server/domain/errors';
import type { GitFileChange } from '@/server/providers/git/types';
import type { FileView } from '@/shared/source/types';
import { imageReference } from '@/shared/image-updates';
import { isComposeFileName, basename } from '@/shared/source/paths';
import { problemsFor } from '@/shared/source/problems';
import { editWudTechStack } from './wud-tech-stack';
import {
  wudGroupPaths,
  wudGroupPlan,
  type WudGroupImageChange,
  type WudUpdateGroupPolicy,
} from './wud-update-groups';

const MARKDOWN = 'docs/TechStack.md';
const INVENTORY = 'docs/TechStack.json';

export type WudRepositoryChange = GitFileChange & { content: string; before: string };

export async function planWudRepositoryUpdate(
  readFile: (path: string) => Promise<FileView | null>,
  commitSha: string,
  groups: WudUpdateGroupPolicy,
  selected: readonly WudGroupImageChange[],
): Promise<WudRepositoryChange[]> {
  const paths = [
    ...new Set([
      ...selected.map(({ path }) => path),
      ...wudGroupPaths(groups, selected),
      MARKDOWN,
      INVENTORY,
    ]),
  ];
  if (paths.length > 24) throw new ValidationError('This image update includes too many linked files.');
  const files = new Map(
    await Promise.all(
      paths.map(async (path) => {
        const file = await readFile(path);
        if (!file || file.locked || file.content === null || !file.blobSha) {
          throw new ValidationError(`Image updates need a readable committed copy of ${path}.`);
        }
        if (file.commitSha !== commitSha)
          throw new ConflictError('Fetch changed the source. Review the image update again.');
        if (file.draft)
          throw new ConflictError(`${path} already has a draft. Review it before preparing an update.`);
        return [path, { before: file.content, baseBlobSha: file.blobSha }] as const;
      }),
    ),
  );

  const plan = wudGroupPlan(groups, selected, new Map([...files].map(([path, file]) => [path, file.before])));
  const documented = new Set<string>();
  const updates = plan.imageChanges.filter(({ path, before, after }) => {
    const image = imageReference(before);
    const key = JSON.stringify([
      path.split('/')[0],
      image?.repository,
      image?.tag,
      imageReference(after)?.tag,
    ]);
    if (documented.has(key)) return false;
    documented.add(key);
    return true;
  });
  const { markdown, json } = editWudTechStack(
    {
      markdown: files.get(MARKDOWN)!.before,
      json: files.get(INVENTORY)!.before,
    },
    updates,
  );
  plan.files.set(MARKDOWN, markdown);
  plan.files.set(INVENTORY, json);

  return [...plan.files]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([path, content]) => {
      const file = files.get(path)!;
      if (file.before === content) return [];
      if (
        isComposeFileName(basename(path)) &&
        problemsFor(path, content, path).some(({ severity }) => severity === 'error')
      ) {
        throw new ValidationError(`The planned changes do not pass Compose validation in ${path}.`);
      }
      return [{ path, content, ...file }];
    });
}

export function wudRepositoryPlanHash(changes: readonly WudRepositoryChange[]): string {
  return createHash('sha256')
    .update(JSON.stringify(changes.map(({ path, baseBlobSha, content }) => [path, baseBlobSha, content])))
    .digest('hex');
}

export const wudRepositoryDiff = (changes: readonly WudRepositoryChange[]) =>
  changes.map(({ path, before, content }) => ({
    path,
    hunks: structuredPatch(path, path, before, content, undefined, undefined, { context: 0 }).hunks,
  }));
