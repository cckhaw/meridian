import { getBranding, getDb, getFavicon, getLogo, type Branding } from '@meridian/core';
import { DEFAULT_THEME } from '@meridian/types';

/** The look the operator chose in the CRM (Settings → Appearance). The service shares the CRM's database, so it reads the same record: nothing to configure twice. */
export const FALLBACK_BRAND: Branding = { name: 'Meridian', theme: DEFAULT_THEME, logo: null, favicon: null };
export async function loadBrand(): Promise<Branding> {
  try { return await getBranding(await getDb()); } catch { return FALLBACK_BRAND; }
}

type Img = { contentType: string; bytes: Buffer; sha256: string } | null;
export async function brandImage(which: 'logo' | 'favicon', req: Request): Promise<Response> {
  let img: Img = null;
  try { const db = await getDb(); img = which === 'logo' ? await getLogo(db) : await getFavicon(db); } catch { /* shown as missing */ }
  if (!img) return new Response(null, { status: 404 });
  const etag = `"${img.sha256}"`;
  const headers = { etag, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(img.bytes), { headers: { ...headers, 'content-type': img.contentType, 'content-length': String(img.bytes.length) } });
}
