'use client';
import { Alert, Badge, Button, Empty, Field, Input, LargeTitle, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useApi, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { label } from '@/lib/format';

interface Check { id: string; title: string; severity: 'ERROR' | 'WARNING' | 'INFO'; description: string; count: number; capped: boolean }
interface Finding { key: string; id: string; name: string; status: string; message: string; related: Array<{ id: string; name: string }>; entity: 'node' | 'bundle_rule' }

const TONE = { ERROR: 'danger', WARNING: 'warning', INFO: 'neutral' } as const;
const GROUPS: Array<{ severity: Check['severity']; title: string }> = [{ severity: 'ERROR', title: 'Fix these' }, { severity: 'WARNING', title: 'Look at these' }, { severity: 'INFO', title: 'For information' }];
const count = (c: Pick<Check, 'count' | 'capped'>) => `${c.count.toLocaleString()}${c.capped ? '+' : ''}`;
const nodeHref = (f: { id: string; entity?: string }) => (f.entity === 'bundle_rule' ? '/catalog/bundles' : `/catalog?node=${encodeURIComponent(f.id)}`);

/**
 * Things in the catalogue that are probably wrong: offers nobody can buy, rules that cannot be met, prices that repeat, go-lives that did not happen. The server finds them
 * in the database one check at a time and pages them, so this works the same with tens of thousands of offers. It only reads; open a finding to fix it in the catalog.
 */
export function CatalogHealth() {
  const { can } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('check');
  const [age, setAge] = useState('30');
  const [near, setNear] = useState('1');
  const opts = `minAgeDays=${encodeURIComponent(age || '30')}&nearPriceBps=${Math.round(Number(near || '1') * 100)}`;
  const summary = useApi<{ cap: number; checks: Check[] }>(can('catalog:write') ? `/catalog/health?${opts}` : null);
  const check = summary.data?.checks.find((c) => c.id === selected) ?? null;
  const findings = usePaged<Finding>(check ? `/catalog/health/${check.id}?limit=50&${opts}` : null);

  if (!can('catalog:write')) return <Alert tone="info">Catalogue health is for people who maintain the catalog.</Alert>;
  const pick = (id: string) => router.replace(`/catalog/health?check=${id}`, { scroll: false });
  const total = summary.data?.checks.filter((c) => c.severity === 'ERROR').reduce((n, c) => n + c.count, 0) ?? 0;
  return (
    <>
      <LargeTitle subtitle="Things in the catalogue that are probably wrong. Nothing here changes by itself: open a finding to fix it.">Catalogue health</LargeTitle>
      <p className="mb-4"><Link href="/catalog" className="text-subhead text-accent">← Back to catalog</Link></p>
      {summary.error && <div className="mb-4"><Alert>{summary.error}</Alert></div>}
      {summary.loading && !summary.data && <Spinner />}
      {summary.data && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] lg:items-start">
          <aside className="min-w-0 space-y-5">
            {total === 0 && <Alert tone="success">No errors found.</Alert>}
            {GROUPS.map((g) => {
              const rows = summary.data!.checks.filter((c) => c.severity === g.severity);
              if (!rows.length) return null;
              return (
                <section key={g.severity}>
                  <h3 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">{g.title}</h3>
                  <ul className="divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
                    {rows.map((c) => (
                      <li key={c.id}>
                        <button type="button" onClick={() => pick(c.id)} aria-current={c.id === selected ? 'true' : undefined}
                          className={`flex min-h-tap w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface2 ${c.id === selected ? 'bg-surface2' : ''}`}>
                          <span className="min-w-0 text-body">{c.title}</span>
                          <Badge tone={c.count === 0 ? 'success' : TONE[c.severity]}>{c.count === 0 ? 'None' : count(c)}</Badge>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            <section className="space-y-3 rounded-card bg-surface p-4 shadow-card">
              <h3 className="text-footnote font-semibold uppercase tracking-wide text-label2">Thresholds</h3>
              <Field label="Never sold: at least this many days old"><Input inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, '').slice(0, 4))} /></Field>
              <Field label="Near-identical prices: within this percent"><Input inputMode="decimal" value={near} onChange={(e) => setNear(e.target.value.replace(/[^\d.]/g, '').slice(0, 5))} /></Field>
              <p className="text-footnote text-label2">Counts stop at {summary.data.cap.toLocaleString()} per check.</p>
            </section>
          </aside>

          <section className="min-w-0" aria-live="polite">
            {!check ? <Empty>Choose a check on the left to see what it found.</Empty> : (
              <>
                <header className="mb-3">
                  <h2 className="text-title2 font-semibold">{check.title} <Badge tone={TONE[check.severity]}>{label(check.severity)}</Badge></h2>
                  <p className="mt-1 text-subhead text-label2">{check.description}</p>
                </header>
                {findings.error && <div className="mb-3"><Alert>{findings.error}</Alert></div>}
                {findings.loading && !findings.items.length && <Spinner />}
                {!findings.loading && !findings.items.length && !findings.error && <Empty>Nothing found.</Empty>}
                {findings.items.length > 0 && (
                  <ul className="divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
                    {findings.items.map((f) => (
                      <li key={f.key} className="px-4 py-3">
                        <p className="flex flex-wrap items-center gap-2">
                          <Link href={nodeHref(f)} className="font-medium text-accent">{f.name}</Link>
                          <Badge tone={f.status === 'ACTIVE' ? 'success' : 'neutral'}>{f.status === 'ACTIVE' ? 'Live' : label(f.status)}</Badge>
                        </p>
                        <p className="mt-0.5 text-subhead text-label2">{f.message}</p>
                        {f.related.length > 0 && (
                          <p className="mt-1 text-footnote text-label2">Also: {f.related.slice(0, 6).map((r, i) => (
                            <span key={r.id}>{i > 0 && ', '}<Link href={nodeHref({ id: r.id })} className="text-accent">{r.name}</Link></span>
                          ))}{f.related.length > 6 && `, and ${f.related.length - 6} more`}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {findings.hasMore && <div className="mt-3"><Button variant="secondary" disabled={findings.loadingMore} onClick={findings.loadMore}>{findings.loadingMore ? 'Loading…' : 'Show more'}</Button></div>}
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
