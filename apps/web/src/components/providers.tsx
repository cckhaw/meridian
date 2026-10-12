'use client';
import { AppShell, ThemeProvider } from '@meridian/ui';
import type { PersonaId } from '@meridian/types';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';

const KEY = 'meridian-persona';

export function Providers({ children }: { children: ReactNode }) {
  const [persona, setPersona] = useState<PersonaId>('admin');
  const pathname = usePathname();
  const [demoDb, setDemoDb] = useState(false);
  useEffect(() => { api('/meta').then((m) => setDemoDb(!m.persistent)).catch(() => {}); }, []);
  useEffect(() => { try { const p = localStorage.getItem(KEY); if (p) setPersona(p as PersonaId); } catch {} }, []);
  const change = (id: PersonaId) => { setPersona(id); try { localStorage.setItem(KEY, id); } catch {} };

  return (
    <ThemeProvider>
      <AppShell persona={persona} onPersonaChange={change} activeHref={pathname}
        linkComponent={({ href, ...p }) => <Link href={href} {...p} />}>
        {demoDb && (
          <p role="status" className="mb-6 rounded-control bg-warning/15 px-4 py-3 text-subhead">
            Embedded demo database: data is not durable and resets when the server restarts. Set <code className="font-mono">DATABASE_URL</code> to use PostgreSQL.
          </p>
        )}
        {children}
      </AppShell>
    </ThemeProvider>
  );
}
