'use client';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useRef, useState } from 'react';
import { post, useAction } from '@/lib/api';
import { label } from '@/lib/format';
import { useLocations } from '../inventory/locations';

type Kind = 'msisdn' | 'imsi' | 'sim';
const HELP: Record<Kind, string> = {
  msisdn: 'One MSISDN per line, starting with the country code and no + sign (60128001234). Spaces and dashes are fine; a + is accepted too. Each is put in its tier by the patterns. MSISDNs already in the pool are skipped.',
  imsi: 'One 15-digit IMSI per line. They join the pool, ready to be bound to ICCIDs (SIM cards) or issued on eSIM profiles.',
  sim: 'Columns: iccid, imsi (optional), type (PHYSICAL or ESIM, optional), location (optional), activation_code (optional). A card without an IMSI gets the next free one from the pool.',
};

/** Loading the pools: paste or upload a file (or give a range), check it (nothing changes), then load it. */
export function LoadPane() {
  const [kind, setKind] = useState<Kind>('msisdn');
  const [mode, setMode] = useState<'file' | 'range'>('file');
  const [text, setText] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [location, setLocation] = useState('WH-MAIN');
  const [simKind, setSimKind] = useState<'PHYSICAL' | 'ESIM'>('PHYSICAL');
  const [autoBind, setAutoBind] = useState(true);
  const [batch, setBatch] = useState('');
  const [result, setResult] = useState<any>(null);
  const file = useRef<HTMLInputElement>(null);
  const { run, busy, error } = useAction();
  const locations = useLocations();
  const body = (apply: boolean) => ({ apply, batch: batch || undefined, ...(mode === 'range' && kind !== 'sim' ? { range } : { csv: text }), ...(kind === 'sim' ? { kind: simKind, locationId: location, autoBindImsi: autoBind } : {}) });
  const path = `/numbering/import/${kind}`;
  const check = () => run(async () => setResult(await post(path, body(false))));
  const load = () => run(async () => { setResult(await post(path, body(true))); });
  const pick = async (f?: File) => { if (!f) return; setText(await f.text()); setResult(null); };
  return (
    <Card>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="What are you loading?"><Select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setResult(null); setMode('file'); }}><option value="msisdn">MSISDN (phone numbers)</option><option value="sim">ICCID (SIM cards or eSIMs)</option><option value="imsi">IMSI (subscriber identities)</option></Select></Field>
        {kind !== 'sim' && <Field label="From"><Select value={mode} onChange={(e) => { setMode(e.target.value as 'file' | 'range'); setResult(null); }}><option value="file">A list or file</option><option value="range">A range</option></Select></Field>}
        <Field label="Batch name" hint="Optional, to find them later"><Input value={batch} maxLength={60} onChange={(e) => setBatch(e.target.value)} /></Field>
      </div>
      <p className="mt-3 text-subhead text-label2">{HELP[kind]}</p>
      {kind === 'sim' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Type"><Select value={simKind} onChange={(e) => setSimKind(e.target.value as 'PHYSICAL' | 'ESIM')}><option value="PHYSICAL">Physical cards</option><option value="ESIM">eSIM profiles</option></Select></Field>
          <Field label="Received at"><Select value={location} onChange={(e) => setLocation(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</Select></Field>
          <label className="flex min-h-tap items-end gap-2 pb-2"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={autoBind} onChange={(e) => setAutoBind(e.target.checked)} />Bind a free IMSI to ICCIDs without one</label>
        </div>
      )}
      {kind !== 'sim' && mode === 'range' ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="From"><Input className="font-mono" value={range.from} onChange={(e) => { setRange({ ...range, from: e.target.value }); setResult(null); }} placeholder={kind === 'msisdn' ? '60128000000' : '525010100000000'} /></Field>
          <Field label="To"><Input className="font-mono" value={range.to} onChange={(e) => { setRange({ ...range, to: e.target.value }); setResult(null); }} placeholder={kind === 'msisdn' ? '60128009999' : '525010100000999'} /></Field>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input ref={file} type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} />
            <Button type="button" variant="secondary" onClick={() => file.current?.click()}>Choose a file…</Button>
            <a className="text-accent" href={`/api/numbering/template/${kind}`}>Download the {kind === 'sim' ? 'ICCID' : kind.toUpperCase()} template</a>
          </div>
          <textarea aria-label="Contents" className="min-h-40 w-full rounded-control border border-separator bg-surface p-3 font-mono text-subhead" value={text} onChange={(e) => { setText(e.target.value); setResult(null); }} placeholder="Paste here" />
        </div>
      )}
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      <div className="mt-4 flex gap-2">
        <Button variant="secondary" disabled={busy || (mode === 'range' && kind !== 'sim' ? !range.from || !range.to : !text.trim())} onClick={check}>{busy ? 'Checking…' : 'Check'}</Button>
        <Button disabled={busy || !result || result.applied || result.errors?.length > 0 || result.added === 0} onClick={load}>Load {result?.added ? result.added.toLocaleString('en') : ''}</Button>
      </div>
      {busy && !result && <div className="mt-3"><Spinner /></div>}
      {result && (
        <div className="mt-4">
          <Alert tone={result.errors.length ? 'danger' : 'success'}>
            {result.applied ? 'Loaded. ' : 'Checked: nothing has changed yet. '}{result.added.toLocaleString('en')} new, {result.duplicates.toLocaleString('en')} already there{result.bound ? `, ${result.bound} given an identity` : ''}{result.errors.length ? `, ${result.errors.length} with a problem` : ''}.
          </Alert>
          {result.byTier && <p className="mt-2 flex flex-wrap gap-2 text-subhead">{Object.entries(result.byTier).map(([t, n]) => <span key={t}><Badge>{label(t)}</Badge> {(n as number).toLocaleString('en')}</span>)}</p>}
          {result.errors.length > 0 && (
            <div className="mt-3"><TableWrap><thead><tr><Th>Line</Th><Th>Value</Th><Th>Problem</Th></tr></thead><tbody>
              {result.errors.slice(0, 20).map((e: any) => <tr key={e.line}><Td>{e.line}</Td><Td className="font-mono">{e.value}</Td><Td>{e.message}</Td></tr>)}
            </tbody></TableWrap>{result.errors.length > 20 && <p className="mt-1 text-footnote text-label2">…and {result.errors.length - 20} more.</p>}</div>
          )}
        </div>
      )}
    </Card>
  );
}
