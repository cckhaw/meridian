import { themeInitScript } from '@nexus/ui';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = { title: { default: 'Nexus', template: '%s · Nexus' }, description: 'Telecom CRM & Billing Suite' };
// viewport-fit=cover lets the shell use safe-area insets on notched phones.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeInitScript }} /></head>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
