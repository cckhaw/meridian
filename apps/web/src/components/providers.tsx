'use client';
import { AppShell, Spinner, ThemeProvider } from '@meridian/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';

const PUBLIC = ['/login'];

export function Providers({ children }: { children: ReactNode }) {
  return <ThemeProvider><AuthProvider><Gate>{children}</Gate></AuthProvider></ThemeProvider>;
}

/** Pages outside the shell (login), then the signed-in shell, with a client-side guard that mirrors the server's module list. */
function Gate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, loading, signOut } = useAuth();
  const isPublic = PUBLIC.includes(pathname);

  useEffect(() => {
    if (loading || isPublic) return;
    if (!me) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else if (me.mustChangePassword && pathname !== '/change-password') router.replace('/change-password');
  }, [loading, me, isPublic, pathname, router]);

  if (isPublic) return <>{children}</>;
  if (loading || !me) return <div className="grid min-h-dvh place-items-center"><Spinner label="Loading" /></div>;
  if (me.mustChangePassword) return <main className="mx-auto max-w-md px-4 py-12">{children}</main>;

  const allowed = pathname === '/change-password' || me.modules.some((m) => (m.href === '/' ? pathname === '/' : pathname === m.href || pathname.startsWith(m.href + '/')))
    || (pathname.startsWith('/orders/') && me.modules.some((m) => m.id === 'orders' || m.id === 'sell'))
    || ((pathname.startsWith('/catalog/manage') || pathname.startsWith('/catalog/edit')) && me.permissions.includes('catalog:write'));
  return (
    <AppShell nav={me.modules} user={{ name: me.displayName, roles: me.roleLabels }} activeHref={pathname} onSignOut={() => void signOut()} onChangePassword={() => router.push('/change-password')}
      linkComponent={({ href, ...p }) => <Link href={href} {...p} />}>
      {allowed ? children : <NotAllowed home={me.home} />}
    </AppShell>
  );
}

function NotAllowed({ home }: { home: string }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-title1 font-bold">Not available for your role</h1>
      <p className="mt-2 text-body text-label2">Your role does not include this area. If you need it, ask an administrator.</p>
      <Link href={home} className="mt-6 inline-flex min-h-tap items-center rounded-control bg-accent px-5 text-body font-medium text-accent-fg">Go to your home</Link>
    </div>
  );
}
