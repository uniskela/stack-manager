import { isIP } from 'node:net';
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
const VERSION = /v?\d+(?:\.\d+){1,3}(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?/i;
const EXACT_VERSION = new RegExp(`^${VERSION.source}$`, 'i');
const VERSION_HEADING = new RegExp(`^(?:(?:release|version)\\s+)?(${VERSION.source})(.*)$`, 'i');
const SECOND_VERSION = /^[\s:()–—-]+v?\d+\.\d+/i;
const SIGNAL =
  /\b(?:breaking(?:[ -]changes?)?|backwards?[ -]incompatible|incompatib(?:le|ility)|migrat(?:e|es|ed|ing|ions?)|upgrad(?:e|es|ed|ing)|deprecat(?:e|es|ed|ing|ion)|manual intervention|actions? required)\b/i;
const HTML_ENTITIES: Record<string, string> = { amp: '&', nbsp: ' ', quot: '"', apos: "'" };

/** Normalize a public changelog link for display. DNS is validated and pinned when reading it. */
export function safeChangelogUrl(raw: string): string | null {
  if (raw.length > 2_048 || /[\s\p{Cc}\\]/u.test(raw)) return null;
  const authority = raw.match(/^https:\/\/([^/?#]+)/i)?.[1];
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
  return EXACT_VERSION.test(text) ? text.replace(/^v/i, '') : null;
}

function headingVersion(heading: string): string | null {
  const match = heading.match(VERSION_HEADING);
  if (!match?.[1]) return null;
  const tail = match[2]?.trimEnd() ?? '';
  if (tail && (!/^(?:\s+[-–—(]|:\s)/.test(tail) || SECOND_VERSION.test(tail))) return null;
  return normalizedVersion(match[1]);
}

function linesFromDocument(source: string): string[] {
  // Interpret headings as text without evaluating HTML or loading any referenced resources.
  const text = source
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(head|script|style|template|noscript|svg|pre)(?=[\s/>])[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  if (!source.trimStart().startsWith('<')) return text.split(/\r?\n/);
  return text
    .replace(/<h([1-6])\b[^<>]*>/gi, (_, level: string) => '\n' + '#'.repeat(Number(level)) + ' ')
    .replace(/<\/?(?:h[1-6]|p|li|div|br|section|article|main)\b[^<>]*>/gi, '\n')
    .replace(/<[^<>]*>/g, '')
    .split(/\r?\n/);
}

function plainText(line: string): string {
  const result = line
    .replace(/<[^<>]*>/g, '')
    .replace(/\p{Cf}/gu, '')
    .replace(
      /&(?:amp|nbsp|quot|apos);/gi,
      (entity) => HTML_ENTITIES[entity.toLowerCase().slice(1, -1)] ?? entity,
    )
    .replace(/\[([^\][\r\n]{1,512})\]\([^()\r\n]{0,2048}\)/g, '$1')
    .replace(/\[([^\][\r\n]{1,512})\]/g, '$1')
    .replace(/(?:\b[a-z][a-z\d+.-]*:)?\/\/[^\s<>]+/gi, '')
    .replace(/^\s*(?:[-*+]\s+|\d+\.\s+|>\s*)/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return scrubString(result);
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
  const lines = linesFromDocument(source);
  let active: Release | undefined;
  let group = 0;
  let fence: string | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker?.[1]?.startsWith(fence) && !marker[2]?.trim()) fence = undefined;
      continue;
    }
    if (marker?.[1]) {
      fence = marker[1];
      continue;
    }

    if (/^ {0,3}\[[^\]]+\]:\s+/.test(line)) continue;
    const atx = line.match(/^ {0,3}(#{1,6})[ \t]+(\S.*)$/);
    const setext = !atx && line.trim() && lines[index + 1]?.match(/^ {0,3}(=+|-+)\s*$/);
    if (atx?.[1] || setext) {
      if (setext) index++;
      const level = atx?.[1]?.length ?? (setext && setext[1]?.startsWith('=') ? 1 : 2);
      const title = plainText((atx?.[2] ?? line).replace(/\s+#+$/, ''));
      const version = headingVersion(title);
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

    const note = plainText(atx?.[2] ?? line);
    if (note) (active?.lines ?? general).push(note);
  }
  return { releases, general };
}

function extractSignals(lines: string[]): string[] {
  return [
    ...new Set(
      lines
        .filter((line) => SIGNAL.test(line))
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
