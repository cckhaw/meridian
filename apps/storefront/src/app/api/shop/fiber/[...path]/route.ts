import { core } from '@/server/core';
import { guarded, json, failure } from '@/server/respond';
import { sameSite, shopperIp } from '@/server/session';
export const dynamic = 'force-dynamic';

/** The fibre coverage calls the address step makes, passed to the CRM (which asks the coverage service). Only these four are allowed. */
const ALLOWED = [/^qualify$/, /^reserve$/, /^waitlist$/, /^release\/[0-9a-f-]{36}$/];
export const POST = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => guarded(async () => {
  if (!sameSite(req)) return failure(403, 'FORBIDDEN', 'Cross-site request blocked.');
  const p = (await ctx.params).path.join('/');
  if (!ALLOWED.some((re) => re.test(p))) return failure(404, 'NOT_FOUND', 'not found');
  const target = p.startsWith('release/') ? `/store/fiber/reservations/${p.slice('release/'.length)}/release` : `/store/fiber/${p}`;
  return json(await core(target, { method: 'POST', json: await req.json().catch(() => ({})), shopperIp: shopperIp(req) }));
});
