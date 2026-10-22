import { COMPOSE_FILE_NAMES, isWithin, normalizeRepoPath, relativeTo } from './source/paths';

export interface RoutingPolicy {
  include: string[];
  exclude: string[];
  dependencies: string[];
}

export const MAX_ROUTING_PATTERNS = 32;
export const MAX_ROUTING_PATTERN_LENGTH = 256;
export const MAX_CHANGED_PATHS = 10_000;

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  include: [...COMPOSE_FILE_NAMES, 'config/**', 'scripts/runtime/**'],
  exclude: ['README.md', 'docs/**', '**/*.md'],
  dependencies: [],
};

export interface RoutingStack {
  stackId: string;
  rootPath: string;
  composePath: string;
  enabled: boolean;
  deployOnPush: boolean;
  policy: RoutingPolicy | null;
  credentialAvailable?: boolean;
}

export interface RoutingDecision {
  stackId: string;
  relevant: boolean;
  deployEligible: boolean;
  matchedPaths: string[];
  reasonCode:
    | 'no_relevant_changes'
    | 'relevant_changes'
    | 'deployment_disabled'
    | 'deploy_on_push_disabled'
    | 'credential_missing';
  explanation: string;
}

/** Only *, ? and whole-segment ** are supported; all patterns are relative POSIX paths. */
export function validateRoutingPolicy(input: unknown): RoutingPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Routing policy must be an object.');
  }
  const value = input as Record<string, unknown>;
  const result: RoutingPolicy = { include: [], exclude: [], dependencies: [] };
  for (const field of ['include', 'exclude', 'dependencies'] as const) {
    const patterns = value[field];
    if (!Array.isArray(patterns)) throw new Error(`Routing policy ${field} must be a list.`);
    if (patterns.length > MAX_ROUTING_PATTERNS) {
      throw new Error(`Routing policy ${field} has too many patterns (limit ${MAX_ROUTING_PATTERNS}).`);
    }
    for (const pattern of patterns) {
      if (
        typeof pattern !== 'string' ||
        pattern.length === 0 ||
        pattern.length > MAX_ROUTING_PATTERN_LENGTH ||
        pattern !== pattern.trim() ||
        /[\u0000-\u001f\u007f\\{}[\]!():]/.test(pattern) ||
        pattern
          .split('/')
          .some(
            (segment) =>
              !segment ||
              segment === '.' ||
              segment === '..' ||
              segment.toLowerCase() === '.git' ||
              (segment.includes('**') && segment !== '**'),
          )
      ) {
        throw new Error(`Routing policy ${field} contains an invalid or unsupported glob.`);
      }
      result[field].push(pattern);
    }
  }
  return result;
}

export function normalizeChangedPaths(paths: readonly string[]): string[] {
  if (paths.length > MAX_CHANGED_PATHS) {
    throw new Error(`Too many changed paths (limit ${MAX_CHANGED_PATHS}).`);
  }
  return [
    ...new Set(
      paths.map((path) => {
        if (
          typeof path !== 'string' ||
          path.startsWith('/') ||
          /^[a-z]:/i.test(path) ||
          path.includes('\\')
        ) {
          throw new Error('Changed paths must be repository-relative POSIX paths.');
        }
        return normalizeRepoPath(path);
      }),
    ),
  ].sort((a, b) => {
    // Git paths use ordinal ordering, independent of the host locale.
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

/** Dynamic programming bounds wildcard matching; no user-derived regular expressions. */
function matchSegment(pattern: string, path: string): boolean {
  const characters = [...path];
  let previous = new Array<boolean>(characters.length + 1).fill(false);
  previous[0] = true;
  for (const token of pattern) {
    const current = new Array<boolean>(characters.length + 1).fill(false);
    current[0] = token === '*' && previous[0] === true;
    for (let i = 1; i <= characters.length; i++) {
      current[i] =
        token === '*'
          ? previous[i] === true || current[i - 1] === true
          : previous[i - 1] === true && (token === '?' || token === characters[i - 1]);
    }
    previous = current;
  }
  return previous[characters.length] === true;
}

function matches(pattern: string, path: string): boolean {
  const segments = path.split('/');
  let previous = new Array<boolean>(segments.length + 1).fill(false);
  previous[0] = true;
  for (const part of pattern.split('/')) {
    const current = new Array<boolean>(segments.length + 1).fill(false);
    current[0] = part === '**' && previous[0] === true;
    for (let i = 1; i <= segments.length; i++) {
      current[i] =
        part === '**'
          ? previous[i] === true || current[i - 1] === true
          : previous[i - 1] === true && matchSegment(part, segments[i - 1] ?? '');
    }
    previous = current;
  }
  return previous[segments.length] === true;
}

export function evaluateRouting(paths: readonly string[], stack: RoutingStack): RoutingDecision {
  const policy = validateRoutingPolicy(stack.policy ?? DEFAULT_ROUTING_POLICY);
  const root = normalizeRepoPath(stack.rootPath, { allowRoot: true });
  const changedPaths = normalizeChangedPaths(paths);
  const work =
    changedPaths.reduce((sum, path) => sum + path.length, 0) *
    [...policy.include, ...policy.exclude, ...policy.dependencies].reduce(
      (sum, pattern) => sum + pattern.length,
      0,
    );
  if (work > 50_000_000) throw new Error('Routing evaluation exceeds the matching work limit.');
  const dependencyPaths = new Set<string>();
  const matchedPaths = changedPaths.filter((path) => {
    const inRoot = isWithin(root, path);
    const relativePath = inRoot ? relativeTo(root, path) : '';
    const dependency = policy.dependencies.some((pattern) => matches(pattern, path));
    if (!inRoot && !dependency) return false;
    // Root exclusions are stack-relative; dependency exclusions are repository-relative.
    if (
      policy.exclude.some(
        (pattern) => (inRoot && matches(pattern, relativePath)) || (dependency && matches(pattern, path)),
      )
    )
      return false;
    if (dependency) dependencyPaths.add(path);
    // Empty includes deliberately match no root paths, including the primary compose file.
    return dependency || (inRoot && policy.include.some((pattern) => matches(pattern, relativePath)));
  });
  const relevant = matchedPaths.length > 0;
  const result = { stackId: stack.stackId, relevant, matchedPaths };
  if (!relevant) {
    return {
      ...result,
      deployEligible: false,
      reasonCode: 'no_relevant_changes',
      explanation:
        changedPaths.length === 1
          ? `No deployment required. Only ${changedPaths[0]} changed; it does not match the routing policy.`
          : 'No deployment required. No changed paths match the routing policy.',
    };
  }
  if (!stack.enabled) {
    return {
      ...result,
      deployEligible: false,
      reasonCode: 'deployment_disabled',
      explanation: 'Relevant paths changed, but deployment is disabled.',
    };
  }
  if (!stack.deployOnPush) {
    return {
      ...result,
      deployEligible: false,
      reasonCode: 'deploy_on_push_disabled',
      explanation: 'Relevant paths changed, but deploy on push is disabled.',
    };
  }
  if (stack.credentialAvailable === false) {
    return {
      ...result,
      deployEligible: false,
      reasonCode: 'credential_missing',
      explanation: 'Relevant paths changed, but the deployment credential is unavailable.',
    };
  }
  const firstPath = matchedPaths[0] ?? '';
  const dependency = dependencyPaths.has(firstPath) ? ' (dependency path)' : '';
  const remaining = matchedPaths.length > 1 ? ` and ${matchedPaths.length - 1} other path(s)` : '';
  return {
    ...result,
    deployEligible: true,
    reasonCode: 'relevant_changes',
    explanation: `Deployment required because ${firstPath}${dependency}${remaining} changed.`,
  };
}
