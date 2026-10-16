'use client';
import { Alert, Badge, Button, Empty, Field, Input, Modal, SectionTitle, Segmented, Spinner, Stat, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { patch, post, useAction, useApi } from '@/lib/api';
import { dt, label } from '@/lib/format';
import { LEVEL_TONE, PortBar } from './shared';

export function Capacity() {
  const [level, setLevel] = useState('');
  const cap = useApi<any>(`/admin/capacity${level ? `?level=${level}` : ''}`);
  const wl = useApi<{ items: any[] }>('/admin/waitlist?status=WAITING');
  const ex = useApi<{ items: any[] }>('/admin/expansions');
  const act = useAction(async () => { await Promise.all([cap.reload(), wl.reload(), ex.reload()]); });
  const [ask, setAsk] = useState<{ dp: any; note: string } | null>(null);
  const s = cap.data?.summary;
  return (
    <div className="grid gap-5 [&>*]:min-w-0">
      {act.error && !ask && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Exhausted" value={s?.EXHAUSTED ?? '–'} tone={s?.EXHAUSTED ? 'danger' : undefined} sub="No free port" /><Stat label="Running low" value={s?.LOW ?? '–'} sub="Close to the limit" /><Stat label="Healthy" value={s?.OK ?? '–'} tone="success" /><Stat label="Customers waiting" value={s?.waiting ?? '–'} sub="On a waitlist" />
      </div>
      <section aria-label="Distribution points by pressure">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><SectionTitle>Distribution points</SectionTitle><Segmented label="Show" value={level} options={[{ value: '', label: 'All' }, { value: 'EXHAUSTED', label: 'Exhausted' }, { value: 'LOW', label: 'Low' }]} onChange={setLevel} /></div>
        {cap.loading && !cap.data && <Spinner />}
        {cap.data && cap.data.items.length === 0 && <Empty>Nothing to show.</Empty>}
        {cap.data && cap.data.items.length > 0 && (
          <TableWrap>
            <thead><tr><Th>DP</Th><Th>Status</Th><Th>Ports</Th><Th right>Used</Th><Th right>Waiting</Th><Th>Expansion</Th><Th /></tr></thead>
            <tbody>{cap.data.items.map((d: any) => (
              <tr key={d.dpId}>
                <Td><span className="font-medium">{d.code}</span><span className="block text-footnote text-label2">{d.provider}{d.city ? ` · ${d.city}` : ''}</span></Td>
                <Td><Badge tone={LEVEL_TONE[d.level as keyof typeof LEVEL_TONE]}>{label(d.level)}</Badge></Td>
                <Td><PortBar available={d.available} reserved={d.reserved} inUse={d.inUse} faulty={d.faulty} total={d.total} /></Td><Td right>{d.utilisationPercent}%</Td><Td right>{d.waiting || '—'}</Td>
                <Td>{d.expansion ? <Badge tone="warning">{label(d.expansion.status)}</Badge> : <span className="text-label2">—</span>}</Td>
                <Td><div className="flex flex-wrap gap-2">
                  {!d.expansion && d.level !== 'OK' && <Button variant="secondary" onClick={() => setAsk({ dp: d, note: '' })}>Request expansion</Button>}
                  {d.waiting > 0 && d.available > 0 && <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => post(`/admin/dps/${d.dpId}/notify`), 'Waiting customers told')}>Tell {Math.min(d.waiting, d.available)} waiting</Button>}
                </div></Td>
              </tr>))}</tbody>
          </TableWrap>)}
      </section>

      <section aria-label="Expansion requests">
        <SectionTitle>Expansion requests</SectionTitle>
        {ex.data && ex.data.items.length === 0 ? <p className="text-subhead text-label2">None raised.</p> : (
          <ul className="divide-y divide-separator rounded-card bg-surface px-4 shadow-card">
            {(ex.data?.items ?? []).map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1"><p className="font-medium">{e.dpCode} <Badge tone={e.status === 'DONE' ? 'success' : e.status === 'REJECTED' ? 'neutral' : 'warning'}>{label(e.status)}</Badge></p><p className="text-footnote text-label2">{e.waiting} waiting when raised · by {e.requestedBy}, {dt(e.requestedAt)}{e.note ? ` · ${e.note}` : ''}</p></div>
                {['OPEN', 'IN_PROGRESS'].includes(e.status) && <div className="flex gap-2">{e.status === 'OPEN' && <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => patch(`/admin/expansions/${e.id}`, { status: 'IN_PROGRESS' }), 'Updated')}>Start</Button>}<Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => patch(`/admin/expansions/${e.id}`, { status: 'DONE' }), 'Marked done')}>Done</Button><button type="button" className="text-footnote text-label2" onClick={() => void act.run(() => patch(`/admin/expansions/${e.id}`, { status: 'REJECTED' }), 'Rejected')}>Reject</button></div>}
              </li>))}
          </ul>)}
      </section>

      <section aria-label="Waitlist">
        <SectionTitle>Waitlist</SectionTitle>
        {wl.data && wl.data.items.length === 0 ? <p className="text-subhead text-label2">Nobody is waiting.</p> : (
          <TableWrap><thead><tr><Th>Customer</Th><Th>Address</Th><Th>DP</Th><Th right>Speed</Th><Th>Since</Th><Th /></tr></thead>
            <tbody>{(wl.data?.items ?? []).map((w) => <tr key={w.id}><Td>{w.customerRef ?? w.contact}<span className="block text-footnote text-label2">{w.customerRef ? w.contact : ''}</span></Td><Td className="text-label2">{w.address ?? '—'}</Td><Td>{w.dpCode ?? '—'}</Td><Td right>{w.speedMbps ? `${w.speedMbps} Mbps` : '—'}</Td><Td className="text-label2">{dt(w.createdAt)}</Td><Td><button type="button" className="text-footnote text-danger" onClick={() => void act.run(() => post(`/admin/waitlist/${w.id}/cancel`), 'Removed from the waitlist')}>Remove</button></Td></tr>)}</tbody></TableWrap>)}
      </section>

      {ask && (
        <Modal title={`Request expansion at ${ask.dp.code}`} onClose={() => setAsk(null)}>
          <p className="mb-3 text-subhead text-label2">Raises a request for network planning: {ask.dp.available} of {ask.dp.total} ports free, {ask.dp.waiting} customer{ask.dp.waiting === 1 ? '' : 's'} waiting.</p>
          {act.error && <Alert>{act.error}</Alert>}
          <Field label="Note for planning"><Input value={ask.note} maxLength={500} onChange={(e) => setAsk({ ...ask, note: e.target.value })} placeholder="For example: add a 1:16 splitter" /></Field>
          <div className="mt-4 flex gap-2"><Button disabled={act.busy} onClick={async () => { if (await act.run(() => post(`/admin/dps/${ask.dp.dpId}/expansion`, { note: ask.note || undefined }), 'Expansion requested')) setAsk(null); }}>Raise request</Button><Button variant="secondary" onClick={() => setAsk(null)}>Cancel</Button></div>
        </Modal>)}
    </div>
  );
}
