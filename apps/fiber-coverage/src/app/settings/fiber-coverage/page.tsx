'use client';
import { Badge, Button, LargeTitle, Segmented, ThemeToggle } from '@meridian/ui';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Capacity } from '@/components/capacity';
import { Check } from '@/components/check';
import { ImportPanel } from '@/components/import';
import { Network } from '@/components/network';
import { Overview } from '@/components/overview';
import { Providers } from '@/components/providers';
import { post, useApi } from '@/lib/api';
import { BrandMark } from '@/components/brand';

// Leaflet touches `window`, so the map loads in the browser only.
const MapView = dynamic(() => import('@/components/map').then((m) => m.MapView), { ssr: false, loading: () => <p className="text-subhead text-label2">Loading the map…</p> });

const TABS = [
  { value: 'overview', label: 'Overview' }, { value: 'providers', label: 'Providers' }, { value: 'network', label: 'Network' }, { value: 'map', label: 'Map' },
  { value: 'import', label: 'Import' }, { value: 'capacity', label: 'Ports and waitlist' }, { value: 'check', label: 'Try a check' },
] as const;
type Tab = (typeof TABS)[number]['value'];

function Hub() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = (TABS.find((t) => t.value === params.get('tab'))?.value ?? 'overview') as Tab;
  const me = useApi<{ displayName: string; username: string }>('/admin/me');
  const mod = useApi<{ enabled: boolean }>('/admin/module');
  const signOut = async () => { await post('/admin/logout').catch(() => {}); router.replace('/login'); };
  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-4 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-separator pb-3 pt-[var(--sat)]">
        <BrandMark /><span className="text-subhead text-label2">Fibre coverage</span>
        <div className="ml-auto flex items-center gap-2"><span className="hidden text-subhead text-label2 sm:inline">{me.data?.displayName}</span><ThemeToggle /><Button variant="secondary" onClick={() => void signOut()}>Sign out</Button></div>
      </div>
      <LargeTitle subtitle="Where fibre reaches, who owns it, how many ports are left, and holding a port while a customer checks out.">
        Fibre coverage {mod.data && <Badge tone={mod.data.enabled ? 'success' : 'neutral'}>{mod.data.enabled ? 'On' : 'Off'}</Badge>}
      </LargeTitle>
      <div className="mb-5"><Segmented label="Section" value={tab} options={TABS.map((t) => ({ value: t.value, label: t.label }))} onChange={(v) => router.replace(`/settings/fiber-coverage?tab=${v}`)} /></div>
      {tab === 'overview' && <Overview onModule={() => void mod.reload()} />}
      {tab === 'providers' && <Providers />}
      {tab === 'network' && <Network />}
      {tab === 'map' && <MapView />}
      {tab === 'import' && <ImportPanel />}
      {tab === 'capacity' && <Capacity />}
      {tab === 'check' && <Check />}
    </div>
  );
}
export default function Page() { return <Suspense><Hub /></Suspense>; }
