'use client';
import { Alert, Button, Card } from '@meridian/ui';
import { useState } from 'react';
import Link from 'next/link';
import { api, post, useAction, useApi } from '@/lib/api';
import type { Profile } from './page';

type Channel = keyof Profile['notificationPrefs']['channels'];
interface ChannelStatus { sms: { available: boolean; via: 'SMS' | 'WHATSAPP' | null }; email: { available: boolean; via: string | null; note: string } }
const EVENTS: Array<[keyof Profile['notificationPrefs']['events'], string, string]> = [
  ['caseAssigned', 'A case is assigned to me', 'When someone else gives you a case. Not sent when you take a case yourself.'],
  ['caseUpdates', 'Updates on my cases', 'When someone else moves a case that is assigned to you to another status. Replies and SLA warnings are not sent here.'],
  ['systemAlerts', 'System alerts', 'Notices an administrator sends to all staff, such as an outage or planned maintenance.'],
  ['securityAlerts', 'Security alerts', 'A sign-in from a device or browser you have not used before, a password change or reset, and a change to your second factor. Never includes codes or passwords.'],
];

function channelRows(p: Profile, st: ChannelStatus | null): Array<[Channel, string, string, string | null]> {
  const sms = !st ? 'Checking whether an SMS gateway is set up…' : st.sms.available
    ? `Short text to your mobile number, through the ${st.sms.via === 'WHATSAPP' ? 'WhatsApp' : 'SMS'} gateway your administrator set up.`
    : 'Not available: no SMS or WhatsApp gateway is set up, so nothing is sent by SMS. Ask your administrator to add one under Settings, Integration hub.';
  const email = !st ? 'Checking whether an e-mail sender is set up…' : st.email.note;
  return [
    ['email', 'E-mail', email, p.email ? null : 'You have no e-mail address on your profile, so nothing can be sent.'],
    ['sms', 'SMS', sms, st?.sms.available && !p.phone ? 'You have no mobile number on your profile, so nothing can be sent.' : null],
    ['push', 'In the app', 'Shown in the bell at the top of every page and in the list below.', null],
  ];
}

export function NotificationsTab({ p, reload }: { p: Profile; reload: () => void | Promise<void> }) {
  const act = useAction(async () => { await reload(); });
  const [prefs, setPrefs] = useState(p.notificationPrefs);
  const status = useApi<ChannelStatus>('/profile/notification-channels');
  const inbox = useApi<{ items: Array<{ id: string; title: string; body: string; createdAt: string; read: boolean; link: string | null }>; unread: number }>('/notifications?limit=10');
  const dirty = JSON.stringify(prefs) !== JSON.stringify(p.notificationPrefs);
  const Row = ({ on, onChange, title, hint, warn }: { on: boolean; onChange: (v: boolean) => void; title: string; hint: string; warn?: string | null }) => (
    <label className="flex min-h-tap items-start gap-3 py-2"><input type="checkbox" className="mt-1" checked={on} onChange={(e) => onChange(e.target.checked)} /><span><span className="block text-subhead font-medium">{title}</span><span className="block text-footnote text-label2">{hint}</span>{warn && on && <span className="block text-footnote text-warning">{warn}</span>}</span></label>
  );
  return (
    <div className="grid max-w-3xl gap-5">
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <Card>
        <h2 className="mb-1 text-title3 font-semibold">How should we reach you?</h2>
        <p className="mb-2 text-footnote text-label2">An alert goes out on every channel you tick, for the kinds of alert you tick below. If one channel fails, the others are not affected and the action that caused the alert is never held up.</p>
        <div className="divide-y divide-separator">{channelRows(p, status.data).map(([k, t, h, w]) => <Row key={k} on={prefs.channels[k]} onChange={(v) => setPrefs({ ...prefs, channels: { ...prefs.channels, [k]: v } })} title={t} hint={h} warn={w} />)}</div>
      </Card>
      <Card>
        <h2 className="mb-1 text-title3 font-semibold">What should we tell you about?</h2>
        <div className="divide-y divide-separator">{EVENTS.map(([k, t, h]) => <Row key={k} on={prefs.events[k]} onChange={(v) => setPrefs({ ...prefs, events: { ...prefs.events, [k]: v } })} title={t} hint={h} />)}</div>
      </Card>
      <Card>
        <h2 className="mb-1 text-title3 font-semibold">Recent alerts in the app</h2>
        {!inbox.data ? null : !inbox.data.items.length ? <p className="text-footnote text-label2">Nothing yet.</p> : (
          <ul className="divide-y divide-separator">{inbox.data.items.map((n) => (
            <li key={n.id} className="py-2"><p className={`text-subhead ${n.read ? '' : 'font-semibold'}`}>{n.title}{!n.read && <span className="sr-only"> (unread)</span>}</p><p className="text-footnote text-label2">{n.body}</p>
              <p className="text-caption text-label3"><time dateTime={n.createdAt}>{new Date(n.createdAt).toLocaleString()}</time>{n.link && <> · <Link className="text-accent" href={n.link}>Open</Link></>}</p></li>
          ))}</ul>
        )}
        {!!inbox.data?.unread && <div className="mt-2"><Button variant="secondary" onClick={() => void post('/notifications/read-all').then(() => inbox.reload())}>Mark all as read</Button></div>}
      </Card>
      <div><Button disabled={!dirty || act.busy} onClick={() => void act.run(() => api('/profile', { method: 'PATCH', json: { notificationPrefs: prefs } }), 'Saved')}>{act.busy ? 'Saving…' : 'Save preferences'}</Button></div>
    </div>
  );
}
