import { ValidationError } from '@/server/domain/errors';

export function historyQuery(req: Request): { limit?: number; cursor?: string } {
  const query = new URL(req.url).searchParams;
  for (const key of query.keys()) {
    if (!['limit', 'cursor'].includes(key) || query.getAll(key).length !== 1) {
      throw new ValidationError('Invalid history query.');
    }
  }
  const limit = query.get('limit');
  if (limit !== null && !/^[1-9]\d*$/.test(limit)) throw new ValidationError('Invalid history page size.');
  return {
    ...(limit !== null ? { limit: Number(limit) } : {}),
    ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}),
  };
}
