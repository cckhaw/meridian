'use client';
import { Alert, Badge, Button, Card, Field, Input, LargeTitle, Modal, Segmented, Select, Spinner } from '@meridian/ui';
import { useMemo, useRef, useState } from 'react';
import { patch, post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label } from '@/lib/format';
import { RichEditor, type EditorApi } from './rich-editor';

const CATEGORY: Record<string, string> = { SUBSCRIBER_AGREEMENT: 'Subscriber agreement', FAIR_USAGE: 'Fair usage policy', DEVICE_INSTALMENT: 'Device instalment terms', PLAN_CHANGE: 'Plan change', OTHER: 'Other' };
const CONTEXT: Record<string, string> = { ORDER: 'New orders', PLAN_CHANGE: 'Plan changes' };
const prose = '[&_h1]:mb-2 [&_h1]:text-title3 [&_h1]:font-bold [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-headline [&_h2]:font-semibold [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_td]:border [&_td]:border-separator [&_td]:p-1 [&_th]:border [&_th]:border-separator [&_th]:p-1 [&_blockquote]:border-l-4 [&_blockquote]:pl-3 [&_[data-align=center]]:text-center [&_[data-align=right]]:text-right';

/** Settings → Document templates: write the agreements customers sign, version them, and publish. */
export default function DocumentTemplates() {
  const { can } = useAuth();
  const list = useApi<{ items: any[] }>(can('document:template') ? '/documents/templates' : null);
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const act = useAction(async () => { await list.reload(); });
  if (!can('document:template')) return <Alert>Writing agreement templates needs the "Write agreement templates" permission.</Alert>;
  const items = list.data?.items ?? [];
  const current = sel ?? items[0]?.id ?? null;
  return (
    <>
      <LargeTitle subtitle="The terms customers read and sign when they order or change plan. Each published version is kept; a signed agreement always shows the version it was signed on.">Document templates</LargeTitle>
      {list.error && <Alert>{list.error}</Alert>}
      {list.loading && !list.data && <Spinner />}
      {list.data && (
        <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
          <aside aria-label="Templates" className="space-y-2">
            <Button className="w-full" onClick={() => setCreating(true)}>New template</Button>
            {items.length === 0 && <Card><p className="text-subhead text-label2">No templates yet. Start from the standard set, or write your own.</p><Button className="mt-3 w-full" variant="secondary" disabled={act.busy} onClick={() => void act.run(() => post('/documents/templates/starter'), 'Added')}>Add the standard templates</Button></Card>}
            {items.map((t) => (
              <button key={t.id} type="button" onClick={() => setSel(t.id)} aria-current={t.id === current}
                className={`w-full rounded-card border bg-surface p-3 text-left shadow-card ${t.id === current ? 'border-accent ring-2 ring-accent' : 'border-transparent'}`}>
                <span className="block font-medium">{t.name}</span>
                <span className="mt-1 flex flex-wrap items-center gap-1 text-footnote text-label2">
                  <Badge tone={t.activeVersion ? 'success' : 'warning'}>{t.activeVersion ?? 'Not published'}</Badge>
                  {t.hasDraft && t.activeVersion && <Badge tone="warning">Draft</Badge>}
                  {t.status === 'INACTIVE' && <Badge>Switched off</Badge>}
                  <span>{CATEGORY[t.category]}</span>
                </span>
                <span className="mt-1 block text-caption text-label2">{(t.contexts as string[]).map((c) => CONTEXT[c] ?? c).join(' · ')}{t.offerKinds.length ? ` · ${t.offerKinds.length} offer type${t.offerKinds.length === 1 ? '' : 's'}` : ' · every offer'}</span>
              </button>
            ))}
          </aside>
          {current && <TemplateWorkbench key={current} id={current} onChanged={() => void list.reload()} />}
        </div>
      )}
      {creating && <NewTemplate onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); setSel(id); void list.reload(); }} />}
    </>
  );
}

function NewTemplate({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const meta = useApi<any>('/documents/tokens');
  const [f, setF] = useState({ name: '', category: 'SUBSCRIBER_AGREEMENT', description: '' });
  const { run, busy, error } = useAction();
  return (
    <Modal title="New template" onClose={onClose}>
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => post('/documents/templates', { ...f, contexts: f.category === 'PLAN_CHANGE' ? ['PLAN_CHANGE'] : ['ORDER'] })); if (r) onDone(r.id); }}>
        <Field label="Name"><Input required maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Kind"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{(meta.data?.categories ?? Object.keys(CATEGORY)).map((c: string) => <option key={c} value={c}>{CATEGORY[c] ?? label(c)}</option>)}</Select></Field>
        <Field label="What it is for (optional)"><Input maxLength={300} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !f.name.trim()}>Create</Button></div>
      </form>
    </Modal>
  );
}

function TemplateWorkbench({ id, onChanged }: { id: string; onChanged: () => void }) {
  const tpl = useApi<any>(`/documents/templates/${id}`);
  const tokens = useApi<any>('/documents/tokens');
  const [tab, setTab] = useState<'edit' | 'preview' | 'history' | 'rules'>('edit');
  const [html, setHtml] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<{ errors: string[]; warnings: string[] } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const editor = useRef<EditorApi | null>(null);
  const act = useAction(async () => { await tpl.reload(); onChanged(); });
  const t = tpl.data;
  const working = t ? (t.draft ?? t.active) : null;
  const initial = working?.html ?? '';
  const current = html ?? initial;
  const dirty = html !== null && html !== initial;
  const groups = useMemo(() => { const g: Record<string, any[]> = {}; for (const k of tokens.data?.tokens ?? []) (g[k.group] ??= []).push(k); return g; }, [tokens.data]);
  if (tpl.error) return <Alert>{tpl.error}</Alert>;
  if (!t) return <Spinner />;
  const check = async (h: string) => { const r = await post('/documents/templates/preview', { html: h }); setProblems({ errors: r.errors, warnings: r.warnings }); return r; };
  const save = () => act.run(async () => { const r = await post(`/documents/templates/${id}/draft`, { html: current, note }); setHtml(null); await check(current); return r; }, 'Draft saved');
  const showPreview = async () => { setTab('preview'); setPreview(null); try { setPreview((await check(current)).html); } catch (e) { setPreview(`<p>${(e as Error).message}</p>`); } };
  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-title3 font-semibold">{t.name}</h2><p className="text-subhead text-label2">{CATEGORY[t.category]} · code <span className="font-mono">{t.code}</span>{t.description ? ` · ${t.description}` : ''}</p></div>
          <div className="flex flex-wrap items-center gap-2">
            {t.activeVersion ? <Badge tone="success">Live: {t.activeVersion}</Badge> : <Badge tone="warning">Not published</Badge>}
            {t.draft && <Badge tone="warning">Unpublished changes</Badge>}
          </div>
        </div>
        <div className="mt-4"><Segmented label="View" value={tab} options={[{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }, { value: 'history', label: 'Versions' }, { value: 'rules', label: 'Where it applies' }]} onChange={(v) => { if (v === 'preview') void showPreview(); else setTab(v); }} /></div>
      </Card>

      {tab === 'edit' && (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Add a detail from the order"><Select value="" onChange={(e) => { if (e.target.value) editor.current?.insertText(`{{${e.target.value}}}`); }}>
              <option value="">Insert a token…</option>
              {Object.entries(groups).map(([g, ks]) => <optgroup key={g} label={g}>{ks.map((k) => <option key={k.key} value={k.key}>{k.label}  ({`{{${k.key}}}`})</option>)}</optgroup>)}
            </Select></Field>
            <p className="pb-3 text-footnote text-label2">Tokens are replaced with the customer's and order's own details when the agreement is shown and signed.</p>
          </div>
          <RichEditor value={initial} resetKey={`${id}:${working?.id}:${working?.status}`} onChange={setHtml} apiRef={editor} />
          {problems?.errors.map((m) => <Alert key={m}>{m}</Alert>)}
          {problems?.warnings.map((m) => <Alert key={m} tone="info">{m}</Alert>)}
          <Field label="What changed (shown in the version history)"><Input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Clarified the early termination wording" /></Field>
          {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={act.busy || (!dirty && !!t.draft)} onClick={() => void save()}>{act.busy ? 'Saving…' : 'Save draft'}</Button>
            <Button variant="secondary" disabled={act.busy || dirty || (!t.draft)} onClick={() => setPublishing(true)} title={dirty ? 'Save the draft first' : undefined}>Publish…</Button>
            {t.draft && t.activeVersion && <Button variant="plain" disabled={act.busy} onClick={() => void act.run(async () => { await post(`/documents/templates/${id}/discard-draft`); setHtml(null); }, 'Draft discarded')}>Discard changes</Button>}
          </div>
        </Card>
      )}

      {tab === 'preview' && (
        <Card>
          <p className="mb-3 text-footnote text-label2">With sample details. The signature appears where <span className="font-mono">{'{{signature.customerImage}}'}</span> is.</p>
          {!preview && <Spinner />}
          {preview && <div className={`rounded-control border border-separator bg-white p-6 text-subhead text-black ${prose}`} dangerouslySetInnerHTML={{ __html: preview }} />}
        </Card>
      )}

      {tab === 'history' && <History t={t} />}

      {tab === 'rules' && <Rules t={t} offerTypes={tokens.data?.offerTypes ?? []} onSaved={() => { void tpl.reload(); onChanged(); }} />}

      {publishing && <Publish t={t} note={note} onClose={() => setPublishing(false)} onDone={() => { setPublishing(false); setNote(''); setHtml(null); void tpl.reload(); onChanged(); }} />}
    </div>
  );
}

function Publish({ t, note, onClose, onDone }: { t: any; note: string; onClose: () => void; onDone: () => void }) {
  const first = !t.activeVersion;
  const [bump, setBump] = useState<'minor' | 'major'>('minor');
  const [n, setN] = useState(note);
  const { run, busy, error } = useAction(onDone);
  const live = t.versions.find((v: any) => v.status === 'PUBLISHED');
  const next = first ? 'v1.0' : bump === 'major' ? `v${(live?.major ?? 1) + 1}.0` : `v${live?.major}.${(live?.minor ?? 0) + 1}`;
  return (
    <Modal title={`Publish ${next}`} onClose={onClose}>
      <div className="space-y-4">
        {!first && <Field label="What kind of change is it?" hint="A major change is something new the customer agrees to. A minor one is wording or a correction."><Segmented label="Change" value={bump} options={[{ value: 'minor', label: 'Minor (wording)' }, { value: 'major', label: 'Major (new terms)' }]} onChange={setBump} /></Field>}
        <Field label="Note"><Input maxLength={300} value={n} onChange={(e) => setN(e.target.value)} /></Field>
        <p className="rounded-control bg-surface2 p-3 text-subhead">From now on every new order or plan change that needs this agreement signs <strong>{next}</strong>. {live ? `${live.version} stays on everything already signed with it.` : ''}</p>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void run(() => post(`/documents/templates/${t.id}/publish`, { bump: first ? undefined : bump, note: n }), 'Published')}>{busy ? 'Publishing…' : `Publish ${next}`}</Button></div>
      </div>
    </Modal>
  );
}

function History({ t }: { t: any }) {
  const versions: any[] = t.versions;
  const [a, setA] = useState<string>(versions[1]?.id ?? '');
  const [b, setB] = useState<string>(versions[0]?.id ?? '');
  const diff = useApi<any>(a && b && a !== b ? `/documents/templates/compare?from=${a}&to=${b}` : null);
  const opts = versions.map((v) => <option key={v.id} value={v.id}>{v.version}{v.status === 'DRAFT' ? ' (draft)' : ''}</option>);
  return (
    <Card className="space-y-4">
      <ul className="divide-y divide-separator">
        {versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-2 py-2 text-subhead">
            <span className="w-16 font-mono font-semibold">{v.version}</span>
            <Badge tone={v.status === 'PUBLISHED' ? 'success' : v.status === 'DRAFT' ? 'warning' : 'neutral'}>{label(v.status)}</Badge>
            <span className="text-label2">{v.publishedAt ? `${dt(v.publishedAt)} by ${v.publishedBy}` : `edited ${dt(v.createdAt)} by ${v.createdBy}`}</span>
            {v.note && <span className="text-label2">· {v.note}</span>}
            <span className="ml-auto text-footnote text-label2">{v.signedDocuments ? `${v.signedDocuments.toLocaleString()} signed` : ''}</span>
          </li>
        ))}
      </ul>
      {versions.length > 1 && (
        <div>
          <h3 className="mb-2 text-headline font-semibold">Compare</h3>
          <div className="mb-3 flex flex-wrap items-end gap-3"><Field label="From"><Select value={a} onChange={(e) => setA(e.target.value)}>{opts}</Select></Field><Field label="To"><Select value={b} onChange={(e) => setB(e.target.value)}>{opts}</Select></Field></div>
          {diff.loading && <Spinner />}
          {diff.error && <Alert>{diff.error}</Alert>}
          {diff.data && (
            <div className="rounded-control border border-separator p-3 text-subhead">
              <p className="mb-2 text-footnote text-label2">{diff.data.from} → {diff.data.to}: {diff.data.added} added, {diff.data.removed} removed</p>
              {diff.data.lines.map((l: any, i: number) => <p key={i} className={`whitespace-pre-wrap py-0.5 ${l.op === 'add' ? 'bg-success/10 text-success' : l.op === 'del' ? 'bg-danger/10 text-danger line-through' : 'text-label2'}`}><span aria-hidden className="mr-2 font-mono">{l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' '}</span>{l.text}</p>)}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Rules({ t, offerTypes, onSaved }: { t: any; offerTypes: Array<{ id: string; name: string }>; onSaved: () => void }) {
  const [v, setV] = useState({ name: t.name as string, description: t.description as string, category: t.category as string, contexts: t.contexts as string[], offerKinds: t.offerKinds as string[], status: t.status as string });
  const { run, busy, error, ok } = useAction(onSaved);
  const toggle = (k: 'contexts' | 'offerKinds', x: string) => setV((s) => ({ ...s, [k]: s[k].includes(x) ? s[k].filter((y) => y !== x) : [...s[k], x] }));
  return (
    <Card className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={v.name} maxLength={80} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Kind"><Select value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>{Object.entries(CATEGORY).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</Select></Field>
        <div className="sm:col-span-2"><Field label="Description"><Input value={v.description} maxLength={300} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field></div>
      </div>
      <fieldset><legend className="mb-1 text-subhead font-medium">Signed when</legend>
        <div className="flex flex-wrap gap-4">{Object.entries(CONTEXT).map(([k, n]) => <label key={k} className="flex min-h-tap items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={v.contexts.includes(k)} onChange={() => toggle('contexts', k)} />{n}</label>)}</div></fieldset>
      <fieldset><legend className="mb-1 text-subhead font-medium">Offer types it applies to</legend>
        <p className="mb-2 text-footnote text-label2">None ticked means every offer. Tick types to limit it, for example device terms only for plans with a device.</p>
        <div className="flex flex-wrap gap-x-5 gap-y-1">{offerTypes.map((o) => <label key={o.id} className="flex min-h-tap items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={v.offerKinds.includes(o.id)} onChange={() => toggle('offerKinds', o.id)} />{o.name}</label>)}</div></fieldset>
      <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={v.status === 'ACTIVE'} onChange={(e) => setV({ ...v, status: e.target.checked ? 'ACTIVE' : 'INACTIVE' })} /><span>In use (customers are asked to sign it)</span></label>
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="success">{ok}</Alert>}
      <Button disabled={busy || !v.contexts.length} onClick={() => void run(() => patch(`/documents/templates/${t.id}`, v), 'Saved')}>Save</Button>
    </Card>
  );
}
