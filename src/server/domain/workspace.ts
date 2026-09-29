import { ValidationError } from './errors';

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export function validateWorkspaceName(input: string): string {
  const name = input.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 80) {
    throw new ValidationError('Invalid workspace name.', { name: 'Use 1–80 characters.' });
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new ValidationError('Invalid workspace name.', { name: 'Control characters are not allowed.' });
  }
  return name;
}

export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'workspace';
}
