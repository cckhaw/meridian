'use client';
import { Alert, Button, Card } from '@meridian/ui';
import { useState } from 'react';
import { api, useAction } from '@/lib/api';
import type { Profile } from './page';

const CHANNELS: Array<[keyof Profile['notificationPrefs']['channels'], string, string]> = [['email', 'E-mail', 'To the address on your profile'], ['sms', 'SMS', 'To your mobile number'], ['push', 'In the app', 'Alerts inside Meridian']];
const EVENTS: Array<[keyof Profile['notificationPrefs']['events'], string, string]> = [
  ['caseAssigned', 'A case is assigned to me', 'When someone gives you a case, or the system routes one to you'],
  ['caseUpdates', 'Updates on my cases', 'Replies, status changes and SLA warnings'],
  ['systemAlerts', 'System alerts', 'Outages and maintenance that affect your work'],
  ['securityAlerts', 'Security alerts', 'New sign-ins, password changes and second-factor changes'],
];

export function NotificationsTab({ p, reload }: { p: Profile; reload: () => void | Promise<void> }) {
  const act = useAction(async () => { await reload(); });
  const [prefs, setPrefs] = useState(p.notificationPrefs);
  const dirty = JSON.stringify(prefs) !== JSON.stringify(p.notificationPrefs);
  const Row = ({ on, onChange, title, hint }: { on: boolean; onChange: (v: boolean) => void; title: string; hint: string }) => (
    <label className="flex min-h-tap items-start gap-3 py-2"><input type="checkbox" className="mt-1" checked={on} onChange={(e) => onChange(e.target.checked)} /><span><span className="block text-subhead font-medium">{title}</span><span className="block text-footnote text-label2">{hint}</span></span></label>
  );
  return (
    <div className="grid max-w-3xl gap-5">
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <Card>
        <h2 className="mb-1 text-title3 font-semibold">How should we reach you?</h2>
        <div className="divide-y divide-separator">{CHANNELS.map(([k, t, h]) => <Row key={k} on={prefs.channels[k]} onChange={(v) => setPrefs({ ...prefs, channels: { ...prefs.channels, [k]: v } })} title={t} hint={h} />)}</div>
      </Card>
      <Card>
        <h2 className="mb-1 text-title3 font-semibold">What should we tell you about?</h2>
        <div className="divide-y divide-separator">{EVENTS.map(([k, t, h]) => <Row key={k} on={prefs.events[k]} onChange={(v) => setPrefs({ ...prefs, events: { ...prefs.events, [k]: v } })} title={t} hint={h} />)}</div>
      </Card>
      <div><Button disabled={!dirty || act.busy} onClick={() => void act.run(() => api('/profile', { method: 'PATCH', json: { notificationPrefs: prefs } }), 'Saved')}>{act.busy ? 'Saving…' : 'Save preferences'}</Button></div>
    </div>
  );
}
