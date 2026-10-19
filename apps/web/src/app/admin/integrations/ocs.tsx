'use client';
import { Alert, Badge, Button, Card, Field, Input, SectionTitle, Select, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { dt } from '@/lib/format';

interface FieldDef { key: string; label: string; kind: 'text' | 'url' | 'number' | 'select' | 'env' | 'commands'; hint?: string; placeholder?: string; required?: boolean; options?: Array<{ value: string; label: string }>; min?: number; max?: number }
interface VendorInfo { id: string; label: string; summary: string; notes: string[]; real: boolean; fields: FieldDef[]; config: Record<string, any>; saved: boolean; envSet: Record<string, boolean> }
interface Job { id: string; createdAt: string; command: string; status: string; attempts: number; nextAttemptAt: string | null; identifier: string; planCode: string | null; reference: string | null; detail: string | null; lastError: string | null; sentAt: string | null }
interface Overview { vendor: string | null; enabled: boolean; vendors: VendorInfo[]; commands: Array<{ id: string; label: string }>; placeholders: string[]; stats: { pending: number; sent: number; skipped: number; dead: number; oldestPendingAt: string | null; unmappedOffers: number; unmappedNames: string[] }; jobs: Job[]; recent: Job[] }

const mono = 'font-mono text-footnote';
const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { SENT: 'success', PENDING: 'warning', DEAD: 'danger', SKIPPED: 'neutral' };
const STATUS_LABEL: Record<string, string> = { SENT: 'Delivered', PENDING: 'Waiting', DEAD: 'Failed', SKIPPED: 'Skipped' };

/** The charging system (OCS): which vendor's connector, its settings, and how delivery is going. The form is drawn from what the connector says it needs. */
export function OcsPanel() {
  const { data, error, loading, reload } = useApi<Overview>('/integrations/ocs');
  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert>{error ?? 'Could not load'}</Alert>;
  return (
    <div className="space-y-5">
      <Connector data={data} reload={reload} />
      <Queue data={data} reload={reload} />
    </div>
  );
}

function Connector({ data, reload }: { data: Overview; reload: () => void }) {
  const [vendor, setVendor] = useState<string>(data.vendor ?? '');
  const [enabled, setEnabled] = useState(data.enabled);
  const [configs, setConfigs] = useState<Record<string, Record<string, any>>>(() => Object.fromEntries(data.vendors.map((v) => [v.id, structuredClone(v.config)])));
  const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null);
  const act = useAction(reload);
  useEffect(() => { setTest(null); }, [vendor]);
  const v = data.vendors.find((x) => x.id === vendor) ?? null;
  const cfg = v ? configs[v.id]! : {};
  const set = (k: string, val: unknown) => setConfigs((c) => ({ ...c, [vendor]: { ...c[vendor], [k]: val } }));
  const setCommand = (id: string, patch: Record<string, string>) => set('commands', { ...cfg.commands, [id]: { method: 'POST', path: '', body: '', ...cfg.commands?.[id], ...patch } });

  return (
    <Card>
      <SectionTitle>Connector</SectionTitle>
      <p className="mb-3 text-footnote text-label2">Each charging-system vendor has its own connector, so Meridian does not depend on any one of them. Pick yours and fill in what it needs.</p>
      <div className="space-y-4">
        <Field label="Charging system">
          <Select value={vendor} onChange={(e) => setVendor(e.target.value)}>
            <option value="">None chosen</option>
            {data.vendors.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </Select>
        </Field>
        {v && (
          <>
            <div className="rounded-control bg-surface2 p-3 text-subhead">
              <p>{v.summary}</p>
              {v.notes.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-footnote text-label2">{v.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {v.fields.filter((f) => f.kind !== 'commands').map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint}>
                  {f.kind === 'select' ? (
                    <Select value={cfg[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>{f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
                  ) : (
                    <>
                      <Input type={f.kind === 'number' ? 'number' : f.kind === 'url' ? 'url' : 'text'} min={f.min} max={f.max} placeholder={f.placeholder} value={cfg[f.key] ?? ''} onChange={(e) => set(f.key, f.kind === 'number' ? Number(e.target.value) : e.target.value)} />
                      {f.kind === 'env' && cfg[f.key] && <div className="mt-1"><Badge tone={v.envSet[cfg[f.key]] ? 'success' : 'warning'}>{v.envSet[cfg[f.key]] ? 'Set on the server' : 'Not set on the server (save to check)'}</Badge></div>}
                    </>
                  )}
                </Field>
              ))}
            </div>
            {v.fields.some((f) => f.kind === 'commands') && (
              <div className="space-y-3">
                <div>
                  <div className="font-medium">Commands</div>
                  <p className="text-footnote text-label2">For each thing Meridian asks the OCS to do, the call to make. Leave the path blank to skip a command. In the path and the body, these fill in per subscriber: {data.placeholders.map((p) => <code key={p} className="mr-1 whitespace-nowrap">{`{{${p}}}`}</code>)}</p>
                </div>
                {data.commands.map((c) => {
                  const cmd = cfg.commands?.[c.id] ?? { method: 'POST', path: '', body: '' };
                  return (
                    <details key={c.id} className="rounded-control border border-separator" open={!!cmd.path && c.id === 'PROVISION'}>
                      <summary className="flex min-h-tap cursor-pointer items-center gap-3 px-3 py-2"><span className="flex-1"><span className="font-medium">{c.id}</span><span className="block text-footnote text-label2">{c.label}</span></span><Badge tone={cmd.path ? 'success' : 'neutral'}>{cmd.path ? 'Defined' : 'Skipped'}</Badge></summary>
                      <div className="grid gap-3 border-t border-separator p-3 sm:grid-cols-[120px_minmax(0,1fr)]">
                        <Field label="Method"><Select value={cmd.method} onChange={(e) => setCommand(c.id, { method: e.target.value })}>{['POST', 'PUT', 'PATCH', 'DELETE', 'GET'].map((m) => <option key={m}>{m}</option>)}</Select></Field>
                        <Field label="Path"><Input className={mono} value={cmd.path} placeholder="/subscribers" onChange={(e) => setCommand(c.id, { path: e.target.value })} /></Field>
                        <div className="sm:col-span-2"><Field label="Request body (JSON)" hint="A value that is exactly one placeholder keeps its type: a number stays a number. Leave empty for none."><textarea className={`min-h-[120px] w-full rounded-control border border-separator bg-surface px-3 py-2 ${mono}`} value={cmd.body} onChange={(e) => setCommand(c.id, { body: e.target.value })} spellCheck={false} /></Field></div>
                      </div>
                    </details>
                  );
                })}
              </div>
            )}
          </>
        )}
        <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={enabled} disabled={!vendor} onChange={(e) => setEnabled(e.target.checked)} /><span><span className="block font-medium">Send provisioning to this charging system</span><span className="text-footnote text-label2">Plans with an OCS plan code are created, changed, barred and closed there. Services that started earlier are not sent unless they change plan.</span></span></label>
        {act.error && <Alert>{act.error}</Alert>}
        {act.ok && <Alert tone="success">{act.ok}</Alert>}
        {test && <Alert tone={test.ok ? 'success' : undefined}>{test.detail}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={act.busy} onClick={() => void act.run(() => post('/integrations/ocs', { vendor: vendor || null, enabled, config: v ? cfg : undefined }), 'Charging system settings saved.')}>{act.busy ? 'Saving…' : 'Save'}</Button>
          {v && <Button type="button" variant="secondary" disabled={act.busy} onClick={async () => { setTest(null); const r = await act.run(() => post('/integrations/ocs/test', { vendor: v.id, config: cfg })); if (r) setTest(r); }}>Test connection</Button>}
        </div>
      </div>
    </Card>
  );
}

function Queue({ data, reload }: { data: Overview; reload: () => void }) {
  const act = useAction(reload);
  const s = data.stats;
  const [ran, setRan] = useState<string | null>(null);
  return (
    <Card>
      <SectionTitle>Delivery</SectionTitle>
      <p className="mb-3 text-footnote text-label2">Jobs for one subscriber are delivered in order. When the OCS is down they are retried (1 min, 5 min, 30 min, 2 h, 12 h); one that still fails is kept here until you retry it. Schedule <code>POST /api/ocs/dispatch</code> every minute.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([['Waiting', s.pending, 'text-warning'], ['Delivered', s.sent, 'text-success'], ['Failed', s.dead, s.dead ? 'text-danger' : 'text-label2'], ['Skipped', s.skipped, 'text-label2']] as const).map(([l, n, t]) => (
          <div key={l} className="rounded-control bg-surface2 p-3"><div className={`text-title2 font-bold tabular-nums ${t}`}>{n}</div><div className="text-footnote text-label2">{l}</div></div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" disabled={act.busy} onClick={async () => { setRan(null); const r = await act.run(() => post('/ocs/dispatch', {})); if (r) setRan(r.notReady ? `Not run: ${r.notReady}` : `Tried ${r.attempted}: ${r.sent} delivered, ${r.skipped} skipped, ${r.retrying} to retry, ${r.dead} failed.`); }}>{act.busy ? 'Working…' : 'Run now'}</Button>
        {ran && <span className="text-subhead text-label2">{ran}</span>}
        {s.oldestPendingAt && <span className="text-footnote text-label2">Oldest waiting since {dt(s.oldestPendingAt)}</span>}
      </div>
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}

      {data.jobs.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1.5 text-footnote font-semibold uppercase tracking-wide text-label2">Failed, needs you</h3>
          <ul className="divide-y divide-separator rounded-control border border-separator">
            {data.jobs.map((j) => (
              <li key={j.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 sm:flex-1"><div className="font-medium">{j.command} <span className="font-normal text-label2">· {j.identifier}{j.planCode ? ` · ${j.planCode}` : ''}</span></div><div className="break-words text-footnote text-danger">{j.lastError}</div><div className="text-caption text-label2">{j.attempts} attempt{j.attempts === 1 ? '' : 's'} · {dt(j.createdAt)}</div></div>
                <Button type="button" variant="secondary" disabled={act.busy} onClick={() => void act.run(() => post(`/integrations/ocs/jobs/${j.id}/retry`, {}), 'Queued to retry.')}>Retry</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.recent.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1.5 text-footnote font-semibold uppercase tracking-wide text-label2">Latest jobs</h3>
          <ul className="divide-y divide-separator text-subhead">
            {data.recent.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"><Badge tone={STATUS_TONE[j.status]}>{STATUS_LABEL[j.status]}</Badge><span className="font-medium">{j.command}</span><span className="text-label2">{j.identifier}{j.planCode ? ` · ${j.planCode}` : ''}</span><span className="text-footnote text-label2 sm:ml-auto">{j.reference ? `${j.reference} · ` : ''}{dt(j.sentAt ?? j.createdAt)}</span></li>
            ))}
          </ul>
        </div>
      )}
      {s.unmappedOffers > 0 && (
        <p className="mt-4 rounded-control bg-warning/10 p-3 text-footnote">
          <strong>{s.unmappedOffers} plan{s.unmappedOffers === 1 ? '' : 's'} on sale {s.unmappedOffers === 1 ? 'has' : 'have'} no OCS plan code</strong> ({s.unmappedNames.join(', ')}{s.unmappedOffers > s.unmappedNames.length ? ', …' : ''}), so customers who buy {s.unmappedOffers === 1 ? 'it are' : 'them are'} not created in the OCS. Add the code when you edit the offer in the <Link href="/catalog" className="text-accent">catalog</Link>.
        </p>
      )}
    </Card>
  );
}
