'use client';
import { Alert, Badge, Button, Card, Field, Input, SectionTitle, Select, Textarea } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { dt, label } from '@/lib/format';

const FORMAT_BY_EXT: Record<string, 'CSV' | 'GEOJSON' | 'KML'> = { csv: 'CSV', geojson: 'GEOJSON', json: 'GEOJSON', kml: 'KML' };
const download = (name: string, text: string, type: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); URL.revokeObjectURL(a.href); };

export function ImportPanel() {
  const providers = useApi<{ items: any[] }>('/admin/providers');
  const jobs = useApi<{ items: any[] }>('/admin/import/jobs');
  const templates = useApi<Record<string, string>>('/admin/import/templates');
  const act = useAction(jobs.reload);
  const [format, setFormat] = useState<'CSV' | 'GEOJSON' | 'KML'>('CSV');
  const [provider, setProvider] = useState('');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<any>(null);
  const run = async (apply: boolean) => { const r = await act.run(() => post('/admin/import', { format, text, provider: provider || undefined, apply }), apply ? undefined : undefined); if (r) setReport({ ...r, ranAs: apply ? 'load' : 'check' }); };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (FORMAT_BY_EXT[ext]) setFormat(FORMAT_BY_EXT[ext]!);
    setFileName(f.name); setText(await f.text()); setReport(null);
  };
  const s = report?.summary;
  return (
    <div className="grid gap-5 [&>*]:min-w-0">
      <Card>
        <h2 className="text-title3 font-semibold">Load coverage from a file</h2>
        <p className="mt-1 text-subhead text-label2">CSV, GeoJSON or KML, as wholesale partners send them. Points become distribution points, areas become coverage polygons, and an address CSV fills the address book. Run a check first: it reports every problem by row and changes nothing. A file with any problem loads nothing.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Format"><Select value={format} onChange={(e) => setFormat(e.target.value as 'CSV')}><option value="CSV">CSV (points or addresses)</option><option value="GEOJSON">GeoJSON</option><option value="KML">KML</option></Select></Field>
          <Field label="Provider" hint="For rows that name none."><Select value={provider} onChange={(e) => setProvider(e.target.value)}><option value="">From the file</option>{(providers.data?.items ?? []).map((p) => <option key={p.id} value={p.code}>{p.name}</option>)}</Select></Field>
          <Field label="File"><Input type="file" accept=".csv,.geojson,.json,.kml" onChange={(e) => void onFile(e.target.files?.[0])} /></Field>
        </div>
        <div className="mt-3"><Field label={fileName ? `Contents of ${fileName}` : 'Or paste the contents'}><Textarea rows={7} className="font-mono text-footnote" value={text} onChange={(e) => { setText(e.target.value); setReport(null); }} /></Field></div>
        <div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" disabled={act.busy || !text.trim()} onClick={() => void run(false)}>Check the file</Button><Button disabled={act.busy || !text.trim() || report?.ranAs !== 'check' || report.errors.length > 0} onClick={() => void run(true)}>Load it</Button></div>
        {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
        {report && (
          <div className="mt-4 space-y-2">
            {report.errors.length === 0 ? <Alert tone={report.applied ? 'success' : 'info'}>{report.applied ? 'Loaded.' : 'The file is fine. Press Load it to apply it.'} {s.dps.create + s.dps.update} distribution point{s.dps.create + s.dps.update === 1 ? '' : 's'} ({s.dps.create} new, {s.dps.update} updated), {s.areas.create + s.areas.update} area{s.areas.create + s.areas.update === 1 ? '' : 's'} ({s.areas.create} new, {s.areas.update} updated), {s.addresses.create + s.addresses.update} address{s.addresses.create + s.addresses.update === 1 ? '' : 'es'}.</Alert>
              : <Alert>Nothing was loaded. {report.errors.length} problem{report.errors.length === 1 ? '' : 's'}:</Alert>}
            {report.errors.length > 0 && <ul className="max-h-60 list-disc space-y-1 overflow-auto rounded-control bg-surface2 py-3 pl-8 pr-3 text-footnote">{report.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>}
          </div>)}
      </Card>
      <section aria-label="Templates">
        <SectionTitle>Templates</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!templates.data} onClick={() => download('distribution-points.csv', templates.data!.dps!, 'text/csv')}>Distribution points (CSV)</Button>
          <Button variant="secondary" disabled={!templates.data} onClick={() => download('addresses.csv', templates.data!.addresses!, 'text/csv')}>Addresses (CSV)</Button>
          <Button variant="secondary" disabled={!templates.data} onClick={() => download('coverage.geojson', templates.data!.geojson!, 'application/geo+json')}>Areas and points (GeoJSON)</Button>
        </div>
        <p className="mt-2 text-footnote text-label2">Sending the same file again updates what is there (points are matched by provider and code, areas by provider and name) instead of duplicating it.</p>
      </section>
      <section aria-label="Recent imports">
        <SectionTitle>Recent imports</SectionTitle>
        {(jobs.data?.items ?? []).length === 0 ? <p className="text-subhead text-label2">None yet.</p> : (
          <ul className="divide-y divide-separator rounded-card bg-surface px-4 shadow-card">{jobs.data!.items.map((j) => <li key={j.id} className="flex flex-wrap items-center gap-3 py-2 text-subhead"><Badge tone={j.status === 'APPLIED' ? 'success' : j.status === 'FAILED' ? 'danger' : 'neutral'}>{label(j.status)}</Badge><span className="font-medium">{j.format}</span><span className="text-label2">{j.summary?.dps ? `${j.summary.dps.create + j.summary.dps.update} DPs, ${j.summary.areas.create + j.summary.areas.update} areas, ${j.summary.addresses.create + j.summary.addresses.update} addresses` : ''}</span><span className="ml-auto text-footnote text-label2">{j.createdBy} · {dt(j.createdAt)}</span></li>)}</ul>)}
      </section>
    </div>
  );
}
