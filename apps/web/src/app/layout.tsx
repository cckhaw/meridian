import { themeInitScript } from '@meridian/ui';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { loadPresentation } from '@/server/presentation';
import './globals.css';

// Brand, theme and number format come from Settings, so the layout is rendered per request.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { name, faviconUrl } = await loadPresentation();
  return { title: { default: name, template: `%s · ${name}` }, description: 'Telecom CRM & Billing Suite', ...(faviconUrl ? { icons: { icon: faviconUrl, apple: faviconUrl } } : {}) };
}
// viewport-fit=cover lets the shell use safe-area insets on notched phones.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const p = await loadPresentation();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <style dangerouslySetInnerHTML={{ __html: p.css }} />
      </head>
      <body><Providers presentation={{ name: p.name, logoUrl: p.logoUrl, regional: p.regional }}>{children}</Providers></body>
    </html>
  );
}
