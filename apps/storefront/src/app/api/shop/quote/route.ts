import { core } from '@/server/core';
import { guarded, json, failure } from '@/server/respond';
import { sameSite } from '@/server/session';
export const dynamic = 'force-dynamic';
export const POST = (req: Request) => guarded(async () => {
  if (!sameSite(req)) return failure(403, 'FORBIDDEN', 'Cross-site request blocked.');
  return json(await core('/store/quote', { method: 'POST', json: await req.json().catch(() => ({})) }));
});
