import { dispatch } from '@/server/router';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

type Ctx = { params: Promise<{ path: string[] }> };
const h = async (req: Request, { params }: Ctx) => dispatch(req, (await params).path);
export { h as GET, h as POST, h as PATCH, h as PUT, h as DELETE };
