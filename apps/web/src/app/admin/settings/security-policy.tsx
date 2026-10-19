'use client';
import { Alert, Button, Card, Field, Input, SectionTitle, Select, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';

interface Policy {
  password: { minLength: number; requireUpper: boolean; requireLower: boolean; requireDigit: boolean; requireSymbol: boolean; maxAgeDays: number; historyCount: number };
  lockout: { maxFailures: number; lockMinutes: number };
  session: { idleMinutes: number; absoluteHours: number; strictRoleIds: string[]; strictIdleMinutes: number };
  recovery: { enabled: boolean; channel: 'EMAIL' | 'SMS' | 'EITHER'; tokenMinutes: number; maxRequestsPerHour: number; publicUrl: string };
  mfa: { requirement: 'OFF' | 'ROLES' | 'ALL'; roleIds: string[]; methods: Array<'TOTP' | 'SMS' | 'EMAIL'>; challengeMinutes: number };
  email: { codesEnabled: boolean; signedCopyFirst: 'GATEWAY' | 'EMAIL' };
}
interface Sender { enabled: boolean; mode: 'API' | 'SMTP' | 'SIMULATOR' | null; name: string | null; from: string | null; lastTest: { ok: boolean; at: string; error: string | null } | null }
interface View { policy: Policy; defaults: Policy; emailSender: Sender }
const Check = ({ checked, onChange, children, hint }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; hint?: string }) => (
  <label className="flex items-start gap-2 text-subhead"><input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} /> <span>{children}{hint && <span className="block text-footnote text-label2">{hint}</span>}</span></label>
);
const n = (v: string) => (v === '' ? 0 : Number(v));

/** Settings → Security policy: how strong passwords must be, when accounts lock, when idle screens sign out, and how a forgotten password is recovered. */
export function SecurityPolicySettings() {
  const view = useApi<View>('/settings/security-policy');
  const roles = useApi<Array<{ id: string; label: string }>>('/roles');
  const act = useAction(async () => { await view.reload(); });
  const [draft, setDraft] = useState<Policy | null>(null);
  if (view.error) return <Alert>{view.error}</Alert>;
  if (!view.data) return <Spinner />;
  const p = draft ?? view.data.policy;
  const set = (patch: Partial<Policy>) => setDraft({ ...p, ...patch });
  const save = async () => { if (await act.run(() => post('/settings/security-policy', p), 'Saved. It applies from the next request.')) setDraft(null); };
  const pw = p.password, lo = p.lockout, se = p.session, re = p.recovery, mf = p.mfa, em = p.email, snd = view.data.emailSender;
  const toggleMfaRole = (id: string, on: boolean) => set({ mfa: { ...mf, roleIds: on ? [...mf.roleIds, id] : mf.roleIds.filter((x) => x !== id) } });
  const toggleMethod = (m: 'TOTP' | 'SMS' | 'EMAIL', on: boolean) => set({ mfa: { ...mf, methods: on ? [...mf.methods, m] : mf.methods.filter((x) => x !== m) } });
  const toggleRole = (id: string, on: boolean) => set({ session: { ...se, strictRoleIds: on ? [...se.strictRoleIds, id] : se.strictRoleIds.filter((x) => x !== id) } });
  return (
    <div className="space-y-6">
      <Card><p className="text-subhead text-label2">These rules apply to every password and sign-in. <strong className="text-label">Until you save, the defaults are what they were before</strong>: 12 characters, lock after 5 failures for 15 minutes, 30 minutes idle. A change applies at once. The super user’s password is set in the server’s environment and is not subject to expiry or history.</p></Card>
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}

      <section aria-label="Passwords" className="space-y-3">
        <SectionTitle>Passwords</SectionTitle>
        <Card className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Shortest password" hint="8 to 64 characters"><Input type="number" min={8} max={64} value={pw.minLength} onChange={(e) => set({ password: { ...pw, minLength: n(e.target.value) } })} /></Field>
            <Field label="Expire after (days)" hint="0 = never. The person must choose a new one at their next sign-in."><Input type="number" min={0} max={3650} value={pw.maxAgeDays} onChange={(e) => set({ password: { ...pw, maxAgeDays: n(e.target.value) } })} /></Field>
            <Field label="Do not reuse the last" hint="0 = no check. Up to 24 passwords."><Input type="number" min={0} max={24} value={pw.historyCount} onChange={(e) => set({ password: { ...pw, historyCount: n(e.target.value) } })} /></Field>
          </div>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-1 text-footnote font-medium text-label2">A password must contain</legend>
            <Check checked={pw.requireUpper} onChange={(v) => set({ password: { ...pw, requireUpper: v } })}>An uppercase letter</Check>
            <Check checked={pw.requireLower} onChange={(v) => set({ password: { ...pw, requireLower: v } })}>A lowercase letter</Check>
            <Check checked={pw.requireDigit} onChange={(v) => set({ password: { ...pw, requireDigit: v } })}>A number</Check>
            <Check checked={pw.requireSymbol} onChange={(v) => set({ password: { ...pw, requireSymbol: v } })}>A symbol</Check>
          </fieldset>
          <p className="text-footnote text-label2">Always checked, whatever you choose: common passwords are refused, the password must not contain the username, and it must use at least five different characters.</p>
        </Card>
      </section>

      <section aria-label="Account lockout" className="space-y-3">
        <SectionTitle>Account lockout</SectionTitle>
        <Card className="grid gap-3 sm:grid-cols-2">
          <Field label="Lock an account after (failed sign-ins)" hint="3 to 20"><Input type="number" min={3} max={20} value={lo.maxFailures} onChange={(e) => set({ lockout: { ...lo, maxFailures: n(e.target.value) } })} /></Field>
          <Field label="Keep it locked for (minutes)" hint="An administrator can unlock it sooner."><Input type="number" min={1} max={1440} value={lo.lockMinutes} onChange={(e) => set({ lockout: { ...lo, lockMinutes: n(e.target.value) } })} /></Field>
        </Card>
      </section>

      <section aria-label="Sessions" className="space-y-3">
        <SectionTitle>Sessions</SectionTitle>
        <Card className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Sign out after idle (minutes)" hint="5 to 720"><Input type="number" min={5} max={720} value={se.idleMinutes} onChange={(e) => set({ session: { ...se, idleMinutes: n(e.target.value) } })} /></Field>
            <Field label="Longest a session can last (hours)" hint="Even when active. 1 to 72."><Input type="number" min={1} max={72} value={se.absoluteHours} onChange={(e) => set({ session: { ...se, absoluteHours: n(e.target.value) } })} /></Field>
          </div>
          <fieldset>
            <legend className="mb-1 text-footnote font-medium text-label2">Sign these roles out sooner (counter and call-centre screens that others can walk up to)</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {(roles.data ?? []).map((r) => <Check key={r.id} checked={se.strictRoleIds.includes(r.id)} onChange={(v) => toggleRole(r.id, v)}>{r.label}</Check>)}
            </div>
            {se.strictRoleIds.length > 0 && <div className="mt-3 max-w-xs"><Field label="Their idle limit (minutes)"><Input type="number" min={5} max={720} value={se.strictIdleMinutes} onChange={(e) => set({ session: { ...se, strictIdleMinutes: n(e.target.value) } })} /></Field></div>}
          </fieldset>
        </Card>
      </section>

      <section aria-label="Two-step sign-in" className="space-y-3">
        <SectionTitle>Two-step sign-in (MFA)</SectionTitle>
        <Card className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Require a second step for" hint="Otherwise people can still turn it on themselves in My profile."><Select value={mf.requirement} onChange={(e) => set({ mfa: { ...mf, requirement: e.target.value as Policy['mfa']['requirement'] } })}><option value="OFF">Nobody (optional)</option><option value="ROLES">Chosen roles</option><option value="ALL">Everyone</option></Select></Field>
            <Field label="A sign-in code stays valid (minutes)" hint="1 to 30"><Input type="number" min={1} max={30} value={mf.challengeMinutes} onChange={(e) => set({ mfa: { ...mf, challengeMinutes: n(e.target.value) } })} /></Field>
          </div>
          {mf.requirement === 'ROLES' && (
            <fieldset><legend className="mb-1 text-footnote font-medium text-label2">Roles that must use it</legend>
              <div className="grid gap-1 sm:grid-cols-2">{(roles.data ?? []).map((r) => <Check key={r.id} checked={mf.roleIds.includes(r.id)} onChange={(v) => toggleMfaRole(r.id, v)}>{r.label}</Check>)}</div></fieldset>)}
          <fieldset><legend className="mb-1 text-footnote font-medium text-label2">Ways people can do it</legend>
            <div className="grid gap-1 sm:grid-cols-3">
              <Check checked={mf.methods.includes('TOTP')} onChange={(v) => toggleMethod('TOTP', v)}>Authenticator app</Check>
              <Check checked={mf.methods.includes('SMS')} onChange={(v) => toggleMethod('SMS', v)}>SMS code</Check>
              <Check checked={mf.methods.includes('EMAIL')} onChange={(v) => toggleMethod('EMAIL', v)} hint={em.codesEnabled ? undefined : 'Not offered while e-mail codes are off (see E-mail codes below).'}>E-mail code</Check>
            </div></fieldset>
          <p className="text-footnote text-label2">People who are required to use it and have not set it up can only reach My profile until they do. SMS and e-mail codes go through the notification outbox; the SMS gateway is set under Integration. The super user’s credentials live in the environment, so a second step does not apply to that account; an administrator can clear a lost second step from Users &amp; roles.</p>
        </Card>
      </section>

      <section aria-label="E-mail codes" className="space-y-3">
        <SectionTitle>E-mail codes</SectionTitle>
        <Card className="space-y-4">
          <Check checked={em.codesEnabled} onChange={(v) => set({ email: { ...em, codesEnabled: v } })} hint="When off, the e-mail second step is not offered at sign-in, in My profile or on the fibre hub, and a forgotten password is not recovered by e-mail. When on, it still needs an enabled e-mail sender in Integration.">Allow sign-in and recovery codes by e-mail</Check>
          <div className="text-subhead" role="status">
            E-mail sender: {!snd.enabled ? <strong className={em.codesEnabled ? 'text-danger' : ''}>none is switched on</strong> : snd.mode === 'SIMULATOR' ? <strong className="text-warning">{snd.name} (simulator: nothing is delivered)</strong> : <strong>{snd.name}, sending as {snd.from} through {snd.mode === 'SMTP' ? 'SMTP' : 'an HTTPS API'}</strong>}.{' '}
            <Link className="text-accent" href="/admin/integrations?item=email-gateway">Open Integration → Messaging → E-mail sender ›</Link>
            {em.codesEnabled && !snd.enabled && <p className="mt-1 text-danger">The switch is on, but no e-mail sender is enabled, so no code is sent by e-mail and e-mail is not offered anywhere until one is.</p>}
            {em.codesEnabled && snd.enabled && snd.mode === 'SIMULATOR' && <p className="mt-1 text-warning">The sender only simulates, so nobody receives the codes.</p>}
            {!em.codesEnabled && snd.enabled && <p className="mt-1 text-label2">A sender is ready, but e-mail codes are off.</p>}
          </div>
          <p className="text-footnote text-label2">E-mail codes have six digits and last as long as the SMS ones: {mf.challengeMinutes} minutes for a sign-in code (A sign-in code stays valid, above) and {re.tokenMinutes} minutes for a recovery link or code (Works for, below).</p>
          <Field label="Signed agreement copies go first by" hint="Used when a customer has both a mobile number and an e-mail address; the other channel is the fall-back if the first fails. A customer with only one is sent that one. Needs the SMS / WhatsApp gateway or the e-mail sender in Integration, whichever you choose."><Select value={em.signedCopyFirst} onChange={(e) => set({ email: { ...em, signedCopyFirst: e.target.value as Policy['email']['signedCopyFirst'] } })}><option value="GATEWAY">SMS / WhatsApp gateway, then e-mail</option><option value="EMAIL">E-mail, then SMS / WhatsApp gateway</option></Select></Field>
        </Card>
      </section>

      <section aria-label="Password recovery" className="space-y-3">
        <SectionTitle>Forgotten passwords</SectionTitle>
        <Card className="space-y-4">
          <Check checked={re.enabled} onChange={(v) => set({ recovery: { ...re, enabled: v } })} hint="Shows “Forgot your password?” on the sign-in page. Accounts are never revealed: the answer is the same for everyone.">Let people reset their own password</Check>
          {re.enabled && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Send the link or code by"><Select value={re.channel} onChange={(e) => set({ recovery: { ...re, channel: e.target.value as Policy['recovery']['channel'] } })}><option value="EITHER">E-mail, or SMS if there is no e-mail</option><option value="EMAIL">E-mail only</option><option value="SMS">SMS only</option></Select></Field>
              <Field label="Works for (minutes)" hint="5 to 1440. Single use."><Input type="number" min={5} max={1440} value={re.tokenMinutes} onChange={(e) => set({ recovery: { ...re, tokenMinutes: n(e.target.value) } })} /></Field>
              <Field label="Requests per person per hour" hint="1 to 20"><Input type="number" min={1} max={20} value={re.maxRequestsPerHour} onChange={(e) => set({ recovery: { ...re, maxRequestsPerHour: n(e.target.value) } })} /></Field>
              <Field label="Public address of this site" hint="https://crm.example.com. Reset links are built from it so they cannot be forged. Leave empty and e-mail carries a six-digit code instead of a link."><Input value={re.publicUrl} placeholder="https://" onChange={(e) => set({ recovery: { ...re, publicUrl: e.target.value } })} /></Field>
            </div>)}
          <p className="text-footnote text-label2">A link or code by e-mail goes out through the e-mail sender (only while e-mail codes are allowed below); a code by SMS goes through the SMS / WhatsApp gateway. Both are set up under Integration → Messaging. People need an e-mail address or mobile number on their account.</p>
        </Card>
      </section>

      <div className="flex flex-wrap gap-2">
        <Button disabled={act.busy || !draft} onClick={() => void save()}>Save</Button>
        {draft && <Button variant="secondary" onClick={() => setDraft(null)}>Discard changes</Button>}
        <Button variant="secondary" onClick={() => setDraft({ ...view.data!.defaults })}>Reset to the defaults</Button>
      </div>
    </div>
  );
}
