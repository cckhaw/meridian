'use client';
import { LargeTitle, Segmented } from '@meridian/ui';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Channel } from './channel';
import { Earnings } from './earnings';
import { Payouts } from './payouts';
import { Plans } from './plans';
import { Statements } from './statements';

type Tab = 'earnings' | 'statements' | 'plans' | 'channel' | 'payouts';

export default function Commission() {
  const { can } = useAuth();
  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'earnings', label: 'Earnings' },
    { value: 'statements', label: 'Statements' },
    ...(can('commission:configure') ? [{ value: 'plans' as const, label: 'Plans' }, { value: 'channel' as const, label: 'Dealer channel' }] : []),
    ...(can('commission:settle') ? [{ value: 'payouts' as const, label: 'Close & payouts' }] : []),
  ];
  const [tab, setTab] = useState<Tab>('earnings');
  return (
    <>
      <LargeTitle subtitle="Earned on completed orders, taken back when a customer leaves early, settled monthly">Commission</LargeTitle>
      {tabs.length > 1 && <div className="mb-5"><Segmented label="Commission sections" value={tab} onChange={setTab} options={tabs} /></div>}
      {tab === 'earnings' && <Earnings />}
      {tab === 'statements' && <Statements />}
      {tab === 'plans' && <Plans />}
      {tab === 'channel' && <Channel />}
      {tab === 'payouts' && <Payouts />}
    </>
  );
}
