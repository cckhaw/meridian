'use client';
import { Alert, Badge, Button, Card, DataList, Field, LargeTitle, SectionTitle, Segmented, Spinner } from '@meridian/ui';
import { useEffect, useMemo, useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { dt } from '@/lib/format';
import { ImportPanel } from './import-panel';

interface Entity { rollback?: boolean; id: string; label: string; domain: string; phase: number; description: string; importable: boolean; dependsOn: string[]; version: string; columns: number; required: string[]; note: string | null }
interface Meta { domains: Array<{ id: string; label: string; description: string }>; phases: Array<{ phase: number; label: string }>; entities: Entity[]; canUnmask: boolean; reasonMin: number; canExport: boolean; canImport: boolean }
interface Job { id: string; kind: 'EXPORT' | 'IMPORT'; entity: string | null; entities: string[]; format: string; status: string; masked: boolean; fileName: string | null; rowsTotal: number | null; rowsDone: number; rowsError: number; percent: number; stage: string | null; summary: any; createdBy: string; createdAt: string; finishedAt: string | null }
type Tab = 'export' | 'import' | 'templates' | 'jobs';

const STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  PENDING: { label: 'Waiting', tone: 'neutral' }, VALIDATING: { label: 'Checking', tone: 'warning' }, VALIDATED: { label: 'Checked', tone: 'neutral' }, IMPORTING: { label: 'Loading', tone: 'warning' },
  EXPORTING: { label: 'Exporting', tone: 'warning' }, COMPLETED: { label: 'Done', tone: 'success' }, FAILED: { label: 'Failed', tone: 'danger' }, CANCELLED: { label: 'Cancelled', tone: 'neutral' }, ROLLED_BACK: { label: 'Rolled back', tone: 'danger' },
};
const ACTIVE = ['PENDING', 'VALIDATING', 'IMPORTING', 'EXPORTING'];
const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString());

export default function Migration() {
  const meta = useApi<Meta>('/migration/meta');
  const jobs = useApi<{ items: Job[] }>('/migration/jobs?limit=20');
  const [tab, setTab] = useState<Tab>('export');
  const active = (jobs.data?.items ?? []).some((j) => ACTIVE.includes(j.status));
  useEffect(() => { if (!active) return; const t = setInterval(() => void jobs.reload(), 2000); return () => clearInterval(t); }, [active, jobs]);

  if (meta.loading && !meta.data) return <Spinner />;
  if (meta.error || !meta.data) return <Alert>{meta.error ?? 'Could not load'}</Alert>;
  const m = meta.data;
  return (
    <>
      <LargeTitle subtitle="Move data in and out: export what you need as spreadsheets or JSON, get the exact templates, and load data from another system in phases, checked first and tracked as jobs.">Data migration</LargeTitle>
      <div className="mb-5"><Segmented label="Data migration" value={tab} onChange={setTab} options={[{ value: 'export', label: 'Export' }, ...(m.canImport ? [{ value: 'import' as Tab, label: 'Import' }] : []), { value: 'templates', label: 'Templates' }, { value: 'jobs', label: active ? 'Jobs ●' : 'Jobs' }]} /></div>
      {tab === 'export' && <ExportPanel meta={m} onStarted={() => { void jobs.reload(); }} jobs={jobs.data?.items ?? []} />}
      {tab === 'import' && m.canImport && <ImportPanel entities={m.entities} phases={m.phases} />}
      {tab === 'templates' && <Templates meta={m} />}
      {tab === 'jobs' && <Jobs jobs={jobs.data?.items ?? []} error={jobs.error} loading={jobs.loading && !jobs.data} />}
    </>
  );
}

function ExportPanel({ meta, onStarted, jobs }: { meta: Meta; onStarted: () => void; jobs: Job[] }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<'CSV' | 'JSON'>('CSV');
  const [nest, setNest] = useState(true);
  const [unmasked, setUnmasked] = useState(false);
  const [reason, setReason] = useState('');
  const [limit, setLimit] = useState('');
  const [resume, setResume] = useState<Record<string, string> | null>(null);
  const act = useAction(onStarted);
  const byDomain = useMemo(() => meta.domains.map((d) => ({ ...d, items: meta.entities.filter((e) => e.domain === d.id) })), [meta]);
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleDomain = (ids: string[], on: boolean) => setPicked((s) => { const n = new Set(s); for (const i of ids) { if (on) n.add(i); else n.delete(i); } return n; });
  const last = jobs.find((j) => j.kind === 'EXPORT' && j.status === 'COMPLETED' && j.summary?.partial);

  const start = async (withResume?: Record<string, string>, entities?: string[]) => {
    const body: Record<string, unknown> = { entities: entities ?? [...picked], format, nest, ...(limit ? { maxRowsPerEntity: Number(limit) } : {}), ...(withResume ? { resume: withResume } : {}), ...(unmasked ? { unmasked: true, reason } : {}) };
    const r = await act.run(() => post('/migration/exports', body), 'Export started: your download begins now. Progress is under Jobs.');
    if (r?.downloadUrl) window.location.assign(r.downloadUrl as string);
    if (withResume) setResume(null);
  };

  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle>What to export</SectionTitle>
        <p className="mb-3 text-footnote text-label2">Pick whole domains, or single data sets. In the archive, files are named by the phase they must be loaded in, so loading them in order respects what points at what.</p>
        <div className="space-y-4">
          {byDomain.map((d) => {
            const ids = d.items.map((e) => e.id);
            const all = ids.every((i) => picked.has(i));
            const some = ids.some((i) => picked.has(i));
            return (
              <fieldset key={d.id} className="rounded-control border border-separator p-3">
                <legend className="px-1">
                  <label className="flex min-h-tap items-center gap-3 font-medium"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={all} ref={(el) => { if (el) el.indeterminate = some && !all; }} onChange={(e) => toggleDomain(ids, e.target.checked)} />{d.label}</label>
                </legend>
                <p className="mb-2 text-footnote text-label2">{d.description}</p>
                <ul className="grid gap-1 sm:grid-cols-2">
                  {d.items.map((e) => (
                    <li key={e.id}><label className="flex min-h-[36px] items-start gap-3 py-1"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={picked.has(e.id)} onChange={() => toggle(e.id)} /><span><span className="block">{e.label}</span><span className="block text-caption text-label2">{e.description}</span></span></label></li>
                  ))}
                </ul>
              </fieldset>
            );
          })}
        </div>
      </Card>

      <Card>
        <SectionTitle>Format and protection</SectionTitle>
        <div className="space-y-4">
          <Segmented label="Format" value={format} onChange={setFormat} options={[{ value: 'CSV', label: 'CSV: one flat file per data set' }, { value: 'JSON', label: 'JSON: nested documents' }]} />
          {format === 'JSON' && <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={nest} onChange={(e) => setNest(e.target.checked)} /><span><span className="block">Nest children under their parents</span><span className="text-footnote text-label2">Accounts and services inside each customer, agents inside each dealer, rules inside each commission plan.</span></span></label>}
          <Field label="Rows per data set in this file (optional)" hint="Take a very large table in parts: each part tells you where the next starts."><input type="number" min={1} className="min-h-tap w-48 rounded-control border border-separator bg-surface px-3" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="All rows" /></Field>
          <Alert tone="info">Sensitive fields (ID document references and their hashes, bank account numbers, eSIM activation codes) are <strong>masked</strong> in the file. Login passwords and API keys are never exported.</Alert>
          {meta.canUnmask && (
            <div className="space-y-2 rounded-control border border-warning p-3">
              <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={unmasked} onChange={(e) => setUnmasked(e.target.checked)} /><span><span className="block font-medium">Export sensitive fields unmasked</span><span className="text-footnote text-label2">For a full backup or a cut-over. Super user only. The reason and the data sets are written to the audit log.</span></span></label>
              {unmasked && <Field label={`Why (at least ${meta.reasonMin} characters)`}><input className="min-h-tap w-full rounded-control border border-separator bg-surface px-3" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>}
            </div>
          )}
          {act.error && <Alert>{act.error}</Alert>}
          {act.ok && <Alert tone="success">{act.ok}</Alert>}
          <Button disabled={act.busy || picked.size === 0 || (unmasked && reason.trim().length < meta.reasonMin)} onClick={() => void start()}>{act.busy ? 'Starting…' : `Export ${picked.size || ''} data set${picked.size === 1 ? '' : 's'}`}</Button>
        </div>
      </Card>

      {last && !resume && (
        <Card>
          <SectionTitle>Continue a part</SectionTitle>
          <p className="mb-3 text-subhead text-label2">The last export was taken in parts. {Object.keys(last.summary.resume).length} data set{Object.keys(last.summary.resume).length === 1 ? ' has' : 's have'} more rows after where it stopped.</p>
          <Button variant="secondary" disabled={act.busy} onClick={() => void start(last.summary.resume as Record<string, string>, Object.keys(last.summary.resume))}>Download the next part</Button>
        </Card>
      )}
    </div>
  );
}

function Templates({ meta }: { meta: Meta }) {
  const link = 'inline-flex min-h-tap items-center rounded-control bg-surface2 px-3 text-subhead font-medium text-accent hover:bg-surface2/70';
  return (
    <div className="space-y-5">
      <p className="text-subhead text-label2">A template has the exact header, what each column takes (type, whether it is required, the pattern or values it must match) and example rows as comments. Fill it in and load it in the phase order below; each file says what must be loaded before it.</p>
      {meta.phases.map((p) => {
        const items = meta.entities.filter((e) => e.phase === p.phase);
        return (
          <Card key={p.phase}>
            <SectionTitle>Phase {p.phase}: {p.label}</SectionTitle>
            <DataList label={`Templates, phase ${p.phase}`} rows={items} rowKey={(e: Entity) => e.id}
              columns={[
                { key: 'e', label: 'Data set', primary: true, render: (e: Entity) => <><span className="font-medium">{e.label}</span><span className="block text-footnote text-label2">{e.description}</span>{e.note && <span className="block text-footnote text-label2">{e.note}</span>}</> },
                { key: 'req', label: 'Required', render: (e: Entity) => <span className="font-mono text-caption text-label2">{e.required.join(', ') || '—'}</span> },
                { key: 'dep', label: 'Load first', render: (e: Entity) => <span className="text-footnote text-label2">{e.dependsOn.length ? e.dependsOn.map((d) => meta.entities.find((x) => x.id === d)?.label ?? d).join(', ') : '—'}</span> },
                { key: 'v', label: 'Version', render: (e: Entity) => <span className="font-mono text-caption">{e.version}</span> },
                { key: 'i', label: 'Use', render: (e: Entity) => (e.importable ? <span className="text-footnote text-label2">Export, template and import</span> : <Badge>Export only</Badge>) },
              ]}
              actions={(e: Entity) => (<><a className={link} href={`/api/migration/templates/${e.id}`}>CSV</a><a className={link} href={`/api/migration/templates/${e.id}?format=json`}>JSON</a></>)} />
          </Card>
        );
      })}
    </div>
  );
}

function Jobs({ jobs, error, loading }: { jobs: Job[]; error: string | null; loading: boolean }) {
  if (loading) return <Spinner />;
  if (error) return <Alert>{error}</Alert>;
  if (!jobs.length) return <Card><p className="text-subhead text-label2">No exports or imports yet.</p></Card>;
  return (
    <Card>
      <DataList label="Jobs" rows={jobs} rowKey={(j: Job) => j.id}
        columns={[
          { key: 'what', label: 'Job', primary: true, render: (j: Job) => <><span className="font-medium">{j.kind === 'EXPORT' ? 'Export' : 'Import'} · {j.kind === 'EXPORT' ? `${j.entities.length} data set${j.entities.length === 1 ? '' : 's'}` : j.entity}</span><span className="block text-footnote text-label2">{j.format}{j.kind === 'EXPORT' ? (j.masked ? ', masked' : ', UNMASKED') : j.fileName ? ` · ${j.fileName}` : ''} · {j.createdBy} · {dt(j.createdAt)}</span></> },
          { key: 'st', label: 'Status', render: (j: Job) => <Badge tone={STATUS[j.status]?.tone ?? 'neutral'}>{STATUS[j.status]?.label ?? j.status}</Badge> },
          { key: 'pr', label: 'Progress', render: (j: Job) => (
            <div className="min-w-[120px]"><div className="h-2 overflow-hidden rounded-full bg-surface2"><div className={`h-full ${j.status === 'FAILED' ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${j.percent}%` }} /></div><span className="text-caption text-label2">{j.percent}%{j.stage && ACTIVE.includes(j.status) ? ` · ${j.stage}` : ''}</span></div>) },
          { key: 'rows', label: 'Rows', right: true, render: (j: Job) => <>{num(j.rowsDone)}{j.rowsTotal ? <span className="text-label2"> / ~{num(j.rowsTotal)}</span> : null}{j.rowsError ? <span className="block text-caption text-danger">{num(j.rowsError)} problems</span> : null}</> },
        ]} />
      {jobs.some((j) => j.status === 'FAILED' && j.summary?.error) && <p className="mt-3 text-footnote text-danger">{jobs.find((j) => j.status === 'FAILED' && j.summary?.error)!.summary.error}</p>}
    </Card>
  );
}
