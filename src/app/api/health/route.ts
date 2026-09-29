import { defineRoute, json } from '@/server/http/route';

/** Liveness/readiness probe for Docker. Reveals nothing beyond up/down. */
export const GET = defineRoute({ auth: 'public' }, async ({ container }) =>
  container.ping() ? json({ status: 'ok' }) : json({ status: 'unavailable' }, { status: 503 }),
);
