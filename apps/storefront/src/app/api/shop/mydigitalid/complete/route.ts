import { core } from '@/server/core';
import { guarded, json, failure } from '@/server/respond';
import { sameSite, shopperIp, shopperUa } from '@/server/session';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** MyDigital ID sent the browser back with a code. The one-time state it carries is what ties this to the sign-up that started it. */
export const POST = (req: Request) => guarded(async () => {
  if (!sameSite(req)) return failure(403, 'FORBIDDEN', 'Cross-site request blocked.');
  const b = (await req.json().catch(() => ({}))) as { state?: string; code?: string; error?: string };
  return json(await core('/store/mydigitalid/complete', { method: 'POST', json: { state: b.state, code: b.code, error: b.error }, shopperIp: shopperIp(req), shopperUa: shopperUa(req) }));
});
