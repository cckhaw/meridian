import { brandImage } from '@/server/brand';
export const dynamic = 'force-dynamic';
export const GET = (req: Request) => brandImage('logo', req);
