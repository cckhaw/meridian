'use client';
import { Alert, Button, Card, Field, Input, Select, Spinner } from '@meridian/ui';
import { useEffect, useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/** How journals reach SAP: company code, document type, file format, summary level and transport; plus the automatic daily close and real-time export. */
export function SapSettings() {
  const { can } = useAuth();
  const edit = can('finance:configure');
  const s = useApi<any>('/finance/sap-settings');
  const [v, setV] = useState<any | null>(null);
  useEffect(() => { if (s.data) setV(s.data); }, [s.data]);
  const save = useAction(s.reload);
  if (s.error) return <Alert>{s.error}</Alert>;
  if (!v) return <Spinner />;
  const set = (k: string, x: unknown) => setV({ ...v, [k]: x });
  return (
    <Card>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save.run(() => post('/finance/sap-settings', v), 'Saved.'); }}>
        <Field label="Company code" hint="SAP BUKRS"><Input className="font-mono" disabled={!edit} maxLength={4} value={v.companyCode} onChange={(e) => set('companyCode', e.target.value)} /></Field>
        <Field label="Document type" hint="SAP BLART, for example SA"><Input className="font-mono" disabled={!edit} maxLength={2} value={v.documentType} onChange={(e) => set('documentType', e.target.value)} /></Field>
        <Field label="Ledger group" hint="Blank for the leading ledger"><Input className="font-mono" disabled={!edit} maxLength={4} value={v.ledgerGroup} onChange={(e) => set('ledgerGroup', e.target.value)} /></Field>
        <Field label="File format">
          <Select disabled={!edit} value={v.format} onChange={(e) => set('format', e.target.value)}><option value="FLAT">Flat file (pipe-delimited)</option><option value="IDOC">IDoc (XML)</option><option value="JSON">JSON (BAPI style)</option><option value="CSV">CSV</option></Select>
        </Field>
        <Field label="Documents" hint="A day’s summary is far smaller than one document per journal">
          <Select disabled={!edit} value={v.aggregate} onChange={(e) => set('aggregate', e.target.value)}><option value="DAILY_SUMMARY">One summary per posting day</option><option value="DETAIL">One document per journal</option></Select>
        </Field>
        <Field label="Delivery">
          <Select disabled={!edit} value={v.transport} onChange={(e) => set('transport', e.target.value)}><option value="MANUAL">Download and upload by hand</option><option value="REST">REST endpoint</option><option value="SFTP" disabled>SFTP (needs the integration connector)</option><option value="RFC" disabled>RFC (needs the integration connector)</option></Select>
        </Field>
        {v.transport === 'REST' && <div className="sm:col-span-2"><Field label="REST endpoint" hint="https only. The access token is the MERIDIAN_SAP_TOKEN environment variable, never kept here."><Input disabled={!edit} type="url" value={v.endpoint} onChange={(e) => set('endpoint', e.target.value)} /></Field></div>}
        <label className="flex items-start gap-3 sm:col-span-2"><input type="checkbox" className="mt-1 h-5 w-5" disabled={!edit} checked={v.autoClose} onChange={(e) => set('autoClose', e.target.checked)} /><span><span className="font-medium">Close the day automatically</span><span className="block text-footnote text-label2">After midnight, the daily job exports everything posted up to the end of yesterday and reconciles it.</span></span></label>
        <label className="flex items-start gap-3 sm:col-span-2"><input type="checkbox" className="mt-1 h-5 w-5" disabled={!edit} checked={v.realtime} onChange={(e) => set('realtime', e.target.checked)} /><span><span className="font-medium">Send each event to SAP straight away</span><span className="block text-footnote text-label2">Every event the sub-ledger receives is exported as its own batch as well as in the daily close. A failed send never loses the posting.</span></span></label>
        {save.error && <div className="sm:col-span-2"><Alert>{save.error}</Alert></div>}
        {save.ok && <div className="sm:col-span-2"><Alert tone="success">{save.ok}</Alert></div>}
        {edit && <div className="sm:col-span-2"><Button type="submit" disabled={save.busy}>{save.busy ? 'Saving…' : 'Save'}</Button></div>}
      </form>
    </Card>
  );
}
