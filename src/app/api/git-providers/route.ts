import { defineRoute } from '@/server/http/route';

export const GET = defineRoute({ auth: 'user' }, async ({ container }) => ({
  providers: container.gitProviders.descriptors(),
}));
