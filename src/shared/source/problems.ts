import { analyzeCompose, analyzeJson, analyzeYaml, type SourceProblem } from './compose';
import { basename, isComposeFileName, languageFor } from './paths';

/** Problems for any supported file: full Compose checks for Compose files, syntax checks otherwise. */
export function problemsFor(path: string, text: string, composePath?: string): SourceProblem[] {
  const language = languageFor(path);
  if (language === 'yaml') {
    return isCompose(path, composePath) ? analyzeCompose(text).problems : analyzeYaml(text);
  }
  if (language === 'json') return analyzeJson(text);
  return [];
}

export function isCompose(path: string, composePath?: string): boolean {
  return path === composePath || isComposeFileName(basename(path));
}
