import { dirname, isMarkdownPath, isWithin, joinRepoPath, normalizeRepoPath, relativeTo } from './paths';

export interface LinkContext {
  /** Repo path of the document being rendered. */
  docPath: string;
  rootPath: string;
  editorHref: string;
  docsHref: string;
}

/**
 * Maps a relative link inside a document to the stack UI: Markdown pages open in Docs, other files in the
 * Editor. Links that leave the stack folder or cannot be resolved return null (rendered as plain text).
 */
export function resolveRepoLink(href: string, ctx: LinkContext): string | null {
  const hashAt = href.indexOf('#');
  const pathPart = hashAt === -1 ? href : href.slice(0, hashAt);
  if (!pathPart) return hashAt === -1 ? null : href;
  let target: string;
  try {
    target = normalizeRepoPath(resolveRelative(dirname(ctx.docPath), decodeURIComponent(pathPart)));
  } catch {
    return null;
  }
  if (!isWithin(ctx.rootPath, target)) return null;
  const rel = encodeURIComponent(relativeTo(ctx.rootPath, target));
  return isMarkdownPath(target) ? `${ctx.docsHref}?doc=${rel}` : `${ctx.editorHref}?file=${rel}`;
}

/** Resolves `./` and `../` segments of a relative link against a directory, without leaving the repo. */
function resolveRelative(dir: string, relative: string): string {
  const out = dir ? dir.split('/') : [];
  for (const seg of relative.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) throw new Error('outside repository');
      out.pop();
    } else out.push(seg);
  }
  return joinRepoPath(...out);
}

/**
 * Renders repository Markdown for reading. Raw HTML is not rendered (react-markdown's default), link
 * URLs go through its safe-URL filter, external links open without a referrer, and only https images
 * load (relative images would point at this app, not the repository).
 */
