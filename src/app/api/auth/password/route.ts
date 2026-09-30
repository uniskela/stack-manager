import { z } from 'zod';
import { defineRoute } from '@/server/http/route';

const PasswordBody = z
  .object({
    currentPassword: z.string().max(1024),
    newPassword: z.string().max(1024),
    confirmPassword: z.string().max(1024),
  })
  .refine((body) => body.newPassword === body.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

export const POST = defineRoute(
  { auth: 'user', body: PasswordBody },
  async ({ container, body, session, requestContext }) => {
    await container.auth.changePassword(
      session.user.id,
      session.session.id,
      { currentPassword: body.currentPassword, newPassword: body.newPassword },
      requestContext,
    );
    return { ok: true };
  },
);
