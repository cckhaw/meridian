import { core } from '@/server/core';
import { guarded, json, failure } from '@/server/respond';
import { clearApplication, readApplication, sameSite } from '@/server/session';
export const dynamic = 'force-dynamic';

const none = () => failure(404, 'NOT_FOUND', 'No sign-up in progress.');

export const GET = () => guarded(async () => {
  const a = await readApplication();
  if (!a) return none();
  try { return json(await core(`/store/applications/${a.id}`, { token: a.token })); }
  catch (e: any) { if (e.status === 404) { await clearApplication(); return none(); } throw e; }
});

export const PATCH = (req: Request) => guarded(async () => {
  if (!sameSite(req)) return failure(403, 'FORBIDDEN', 'Cross-site request blocked.');
  const a = await readApplication();
  if (!a) return none();
  return json(await core(`/store/applications/${a.id}`, { method: 'PATCH', token: a.token, json: await req.json().catch(() => ({})) }));
});

export const DELETE = (req: Request) => guarded(async () => {
  if (!sameSite(req)) return failure(403, 'FORBIDDEN', 'Cross-site request blocked.');
  const a = await readApplication();
  if (a) await core(`/store/applications/${a.id}/cancel`, { method: 'POST', token: a.token, json: {} }).catch(() => {});
  await clearApplication();
  return json({ ok: true });
});
