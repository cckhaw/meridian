'use client';
import { Alert, Empty, LargeTitle, SearchField, Spinner } from '@meridian/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useApi } from '@/lib/api';
import { AppearanceSettings } from './appearance';
import { CancellationSettings } from './cancellation';
import { FulfilmentSettings, OfferTypeSettings, ServiceKindSettings } from './catalog-config';
import { BillCycleSettings, CustomerSettings } from './customers';
import { CaseSettings } from './cases';
import { DunningSettings } from './dunning';
import { MarketSettings } from './markets';
import { DonorOperatorSettings } from './donor-operators';
import { NumberingSettings } from './numbering';
import { RegionalSettingsForm } from './regional';
import { GROUPS, SECTIONS, searchSections, sectionById } from './sections';

/**
 * Settings: a menu of sections on the left (grouped, searchable) and the chosen section on the right. On a phone the menu is the first screen and
 * a section slides in over it, like the iOS Settings app. The section is in the address (?section=…) so it can be linked and Back works.
 */
export default function SettingsPage() {
  return <Suspense fallback={<Spinner />}><Settings /></Suspense>;
}

function Settings() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const current = sectionById(sp.get('section'));
  // The store-front moved to the Integration page; old links still land in the right place.
  useEffect(() => {
    if (sp.get('section') === 'storefront') router.replace('/admin/integrations?item=storefront');
    if (sp.get('section') === 'service-kinds') router.replace(`${path}?section=service-types`); // renamed
  }, [sp, router, path]);
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useApi('/settings');
  const open = (id: string | null) => router.push(id ? `${path}?section=${id}` : path, { scroll: false });
  const found = searchSections(q);

  const menu = (
    <nav aria-label="Settings sections" className="space-y-5">
      <SearchField label="Search settings" placeholder="Search settings" value={q} onChange={setQ} />
      {found.length === 0 && <Empty>No setting matches “{q}”.</Empty>}
      {GROUPS.map((g) => {
        const items = found.filter((s) => s.group === g);
        if (!items.length) return null;
        return (
          <div key={g}>
            <h2 className="mb-1.5 px-3 text-footnote font-semibold uppercase tracking-wide text-label2">{g}</h2>
            <ul className="overflow-hidden rounded-card bg-surface shadow-card">
              {items.map((s) => {
                const on = current?.id === s.id;
                return (
                  <li key={s.id} className="border-b border-separator last:border-0">
                    <button onClick={() => open(s.id)} aria-current={on ? 'page' : undefined}
                      className={`flex min-h-[56px] w-full items-center gap-3 px-4 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${on ? 'bg-accent/10' : 'hover:bg-surface2'}`}>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate ${on ? 'font-semibold text-accent' : 'font-medium'}`}>{s.label}</span>
                        <span className="block truncate text-footnote text-label2">{s.description}</span>
                      </span>
                      <span aria-hidden className="text-label2 lg:hidden">›</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  return (
    <>
      <LargeTitle subtitle="Everything that shapes how Meridian behaves for your business. Only the super user can change these; every change is recorded in the audit log.">Settings</LargeTitle>
      {error && <Alert>{error}</Alert>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)] lg:items-start">
        {/* On a phone the menu and the section are separate screens; from lg up they sit side by side. */}
        <div className={`${current ? 'hidden lg:block' : 'block'} lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto`}>{menu}</div>
        <div className={`${current ? 'block' : 'hidden lg:block'} min-w-0`}>
          {current ? (
            <div key={current.id} className="push-fwd">
              <button onClick={() => open(null)} className="mb-3 inline-flex min-h-tap items-center gap-1 text-subhead text-accent lg:hidden"><span aria-hidden>‹</span> Settings</button>
              <header className="mb-4">
                <p className="text-footnote font-medium uppercase tracking-wide text-label2">{current.group}</p>
                <h2 className="text-title1 font-bold tracking-tight">{current.label}</h2>
                <p className="mt-1 text-subhead text-label2">{current.description}</p>
              </header>
              {loading && !data && <Spinner />}
              {data && <Section id={current.id} data={data} reload={reload} />}
            </div>
          ) : (
            <div className="hidden rounded-card bg-surface p-8 text-center text-subhead text-label2 shadow-card lg:block">Choose a setting on the left. {SECTIONS.length} sections in {GROUPS.length} groups; use the search to jump straight to one.</div>
          )}
        </div>
      </div>
    </>
  );
}

function Section({ id, data, reload }: { id: string; data: any; reload: () => void | Promise<void> }) {
  switch (id) {
    case 'regional': return <RegionalSettingsForm initial={data.regional} locked={data.currencyLocked} onSaved={reload} />;
    case 'appearance': return <AppearanceSettings branding={data.branding} themes={data.themes} guidance={data.logoGuidance} faviconGuidance={data.faviconGuidance} onSaved={reload} />;
    case 'customers': return <CustomerSettings />;
    case 'markets': return <MarketSettings />;
    case 'bill-cycles': return <BillCycleSettings />;
    case 'offer-types': return <OfferTypeSettings />;
    case 'fulfilment': return <FulfilmentSettings />;
    case 'service-types': return <ServiceKindSettings />;
    case 'cancellation': return <CancellationSettings />;
    case 'cases': return <CaseSettings />;
    case 'dunning-rules': return <DunningSettings />;
    case 'numbering': return <NumberingSettings />;
    case 'donor-operators': return <DonorOperatorSettings />;
    default: return <Empty>This section is not available yet.</Empty>;
  }
}
