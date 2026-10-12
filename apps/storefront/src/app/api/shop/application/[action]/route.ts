import { core } from '@/server/core';
import { guarded, json, failure } from '@/server/respond';
import { readApplication, sameSite } from '@/server/session';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Only these actions are forwarded, each to one fixed CRM path. */
const ACTIONS: Record<string, string> = { documents: 'documents', kyc: 'kyc', checkout: 'checkout', payment: 'payment', 'payment-test': 'payment/test' };

export const POST = (req: Request, ctx: { params: Promise<{ action: string }> }) => guarded(async () => {
  if (!sameSite(req)) return failure(403, 'FORBIDDEN', 'Cross-site request blocked.');
  const path = ACTIONS[(await ctx.params).action];
  if (!path) return failure(404, 'NOT_FOUND', 'not found');
  const a = await readApplication();
  if (!a) return failure(404, 'NOT_FOUND', 'No sign-up in progress.');
  return json(await core(`/store/applications/${a.id}/${path}`, { method: 'POST', token: a.token, json: await req.json().catch(() => ({})) }));
});
