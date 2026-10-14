'use client';
import { LargeTitle, Segmented } from '@meridian/ui';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { LoadPane } from './load-pane';
import { IdentityPanes, OverviewPane } from './panes';
import { TiersPane } from './tiers-pane';

type Tab = 'overview' | 'numbers' | 'sims' | 'imsis' | 'tiers' | 'load';

/** Numbers & SIMs: the pools of phone numbers, SIM cards and subscriber identities, what VIP numbers cost, and loading more. */
export default function Numbering() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('overview');
  const options: Array<{ value: Tab; label: string }> = [
    { value: 'overview', label: 'Overview' }, { value: 'numbers', label: 'Numbers' }, { value: 'sims', label: 'SIM cards' }, { value: 'imsis', label: 'Identities' }, { value: 'tiers', label: 'VIP tiers' },
    ...(can('numbering:manage') ? [{ value: 'load' as Tab, label: 'Load' }] : []),
  ];
  return (
    <>
      <LargeTitle subtitle="Phone numbers (VIP included), SIM cards and eSIM profiles, and the subscriber identities behind them.">Numbers & SIMs</LargeTitle>
      <div className="mb-4 overflow-x-auto"><Segmented label="Numbers and SIMs view" value={tab} options={options} onChange={setTab} /></div>
      {tab === 'overview' && <OverviewPane go={setTab} />}
      {tab === 'numbers' && <IdentityPanes kind="numbers" />}
      {tab === 'sims' && <IdentityPanes kind="sims" />}
      {tab === 'imsis' && <IdentityPanes kind="imsis" />}
      {tab === 'tiers' && <TiersPane />}
      {tab === 'load' && <LoadPane />}
    </>
  );
}
