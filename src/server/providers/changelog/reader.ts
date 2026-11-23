import { isIP } from 'node:net';
import { raw } from 'hast-util-raw';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toHast } from 'mdast-util-to-hast';
import { readHttps } from '@/server/security/https-read';
import { classifyAddress } from '@/server/security/network-policy';
import { scrubString } from '@/server/security/redact';

export interface ChangelogEvidence {
  status: 'checked' | 'incomplete' | 'unavailable';
  url: string;
  signals: string[];
  detail: string;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_SIGNALS = 8;
const MAX_EXCERPT_LENGTH = 240;
const VERSION_CORE = /^v?\d+(?:\.\d+){1,3}$/i;
const VERSION_METADATA = /^[\da-z-]+(?:\.[\da-z-]+)*$/i;
const VERSION_PREFIX = /^(?:release|version) /i;
const SECOND_VERSION = /^v?\d+\.\d+/i;
const SIGNALS = [
  /\b(?:breaking|backwards?[ -]incompatible|incompatib(?:le|ility))\b/i,
  /\bmigrat(?:e[sd]?|ing|ions?)\b/i,
  /\bupgrad(?:e[sd]?|ing)\b/i,
  /\bdeprecat(?:e[sd]?|ing|ion)\b/i,
  /\b(?:manual intervention|actions? required)\b/i,
];
const OMITTED_ELEMENTS = new Set(['head', 'title', 'script', 'style', 'template', 'noscript', 'svg', 'pre']);
const BLOCK_ELEMENTS = new Set(['p', 'li', 'div', 'br', 'section', 'article', 'main', 'blockquote']);
const NESTED_NOTE_ELEMENTS = new Set(['blockquote', 'li']);

/** Normalize a public changelog link for display. DNS is validated and pinned when reading it. */
export function safeChangelogUrl(raw: string): string | null {
  if (raw.length > 2_048 || /[\s\p{Cc}\\]/u.test(raw)) return null;
  const authority = /^https:\/\/([^/?#]+)/i.exec(raw)?.[1];
  if (!authority || authority.includes('@')) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.replace(/^\[|\]$|\.$/g, '');
    if (isIP(host)) {
      if (classifyAddress(host) !== 'public') return null;
    } else if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(host)) {
      return null;
    }

    url.search = '';
    if (!/^#[\da-z][\da-z_.-]{0,127}$/i.test(url.hash)) url.hash = '';
    if (scrubString(url.hash) !== url.hash) url.hash = '';
    return scrubString(url.href) === url.href ? url.href : null;
  } catch {
    return null;
  }
}

function normalizedVersion(text: string): string | null {
  if (/\s/.test(text)) return null;

  const buildStart = text.indexOf('+');
  const release = buildStart < 0 ? text : text.slice(0, buildStart);
  if (buildStart >= 0 && !VERSION_METADATA.test(text.slice(buildStart + 1))) return null;

  const prereleaseStart = release.indexOf('-');
  const core = prereleaseStart < 0 ? release : release.slice(0, prereleaseStart);
  if (!VERSION_CORE.test(core)) return null;
  if (prereleaseStart >= 0 && !VERSION_METADATA.test(release.slice(prereleaseStart + 1))) return null;

  return text.replace(/^v/i, '');
}

function headingVersion(heading: string): string | null {
  const title = heading.replace(VERSION_PREFIX, '');
  const separator = title.search(/[ :]/);
  const candidate = separator < 0 ? title : title.slice(0, separator);
  const tail = separator < 0 ? '' : title.slice(separator);

  if (tail && !/^(?: [-–—(]|: )/.test(tail)) return null;
  const tailContent = /[^ :()–—-]/.exec(tail)?.index;
  if (tailContent !== undefined && SECOND_VERSION.test(tail.slice(tailContent))) return null;

  const version = candidate.startsWith('[') && candidate.endsWith(']') ? candidate.slice(1, -1) : candidate;
  return normalizedVersion(version);
}

function withoutVisibleUrl(word: string): string {
  const separator = word.indexOf('//');
  if (separator < 0 || separator + 2 === word.length) return word;
  const prefix = word.slice(0, separator);
  if (!prefix.endsWith(':')) return prefix;
  const scheme =
    prefix
      .slice(0, -1)
      .split(/[^a-z\d+.-]+/i)
      .at(-1) ?? '';
  return /^[a-z]/i.test(scheme) ? prefix.slice(0, -scheme.length - 1) : prefix;
}

function cleanText(text: string): string {
  const result = text
    .replace(/\p{Cf}/gu, '')
    .replace(/[^\s<>]+/g, withoutVisibleUrl)
    .replace(/\s+/g, ' ')
    .trim();
  return scrubString(result);
}

function parseMarkdown(source: string): ReturnType<typeof fromMarkdown> {
  const tree = fromMarkdown(source);
  const titleLines = new Set<number>();
  for (const node of tree.children) {
    if (node.type !== 'heading' || !node.position) continue;
    const { start, end } = node.position;
    // Existing changelogs can start a setext version heading immediately after a note.
    if (end.line > start.line + 1) titleLines.add(end.line - 1);
  }
  if (!titleLines.size) return tree;

  const lines = source.split(/\r\n?|\n/);
  for (const line of titleLines) lines[line - 1] = '\n' + lines[line - 1];
  return fromMarkdown(lines.join('\n'));
}

type HtmlRoot = Extract<ReturnType<typeof raw>, { type: 'root' }>;
type TextEvent = { type: 'text'; value: string } | { type: 'boundary'; level?: number };

function* textEvents(nodes: HtmlRoot['children'], allowHeadings = true): Generator<TextEvent> {
  for (const node of nodes) {
    if (node.type === 'text') {
      yield node;
      continue;
    }
    if (node.type !== 'element' || OMITTED_ELEMENTS.has(node.tagName) || node.properties.hidden) continue;

    const heading = /^h([1-6])$/.exec(node.tagName);
    const level = heading && allowHeadings ? Number(heading[1]) : undefined;
    const boundary = heading || BLOCK_ELEMENTS.has(node.tagName);
    if (boundary) yield { type: 'boundary', level };
    yield* textEvents(node.children, allowHeadings && !NESTED_NOTE_ELEMENTS.has(node.tagName));
    if (boundary) yield { type: 'boundary' };
  }
}

interface NoteLine {
  text: string;
  level?: number;
}

function* noteLines(parts: string[], level: number | undefined): Generator<NoteLine> {
  const text = parts.join('');
  for (const line of level === undefined ? text.split(/\r\n?|\n/) : [text]) {
    const normalized = cleanText(line);
    if (normalized) yield { text: normalized, level };
  }
}

function* documentLines(source: string): Generator<NoteLine> {
  // The HTML parser consumes raw Markdown HTML in memory. Only text nodes reach the evidence.
  const tree = raw(toHast(parseMarkdown(source), { allowDangerousHtml: true }));
  if (tree.type !== 'root') return;

  const parts: string[] = [];
  let level: number | undefined;
  for (const event of textEvents(tree.children)) {
    if (event.type === 'text') {
      parts.push(event.value);
      continue;
    }
    yield* noteLines(parts, level);
    parts.length = 0;
    level = event.level;
  }
  yield* noteLines(parts, level);
}

interface Release {
  version: string;
  level: number;
  group: number;
  lines: string[];
}

function releaseNotes(source: string): { releases: Release[]; general: string[] } {
  const releases: Release[] = [];
  const general: string[] = [];
  let active: Release | undefined;
  let group = 0;

  for (const { text, level } of documentLines(source)) {
    if (level !== undefined) {
      const version = headingVersion(text);
      if (version) {
        active = { version, level, group, lines: [] };
        releases.push(active);
        continue;
      }
      if (active && level <= active.level) {
        active = undefined;
        group++;
      }
    }

    (active?.lines ?? general).push(text);
  }
  return { releases, general };
}

function extractSignals(lines: string[]): string[] {
  return [
    ...new Set(
      lines
        .filter((line) => SIGNALS.some((signal) => signal.test(line)))
        .map((line) =>
          line.length > MAX_EXCERPT_LENGTH ? line.slice(0, MAX_EXCERPT_LENGTH - 1) + '…' : line,
        ),
    ),
  ].slice(0, MAX_SIGNALS);
}

function unavailable(url: string, detail: string): ChangelogEvidence {
  return { status: 'unavailable', url, signals: [], detail };
}

function inspectNotes(url: string, text: string, currentTag: string, targetTag: string): ChangelogEvidence {
  const { releases, general } = releaseNotes(text);
  const currentVersion = normalizedVersion(currentTag);
  const targetVersion = normalizedVersion(targetTag);
  const current = releases.filter((release) => release.version === currentVersion);
  const target = releases.filter((release) => release.version === targetVersion);

  if (current.length === 1 && target.length === 1 && currentVersion !== targetVersion) {
    const start = releases.indexOf(target[0]!);
    const end = releases.indexOf(current[0]!);
    const range = start < end ? releases.slice(start, end) : releases.slice(end + 1, start + 1).reverse();
    if (
      range.every(
        (release) =>
          release.group === current[0]!.group &&
          release.level === current[0]!.level &&
          release.lines.length > 0,
      )
    ) {
      return {
        status: 'checked',
        url,
        signals: extractSignals(range.flatMap((release) => release.lines)),
        detail: 'Found release notes spanning the installed and target versions.',
      };
    }
  }

  const signals = extractSignals(target.length ? target.flatMap((release) => release.lines) : general);
  if (!signals.length && !releases.some((release) => release.lines.length > 0))
    return unavailable(url, 'The response did not contain recognizable release notes.');

  return {
    status: 'incomplete',
    url,
    signals,
    detail: 'Could not verify release notes spanning the installed and target versions.',
  };
}

export class ChangelogReader {
  constructor(private readonly options: { read?: typeof readHttps } = {}) {}

  async check(rawUrl: string, currentTag: string, targetTag: string): Promise<ChangelogEvidence> {
    const url = safeChangelogUrl(rawUrl);
    if (!url) return unavailable('', 'Use a public HTTPS changelog URL without embedded credentials.');

    try {
      const request = new URL(url);
      request.hash = '';
      const { status, body } = await (this.options.read ?? readHttps)(request, {
        headers: { Accept: 'text/plain, text/markdown, text/html' },
        allowPrivateNetworks: false,
        maxBytes: MAX_RESPONSE_BYTES,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (status !== 200) return unavailable(url, 'Unable to read the public changelog.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      return inspectNotes(url, text, currentTag, targetTag);
    } catch {
      return unavailable(url, 'Unable to read the public changelog.');
    }
  }
}
