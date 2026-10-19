'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LargeTitle, Modal, Segmented, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { del, post, useAction, useApi } from '@/lib/api';
import { dt, label } from '@/lib/format';

type Tab = 'alerts' | 'swaps' | 'blacklist';
const TONE: Record<string, 'danger' | 'warning' | 'neutral'> = { HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' };

export default function FraudDesk() {
  const [tab, setTab] = useState<Tab>('alerts');
  const alerts = useApi<{ items: any[]; open: number }>('/fraud/alerts');
  return (
    <>
      <LargeTitle subtitle="SIM-swap anomalies, usage spikes and the blacklist. Barring a service cuts it off, except for emergency calls, until you lift the bar.">Fraud desk</LargeTitle>
      <div className="mb-4"><Segmented label="Fraud desk" value={tab} options={[{ value: 'alerts', label: `Alerts${alerts.data?.open ? ` (${alerts.data.open})` : ''}` }, { value: 'swaps', label: 'SIM swaps' }, { value: 'blacklist', label: 'Blacklist' }]} onChange={(v) => setTab(v as Tab)} /></div>
      {tab === 'alerts' && <Alerts state={alerts} />}
      {tab === 'swaps' && <Swaps />}
      {tab === 'blacklist' && <Blacklist />}
    </>
  );
}

function Alerts({ state }: { state: ReturnType<typeof useApi<{ items: any[]; open: number }>> }) {
  const act = useAction(state.reload);
  const [bar, setBar] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  return (
    <div className="grid gap-4">
      {(state.error || act.error) && <Alert>{state.error || act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(async () => { const r = await post('/fraud/scan'); return r; }, 'Scan finished')}>Scan SIM swaps now</Button>
      </div>
      {state.loading && !state.data && <Spinner />}
      {state.data && state.data.items.length === 0 && <Empty>No alerts. Run a scan, or wait for the network feed.</Empty>}
      {state.data && state.data.items.length > 0 && (
        <TableWrap>
          <thead><tr><Th>Severity</Th><Th>What</Th><Th>Source</Th><Th>Raised</Th><Th>Status</Th><Th /></tr></thead>
          <tbody>
            {state.data.items.map((a) => (
              <tr key={a.id}>
                <Td><Badge tone={TONE[a.severity] ?? 'neutral'}>{label(a.severity)}</Badge></Td>
                <Td><span className="font-medium">{label(a.kind)}</span><span className="block text-footnote text-label2">{a.summary}</span>{a.note && <span className="block text-footnote text-label2">Note: {a.note}</span>}</Td>
                <Td className="text-label2">{label(a.source)}</Td>
                <Td className="text-label2">{dt(a.createdAt)}</Td>
                <Td><Badge tone={a.status === 'OPEN' ? 'warning' : a.status === 'CONFIRMED' ? 'danger' : 'neutral'}>{label(a.status)}</Badge></Td>
                <Td>
                  {a.status === 'OPEN' && (
                    <div className="flex flex-wrap gap-2">
                      {a.serviceId && <Button variant="destructive" onClick={() => { setBar(a); setReason(a.summary); }}>Bar service</Button>}
                      <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => post(`/fraud/alerts/${a.id}/resolve`, { decision: 'CONFIRMED', note: note || undefined }), 'Alert confirmed')}>Confirm</Button>
                      <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => post(`/fraud/alerts/${a.id}/resolve`, { decision: 'DISMISSED', note: note || undefined }), 'Alert dismissed')}>Dismiss</Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {state.data?.items.some((a) => a.status === 'OPEN') && <Field label="Note for the next alert you close" hint="Optional: saved with the decision."><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>}
      {bar && (
        <Modal title={`Bar ${bar.identifier ?? 'service'}`} onClose={() => setBar(null)}>
          <p className="mb-3 text-subhead text-label2">Calls, SMS and data stop in both directions; emergency calls still work. Only a fraud analyst can lift the bar.</p>
          <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setBar(null)}>Cancel</Button>
            <Button variant="destructive" disabled={act.busy || !reason.trim()} onClick={async () => { await act.run(() => post(`/fraud/services/${bar.serviceId}/bar`, { reason }), 'Service barred'); setBar(null); }}>Bar service</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Swaps() {
  const swaps = useApi<{ items: any[] }>('/fraud/sim-swaps?days=30');
  const act = useAction(swaps.reload);
  const [release, setRelease] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  return (
    <div className="grid gap-4">
      {(swaps.error || act.error) && <Alert>{swaps.error || act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      {swaps.loading && !swaps.data && <Spinner />}
      {swaps.data && swaps.data.items.length === 0 && <Empty>No SIM swaps in the last 30 days.</Empty>}
      {swaps.data && swaps.data.items.length > 0 && (
        <TableWrap>
          <thead><tr><Th>Number</Th><Th>Reason</Th><Th>By</Th><Th>When</Th><Th right>Swaps in 30 days</Th><Th /></tr></thead>
          <tbody>
            {swaps.data.items.map((s, i) => (
              <tr key={`${s.serviceId}-${i}`}>
                <Td className="font-medium">{s.identifier ?? '—'}</Td><Td>{s.reason ? label(s.reason) : '—'}</Td><Td className="text-label2">{s.actor}</Td><Td className="text-label2">{dt(s.at)}</Td>
                <Td right>{s.swapsInWindow >= 2 ? <Badge tone="danger">{s.swapsInWindow}</Badge> : s.swapsInWindow}</Td>
                <Td><div className="flex gap-2"><Button variant="destructive" disabled={act.busy} onClick={() => void act.run(() => post(`/fraud/services/${s.serviceId}/bar`, { reason: 'SIM swap under review' }), 'Service barred')}>Bar</Button><Button variant="secondary" onClick={() => { setRelease(s); setReason(''); }}>Lift bar</Button></div></Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {release && (
        <Modal title={`Lift the bar on ${release.identifier}`} onClose={() => setRelease(null)}>
          <Field label="Reason" hint="For example: owner verified in store."><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRelease(null)}>Cancel</Button>
            <Button disabled={act.busy || !reason.trim()} onClick={async () => { await act.run(() => post(`/fraud/services/${release.serviceId}/release`, { reason }), 'Bar lifted'); setRelease(null); }}>Lift bar</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { ID_DOCUMENT: 'ID document', MSISDN: 'Mobile number', ICCID: 'SIM (ICCID)', IMEI: 'Device (IMEI)', EMAIL: 'E-mail' };
function Blacklist() {
  const list = useApi<{ items: any[] }>('/fraud/blacklist');
  const act = useAction(list.reload);
  const [kind, setKind] = useState('ID_DOCUMENT');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  return (
    <div className="grid gap-4">
      {(list.error || act.error) && <Alert>{list.error || act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <Card>
        <h2 className="mb-1 text-title3 font-semibold">Add to the blacklist</h2>
        <p className="mb-3 text-subhead text-label2">Only a scrambled form of the value is kept, plus its last three characters as a hint, so nobody can read it back. A match stops a sign-up, an order or a SIM swap.</p>
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr_1fr_auto] sm:items-end">
          <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Value"><Input value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" /></Field>
          <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
          <Button disabled={act.busy || value.trim().length < 3 || !reason.trim()} onClick={async () => { await act.run(() => post('/fraud/blacklist', { kind, value, reason }), 'Added'); setValue(''); setReason(''); }}>Add</Button>
        </div>
      </Card>
      {list.loading && !list.data && <Spinner />}
      {list.data && list.data.items.length === 0 && <Empty>The blacklist is empty.</Empty>}
      {list.data && list.data.items.length > 0 && (
        <TableWrap>
          <thead><tr><Th>Kind</Th><Th>Value</Th><Th>Reason</Th><Th>Added</Th><Th /></tr></thead>
          <tbody>
            {list.data.items.map((b) => (
              <tr key={b.id}><Td>{KIND_LABEL[b.kind] ?? b.kind}</Td><Td className="font-mono text-label2">{b.valueHint}</Td><Td>{b.reason}</Td><Td className="text-label2">{b.addedBy} · {dt(b.addedAt)}</Td>
                <Td><Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => del(`/fraud/blacklist/${b.id}`), 'Removed')}>Remove</Button></Td></tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
