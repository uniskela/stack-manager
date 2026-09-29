'use client';

import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import type { SourceProblem } from '@/shared/source/compose';
import type { SourceLanguage } from '@/shared/source/paths';
import { baseExtensions } from './editor-setup';

export interface CodeEditorProps {
  /** Identity of the open document. Each key keeps its own undo history while the editor is mounted. */
  docKey: string;
  /** Content used the first time a key is shown. Later changes are ignored unless the key changes. */
  initialValue: string;
  language: SourceLanguage;
  compose?: boolean;
  readOnly?: boolean;
  wrap?: boolean;
  problems?: SourceProblem[];
  /** Keys still open; states for other keys are dropped. */
  openKeys?: string[];
  jump?: { line: number; nonce: number } | null;
  onChange?: (text: string) => void;
  onCursor?: (line: number, column: number) => void;
  onSave?: () => void;
  className?: string;
}

/**
 * CodeMirror 6 editor (ADR 0003). This component is the editor-engine seam: the rest of the UI only
 * talks to these props, so another engine could replace it behind the same interface.
 */
export function CodeEditor(props: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const statesRef = useRef(new Map<string, EditorState>());
  const keyRef = useRef<string | null>(null);
  const configRef = useRef(new Compartment());
  const callbacks = useRef(props);
  // Keep the latest callbacks without recreating editor state.
  useEffect(() => {
    callbacks.current = props;
  });

  const extensions = () =>
    baseExtensions({
      language: props.language,
      compose: !!props.compose,
      readOnly: !!props.readOnly,
      wrap: !!props.wrap,
      onSave: () => callbacks.current.onSave?.(),
    });

  const createState = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        configRef.current.of(extensions()),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacks.current.onChange?.(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            callbacks.current.onCursor?.(line.number, head - line.from + 1);
          }
        }),
      ],
    });

  // Mount once.
  useEffect(() => {
    const view = new EditorView({ parent: hostRef.current! });
    viewRef.current = view;
    const states = statesRef.current;
    return () => {
      view.destroy();
      viewRef.current = null;
      states.clear();
      keyRef.current = null;
    };
  }, []);

  // Switch documents, keeping each one's state (undo history, selection, scroll).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (keyRef.current !== null && keyRef.current !== props.docKey) {
      statesRef.current.set(keyRef.current, view.state);
    }
    if (keyRef.current !== props.docKey) {
      const state = statesRef.current.get(props.docKey) ?? createState(props.initialValue);
      view.setState(state);
      keyRef.current = props.docKey;
    }
    view.dispatch({ effects: configRef.current.reconfigure(extensions()) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- extensions() reads the props listed here
  }, [props.docKey, props.language, props.compose, props.readOnly, props.wrap]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const length = view.state.doc.length;
    const diagnostics: Diagnostic[] = (props.problems ?? []).map((p) => ({
      from: Math.min(p.from, length),
      to: Math.min(Math.max(p.to, p.from), length),
      severity: p.severity,
      message: p.message,
    }));
    view.dispatch(setDiagnostics(view.state, diagnostics));
  }, [props.problems, props.docKey]);

  useEffect(() => {
    if (!props.openKeys) return;
    const open = new Set(props.openKeys);
    for (const key of statesRef.current.keys()) if (!open.has(key)) statesRef.current.delete(key);
  }, [props.openKeys]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !props.jump) return;
    const line = view.state.doc.line(Math.min(Math.max(1, props.jump.line), view.state.doc.lines));
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
  }, [props.jump]);

  return <div ref={hostRef} className={props.className ?? 'editor-surface'} />;
}
