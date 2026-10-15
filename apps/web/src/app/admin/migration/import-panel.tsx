'use client';
import { Alert, Badge, Button, Card, Field, SectionTitle, Spinner } from '@meridian/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, post, useApi } from '@/lib/api';
import { dt } from '@/lib/format';

interface Entity { id: string; label: string; phase: number; importable: boolean; dependsOn: string[]; rollback?: boolean; note: string | null }
interface Phase { phase: number; label: string }
interface Item { line: number; severity: string; field: string | null; code: string; message: string; pass: string }
interface Job { id: string; entity: string; status: string; fileName: string; percent: number; stage: string | null; rowsTotal: number | null; rowsDone: number; rowsOk: number; rowsError: number; rowsSkipped: number; summary: any; options: any; createdAt: string; waitingFor?: string | null; busy?: boolean; items?: Item[] }

const LIVE = ['PENDING', 'VALIDATING', 'IMPORTING', 'ROLLING_BACK'];
const TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { PENDING: 'neutral', VALIDATING: 'warning', VALIDATED: 'neutral', IMPORTING: 'warning', ROLLING_BACK: 'warning', COMPLETED: 'success', FAILED: 'danger', CANCELLED: 'neutral', ROLLED_BACK: 'danger' };
const LABEL: Record<string, string> = { PENDING: 'Waiting', VALIDATING: 'Checking', VALIDATED: 'Checked', IMPORTING: 'Loading', ROLLING_BACK: 'Taking out', COMPLETED: 'Done', FAILED: 'Failed', CANCELLED: 'Cancelled', ROLLED_BACK: 'Rolled back' };
const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());
const CHUNK = 2 * 1024 * 1024;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Sends a file in pieces (or straight to the object store) and returns the uploads it became. */
async function sendFile(file: File, onProgress: (pct: number) => void): Promise<Array<{ id: string; entity: string | null }>> {
  const up = await post('/migration/uploads', { fileName: file.name, totalBytes: file.size });
  if (up.mode === 'presigned' && up.presigned) {
    await new Promise<void>((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', up.presigned.url);
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.floor((e.loaded / e.total) * 100)); };
      x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`The object store refused the file (${x.status}).`)));
      x.onerror = () => reject(new Error('The upload to the object store failed. Check its cross-origin (CORS) settings allow PUT from this site.'));
      x.send(file);
    });
  } else {
    for (let i = 0; i < up.chunks; i++) {
      const piece = file.slice(i * CHUNK, (i + 1) * CHUNK);
      let tries = 0;
      for (;;) {
        try { await post(`/migration/uploads/${up.id}/chunks/${i}`, { data: toBase64(await piece.arrayBuffer()) }); break; }
        catch (e) { if (++tries >= 3) throw e; await new Promise((r) => setTimeout(r, 800 * tries)); }
      }
      onProgress(Math.floor(((i + 1) / up.chunks) * 100));
    }
  }
  const done = await post(`/migration/uploads/${up.id}/complete`);
  return done.uploads;
}

export function ImportPanel({ entities, phases }: { entities: Entity[]; phases: Phase[] }) {
  const loadable = entities.filter((e) => e.importable);
  const [entity, setEntity] = useState(loadable[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [skip, setSkip] = useState(false);
  const [threshold, setThreshold] = useState('5');
  const [auto, setAuto] = useState(false);
  const [sending, setSending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string[]>([]);
  const list = useApi<{ items: Job[] }>('/migration/jobs?kind=IMPORT&limit=12');
  const def = entities.find((e) => e.id === entity);

  const submit = async () => {
    if (!file) return;
    setError(null); setSending(0);
    try {
      const ups = await sendFile(file, setSending);
      const ids: string[] = [];
      for (const u of ups) {
        const j = await post('/migration/imports', { uploadId: u.id, entity: u.entity ?? entity, ...(skip ? { onError: 'SKIP', errorThresholdPercent: Number(threshold) || 0 } : {}), autoStart: auto });
        ids.push(j.id);
      }
      setMade(ids); setFile(null);
      await list.reload();
    } catch (e) { setError((e as Error).message); }
    finally { setSending(null); }
  };

  const jobs = list.data?.items ?? [];
  const open = jobs.filter((j) => LIVE.includes(j.status) || j.status === 'VALIDATED' || made.includes(j.id));
  const recent = jobs.filter((j) => !open.includes(j)).slice(0, 4);

  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle>Load a file</SectionTitle>
        <p className="mb-3 text-footnote text-label2">Pick the data set, then the file (CSV, JSON, NDJSON or Excel). It is uploaded in pieces, <strong>checked in full without changing anything</strong>, and only loaded when you say so. Load in phase order; a file waits for what it points at.</p>
        <div className="space-y-4">
          <Field label="Data set">
            <select className="min-h-tap w-full rounded-control border border-separator bg-surface px-3" value={entity} onChange={(e) => setEntity(e.target.value)}>
              {phases.map((p) => (
                <optgroup key={p.phase} label={`Phase ${p.phase}: ${p.label}`}>{loadable.filter((e) => e.phase === p.phase).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</optgroup>
              ))}
            </select>
          </Field>
          {def?.note && <p className="text-footnote text-label2">{def.note}</p>}
          {def && def.dependsOn.length > 0 && <p className="text-footnote text-label2">Load first: {def.dependsOn.map((d) => entities.find((x) => x.id === d)?.label ?? d).join(', ')}.</p>}
          <Field label="File" hint="A JSON export with nested records is split into its data sets and loaded in the right order (choose Customers, Dealers or the top-level set).">
            <input type="file" accept=".csv,.txt,.json,.ndjson,.jsonl,.xlsx" className="block min-h-tap w-full text-subhead" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={skip} onChange={(e) => setSkip(e.target.checked)} /><span><span className="block">Skip rows with problems</span><span className="text-footnote text-label2">Off: the file loads only if every row is fine. On: good rows load, bad rows are listed in the report.</span></span></label>
          {skip && <Field label="Stop if more than this percent of rows have problems"><input type="number" min={0} max={100} className="min-h-tap w-32 rounded-control border border-separator bg-surface px-3" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></Field>}
          <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={auto} onChange={(e) => setAuto(e.target.checked)} /><span><span className="block">Load straight after a clean check</span><span className="text-footnote text-label2">Otherwise you review the check and press Load.</span></span></label>
          {error && <Alert>{error}</Alert>}
          {sending !== null && <div><div className="h-2 overflow-hidden rounded-full bg-surface2"><div className="h-full bg-accent" style={{ width: `${sending}%` }} /></div><span className="text-caption text-label2">Uploading {sending}%</span></div>}
          <Button disabled={!file || !entity || sending !== null} onClick={() => void submit()}>{sending !== null ? 'Uploading…' : 'Upload and check'}</Button>
        </div>
      </Card>

      {list.loading && !list.data && <Spinner />}
      {open.map((j) => <JobCard key={j.id} job={j} entities={entities} onChange={() => void list.reload()} />)}
      {recent.length > 0 && (
        <Card>
          <SectionTitle>Recent loads</SectionTitle>
          <ul className="divide-y divide-separator">
            {recent.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-subhead">
                <span><span className="font-medium">{entities.find((e) => e.id === j.entity)?.label ?? j.entity}</span> <span className="text-label2">· {j.fileName} · {dt(j.createdAt)}</span></span>
                <span className="flex items-center gap-2"><span className="text-footnote text-label2">{n(j.rowsOk)} loaded{j.rowsError ? `, ${n(j.rowsError)} problems` : ''}</span><Badge tone={TONE[j.status] ?? 'neutral'}>{LABEL[j.status] ?? j.status}</Badge></span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** One import job: it drives the work while the page is open (each call does up to about 20 seconds), shows the check, and offers the next step. */
function JobCard({ job: first, entities, onChange }: { job: Job; entities: Entity[]; onChange: () => void }) {
  const [job, setJob] = useState<Job>(first);
  const [items, setItems] = useState<Item[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const def = entities.find((e) => e.id === job.entity);

  const refreshItems = useCallback(async (id: string) => {
    try { const d = await api<Job>(`/migration/jobs/${id}`); if (alive.current) { setItems(d.items ?? []); setJob((j) => ({ ...j, ...d })); } } catch { /* shown on the next call */ }
  }, []);

  // Drive the job while it has work: one slice at a time, back to back.
  useEffect(() => {
    if (!LIVE.includes(job.status)) { if (items.length === 0 && (job.rowsError || job.status === 'VALIDATED')) void refreshItems(job.id); return; }
    let stop = false;
    (async () => {
      while (!stop && alive.current) {
        try {
          const r: Job = await post(`/migration/jobs/${job.id}/run`);
          if (stop || !alive.current) return;
          setJob(r); setErr(null);
          if (!LIVE.includes(r.status)) { void refreshItems(job.id); onChange(); return; }
          if (r.busy || r.waitingFor) await new Promise((res) => setTimeout(res, 2500));
        } catch (e) { setErr((e as Error).message); await new Promise((res) => setTimeout(res, 4000)); }
      }
    })();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, LIVE.includes(job.status)]);

  const act = async (path: string, body?: unknown) => {
    setBusy(true); setErr(null);
    try { const r: Job = await post(`/migration/jobs/${job.id}/${path}`, body); setJob((j) => ({ ...j, ...r })); onChange(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const v = job.summary?.validation as { rows: number; ok: number; errors: number; skipped: number; canStart: boolean; reason?: string } | undefined;
  const errorsShown = items.filter((i) => i.severity === 'ERROR').slice(0, 25);

  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div><SectionTitle>{def?.label ?? job.entity}</SectionTitle><p className="-mt-2 text-footnote text-label2">{job.fileName} · {dt(job.createdAt)}</p></div>
        <Badge tone={TONE[job.status] ?? 'neutral'}>{LABEL[job.status] ?? job.status}</Badge>
      </div>
      {(LIVE.includes(job.status) || job.status === 'COMPLETED') && (
        <div className="mb-3">
          <div className="h-2 overflow-hidden rounded-full bg-surface2"><div className="h-full bg-accent transition-[width]" style={{ width: `${job.percent}%` }} /></div>
          <span className="text-caption text-label2">{job.percent}% · {job.stage ?? ''}{job.rowsDone ? ` · ${n(job.rowsDone)}${job.rowsTotal ? ` of ${n(job.rowsTotal)}` : ''} rows` : ''}</span>
        </div>
      )}
      {job.summary?.warnings?.map((w: string) => <Alert key={w} tone="info">{w}</Alert>)}
      {job.summary?.problem && <Alert>{job.summary.problem}</Alert>}
      {err && <Alert>{err}</Alert>}
      {job.status === 'VALIDATED' && v && (
        <div className="space-y-3">
          <p className="text-subhead">Checked <strong>{n(v.rows)}</strong> rows: <strong>{n(v.ok)}</strong> ready to load{v.errors ? <>, <strong className="text-danger">{n(v.errors)}</strong> with problems</> : ''}{v.skipped ? `, ${n(v.skipped)} already loaded earlier` : ''}.</p>
          {v.reason && <Alert tone="info">{v.reason}</Alert>}
          {errorsShown.length > 0 && (
            <div className="overflow-x-auto"><table className="w-full text-footnote"><thead><tr className="text-left text-label2"><th className="py-1 pr-3">Line</th><th className="pr-3">Field</th><th>Problem</th></tr></thead>
              <tbody>{errorsShown.map((i, k) => <tr key={k} className="border-t border-separator"><td className="py-1 pr-3 font-mono">{i.line}</td><td className="pr-3 font-mono">{i.field ?? ''}</td><td>{i.message}</td></tr>)}</tbody></table></div>
          )}
        </div>
      )}
      {job.status === 'COMPLETED' && <p className="text-subhead">Loaded <strong>{n(job.rowsOk)}</strong> rows{job.rowsSkipped ? `, ${n(job.rowsSkipped)} already there` : ''}{job.rowsError ? `, ${n(job.rowsError)} skipped for problems` : ''}.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {job.status === 'VALIDATED' && v?.canStart && <Button disabled={busy} onClick={() => void act('start')}>Load {n(v.ok)} rows</Button>}
        {(job.rowsError > 0 || (v && v.errors > 0)) && <a className="inline-flex min-h-tap items-center rounded-control bg-surface2 px-3 text-subhead font-medium text-accent" href={`/api/migration/jobs/${job.id}/report.csv`}>Download the report</a>}
        {['PENDING', 'VALIDATING', 'VALIDATED', 'IMPORTING'].includes(job.status) && <Button variant="secondary" disabled={busy} onClick={() => { if (confirm('Cancel this job? Rows already loaded stay loaded.')) void act('cancel'); }}>Cancel</Button>}
        {['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status) && def?.rollback && job.rowsOk > 0 && <Button variant="secondary" disabled={busy} onClick={() => { if (confirm(`Take out the ${n(job.rowsOk)} rows this job loaded?`)) void act('rollback', { reason: 'Rolled back from the Import tab' }); }}>Roll back</Button>}
        {['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status) && !def?.rollback && job.rowsOk > 0 && <span className="self-center text-footnote text-label2">This data set cannot be taken out automatically.</span>}
      </div>
    </Card>
  );
}
