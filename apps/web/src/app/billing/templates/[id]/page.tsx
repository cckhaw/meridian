'use client';
import { Alert, Badge, Button, Card, Field, Input, LargeTitle, Select, Spinner, Textarea } from '@meridian/ui';
import Link from 'next/link';
import { use, useEffect, useMemo, useRef, useState } from 'react';
import { post, useAction, useApi, useDebounced } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt } from '@/lib/format';

type Region = 'header' | 'body' | 'footer';
const rid = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const NEW: Record<string, () => any> = {
  heading: () => ({ type: 'heading', text: 'Heading', level: 2 }), text: () => ({ type: 'text', text: 'Hello {{customer.name}}' }),
  image: () => ({ type: 'image', src: 'logo', widthMm: 40 }), band: () => ({ type: 'band', text: '{{company.name}}', heightMm: 12, bg: '#0071e3', color: '#ffffff' }),
  columns: () => ({ type: 'columns', columns: [[{ id: rid(), type: 'text', text: 'Left' }], [{ id: rid(), type: 'text', text: 'Right', style: { align: 'right' } }]] }),
  keyvalue: () => ({ type: 'keyvalue', rows: [{ label: 'Invoice', value: '{{invoice.number}}' }, { label: 'Due', value: '{{invoice.dueDate}}' }] }),
  summary: () => ({ type: 'summary', rows: ['net', 'tax', 'total', 'paid', 'balance'] }), items: () => ({ type: 'items', title: 'Charges', filter: {}, columns: ['description', 'net', 'tax', 'total'], showSubtotal: true, hideIfEmpty: true }),
  qr: () => ({ type: 'qr', value: '{{payment.url}}', sizeMm: 28, caption: 'Scan to pay', hideIfEmpty: true }), barcode: () => ({ type: 'barcode', value: '{{invoice.number}}', heightMm: 10 }),
  terms: () => ({ type: 'terms', title: 'Terms', points: ['Payment is due by the due date.'] }), rule: () => ({ type: 'rule' }), spacer: () => ({ type: 'spacer', heightMm: 6 }), pagebreak: () => ({ type: 'pagebreak' }),
};
const summary = (b: any) => b.text ?? b.title ?? (b.type === 'keyvalue' ? b.rows.map((r: any) => r.label).join(', ') : b.value ?? '') ;

export default function Designer({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();
  const t = useApi(`/billing/templates/${id}`);
  const meta = useApi('/billing/templates/meta');
  const [draft, setDraft] = useState<any>(null);
  const [name, setName] = useState('');
  const [sel, setSel] = useState<{ region: Region; i: number } | null>(null);
  const [print, setPrint] = useState(false);
  const [invoiceId, setInvoiceId] = useState('');
  const [note, setNote] = useState('');
  const [dirty, setDirty] = useState(false);
  const act = useAction(async () => { await t.reload(); });
  useEffect(() => { if (t.data && !draft) { setDraft(t.data.draft); setName(t.data.name); } }, [t.data, draft]);
  const edit = (f: (d: any) => void) => { setDraft((d: any) => { const n = structuredClone(d); f(n); return n; }); setDirty(true); };

  // Live preview: the same engine that makes the PDF draws it, so what is shown is what is printed.
  const stable = useDebounced(draft, 700);
  const [url, setUrl] = useState<string | null>(null), [perr, setPerr] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!stable) return; let off = false; setBusy(true);
    fetch('/api/billing/templates/preview', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template: stable, print, ...(invoiceId.trim() ? { invoiceId: invoiceId.trim() } : {}) }) })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? `Preview failed (${r.status})`); return r.blob(); })
      .then((b) => { if (off) return; const u = URL.createObjectURL(b); if (last.current) URL.revokeObjectURL(last.current); last.current = u; setUrl(u); setPerr(null); })
      .catch((e) => !off && setPerr(e.message)).finally(() => !off && setBusy(false));
    return () => { off = true; };
  }, [stable, print, invoiceId]);

  const block = sel && draft ? draft[sel.region][sel.i] : null;
  const tokens: any[] = meta.data?.tokens ?? [];
  const [json, setJson] = useState('');
  useEffect(() => { setJson(block ? JSON.stringify(block, null, 2) : ''); }, [sel?.region, sel?.i, block?.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [jerr, setJerr] = useState('');
  const canEdit = can('billing:template');

  if (t.error) return <Alert>{t.error}</Alert>;
  if (!draft || !t.data) return <Spinner />;
  const patchBlock = (p: any) => edit((d) => { Object.assign(d[sel!.region][sel!.i], p); });
  const styleOf = (b: any) => b.style ?? {};
  const setStyle = (p: any) => edit((d) => { const b = d[sel!.region][sel!.i]; b.style = { ...(b.style ?? {}), ...p }; });

  return (
    <>
      <LargeTitle subtitle={`Version ${t.data.version || 'not published'}${t.data.isDefault ? ' · default' : ''} · edited ${dt(t.data.updatedAt)} by ${t.data.updatedBy}`}>{t.data.name}</LargeTitle>
      <p className="mb-4 text-footnote text-label2"><Link className="text-accent" href="/billing/templates">← Bill templates</Link></p>
      {t.data.report && <Alert tone="info">Converted from {t.data.source.replace('LEGACY_', '')}: {t.data.report.blocks} blocks carried over{t.data.report.warnings.length > 0 && <> · {t.data.report.warnings.join(' ')}</>}{t.data.report.unsupported.length > 0 && <> · Not carried over: {t.data.report.unsupported.join('; ')}</>}{t.data.report.tokens.unknown.length > 0 && <> · Unknown fields shown as «name»: {t.data.report.tokens.unknown.join(', ')}</>}</Alert>}
      <div className="mt-4 grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-4">
          <Card className="space-y-3">
            <Field label="Name"><Input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} disabled={!canEdit} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Page"><Select value={draft.page.size} onChange={(e) => edit((d) => { d.page.size = e.target.value; })} disabled={!canEdit}>{Object.keys(meta.data?.pageSizes ?? { A4: 1 }).map((s) => <option key={s}>{s}</option>)}</Select></Field>
              <Field label="Colour"><Select value={draft.page.colorMode} onChange={(e) => edit((d) => { d.page.colorMode = e.target.value; })} disabled={!canEdit}><option>RGB</option><option>CMYK</option></Select></Field>
            </div>
            <div className="grid grid-cols-4 gap-2">{(['top', 'right', 'bottom', 'left'] as const).map((k) => <Field key={k} label={k[0]!.toUpperCase() + k.slice(1)}><Input type="number" min={0} max={60} value={draft.page.marginsMm[k]} onChange={(e) => edit((d) => { d.page.marginsMm[k] = Number(e.target.value); })} disabled={!canEdit} /></Field>)}</div>
            <div className="grid grid-cols-2 gap-2">{(['accent', 'text'] as const).map((k) => <Field key={k} label={k === 'accent' ? 'Accent colour' : 'Text colour'}><Input type="color" value={draft.theme[k]} onChange={(e) => edit((d) => { d.theme[k] = e.target.value; })} disabled={!canEdit} /></Field>)}</div>
          </Card>
          {(['header', 'body', 'footer'] as Region[]).map((region) => (
            <Card key={region} className="space-y-2">
              <div className="flex items-center justify-between"><h2 className="text-subhead font-semibold capitalize">{region}{region !== 'body' && <span className="font-normal text-label2"> · every page</span>}</h2>
                {canEdit && <Select aria-label={`Add to ${region}`} value="" onChange={(e) => { const k = e.target.value; if (!k) return; edit((d) => { d[region].push({ id: rid(), ...NEW[k]!() }); }); setSel({ region, i: draft[region].length }); }} className="max-w-[130px]"><option value="">+ Add…</option>{(meta.data?.blockTypes ?? []).map((b: any) => <option key={b.type} value={b.type}>{b.label}</option>)}</Select>}</div>
              {draft[region].length === 0 && <p className="text-footnote text-label2">Nothing here.</p>}
              <ol className="space-y-1">{draft[region].map((b: any, i: number) => {
                const on = sel?.region === region && sel.i === i;
                return <li key={b.id} className={`flex items-center gap-1 rounded-control px-2 py-1 text-footnote ${on ? 'bg-accent/15' : 'bg-surface2'}`}>
                  <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => setSel({ region, i })}><span className="font-medium capitalize">{b.type}</span> <span className="text-label2">{String(summary(b)).slice(0, 28)}</span></button>
                  {canEdit && <>
                    <button type="button" aria-label="Move up" disabled={i === 0} className="px-1 text-label2 disabled:opacity-30" onClick={() => { edit((d) => { [d[region][i - 1], d[region][i]] = [d[region][i], d[region][i - 1]]; }); setSel({ region, i: i - 1 }); }}>↑</button>
                    <button type="button" aria-label="Move down" disabled={i === draft[region].length - 1} className="px-1 text-label2 disabled:opacity-30" onClick={() => { edit((d) => { [d[region][i + 1], d[region][i]] = [d[region][i], d[region][i + 1]]; }); setSel({ region, i: i + 1 }); }}>↓</button>
                    <button type="button" aria-label="Delete" className="px-1 text-danger" onClick={() => { edit((d) => { d[region].splice(i, 1); }); setSel(null); }}>✕</button></>}
                </li>; })}</ol>
            </Card>
          ))}
        </div>

        <div className="space-y-4">
          <Card className="space-y-3">
            <h2 className="text-subhead font-semibold">{block ? <span className="capitalize">{block.type}</span> : 'Select a block'}</h2>
            {!block && <p className="text-footnote text-label2">Pick a block on the left to change its words, size and colour. The page on the right redraws as you type.</p>}
            {block && ['text', 'heading', 'band'].includes(block.type) && <Field label="Text" hint="Use fields such as {{customer.name}}"><Textarea rows={3} value={block.text ?? ''} onChange={(e) => patchBlock({ text: e.target.value })} disabled={!canEdit} /></Field>}
            {block && ['text', 'heading', 'keyvalue'].includes(block.type) && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Size"><Input type="number" min={5} max={48} value={styleOf(block).size ?? ''} onChange={(e) => setStyle({ size: e.target.value ? Number(e.target.value) : undefined })} disabled={!canEdit} /></Field>
                <Field label="Align"><Select value={styleOf(block).align ?? 'left'} onChange={(e) => setStyle({ align: e.target.value })} disabled={!canEdit}><option>left</option><option>center</option><option>right</option></Select></Field>
                <label className="flex items-center gap-2 text-subhead"><input type="checkbox" checked={!!styleOf(block).bold} onChange={(e) => setStyle({ bold: e.target.checked })} disabled={!canEdit} /> Bold</label>
                <Field label="Colour"><Input type="color" value={styleOf(block).color ?? draft.theme.text} onChange={(e) => setStyle({ color: e.target.value })} disabled={!canEdit} /></Field>
              </div>)}
            {block?.type === 'band' && <div className="grid grid-cols-3 gap-2"><Field label="Height mm"><Input type="number" value={block.heightMm} onChange={(e) => patchBlock({ heightMm: Number(e.target.value) })} /></Field><Field label="Fill"><Input type="color" value={block.bg} onChange={(e) => patchBlock({ bg: e.target.value })} /></Field><label className="flex items-center gap-2 pt-6 text-subhead"><input type="checkbox" checked={!!block.bleed} onChange={(e) => patchBlock({ bleed: e.target.checked })} /> Run to edge</label></div>}
            {block?.type === 'image' && <div className="grid grid-cols-2 gap-2"><Field label="Width mm"><Input type="number" value={block.widthMm} onChange={(e) => patchBlock({ widthMm: Number(e.target.value) })} /></Field><Field label="Align"><Select value={block.align ?? 'left'} onChange={(e) => patchBlock({ align: e.target.value })}><option>left</option><option>center</option><option>right</option></Select></Field></div>}
            {block && ['spacer'].includes(block.type) && <Field label="Height mm"><Input type="number" value={block.heightMm} onChange={(e) => patchBlock({ heightMm: Number(e.target.value) })} /></Field>}
            {block?.type === 'items' && <>
              <Field label="Title"><Input value={block.title} onChange={(e) => patchBlock({ title: e.target.value })} /></Field>
              <Field label="Shows"><Select value={block.filter.streams?.[0] ?? ''} onChange={(e) => patchBlock({ filter: e.target.value ? { streams: [e.target.value] } : {} })}><option value="">Every charge</option>{Object.entries(meta.data?.streams ?? {}).map(([k, v]) => <option key={k} value={k}>{String(v)}</option>)}</Select></Field>
              <div className="flex flex-wrap gap-3 text-subhead">{['description', 'service', 'net', 'tax', 'total'].map((c) => <label key={c} className="flex items-center gap-1"><input type="checkbox" checked={block.columns.includes(c)} onChange={(e) => patchBlock({ columns: ['description', 'service', 'net', 'tax', 'total'].filter((x) => (x === c ? e.target.checked : block.columns.includes(x))) })} />{c}</label>)}</div></>}
            {block?.type === 'summary' && <div className="flex flex-wrap gap-3 text-subhead">{['net', 'tax', 'total', 'paid', 'credited', 'balance', 'due'].map((c) => <label key={c} className="flex items-center gap-1"><input type="checkbox" checked={block.rows.includes(c)} onChange={(e) => patchBlock({ rows: ['net', 'tax', 'total', 'paid', 'credited', 'balance', 'due'].filter((x) => (x === c ? e.target.checked : block.rows.includes(x))) })} />{c}</label>)}</div>}
            {block && ['qr', 'barcode'].includes(block.type) && <Field label="Value" hint="A field such as {{payment.url}}"><Input value={block.value} onChange={(e) => patchBlock({ value: e.target.value })} /></Field>}
            {block?.type === 'terms' && <Field label="Points (one per line)"><Textarea rows={5} value={block.points.join('\n')} onChange={(e) => patchBlock({ points: e.target.value.split('\n').filter(Boolean) })} /></Field>}
            {block && (
              <details><summary className="cursor-pointer text-footnote text-accent">Everything about this block (advanced)</summary>
                <Textarea rows={10} className="mt-2 font-mono text-caption" value={json} onChange={(e) => setJson(e.target.value)} disabled={!canEdit} />
                {jerr && <p className="text-footnote text-danger">{jerr}</p>}
                <Button variant="secondary" className="mt-2" disabled={!canEdit} onClick={() => { try { const v = JSON.parse(json); if (!v.type) throw new Error('A block needs a type.'); edit((d) => { d[sel!.region][sel!.i] = { ...v, id: block.id }; }); setJerr(''); } catch (e) { setJerr((e as Error).message); } }}>Apply</Button></details>)}
          </Card>
          <Card className="space-y-2">
            <h2 className="text-subhead font-semibold">Fields you can use</h2>
            <p className="text-footnote text-label2">Type these inside any text. They are filled in for each customer.</p>
            <div className="flex max-h-48 flex-wrap gap-1 overflow-auto">{tokens.map((k) => <button key={k.token} type="button" title={`${k.label} · e.g. ${String(k.sample).split('\n')[0]}`} className="rounded-full bg-surface2 px-2 py-0.5 font-mono text-caption" onClick={() => void navigator.clipboard?.writeText(`{{${k.token}}}`)}>{`{{${k.token}}}`}</button>)}</div>
            <p className="text-caption text-label2">Click to copy.</p>
          </Card>
        </div>

        <div className="space-y-3">
          <Card className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex items-center gap-2 text-subhead"><input type="checkbox" checked={print} onChange={(e) => setPrint(e.target.checked)} /> Print view (bleed, crop marks, marks)</label>
              <Field label="Preview with invoice id (optional)"><Input value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} placeholder="sample data" className="font-mono" /></Field>
            </div>
            {perr ? <Alert>{perr}</Alert> : <div className="relative h-[70vh] min-h-[420px] overflow-hidden rounded-card bg-surface2">{url ? <iframe title="Bill preview" src={`${url}#toolbar=0&navpanes=0`} className="h-full w-full" /> : <Spinner />}{busy && <span className="absolute right-3 top-3 rounded-full bg-surface px-2 py-0.5 text-caption text-label2">Redrawing…</span>}</div>}
            {url && <a className="text-footnote text-accent" href={url} target="_blank" rel="noreferrer">Open the preview in its own tab (also if your browser does not show PDFs here)</a>}
          </Card>
          {canEdit && (
            <Card className="space-y-3">
              {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
              <div className="flex flex-wrap gap-2">
                <Button disabled={act.busy || !dirty} onClick={() => act.run(async () => { await post(`/billing/templates/${id}/save`, { name, template: draft }); setDirty(false); }, 'Draft saved')}>Save draft</Button>
                {t.data.isDefault ? <Badge tone="success">Default</Badge> : t.data.version > 0 && <Button variant="secondary" disabled={act.busy || dirty} onClick={() => act.run(() => post(`/billing/templates/${id}/default`), 'Now the default')}>Make default</Button>}
              </div>
              <div className="flex flex-wrap items-end gap-2"><Field label="Publish as the next version" hint="Bills already sent keep the version they were drawn with."><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed (optional)" /></Field>
                <Button variant="secondary" disabled={act.busy || dirty} onClick={() => act.run(() => post(`/billing/templates/${id}/publish`, { note }), 'Published')}>Publish v{t.data.version + 1}</Button></div>
              {dirty && <p className="text-footnote text-label2">Save the draft before publishing.</p>}
              {t.data.versions?.length > 0 && <p className="text-footnote text-label2">Published: {t.data.versions.map((v: any) => `v${v.version} (${dt(v.publishedAt)})`).join(' · ')}</p>}
            </Card>)}
        </div>
      </div>
    </>
  );
}
