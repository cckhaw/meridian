'use client';
import { Alert, Badge, Button, Card, DataList, Empty, Field, Input, LargeTitle, SectionTitle, Segmented, Select, Spinner, Textarea } from '@meridian/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, dt } from '@/lib/format';

export default function Page() {
  const { can } = useAuth();
  const list = useApi<any[]>(can('billing:template') ? '/billing/templates' : null);
  return (
    <>
      <LargeTitle subtitle="How a customer's bill looks: design it, bring in an old template, and send bills to the print house">Bill templates</LargeTitle>
      <p className="mb-4 text-footnote text-label2"><Link className="text-accent" href="/billing">← Billing</Link></p>
      {can('billing:template') && <Templates list={list} />}
      {can('billing:print') && <Print />}
      {!can('billing:template') && !can('billing:print') && <Alert>Your role does not include bill templates or printing.</Alert>}
    </>
  );
}

function Templates({ list }: { list: ReturnType<typeof useApi<any[]>> }) {
  const router = useRouter();
  const [mode, setMode] = useState<'new' | 'legacy'>('new');
  const [name, setName] = useState('');
  const [format, setFormat] = useState<'HTML' | 'JSON' | 'XML'>('HTML');
  const [content, setContent] = useState('');
  const [res, setRes] = useState<any>(null);
  const act = useAction();
  const create = () => act.run(async () => { const t = await post('/billing/templates', { name }); router.push(`/billing/templates/${t.id}`); });
  const convert = () => act.run(async () => setRes(await post('/billing/templates/convert', { format, content })));
  const save = () => act.run(async () => { const t = await post('/billing/templates/import', { name, format, content }); router.push(`/billing/templates/${t.id}`); });
  return (
    <>
      <SectionTitle>Templates</SectionTitle>
      {list.error && <Alert>{list.error}</Alert>}
      {list.loading && !list.data && <Spinner />}
      {list.data && list.data.length === 0 && <Empty>No template yet. Bills use the layout that comes with the system until you publish one.</Empty>}
      {list.data && list.data.length > 0 && (
        <DataList label="Templates" rows={list.data} rowKey={(t: any) => t.id} columns={[
          { key: 'n', label: 'Name', primary: true, render: (t: any) => <Link className="font-medium text-accent" href={`/billing/templates/${t.id}`}>{t.name}</Link> },
          { key: 'v', label: 'Published', render: (t: any) => (t.version ? `v${t.version}` : 'Draft only') },
          { key: 's', label: 'Made', render: (t: any) => (t.source === 'DESIGNER' ? 'In the designer' : `Converted from ${t.source.replace('LEGACY_', '')}`) },
          { key: 'd', label: '', render: (t: any) => (t.isDefault ? <Badge tone="success">Default</Badge> : null) },
          { key: 'u', label: 'Edited', render: (t: any) => dt(t.updatedAt) },
        ]} />
      )}
      <Card className="mt-4 space-y-3">
        <Segmented label="New template" value={mode} onChange={setMode} options={[{ value: 'new', label: 'Start from the standard layout' }, { value: 'legacy', label: 'Convert an old template' }]} />
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Consumer bill 2026" /></Field>
        {mode === 'legacy' && <>
          <p className="text-subhead text-label2">Paste an HTML/CSS bill, a JSON design or an XML layout. Fields such as <code>{'{{invoice_no}}'}</code>, <code>{'${customer_name}'}</code>, <code>[[total]]</code> and <code>%due_date%</code> are matched to the fields the system knows; anything unknown is shown as «name» so nothing is silently lost.</p>
          <Field label="Format"><Select value={format} onChange={(e) => setFormat(e.target.value as any)}><option>HTML</option><option>JSON</option><option>XML</option></Select></Field>
          <Textarea rows={10} value={content} onChange={(e) => setContent(e.target.value)} className="font-mono text-caption" aria-label="Legacy template" />
          <input type="file" aria-label="Choose a file" accept=".html,.htm,.json,.xml,.txt" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setContent(await f.text()); setFormat(/\.json$/i.test(f.name) ? 'JSON' : /\.xml$/i.test(f.name) ? 'XML' : 'HTML'); if (!name) setName(f.name.replace(/\.\w+$/, '')); } }} />
        </>}
        {act.error && <Alert>{act.error}</Alert>}
        <div className="flex gap-2">
          {mode === 'new' ? <Button disabled={act.busy || !name.trim()} onClick={() => void create()}>Create and design</Button> : <>
            <Button variant="secondary" disabled={act.busy || !content.trim()} onClick={() => void convert()}>Check the conversion</Button>
            <Button disabled={act.busy || !content.trim() || !name.trim()} onClick={() => void save()}>Convert and open in the designer</Button></>}
        </div>
        {res && (
          <div className="space-y-2 text-subhead">
            <Alert tone="success">{res.report.blocks} blocks carried over · {res.report.tokens.mapped.length} fields matched{res.problems.length ? ` · ${res.problems.length} to fix in the designer` : ''}</Alert>
            {res.report.warnings.map((w: string) => <Alert key={w} tone="info">{w}</Alert>)}
            {res.report.unsupported.length > 0 && <Alert tone="danger">Not carried over: {res.report.unsupported.join('; ')}</Alert>}
            {res.report.tokens.unknown.length > 0 && <Alert tone="info">Unknown fields (shown as «name»): {res.report.tokens.unknown.join(', ')}</Alert>}
          </div>)}
      </Card>
    </>
  );
}

function Print() {
  const runs = useApi<any>('/billing/runs?limit=20');
  const jobs = useApi<any[]>('/billing/print/jobs?limit=10');
  const [runId, setRunId] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [batch, setBatch] = useState('500');
  const [color, setColor] = useState('CMYK');
  const [bleed, setBleed] = useState('3');
  const [slug, setSlug] = useState('9');
  const [crop, setCrop] = useState(true);
  const [insert, setInsert] = useState(false);
  const done = (runs.data?.items ?? []).filter((r: any) => r.kind === 'CYCLE' && r.status === 'COMPLETED');
  const ready = runId || (from && to);
  const qs = new URLSearchParams({ ...(runId ? { billRunId: runId } : { from, to }), batchSize: batch, color, bleed, slug, crop: crop ? '1' : '0', insert: insert ? '1' : '0' }).toString();
  return (
    <>
      <SectionTitle>Print-house package</SectionTitle>
      <Card className="space-y-3">
        <p className="text-subhead text-label2">A ZIP with the bills as batch PDFs (trim and bleed boxes, crop marks, optical-mark channels and a barcode on every sheet), the control files the printer&apos;s machines read (<code>.csv</code> and <code>.dat</code>), a list of bills that cannot be mailed, and a manifest with checksums. Uses the default template.</p>
        <div className="form-row">
          <Field label="A completed bill run"><Select value={runId} onChange={(e) => setRunId(e.target.value)}><option value="">— or choose dates —</option>{done.map((r: any) => <option key={r.id} value={r.id}>{d(r.asOf)} · cycle day {r.cycleDay} · {r.billedInvoices} bills</option>)}</Select></Field>
          {!runId && <><Field label="Issued from"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="to"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></>}
        </div>
        <div className="form-row">
          <Field label="Bills per PDF"><Input type="number" min={1} max={5000} value={batch} onChange={(e) => setBatch(e.target.value)} /></Field>
          <Field label="Colour"><Select value={color} onChange={(e) => setColor(e.target.value)}><option>CMYK</option><option>RGB</option></Select></Field>
          <Field label="Bleed mm"><Input type="number" min={0} max={10} value={bleed} onChange={(e) => setBleed(e.target.value)} /></Field>
          <Field label="Slug mm"><Input type="number" min={0} max={20} value={slug} onChange={(e) => setSlug(e.target.value)} /></Field>
        </div>
        <div className="flex flex-wrap gap-4 text-subhead"><label className="flex items-center gap-2"><input type="checkbox" checked={crop} onChange={(e) => setCrop(e.target.checked)} /> Crop marks</label><label className="flex items-center gap-2"><input type="checkbox" checked={insert} onChange={(e) => setInsert(e.target.checked)} /> Paper insert in every envelope</label></div>
        <a href={ready ? `/api/billing/print/package?${qs}` : undefined} aria-disabled={!ready} onClick={() => setTimeout(() => void jobs.reload(), 4000)}
          className={`inline-flex min-h-tap items-center rounded-control px-4 text-subhead font-semibold ${ready ? 'bg-accent text-[rgb(var(--accent-label))]' : 'pointer-events-none bg-surface2 text-label2'}`}>Download package</a>
      </Card>
      {jobs.data && jobs.data.length > 0 && (
        <>
          <SectionTitle>Recent print jobs</SectionTitle>
          <DataList label="Print jobs" rows={jobs.data} rowKey={(j: any) => j.id} columns={[
            { key: 'w', label: 'When', primary: true, render: (j: any) => dt(j.createdAt) },
            { key: 'b', label: 'By', render: (j: any) => j.createdBy },
            { key: 't', label: 'Template', render: (j: any) => `${j.templateName} v${j.templateVersion}` },
            { key: 'i', label: 'Bills', right: true, render: (j: any) => j.invoiceCount.toLocaleString() },
            { key: 'p', label: 'Pages', right: true, render: (j: any) => j.pageCount.toLocaleString() },
            { key: 's', label: 'Status', render: (j: any) => <Badge tone={j.status === 'COMPLETED' ? 'success' : j.status === 'FAILED' ? 'danger' : 'warning'}>{j.status.toLowerCase()}</Badge> },
          ]} />
        </>)}
    </>
  );
}
