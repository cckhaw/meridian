import { DEFAULT_THEME, themeCss } from '@meridian/types';
import { themeInitScript } from '@meridian/ui';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = { title: { default: 'Fibre coverage', template: '%s · Fibre coverage' }, description: 'Fibre coverage, serviceability and port reservations for Meridian.' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <style dangerouslySetInnerHTML={{ __html: themeCss(DEFAULT_THEME) }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
