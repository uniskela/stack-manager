# ADR 0003 — Prefer CodeMirror 6 for editors

## Status

Accepted (PR #1)

## Context

Core UX is editing Compose, YAML, Markdown, and related text. Mobile editing matters. Monaco is common for “IDE-like” UIs but is heavier and historically weaker on touch/mobile.

## Decision

Evaluate and **prefer CodeMirror 6** as the default editor component for MVP.

Do **not** choose Monaco merely because the UI has some VS Code characteristics.

## Consequences

- Better mobile viability and smaller bundle potential
- Need to assemble YAML/Markdown extensions deliberately
- If desktop power features later demand Monaco, isolate behind an `EditorEngine` interface so swap is possible

## Rejection notes

Monaco remains allowed as an experiment behind a flag only if CodeMirror fails a documented mobile editing checklist in PR #3.
