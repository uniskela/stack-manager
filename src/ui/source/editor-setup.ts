import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { lintGutter } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import type { Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { SourceLanguage } from '@/shared/source/paths';

/** Colours come from CSS custom properties, so the editor follows the app's light/dark tokens. */
const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--surface)' },
  '.cm-content': { caretColor: 'var(--text)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text-muted)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--text) 6%, transparent)',
    color: 'var(--text)',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)' },
  '.cm-matchingBracket': { outline: '1px solid var(--border-strong)', backgroundColor: 'transparent' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--surface-2)',
    border: '1px solid var(--border)',
    color: 'var(--text-muted)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border-strong)',
    borderRadius: '6px',
    boxShadow: 'var(--shadow-overlay)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--text)',
  },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-textfield': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border-strong)',
    borderRadius: '4px',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border-strong)',
  },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warn)' },
  '.cm-diagnostic-info': { borderLeftColor: 'var(--accent)' },
});

const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName), t.attributeName], color: 'var(--syntax-key)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syntax-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syntax-number)' },
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword], color: 'var(--syntax-keyword)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [t.meta, t.variableName, t.labelName, t.typeName], color: 'var(--syntax-meta)' },
  { tag: t.heading1, color: 'var(--syntax-heading)', fontWeight: '700', fontSize: '1.45em' },
  { tag: t.heading2, color: 'var(--syntax-heading)', fontWeight: '700', fontSize: '1.25em' },
  { tag: t.heading3, color: 'var(--syntax-heading)', fontWeight: '700', fontSize: '1.1em' },
  { tag: [t.heading4, t.heading5, t.heading6], color: 'var(--syntax-heading)', fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--syntax-link)', textDecoration: 'underline' },
  { tag: t.monospace, fontFamily: 'var(--mono)', color: 'var(--syntax-string)' },
  { tag: t.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

const TOP_LEVEL = ['services', 'networks', 'volumes', 'configs', 'secrets', 'include', 'name'];
const SERVICE_KEYS = [
  'image',
  'build',
  'container_name',
  'command',
  'entrypoint',
  'environment',
  'env_file',
  'ports',
  'expose',
  'volumes',
  'networks',
  'depends_on',
  'restart',
  'labels',
  'healthcheck',
  'deploy',
  'user',
  'working_dir',
  'extra_hosts',
  'logging',
  'secrets',
  'configs',
  'profiles',
  'cap_add',
  'cap_drop',
  'devices',
  'dns',
  'hostname',
  'init',
  'mem_limit',
  'platform',
  'privileged',
  'pull_policy',
  'read_only',
  'security_opt',
  'shm_size',
  'stop_grace_period',
  'sysctls',
  'tmpfs',
  'ulimits',
];

/** Key completion for Compose files: top-level keys at column 0, service keys when indented. */
function composeCompletions(context: CompletionContext) {
  const word = context.matchBefore(/[A-Za-z_]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, word.from - line.from);
  if (before.trim() !== '' && before.trim() !== '-') return null;
  const keys = before.length === 0 ? TOP_LEVEL : SERVICE_KEYS;
  return {
    from: word.from,
    options: keys.map((label) => ({ label, type: 'property', apply: `${label}: ` })),
    validFor: /^[A-Za-z_]*$/,
  };
}

function languageExtension(language: SourceLanguage, compose: boolean): Extension {
  switch (language) {
    case 'yaml':
      return compose ? [yaml(), autocompletion({ override: [composeCompletions] })] : yaml();
    case 'markdown':
      return [markdown(), EditorView.lineWrapping];
    case 'json':
      return json();
    case 'dotenv':
      return StreamLanguage.define(properties);
    case 'shell':
      return StreamLanguage.define(shell);
    case 'dockerfile':
      return StreamLanguage.define(dockerFile);
    case 'toml':
      return StreamLanguage.define(toml);
    default:
      return [];
  }
}

export function baseExtensions(options: {
  language: SourceLanguage;
  compose: boolean;
  readOnly: boolean;
  wrap: boolean;
  onSave: () => void;
}): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter(),
    lintGutter(),
    history(),
    drawSelection(),
    rectangularSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    indentUnit.of('  '),
    // Explicit tabindex: the scroll area stays keyboard-reachable even when read-only (contenteditable=false).
    EditorView.contentAttributes.of({
      'aria-label': 'File contents',
      spellcheck: 'false',
      autocapitalize: 'off',
      tabindex: '0',
    }),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (options.onSave(), true) },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    theme,
    syntaxHighlighting(highlight),
    languageExtension(options.language, options.compose),
    options.wrap ? EditorView.lineWrapping : [],
    EditorView.editable.of(!options.readOnly),
  ];
}
