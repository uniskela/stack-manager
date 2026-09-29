import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLMap } from 'yaml';

/**
 * Static analysis of Compose files and other YAML, shared by the editor (live problems) and the
 * server (environment inventory). It never executes anything and never resolves variable values.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface SourceProblem {
  /** Character offsets into the analysed text. */
  from: number;
  to: number;
  line: number;
  column: number;
  severity: Severity;
  message: string;
  /** Stable identifier for problems other views act on. */
  code?: 'hardcoded-secret';
}

export interface VariableReference {
  name: string;
  line: number;
  /** `${VAR:-x}` / `${VAR-x}` */
  hasDefault: boolean;
  /** `${VAR:?msg}` / `${VAR?msg}` */
  required: boolean;
}

export interface ServiceSummary {
  name: string;
  image: string | null;
  build: boolean;
  /** Keys of `environment:` (values are deliberately not collected). */
  environmentKeys: string[];
  envFiles: string[];
  line: number;
}

export interface ComposeAnalysis {
  problems: SourceProblem[];
  services: ServiceSummary[];
  variables: VariableReference[];
  envFiles: string[];
}

const TOP_LEVEL_KEYS = new Set([
  'version',
  'name',
  'services',
  'networks',
  'volumes',
  'configs',
  'secrets',
  'include',
]);
const SECRETISH_KEY = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)/i;
/** `$$` is an escaped dollar; `${NAME...}` or `$NAME` are references. */
const VARIABLE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

class Collector {
  readonly problems: SourceProblem[] = [];
  constructor(
    private readonly text: string,
    private readonly lines: LineCounter,
  ) {}

  add(severity: Severity, message: string, from: number, to = from) {
    const clampedFrom = Math.max(0, Math.min(from, this.text.length));
    const clampedTo = Math.max(clampedFrom, Math.min(to, this.text.length));
    const pos = this.lines.linePos(clampedFrom);
    this.problems.push({
      from: clampedFrom,
      to: clampedTo,
      line: pos.line,
      column: pos.col,
      severity,
      message,
    });
  }

  at(node: Node | null | undefined, severity: Severity, message: string, code?: SourceProblem['code']) {
    const [from, to] = node?.range ?? [0, 0];
    this.add(severity, message, from, to);
    if (code) this.problems[this.problems.length - 1]!.code = code;
  }

  lineOf(offset: number) {
    return this.lines.linePos(offset).line;
  }
}

function parse(text: string) {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  const c = new Collector(text, lines);
  for (const e of doc.errors) c.add('error', cleanYamlMessage(e.message), e.pos[0], e.pos[1]);
  for (const w of doc.warnings) c.add('warning', cleanYamlMessage(w.message), w.pos[0], w.pos[1]);
  return { doc, c };
}

function cleanYamlMessage(message: string) {
  return message.split('\n')[0]!.replace(/ at line \d+, column \d+:?$/, '');
}

/** YAML syntax problems only (for YAML files that are not Compose files). */
export function analyzeYaml(text: string): SourceProblem[] {
  return parse(text).c.problems;
}

/** Offsets and line for a JSON syntax error, or none. */
export function analyzeJson(text: string): SourceProblem[] {
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON.';
    const m = message.match(/position (\d+)/);
    const from = m ? Number(m[1]) : 0;
    const line = text.slice(0, from).split('\n').length;
    const column = from - text.lastIndexOf('\n', from - 1);
    return [
      { from, to: from, line, column, severity: 'error', message: message.replace(/^JSON\.parse: /, '') },
    ];
  }
}

const keyName = (k: unknown) => (isScalar(k) ? String(k.value) : String(k));

function scalarString(node: unknown): string | null {
  return isScalar(node) && (typeof node.value === 'string' || typeof node.value === 'number')
    ? String(node.value)
    : null;
}

export function analyzeCompose(text: string): ComposeAnalysis {
  const { doc, c } = parse(text);
  const services: ServiceSummary[] = [];
  const envFiles = new Set<string>();
  const variables = findVariables(text, c);

  const root = doc.contents;
  if (doc.errors.length === 0) {
    if (root === null || root === undefined) {
      c.add('error', 'The file is empty. A Compose file needs a top-level `services:` mapping.', 0);
    } else if (!isMap(root)) {
      c.at(root, 'error', 'The top level of a Compose file must be a mapping (key: value).');
    } else {
      checkTopLevel(root, c, services, envFiles);
    }
  }

  const problems = c.problems.sort((a, b) => a.from - b.from);
  return { problems, services, variables, envFiles: [...envFiles] };
}

function checkTopLevel(root: YAMLMap, c: Collector, services: ServiceSummary[], envFiles: Set<string>) {
  const defined = { networks: new Set(['default']), volumes: new Set<string>() };
  let servicesNode: unknown = undefined;
  let hasInclude = false;

  for (const pair of root.items) {
    const key = keyName(pair.key);
    const keyNode = pair.key as Node;
    if (key === 'version') {
      c.at(keyNode, 'info', '`version` is obsolete in the Compose Specification and is ignored.');
    } else if (!TOP_LEVEL_KEYS.has(key) && !key.startsWith('x-')) {
      c.at(keyNode, 'warning', `Unknown top-level key "${key}". Extension fields must start with "x-".`);
    }
    if (key === 'services') servicesNode = pair.value;
    if (key === 'include') hasInclude = true;
    if ((key === 'networks' || key === 'volumes') && isMap(pair.value)) {
      for (const item of pair.value.items) defined[key].add(keyName(item.key));
    }
  }

  if (servicesNode === undefined) {
    if (!hasInclude) c.add('error', 'Missing top-level `services:` mapping.', 0, 0);
    return;
  }
  if (!isMap(servicesNode)) {
    if (servicesNode !== null)
      c.at(servicesNode as Node, 'error', '`services` must be a mapping of service names.');
    return;
  }

  const serviceNames = new Set(servicesNode.items.map((p) => keyName(p.key)));
  for (const pair of servicesNode.items) {
    const name = keyName(pair.key);
    const keyNode = pair.key as Node;
    const svc = pair.value;
    const line = c.lineOf(keyNode?.range?.[0] ?? 0);
    if (!isMap(svc)) {
      c.at(keyNode, 'error', `Service "${name}" must be a mapping.`);
      continue;
    }
    const get = (k: string) => svc.items.find((p) => keyName(p.key) === k);
    const image = scalarString(get('image')?.value);
    const build = get('build') !== undefined;
    if (!image && !build && get('extends') === undefined) {
      c.at(keyNode, 'error', `Service "${name}" needs an \`image\` or a \`build\` section.`);
    }
    if (image && /:latest$|^[^:@]+$/.test(image) && !image.includes('${')) {
      c.at(get('image')?.value as Node, 'info', `Image "${image}" is not pinned to a version tag or digest.`);
    }

    const environmentKeys = collectEnvironment(get('environment')?.value, c);
    const serviceEnvFiles = collectEnvFiles(get('env_file')?.value);
    serviceEnvFiles.forEach((f) => envFiles.add(f));

    const dependsOn = get('depends_on')?.value;
    const deps = isSeq(dependsOn)
      ? dependsOn.items
      : isMap(dependsOn)
        ? dependsOn.items.map((p) => p.key)
        : [];
    for (const dep of deps) {
      const depName = scalarString(dep);
      if (depName && !serviceNames.has(depName)) {
        c.at(dep as Node, 'error', `Service "${name}" depends on unknown service "${depName}".`);
      }
    }

    const nets = get('networks')?.value;
    const netRefs = isSeq(nets) ? nets.items : isMap(nets) ? nets.items.map((p) => p.key) : [];
    for (const net of netRefs) {
      const netName = scalarString(net);
      if (netName && !defined.networks.has(netName)) {
        c.at(net as Node, 'warning', `Network "${netName}" is not defined under top-level \`networks:\`.`);
      }
    }

    const vols = get('volumes')?.value;
    if (isSeq(vols)) {
      for (const v of vols.items) {
        const spec = scalarString(v);
        const source = spec?.split(':')[0];
        if (
          spec &&
          spec.includes(':') &&
          source &&
          /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source) &&
          !defined.volumes.has(source)
        ) {
          c.at(v as Node, 'warning', `Named volume "${source}" is not defined under top-level \`volumes:\`.`);
        }
      }
    }

    services.push({ name, image, build, environmentKeys, envFiles: serviceEnvFiles, line });
  }
}

function collectEnvironment(node: unknown, c: Collector): string[] {
  const keys: string[] = [];
  const check = (key: string, value: string | null, at: Node | null | undefined) => {
    keys.push(key);
    if (value && SECRETISH_KEY.test(key) && !value.includes('$')) {
      c.at(
        at,
        'warning',
        `"${key}" looks like a hard-coded secret. Reference a variable instead, e.g. \${${key}}.`,
        'hardcoded-secret',
      );
    }
  };
  if (isMap(node)) {
    for (const p of node.items) check(keyName(p.key), scalarString(p.value), p.value as Node);
  } else if (isSeq(node)) {
    for (const item of node.items) {
      const entry = scalarString(item);
      if (!entry) continue;
      const eq = entry.indexOf('=');
      check(eq === -1 ? entry : entry.slice(0, eq), eq === -1 ? null : entry.slice(eq + 1), item as Node);
    }
  }
  return keys;
}

function collectEnvFiles(node: unknown): string[] {
  const one = (n: unknown): string | null => {
    if (isMap(n)) return scalarString(n.items.find((p) => keyName(p.key) === 'path')?.value);
    return scalarString(n);
  };
  if (isSeq(node)) return node.items.map(one).filter((v): v is string => !!v);
  const single = one(node);
  return single ? [single] : [];
}

function findVariables(text: string, c: Collector): VariableReference[] {
  const refs: VariableReference[] = [];
  // Comments never interpolate; blank them out while keeping offsets stable.
  const scanned = text.replace(/(^|\s)#.*$/gm, (m) => ' '.repeat(m.length));
  for (const m of scanned.matchAll(VARIABLE)) {
    if (m[0] === '$$') continue;
    const name = m[1] ?? m[3]!;
    const modifier = m[2] ?? '';
    refs.push({
      name,
      line: c.lineOf(m.index ?? 0),
      hasDefault: modifier.endsWith('-'),
      required: modifier.endsWith('?'),
    });
  }
  return refs;
}

/** Variable names documented in a `.env.example`-style file (values are ignored). */
export function parseEnvTemplate(text: string): string[] {
  const names = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m?.[1]) names.add(m[1]);
  }
  return [...names];
}
