'use client';

import type { GitWorkflowResult } from '@/shared/git-workflow';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

async function requestJson(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data: unknown = await res.json().catch(() => ({}));
  return { res, data };
}

function throwApiError(status: number, data: unknown): never {
  const err = (data as { error?: { code?: string; message?: string; fields?: Record<string, string> } })
    .error;
  throw new ApiError(
    status,
    err?.code ?? 'error',
    err?.message ?? `Request failed (${status}).`,
    err?.fields,
  );
}

/** Same-origin JSON fetch. The session cookie is HTTP-only and sent automatically. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { res, data } = await requestJson(path, init);
  if (!res.ok) throwApiError(res.status, data);
  return data as T;
}

function isGitWorkflowResult(data: unknown): data is GitWorkflowResult {
  return (
    !!data &&
    typeof data === 'object' &&
    'status' in data &&
    'draftsPreserved' in data &&
    (data as GitWorkflowResult).draftsPreserved === true
  );
}

/**
 * Git workflow routes return a structured `GitWorkflowResult` for both success and
 * expected conflict/validation outcomes (409/422/502). Malformed requests still use the error envelope.
 */
export async function gitWorkflow(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<GitWorkflowResult> {
  const { res, data } = await requestJson(path, init);
  if (isGitWorkflowResult(data)) return data;
  if (!res.ok) throwApiError(res.status, data);
  throw new ApiError(res.status, 'error', 'Unexpected Git workflow response.');
}
