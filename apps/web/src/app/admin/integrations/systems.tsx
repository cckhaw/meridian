'use client';
import { Badge, Card } from '@meridian/ui';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { dt } from '@/lib/format';
import { AuthConnections } from './authentication';
import { EmailSender } from './email-sender';
import { EndpointManager, type Hub } from './integration-hub';
import { OcsPanel } from './ocs';
import { IdentityConnections } from './identity';
import { KycPanel, PaymentsPanel, StorefrontPanel } from './storefront';

export type Status = 'CONNECTED' | 'NEEDS_SETUP' | 'LISTENING' | 'WAITING' | 'MANUAL' | 'STAND_IN' | 'REMOTE';
export interface Item {
  id: string; group: string; name: string; with: string; summary: string; maturity: 'BUILT' | 'OUTBOX' | 'ENDPOINT' | 'MANUAL' | 'STUB'; direction: 'OUT' | 'IN' | 'BOTH'; keywords?: string; doc?: string;
  env?: Array<{ name: string; purpose: string; on: string; required?: boolean }>;
  endpoints?: Array<{ method: string; path: string; purpose: string; auth: string }>;
  outbox?: { kind: string; instructions: string[] };
  needs: string[]; configure?: { label: string; href: string };
  state: { status: Status; detail: string; env: Array<{ name: string; set: boolean | null }>; pending: number; delivered: number; lastDeliveredAt: string | null; oldestPendingAt: string | null };
}
export interface Overview { groups: string[]; items: Item[]; outbox: Array<{ kind: string; instruction: string; pending: number; delivered: number }> }

export const STATUS: Record<Status, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger'; bucket: 'working' | 'action' | 'hand' }> = {
  CONNECTED: { label: 'Connected', tone: 'success', bucket: 'working' },
  REMOTE: { label: 'Set elsewhere', tone: 'success', bucket: 'working' },
  LISTENING: { label: 'Ready for calls', tone: 'neutral', bucket: 'working' },
  NEEDS_SETUP: { label: 'Needs setup', tone: 'warning', bucket: 'action' },
  WAITING: { label: 'Needs a connector', tone: 'warning', bucket: 'action' },
  MANUAL: { label: 'By hand', tone: 'neutral', bucket: 'hand' },
  STAND_IN: { label: 'Stand-in', tone: 'neutral', bucket: 'hand' },
};
const MATURITY: Record<Item['maturity'], string> = {
  BUILT: 'Built in: needs configuring', OUTBOX: 'Meridian queues instructions; a connector delivers them', ENDPOINT: 'Meridian offers an API; the other system calls it',
  MANUAL: 'No connector: done by hand', STUB: 'Interface exists; a stand-in answers',
};
const DIRECTION: Record<Item['direction'], string> = { OUT: 'Meridian sends', IN: 'Meridian receives', BOTH: 'Both ways' };
const FILTERS = [{ value: 'all', label: 'All' }, { value: 'action', label: 'Needs action' }, { value: 'working', label: 'Working' }, { value: 'hand', label: 'By hand' }] as const;

/** Item id → the kinds of hub connection that belong to it, so a system's address and credentials are edited on the system itself. */
export const ITEM_KINDS: Record<string, string[]> = {
  'network-provisioning': ['HLR_HSS', 'UDM', 'PCRF'], esim: ['SMDP_PLUS'], ocs: ['OCS'], wfm: ['WFM_GATEWAY', 'SLOT_SYNC'], 'payment-webhook': ['PAYMENT_GATEWAY'],
  sap: ['SAP_FICO'], 'sso-oidc': ['IDP_OIDC'], 'sso-saml': ['IDP_SAML'], ldap: ['LDAP'], 'otp-gateway': ['OTP_GATEWAY'], 'credit-bureau': ['CREDIT_BUREAU'], 'event-bus': ['EVENT_BUS'],
};

const AUTH_KIND: Record<string, 'IDP_OIDC' | 'IDP_SAML' | 'LDAP' | 'OTP_GATEWAY'> = { 'sso-oidc': 'IDP_OIDC', 'sso-saml': 'IDP_SAML', ldap: 'LDAP', 'otp-gateway': 'OTP_GATEWAY' };

/** The systems of one area: each a card with its status, and, opened, what it is for, what to provide, and its connection details. */
export function SystemList({ items, hub, reload, target }: { items: Item[]; hub: Hub; reload: () => void | Promise<void>; target?: string | null }) {
  const [open, setOpen] = useState<Set<string>>(new Set(target ? [target] : []));
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  useEffect(() => {
    if (!target) return;
    setOpen((s) => new Set(s).add(target));
    const t = setTimeout(() => document.getElementById(`int-${target}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
    return () => clearTimeout(t);
  }, [target]);
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  if (!items.length) return <Card><p className="text-subhead text-label2">Nothing here.</p></Card>;
  return <ul className="space-y-3">{items.map((i) => <li key={i.id}><Row item={i} open={open.has(i.id)} onToggle={() => toggle(i.id)} origin={origin} hub={hub} reload={reload} /></li>)}</ul>;
}

export function Count({ n, label, tone }: { n: number; label: string; tone: string }) {
  return <div className="rounded-card bg-surface p-3 shadow-card sm:p-4"><div className={`text-title1 font-bold tabular-nums ${tone}`}>{n}</div><div className="text-footnote text-label2">{label}</div></div>;
}

function Row({ item: i, open, onToggle, origin, hub, reload }: { item: Item; open: boolean; onToggle: () => void; origin: string; hub: Hub; reload: () => void | Promise<void> }) {
  const st = STATUS[i.state.status];
  const panel = `int-panel-${i.id}`;
  return (
    <div id={`int-${i.id}`} className="scroll-mt-4 overflow-hidden rounded-card bg-surface shadow-card">
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={panel}
        className="flex min-h-[64px] w-full items-start gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{i.name}</span>
          <span className="block text-footnote text-label2">{i.with}</span>
          <span className="mt-1 block text-subhead text-label2">{i.state.detail}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge tone={st.tone}>{st.label}</Badge>
          {i.state.pending > 0 && <span className="text-caption text-label2">{i.state.pending} waiting</span>}
          <span aria-hidden className={`text-label2 transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        </span>
      </button>
      {open && (
        <div id={panel} className="space-y-4 border-t border-separator px-4 py-4 text-subhead">
          <p>{i.summary}</p>
          <dl className="grid gap-x-6 gap-y-1 text-footnote sm:grid-cols-2">
            <div><dt className="inline text-label2">How it works: </dt><dd className="inline">{MATURITY[i.maturity]}</dd></div>
            <div><dt className="inline text-label2">Direction: </dt><dd className="inline">{DIRECTION[i.direction]}</dd></div>
          </dl>

          <Block title="What you need to do">
            <ul className="list-disc space-y-1 pl-5">{i.needs.map((n) => <li key={n}>{n}</li>)}</ul>
          </Block>

          {i.state.env.length > 0 && (
            <Block title="Settings in the environment">
              <ul className="divide-y divide-separator rounded-control bg-surface2">
                {i.env!.map((v, n) => {
                  const set = i.state.env[n]?.set;
                  return (
                    <li key={v.name} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
                      <div className="min-w-0 sm:flex-1"><code className="break-all text-footnote font-medium">{v.name}</code><div className="text-footnote text-label2">{v.purpose}</div></div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-caption text-label2">on {v.on === 'web' ? 'this portal' : `the ${v.on}`}{v.required ? ', required' : ''}</span>
                        {set === null ? <Badge>Not visible here</Badge> : <Badge tone={set ? 'success' : v.required ? 'warning' : 'neutral'}>{set ? 'Set' : 'Not set'}</Badge>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Block>
          )}

          {i.endpoints && i.endpoints.length > 0 && (
            <Block title={i.direction === 'OUT' ? 'API a connector uses' : 'API the other system calls'}>
              <ul className="space-y-2">
                {i.endpoints.map((e) => (
                  <li key={`${e.method} ${e.path}`} className="rounded-control bg-surface2 px-3 py-2">
                    <div className="flex items-start gap-2"><span className="shrink-0 rounded bg-label/10 px-1.5 py-0.5 text-caption font-semibold">{e.method}</span><code className="min-w-0 break-all text-footnote">{origin}{e.path}</code></div>
                    <div className="mt-1 text-footnote text-label2">{e.purpose}. <span className="whitespace-nowrap">Auth: {e.auth}.</span></div>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {i.outbox && (
            <Block title={`Instructions Meridian queues (${i.outbox.kind})`}>
              <div className="flex flex-wrap gap-1.5">{i.outbox.instructions.map((x) => <code key={x} className="rounded bg-surface2 px-2 py-0.5 text-footnote">{x}</code>)}</div>
              <p className="mt-2 text-footnote text-label2">
                {i.state.pending} waiting, {i.state.delivered} delivered{i.state.lastDeliveredAt ? `, last delivered ${dt(i.state.lastDeliveredAt)}` : ''}{i.state.oldestPendingAt ? `. Oldest waiting since ${dt(i.state.oldestPendingAt)}` : ''}.
              </p>
            </Block>
          )}

          {i.id === 'storefront' && <StorefrontPanel />}
          {i.id === 'stripe' && <PaymentsPanel />}
          {i.id === 'ekyc' && <><KycPanel /><IdentityConnections kind="KYC_OCR" h={hub} reload={reload} /></>}
          {i.id === 'mydigitalid' && <IdentityConnections kind="KYC_MYDIGITALID" h={hub} reload={reload} />}
          {i.id === 'ocs' && <OcsPanel />}

          {i.id === 'email-gateway' ? <EmailSender h={hub} reload={reload} /> : AUTH_KIND[i.id] ? <AuthConnections kind={AUTH_KIND[i.id]!} h={hub} reload={reload} /> : ITEM_KINDS[i.id] && <EndpointManager kinds={ITEM_KINDS[i.id]!} h={hub} reload={reload} />}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-footnote">
            {i.configure && !['storefront', 'stripe', 'ekyc', 'ocs'].includes(i.id) && <Link href={i.configure.href} className="inline-flex min-h-[32px] items-center text-accent">{i.configure.label} ›</Link>}
            {i.doc && <span className="text-label2">Guide: docs/{i.doc}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return <div><h3 className="mb-1.5 text-footnote font-semibold uppercase tracking-wide text-label2">{title}</h3>{children}</div>;
}
