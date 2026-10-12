'use client';
import { Alert, Card, LargeTitle, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { useApi } from '@/lib/api';
import { AppearanceSettings } from './appearance';
import { RegionalSettingsForm } from './regional';

const TABS = [['regional', 'Regional'], ['appearance', 'Appearance']] as const;

export default function SettingsPage() {
  const { data, error, loading, reload } = useApi('/settings');
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('regional');
  return (
    <>
      <LargeTitle subtitle="Currency, number and date formats, and how the portal looks. Only the super user can change these.">Settings</LargeTitle>
      <div role="tablist" aria-label="Settings sections" className="mb-5 flex gap-1 overflow-x-auto rounded-control bg-surface2 p-1">
        {TABS.map(([id, name]) => (
          <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} onClick={() => setTab(id)}
            className={`min-h-[40px] flex-1 whitespace-nowrap rounded-[10px] px-4 text-subhead font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${tab === id ? 'bg-surface text-label shadow-card' : 'text-label2 hover:text-label'}`}>{name}</button>
        ))}
      </div>
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && (
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'regional' && <RegionalSettingsForm initial={data.regional} locked={data.currencyLocked} onSaved={reload} />}
          {tab === 'appearance' && <AppearanceSettings branding={data.branding} themes={data.themes} guidance={data.logoGuidance} onSaved={reload} />}
        </div>
      )}
      {data && <Card><p className="text-footnote text-label2">Changes are recorded in the audit log and apply to everyone straight away.</p></Card>}
    </>
  );
}
