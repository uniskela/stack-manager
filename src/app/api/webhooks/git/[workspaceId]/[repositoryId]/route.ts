import { defineRoute, json } from '@/server/http/route';

type Params = { workspaceId: string; repositoryId: string };

/** Public ingress authenticated solely by the repository's native HMAC-SHA256 signature. */
export const POST = defineRoute<Params, undefined, 'signed-webhook'>(
  { auth: 'signed-webhook' },
  async ({ container, params, req, rawBody }) => {
    const result = await container.gitWebhooks.receive(
      params.workspaceId,
      params.repositoryId,
      req.headers,
      rawBody,
    );
    if (result === 'accepted') container.worker.nudge();
    return json({ result }, { status: result === 'accepted' ? 202 : 200 });
  },
);
