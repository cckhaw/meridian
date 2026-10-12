export const dynamic = 'force-dynamic';

/** The operator's logo, fetched from the CRM's public branding endpoint so the browser never needs to know where the CRM is. */
export async function GET() {
  const base = process.env.MERIDIAN_API_URL?.replace(/\/$/, '');
  if (!base) return new Response(null, { status: 404 });
  const res = await fetch(`${base}/branding/logo`, { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return new Response(null, { status: 404 });
  const type = res.headers.get('content-type') ?? '';
  if (!/^image\/(png|jpeg|webp)$/.test(type)) return new Response(null, { status: 404 });
  return new Response(await res.arrayBuffer(), { headers: { 'content-type': type, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } });
}
