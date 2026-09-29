'use client';

import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  KeyRound,
  Link2,
  Package,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { languageFor, relativeTo } from '@/shared/source/paths';
import { LOCK_LABELS, type TreeNodeView } from '@/shared/source/types';

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: TreeNodeView[];
}

function buildTree(entries: TreeNodeView[], root: string): Dir {
  const top: Dir = { name: '', path: root, dirs: new Map(), files: [] };
  for (const entry of entries) {
    const parts = relativeTo(root, entry.path).split('/');
    let dir = top;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      let next = dir.dirs.get(name);
      if (!next) {
        next = { name, path: dir.path ? `${dir.path}/${name}` : name, dirs: new Map(), files: [] };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.push(entry);
  }
  return top;
}

function FileIcon({ node }: { node: TreeNodeView }) {
  if (node.locked === 'secret') return <KeyRound className="icon" aria-hidden="true" />;
  if (node.kind === 'symlink') return <Link2 className="icon" aria-hidden="true" />;
  if (node.kind === 'submodule') return <Package className="icon" aria-hidden="true" />;
  const lang = languageFor(node.path);
  if (lang === 'markdown') return <FileText className="icon" aria-hidden="true" />;
  if (lang === 'text') return <File className="icon" aria-hidden="true" />;
  return <FileCode className="icon" aria-hidden="true" />;
}

/**
 * Explorer tree (VS Code style) built from flat repository paths. Folders are disclosure buttons, files
 * are buttons that open a tab; with a filter the tree collapses to a flat list of matches.
 */
export function FileTree(props: {
  entries: TreeNodeView[];
  root: string;
  activePath: string | null;
  dirtyPaths: Set<string>;
  filter: string;
  onOpen: (path: string) => void;
}) {
  const tree = useMemo(() => buildTree(props.entries, props.root), [props.entries, props.root]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const query = props.filter.trim().toLowerCase();

  const fileButton = (node: TreeNodeView, label: string) => {
    const dirty = props.dirtyPaths.has(node.path);
    const status = dirty
      ? 'unsaved'
      : node.draft === 'new'
        ? 'new draft'
        : node.draft === 'modified'
          ? 'draft'
          : null;
    return (
      <li key={node.path}>
        <button
          type="button"
          className={`tree-item file${node.locked ? ' locked' : ''}`}
          aria-current={props.activePath === node.path ? 'true' : undefined}
          title={node.locked ? LOCK_LABELS[node.locked] : node.path}
          onClick={() => props.onOpen(node.path)}
        >
          <FileIcon node={node} />
          <span className="name">{label}</span>
          {status ? <span className="visually-hidden">({status})</span> : null}
          {dirty ? (
            <span className="dirty-dot" aria-hidden="true" />
          ) : node.draft ? (
            <span className={`tree-badge ${node.draft}`} aria-hidden="true">
              {node.draft === 'new' ? 'A' : 'M'}
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  if (query) {
    const matches = props.entries.filter((e) => relativeTo(props.root, e.path).toLowerCase().includes(query));
    if (matches.length === 0) return <p className="fine-print tree-empty">No matching files.</p>;
    return <ul className="tree">{matches.map((m) => fileButton(m, relativeTo(props.root, m.path)))}</ul>;
  }

  const renderDir = (dir: Dir): React.ReactNode[] => [
    ...[...dir.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((sub) => {
        const open = !collapsed.has(sub.path);
        return (
          <li key={`d:${sub.path}`}>
            <button
              type="button"
              className="tree-item"
              aria-expanded={open}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (open) next.add(sub.path);
                  else next.delete(sub.path);
                  return next;
                })
              }
            >
              {open ? (
                <ChevronDown className="icon" aria-hidden="true" />
              ) : (
                <ChevronRight className="icon" aria-hidden="true" />
              )}
              {open ? (
                <FolderOpen className="icon" aria-hidden="true" />
              ) : (
                <Folder className="icon" aria-hidden="true" />
              )}
              <span className="name">{sub.name}</span>
            </button>
            {open ? <ul>{renderDir(sub)}</ul> : null}
          </li>
        );
      }),
    ...dir.files
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => fileButton(f, f.path.slice(f.path.lastIndexOf('/') + 1))),
  ];

  return (
    <ul className="tree" aria-label="Files">
      {renderDir(tree)}
    </ul>
  );
}
