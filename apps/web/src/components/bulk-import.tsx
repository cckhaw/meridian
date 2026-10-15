'use client';
import { Alert, Badge, Button, Modal, Segmented, TableWrap, Td, Th } from '@meridian/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { post, useAction } from '@/lib/api';

interface Row { line: number; id: string; name: string; action: 'CREATE' | 'UPDATE'; status: 'OK' | 'ERROR' | 'SKIPPED'; message?: string }
interface Result { applied: boolean; canApply: boolean; rows: Row[]; summary: { created: number; updated: number; errors: number; skipped: number } }
export interface BulkTab {
  id: string; label: string;
  /** What one row is: ['dealer', 'dealers']. */
  noun: [string, string];
  templateHref: string; exportHref: string; importPath: string;
  help?: ReactNode;
}
const SHOWN_OK = 100;
const link = 'inline-flex min-h-tap items-center rounded-control bg-surface2 px-4 text-subhead font-medium text-accent hover:bg-surface2/70';

/**
 * Bulk loading of master data: download a template or what is there now, edit it, choose the file, check it (nothing changes), then load it (every row or none).
 * One dialog serves dealers, agents and stores; several tabs when a page has more than one kind of file.
 */
export function BulkImport({ title, tabs, onClose, onDone }: { title: string; tabs: BulkTab[]; onClose: () => void; onDone: () => void }) {
  const [tabId, setTabId] = useState(tabs[0]!.id);
  const tab = tabs.find((t) => t.id === tabId)!;
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const { run, busy, error } = useAction();
  useEffect(() => { setName(''); setText(''); setResult(null); }, [tabId]);

  const [one, many] = tab.noun;
  const pick = async (f: File | undefined) => {
    setResult(null);
    if (!f) return;
    if (f.size > 1_900_000) { setName(''); setText(''); return void run(async () => { throw new Error('That file is too large (2 MB at most). Split it into several files.'); }); }
    setName(f.name); setText(await f.text());
  };
  const check = () => run(async () => setResult(await post<Result>(tab.importPath, { csv: text, apply: false })));
  const load = () => run(async () => { const r = await post<Result>(tab.importPath, { csv: text, apply: true }); setResult(r); onDone(); });
  const s = result?.summary;
  const problems = (result?.rows ?? []).filter((r) => r.status === 'ERROR');
  const good = (result?.rows ?? []).filter((r) => r.status === 'OK');
  const made = good.filter((r) => r.action === 'CREATE' && r.id);

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="space-y-5">
        {tabs.length > 1 && !result?.applied && <Segmented label="What to load" value={tabId} options={tabs.map((t) => ({ value: t.id, label: t.label }))} onChange={setTabId} />}
        {result?.applied && s ? (
          <div className="space-y-4">
            <Alert tone="success">Loaded: {s.created} {s.created === 1 ? one : many} added, {s.updated} updated.{made.length > 0 && <span className="mt-1 block break-words font-mono text-footnote">New: {made.slice(0, 12).map((r) => r.id).join(', ')}{made.length > 12 ? ` and ${made.length - 12} more` : ''}</span>}</Alert>
            <div className="flex gap-3"><Button onClick={onClose}>Done</Button><Button variant="secondary" onClick={() => { setResult(null); setText(''); setName(''); }}>Load another file</Button></div>
          </div>
        ) : (
          <>
            <section aria-label="Step 1: get a file" className="space-y-2">
              <p className="text-subhead font-medium">1. Download a file to fill in</p>
              <div className="flex flex-wrap gap-2">
                <a className={link} href={tab.templateHref}>Empty template</a>
                <a className={link} href={tab.exportHref}>Download my current {many}</a>
              </div>
              <p className="text-footnote text-label2">The template explains each column and has an example (as a comment, so it is not loaded). The download holds everything there is now, and loads straight back: a row with an id <strong>updates</strong> that {one}, a row with no id <strong>adds</strong> one with an id the system issues. On an update, a blank cell leaves the field as it is and a single <code>-</code> clears it.</p>
              {tab.help && <p className="text-footnote text-label2">{tab.help}</p>}
            </section>

            <section aria-label="Step 2: choose the file" className="space-y-2">
              <p className="text-subhead font-medium">2. Choose the filled-in file</p>
              <input key={tabId} type="file" accept=".csv,text/csv" aria-label={`${tab.label} file`} className="block w-full text-subhead file:mr-3 file:min-h-tap file:rounded-control file:border-0 file:bg-surface2 file:px-4 file:font-medium" onChange={(e) => void pick(e.target.files?.[0])} />
              <Button type="button" onClick={() => void check()} disabled={busy || !text}>{busy && !result ? 'Checking…' : 'Check the file'}</Button>
            </section>

            {error && <Alert>{error}</Alert>}
            {result && s && (
              <section aria-label="Check result" className="space-y-3">
                <p className="text-subhead font-medium">3. Check the result{name ? ` (${name})` : ''}</p>
                <p role="status" className="text-subhead"><strong>{s.created}</strong> to add · <strong>{s.updated}</strong> to update · <strong className={s.errors ? 'text-danger' : ''}>{s.errors}</strong> with a problem{s.skipped ? ` · ${s.skipped} empty` : ''}</p>
                {s.errors > 0 && <Alert>Nothing is loaded until every row is fixed. Correct the lines below in your file and check it again.</Alert>}
                {(problems.length > 0 || good.length > 0) && (
                  <TableWrap><thead><tr><Th>Line</Th><Th>{tab.label.replace(/s$/, '')}</Th><Th>Will</Th><Th>Result</Th></tr></thead><tbody>
                    {[...problems, ...good.slice(0, SHOWN_OK)].map((r) => (
                      <tr key={r.line}><Td>{r.line}</Td><Td><span className="font-medium">{r.name || '—'}</span>{r.id && <span className="block font-mono text-caption text-label2">{r.id}</span>}</Td>
                        <Td>{r.action === 'CREATE' ? 'Add' : 'Update'}</Td>
                        <Td><Badge tone={r.status === 'OK' ? 'success' : 'danger'}>{r.status === 'OK' ? 'Ready' : 'Problem'}</Badge>{r.message && <span className="block text-footnote text-label2">{r.message}</span>}</Td></tr>
                    ))}
                  </tbody></TableWrap>
                )}
                {good.length > SHOWN_OK && <p className="text-footnote text-label2">…and {good.length - SHOWN_OK} more rows that are ready.</p>}
                <Button onClick={() => void load()} disabled={busy || !result.canApply}>{busy ? 'Loading…' : `Load ${s.created + s.updated} ${s.created + s.updated === 1 ? one : many}`}</Button>
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
