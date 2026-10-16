import { dispatch } from '@/server/router';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

type Ctx = { params: Promise<{ path: string[] }> };
const h = async (req: Request, { params }: Ctx) => dispatch(req, ['tmf-api', ...(await params).path]);
export { h as GET, h as POST };
