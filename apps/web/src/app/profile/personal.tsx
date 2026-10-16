'use client';
import { Alert, Button, Card, Field, Input } from '@meridian/ui';
import { useRef, useState } from 'react';
import { api, useAction } from '@/lib/api';
import { dt } from '@/lib/format';
import type { Profile } from './page';

/** Shrinks a chosen picture to a small square before it is saved, so the profile stays light on every device. */
async function shrink(file: File, size = 192): Promise<string> {
  const img = await new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('That file is not a picture.')); i.src = URL.createObjectURL(file); });
  const c = document.createElement('canvas'); c.width = c.height = size;
  const side = Math.min(img.width, img.height);
  c.getContext('2d')!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.85);
}
export const Avatar = ({ src, name, size = 64 }: { src: string | null; name: string; size?: number }) => src
  // eslint-disable-next-line @next/next/no-img-element
  ? <img src={src} alt="" width={size} height={size} className="rounded-full object-cover" style={{ width: size, height: size }} />
  : <span aria-hidden className="grid place-items-center rounded-full bg-accent/15 font-semibold text-accent" style={{ width: size, height: size, fontSize: size / 2.6 }}>{name.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('') || '?'}</span>;

export function PersonalTab({ p, reload }: { p: Profile; reload: () => void | Promise<void> }) {
  const act = useAction(async () => { await reload(); });
  const [f, setF] = useState({ displayName: p.displayName, email: p.email ?? '', phone: p.phone ?? '', password: '' });
  const file = useRef<HTMLInputElement>(null);
  const contactChanged = f.email.trim() !== (p.email ?? '') || f.phone.replace(/[\s()-]/g, '') !== (p.phone ?? '');
  const o = p.organisation;
  const save = () => act.run(() => api('/profile', { method: 'PATCH', json: { displayName: f.displayName, email: f.email.trim() || null, phone: f.phone.trim() || null, ...(contactChanged ? { currentPassword: f.password } : {}) } }), 'Saved').then((ok) => { if (ok) setF((x) => ({ ...x, password: '' })); });
  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fl = e.target.files?.[0]; e.target.value = '';
    if (!fl) return;
    try { const data = await shrink(fl); await act.run(() => api('/profile', { method: 'PATCH', json: { avatar: data } }), 'Picture updated'); } catch (err) { alert((err as Error).message); }
  };
  if (p.isSuperuser) return <Alert tone="info">The super user’s name and password are set in the server’s environment, so there is nothing to edit here.</Alert>;
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
      <Card className="space-y-4">
        <div className="flex items-center gap-4">
          <Avatar src={p.avatar} name={p.displayName} size={72} />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => file.current?.click()} disabled={act.busy}>Change picture</Button>
            {p.avatar && <Button variant="plain" disabled={act.busy} onClick={() => void act.run(() => api('/profile', { method: 'PATCH', json: { avatar: null } }), 'Picture removed')}>Remove</Button>}
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void pick(e)} />
          </div>
        </div>
        {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={f.displayName} maxLength={100} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
          <Field label="Username" hint="Set by an administrator."><Input value={p.username} readOnly disabled /></Field>
          <Field label="E-mail" hint="Used for password recovery and codes."><Input type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Mobile number" hint="With country code, for example +6591234567."><Input type="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          {contactChanged && <div className="sm:col-span-2"><Field label="Current password" hint="Needed to change your e-mail or mobile number, because they are used to recover your account."><Input type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field></div>}
        </div>
        <Button onClick={() => void save()} disabled={act.busy || !f.displayName.trim() || (contactChanged && !f.password)}>{act.busy ? 'Saving…' : 'Save'}</Button>
      </Card>
      <Card className="h-fit space-y-3">
        <h2 className="text-title3 font-semibold">Where you work</h2>
        <dl className="space-y-2 text-subhead">
          <div><dt className="text-footnote text-label2">Role</dt><dd>{p.roles.join(', ') || '—'}</dd></div>
          <div><dt className="text-footnote text-label2">Store</dt><dd>{o.storeId ? `${o.storeName ?? o.storeId} (${o.storeId})` : '—'}</dd></div>
          <div><dt className="text-footnote text-label2">Dealer</dt><dd>{o.dealerId ? `${o.dealerName ?? o.dealerId} (${o.dealerId})` : '—'}</dd></div>
          <div><dt className="text-footnote text-label2">Last sign-in</dt><dd>{p.lastLoginAt ? dt(p.lastLoginAt) : '—'}</dd></div>
        </dl>
        <p className="text-footnote text-label2">Your role and where you work are set by an administrator.</p>
      </Card>
    </div>
  );
}
