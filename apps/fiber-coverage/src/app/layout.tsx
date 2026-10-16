import { themeCss, type ThemeId } from '@meridian/types';
import { themeInitScript } from '@meridian/ui';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { BrandProvider } from '@/components/brand';
import { loadBrand } from '@/server/brand';
import './globals.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const b = await loadBrand();
  const icon = b.favicon ? `/brand/favicon?v=${b.favicon.sha256.slice(0, 12)}` : null;
  return { title: { default: `${b.name} · Fibre coverage`, template: `%s · ${b.name} Fibre coverage` }, description: 'Fibre coverage, serviceability and port reservations.', ...(icon ? { icons: { icon, apple: icon } } : {}) };
}
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const b = await loadBrand();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <style dangerouslySetInnerHTML={{ __html: themeCss(b.theme as ThemeId) }} />
      </head>
      <body><BrandProvider value={{ name: b.name, logoUrl: b.logo ? `/brand/logo?v=${b.logo.sha256.slice(0, 12)}` : null }}>{children}</BrandProvider></body>
    </html>
  );
}
