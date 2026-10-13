'use client';
import { Alert, Badge, Button, Field, Modal, Select, TableWrap, Td, Th } from '@meridian/ui';
import { useRef, useState } from 'react';
import { post, useAction } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface Row { line: number; locationId: string; sku: string; action: string; quantity: number | null; before: number | null; after: number | null; status: 'OK' | 'WARNING' | 'ERROR' | 'SKIPPED'; message?: string }
interface Result { applied: boolean; canApply: boolean; rows: Row[]; summary: { ok: number; warnings: number; errors: number; skipped: number; unitsAdded: number; unitsRemoved: number } }
const TONE = { OK: 'success', WARNING: 'warning', ERROR: 'danger', SKIPPED: 'neutral' } as const;
const SHOWN_OK = 100;

/** Batch stock loading: download a template, fill it in, check it (nothing changes), then load it (every row or none). */
export function ImportStock({ locations, onClose, onDone }: { locations: string[]; onClose: () => void; onDone: () => void }) {
  const { me } = useAuth();
  const [loc, setLoc] = useState(me?.storeId ?? 'WH-MAIN');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const { run, busy, error } = useAction();
  const options = [...new Set(['WH-MAIN', ...locations])];

  const pick = async (f: File | undefined) => {
    setResult(null);
    if (!f) return;
    if (f.size > 1_900_000) { setName(''); setText(''); return void run(async () => { throw new Error('That file is too large (2 MB at most). Split it into several files.'); }); }
    setName(f.name); setText(await f.text());
  };
  const check = () => run(async () => setResult(await post<Result>('/inventory/import', { csv: text, apply: false })));
  const load = () => run(async () => { const r = await post<Result>('/inventory/import', { csv: text, apply: true }); setResult(r); onDone(); });
  const s = result?.summary;
  const problems = (result?.rows ?? []).filter((r) => r.status === 'ERROR' || r.status === 'WARNING');
  const good = (result?.rows ?? []).filter((r) => r.status === 'OK');
  const q = `locationId=${encodeURIComponent(loc)}`;

  return (
    <Modal title="Import stock from a file" onClose={onClose} wide>
      {result?.applied && s ? (
        <div className="space-y-4">
          <Alert tone="success">Loaded {s.ok + s.warnings} {s.ok + s.warnings === 1 ? 'row' : 'rows'}: {s.unitsAdded.toLocaleString()} units added{s.unitsRemoved ? `, ${s.unitsRemoved.toLocaleString()} removed` : ''}.</Alert>
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="space-y-5">
          <section aria-label="Step 1: get the template" className="space-y-2">
            <p className="text-subhead font-medium">1. Download the template</p>
            {!me?.storeId && <Field label="Location the stock is for"><Select value={loc} onChange={(e) => setLoc(e.target.value)}>{options.map((l) => <option key={l}>{l}</option>)}</Select></Field>}
            <div className="flex flex-wrap gap-2">
              <a className="inline-flex min-h-tap items-center rounded-control bg-surface2 px-4 text-subhead font-medium text-accent hover:bg-surface2/70" href={`/api/inventory/import-template?skus=1&${q}`}>Template with all my SKUs</a>
              <a className="inline-flex min-h-tap items-center rounded-control bg-surface2 px-4 text-subhead font-medium text-accent hover:bg-surface2/70" href={`/api/inventory/import-template?${q}`}>Empty template</a>
            </div>
            <p className="text-footnote text-label2">The first lists every SKU your offers use, with the quantity blank: fill in what arrived and leave the rest (rows without a quantity are skipped). Each row has an action: <strong>RECEIVE</strong> adds stock, <strong>REMOVE</strong> writes it off, <strong>SET</strong> is a stock count.</p>
          </section>

          <section aria-label="Step 2: choose the file" className="space-y-2">
            <p className="text-subhead font-medium">2. Choose the filled-in file</p>
            <input ref={file} type="file" accept=".csv,text/csv" aria-label="Stock file" className="block w-full text-subhead file:mr-3 file:min-h-tap file:rounded-control file:border-0 file:bg-surface2 file:px-4 file:font-medium" onChange={(e) => void pick(e.target.files?.[0])} />
            <Button type="button" onClick={() => void check()} disabled={busy || !text}>{busy && !result ? 'Checking…' : 'Check the file'}</Button>
          </section>

          {error && <Alert>{error}</Alert>}
          {result && s && (
            <section aria-label="Check result" className="space-y-3">
              <p className="text-subhead font-medium">3. Check the result{name ? ` (${name})` : ''}</p>
              <p role="status" className="text-subhead">
                <strong>{s.ok + s.warnings}</strong> ready to load · <strong className={s.errors ? 'text-danger' : ''}>{s.errors}</strong> with a problem · {s.skipped} skipped · {s.unitsAdded.toLocaleString()} units in{s.unitsRemoved ? ` · ${s.unitsRemoved.toLocaleString()} out` : ''}
              </p>
              {s.errors > 0 && <Alert>Nothing is loaded until every row is fixed. Correct the lines below in your file and check it again.</Alert>}
              {(problems.length > 0 || good.length > 0) && (
                <TableWrap><thead><tr><Th>Line</Th><Th>Location</Th><Th>SKU</Th><Th>Action</Th><Th right>Qty</Th><Th right>On hand</Th><Th>Result</Th></tr></thead><tbody>
                  {[...problems, ...good.slice(0, SHOWN_OK)].map((r) => (
                    <tr key={r.line}><Td>{r.line}</Td><Td>{r.locationId}</Td><Td className="font-mono">{r.sku}</Td><Td>{r.action}</Td><Td right>{r.quantity ?? ''}</Td>
                      <Td right className="tabular-nums">{r.after !== null ? `${r.before} → ${r.after}` : ''}</Td>
                      <Td><Badge tone={TONE[r.status]}>{r.status === 'OK' ? 'Ready' : r.status === 'WARNING' ? 'Check' : 'Problem'}</Badge>{r.message && <span className="block text-footnote text-label2">{r.message}</span>}</Td></tr>
                  ))}
                </tbody></TableWrap>
              )}
              {good.length > SHOWN_OK && <p className="text-footnote text-label2">…and {good.length - SHOWN_OK} more rows that are ready.</p>}
              <Button onClick={() => void load()} disabled={busy || !result.canApply}>{busy ? 'Loading…' : `Load ${s.ok + s.warnings} ${s.ok + s.warnings === 1 ? 'row' : 'rows'}`}</Button>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
