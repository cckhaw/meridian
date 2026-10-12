'use client';
import { AppShell, ThemeProvider } from '@meridian/ui';
import type { PersonaId } from '@meridian/types';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

const KEY = 'meridian-persona';

export function Providers({ children }: { children: ReactNode }) {
  const [persona, setPersona] = useState<PersonaId>('product-configurator');
  const pathname = usePathname();
  useEffect(() => { try { const p = localStorage.getItem(KEY); if (p) setPersona(p as PersonaId); } catch {} }, []);
  const change = (id: PersonaId) => { setPersona(id); try { localStorage.setItem(KEY, id); } catch {} };

  return (
    <ThemeProvider>
      <AppShell persona={persona} onPersonaChange={change} activeHref={pathname}
        linkComponent={({ href, ...p }) => <Link href={href} {...p} />}>
        {children}
      </AppShell>
    </ThemeProvider>
  );
}
