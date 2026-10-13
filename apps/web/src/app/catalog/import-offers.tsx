'use client';
import { Alert, Badge, Button, Modal, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction } from '@/lib/api';

interface Row { line: number; id: string; name: string; action: 'CREATE' | 'UPDATE'; status: 'OK' | 'ERROR' | 'SKIPPED'; message?: string }
interface Result { applied: boolean; canApply: boolean; rows: Row[]; summary: { created: number; updated: number; errors: number; skipped: number } }
const SHOWN_OK = 100;
const link = 'inline-flex min-h-tap items-center rounded-control bg-surface2 px-4 text-subhead font-medium text-accent hover:bg-surface2/70';

/** Bulk offers: download a template (or every current offer), edit it, check it (nothing changes), then load it (every row or none). */
export function ImportOffers({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const { run, busy, error } = useAction();

  const pick = async (f: File | undefined) => {
    setResult(null);
    if (!f) return;
    if (f.size > 1_900_000) { setName(''); setText(''); return void run(async () => { throw new Error('That file is too large (2 MB at most). Split it into several files.'); }); }
    setName(f.name); setText(await f.text());
  };
  const check = () => run(async () => setResult(await post<Result>('/catalog-import', { csv: text, apply: false })));
  const load = () => run(async () => { const r = await post<Result>('/catalog-import', { csv: text, apply: true }); setResult(r); onDone(); });
  const s = result?.summary;
  const problems = (result?.rows ?? []).filter((r) => r.status === 'ERROR');
  const good = (result?.rows ?? []).filter((r) => r.status === 'OK');

  return (
    <Modal title="Import offers from a file" onClose={onClose} wide>
      {result?.applied && s ? (
        <div className="space-y-4">
          <Alert tone="success">Loaded: {s.created} {s.created === 1 ? 'offer' : 'offers'} created, {s.updated} updated. New offers start as drafts unless the file says otherwise.</Alert>
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="space-y-5">
          <section aria-label="Step 1: get the template" className="space-y-2">
            <p className="text-subhead font-medium">1. Download the template</p>
            <div className="flex flex-wrap gap-2">
              <a className={link} href="/api/catalog-import/template">Empty template</a>
              <a className={link} href="/api/catalog-import/template?offers=1">Template with my current offers</a>
            </div>
            <p className="text-footnote text-label2">The template lists the group, type and fulfilment ids you can use. The <strong>offer_id</strong> is the key: a row whose offer_id already exists <strong>updates</strong> that offer (a blank cell leaves a field as it is); any other row creates a new one. Start from your current offers to change prices or details in bulk.</p>
          </section>

          <section aria-label="Step 2: choose the file" className="space-y-2">
            <p className="text-subhead font-medium">2. Choose the filled-in file</p>
            <input type="file" accept=".csv,text/csv" aria-label="Offers file" className="block w-full text-subhead file:mr-3 file:min-h-tap file:rounded-control file:border-0 file:bg-surface2 file:px-4 file:font-medium" onChange={(e) => void pick(e.target.files?.[0])} />
            <Button type="button" onClick={() => void check()} disabled={busy || !text}>{busy && !result ? 'Checking…' : 'Check the file'}</Button>
          </section>

          {error && <Alert>{error}</Alert>}
          {result && s && (
            <section aria-label="Check result" className="space-y-3">
              <p className="text-subhead font-medium">3. Check the result{name ? ` (${name})` : ''}</p>
              <p role="status" className="text-subhead"><strong>{s.created}</strong> to create · <strong>{s.updated}</strong> to update · <strong className={s.errors ? 'text-danger' : ''}>{s.errors}</strong> with a problem{s.skipped ? ` · ${s.skipped} empty` : ''}</p>
              {s.errors > 0 && <Alert>Nothing is loaded until every row is fixed. Correct the lines below in your file and check it again.</Alert>}
              {(problems.length > 0 || good.length > 0) && (
                <TableWrap><thead><tr><Th>Line</Th><Th>Offer</Th><Th>Will</Th><Th>Result</Th></tr></thead><tbody>
                  {[...problems, ...good.slice(0, SHOWN_OK)].map((r) => (
                    <tr key={r.line}><Td>{r.line}</Td><Td><span className="font-medium">{r.name || r.id}</span><span className="block font-mono text-caption text-label2">{r.id}</span></Td>
                      <Td>{r.action === 'CREATE' ? 'Create' : 'Update'}</Td>
                      <Td><Badge tone={r.status === 'OK' ? 'success' : 'danger'}>{r.status === 'OK' ? 'Ready' : 'Problem'}</Badge>{r.message && <span className="block text-footnote text-label2">{r.message}</span>}</Td></tr>
                  ))}
                </tbody></TableWrap>
              )}
              {good.length > SHOWN_OK && <p className="text-footnote text-label2">…and {good.length - SHOWN_OK} more rows that are ready.</p>}
              <Button onClick={() => void load()} disabled={busy || !result.canApply}>{busy ? 'Loading…' : `Load ${s.created + s.updated} ${s.created + s.updated === 1 ? 'offer' : 'offers'}`}</Button>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
