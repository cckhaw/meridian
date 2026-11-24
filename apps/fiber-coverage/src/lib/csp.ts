/**
 * The Content-Security-Policy of the pages. Scripts run only with this request's nonce (Next puts it on its own scripts when it finds it in the request's CSP header, and the layout puts it
 * on the theme script), and `'strict-dynamic'` lets those scripts load the chunks they need; an injected `<script>` has no nonce and does not run. Styles keep `'unsafe-inline'`
 * (React inline styles and the brand stylesheet): a style cannot run code.
 */
export function buildCsp(nonce: string, dev = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // Map tiles are the one outside resource: OpenStreetMap's tile servers (change the tile host here, in next.config.mjs and in src/components/map.tsx to use another provider).
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** A fresh, unguessable nonce for one request. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
