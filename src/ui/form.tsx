'use client';

import { useId } from 'react';

export function Field(props: {
  label: string;
  name: string;
  type?: 'text' | 'password' | 'url';
  value: string;
  onChange: (value: string) => void;
  hint?: React.ReactNode;
  error?: string;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  spellCheck?: boolean;
  inputMode?: 'text' | 'url';
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [props.hint ? hintId : null, props.error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        name={props.name}
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        required={props.required}
        autoFocus={props.autoFocus}
        spellCheck={props.spellCheck ?? false}
        autoCapitalize="off"
        autoCorrect="off"
        inputMode={props.inputMode}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy}
      />
      {props.hint ? (
        <div className="hint" id={hintId}>
          {props.hint}
        </div>
      ) : null}
      {props.error ? (
        <div className="error-text" id={errorId}>
          {props.error}
        </div>
      ) : null}
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="alert error" role="alert">
      {message}
    </div>
  );
}

export function Steps({ current }: { current: 1 | 2 | 3 }) {
  const steps = ['Admin account', 'Workspace', 'Repository'];
  return (
    <ol className="steps" aria-label="Setup progress">
      {steps.map((label, i) => {
        const n = i + 1;
        return (
          <li
            key={label}
            aria-current={n === current ? 'step' : undefined}
            className={n < current ? 'done' : undefined}
          >
            <span className="num" aria-hidden="true">
              {n < current ? '✓' : n}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}
