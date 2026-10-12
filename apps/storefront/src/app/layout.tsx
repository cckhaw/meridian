import { DEFAULT_REGIONAL, DEFAULT_THEME, themeCss, type ThemeId } from '@meridian/types';
import { themeInitScript } from '@meridian/ui';
import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ConfigProvider, type StoreConfig } from '@/components/config';
import { core } from '@/server/core';
import './globals.css';

export const dynamic = 'force-dynamic';

const FALLBACK: StoreConfig = {
  brand: { name: 'Store', theme: DEFAULT_THEME, logo: null }, regional: DEFAULT_REGIONAL,
  kyc: { mode: 'manual', minAge: 18, idTypes: ['NATIONAL_ID', 'PASSPORT'], requiresBack: [], maxDocumentBytes: 2_500_000 }, terms: { version: '1', termsUrl: null, privacyUrl: null }, payment: { gateways: [], default: null },
};
const load = async (): Promise<{ cfg: StoreConfig; ok: boolean }> => { try { return { cfg: await core<StoreConfig>('/store/config'), ok: true }; } catch { return { cfg: FALLBACK, ok: false }; } };

export async function generateMetadata(): Promise<Metadata> {
  const { cfg } = await load();
  return { title: { default: `${cfg.brand.name} – shop`, template: `%s · ${cfg.brand.name}` }, description: 'Choose a plan, verify your identity and get connected.' };
}
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { cfg, ok } = await load();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <style dangerouslySetInnerHTML={{ __html: themeCss(cfg.brand.theme as ThemeId) }} />
      </head>
      <body>
        <ConfigProvider value={cfg}>
          <header className="sticky top-0 z-30 border-b border-separator bg-bg/80 pt-[var(--sat)] backdrop-blur-chrome">
            <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2 sm:px-6">
              <Link href="/" className="flex min-h-tap items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                {cfg.brand.logo
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={`/brand/logo?v=${cfg.brand.logo.sha256.slice(0, 12)}`} alt={cfg.brand.name} className="max-h-10 w-auto max-w-[200px] object-contain" />
                  : <span className="text-title3 font-bold">{cfg.brand.name}</span>}
              </Link>
              <nav aria-label="Main" className="ml-auto flex items-center gap-1 text-subhead">
                <Link href="/" className="min-h-tap rounded-control px-3 py-2 text-label hover:bg-surface2">Plans</Link>
                <Link href="/apply" className="min-h-tap rounded-control px-3 py-2 text-label hover:bg-surface2">Continue sign-up</Link>
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-4 pb-24 pt-6 sm:px-6 sm:pt-8">
            {!ok && <p role="alert" className="mb-4 rounded-control bg-warning/15 px-4 py-3 text-subhead text-label">The store is temporarily unavailable. Please try again shortly.</p>}
            {children}
          </main>
          <footer className="border-t border-separator px-4 py-6 text-center text-footnote text-label2">
            © {new Date().getFullYear()} {cfg.brand.name}
            {cfg.terms.termsUrl && <> · <a className="underline" href={cfg.terms.termsUrl} target="_blank" rel="noreferrer">Terms</a></>}
            {cfg.terms.privacyUrl && <> · <a className="underline" href={cfg.terms.privacyUrl} target="_blank" rel="noreferrer">Privacy</a></>}
          </footer>
        </ConfigProvider>
      </body>
    </html>
  );
}
