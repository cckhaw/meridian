import { core } from '@/server/core';
import { guarded, json, failure } from '@/server/respond';
import { saveApplication, sameSite, shopperIp } from '@/server/session';
export const dynamic = 'force-dynamic';

/** Starts an application for the basket. The secret token goes into an HttpOnly cookie; the browser only learns that it worked. */
export const POST = (req: Request) => guarded(async () => {
  if (!sameSite(req)) return failure(403, 'FORBIDDEN', 'Cross-site request blocked.');
  const body = await req.json().catch(() => ({}));
  const r = await core<{ id: string; token: string; expiresAt: string }>('/store/applications', { method: 'POST', json: { lines: body.lines }, shopperIp: shopperIp(req) });
  await saveApplication(r.id, r.token, r.expiresAt);
  return json({ ok: true });
});
