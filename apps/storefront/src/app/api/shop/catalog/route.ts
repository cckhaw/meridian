import { core } from '@/server/core';
import { guarded, json } from '@/server/respond';
export const dynamic = 'force-dynamic';
export const GET = () => guarded(async () => json(await core('/store/catalog')));
