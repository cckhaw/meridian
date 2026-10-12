import { core } from '@/server/core';
import { guarded, json } from '@/server/respond';
export const dynamic = 'force-dynamic';

/** Passes only the search/paging parameters through; the shop never forwards arbitrary query strings to the CRM. */
export const GET = (req: Request) => guarded(async () => {
  const from = new URL(req.url).searchParams, to = new URLSearchParams();
  for (const k of ['q', 'kind', 'notKind', 'limit', 'cursor']) { const v = from.get(k); if (v) to.set(k, v.slice(0, 200)); }
  const qs = to.toString();
  return json(await core(`/store/catalog${qs ? `?${qs}` : ''}`));
});
