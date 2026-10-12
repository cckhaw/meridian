import { cookies } from 'next/headers';

const NAME = 'shop_app';
/** The shopper's application id and secret token live in an HttpOnly cookie, so page scripts can never read them. */
export async function readApplication(): Promise<{ id: string; token: string } | null> {
  const v = (await cookies()).get(NAME)?.value;
  const m = v && /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/.exec(v);
  return m ? { id: m[1]!, token: m[2]! } : null;
}
export async function saveApplication(id: string, token: string, expiresAt?: string) {
  (await cookies()).set(NAME, `${id}.${token}`, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', expires: expiresAt ? new Date(expiresAt) : undefined });
}
export async function clearApplication() { (await cookies()).delete(NAME); }

/** Mutations must come from this site's own pages. */
export function sameSite(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try { return new URL(origin).host === (req.headers.get('x-forwarded-host') ?? req.headers.get('host')); } catch { return false; }
}
export const shopperIp = (req: Request) => (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim().slice(0, 45) || null;
