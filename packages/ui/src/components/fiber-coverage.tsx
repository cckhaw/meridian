'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Input } from './forms';
import { Badge, Button } from './primitives';

/**
 * The fibre coverage check at address entry, shared by the CRM order screen and the store-front. It asks the coverage service (through the app's own API)
 * whether the address can be served and, when it can, holds a port for the customer while they finish ordering. The parent only supplies the address, the speed
 * wanted and four calls; it gets back the id of the held port to put on the order.
 */
export interface FiberApi {
  qualify: (p: { address?: string; postalCode?: string; speedMbps?: number }) => Promise<any>;
  reserve: (p: { providerId: string; dpId?: string; speedMbps?: number; lat?: number; lng?: number; address?: string }) => Promise<any>;
  release: (id: string) => Promise<unknown>;
  waitlist: (p: { providerId: string; dpId?: string; contact?: string; lat?: number; lng?: number; address?: string; speedMbps?: number }) => Promise<unknown>;
}
const tiers = (a: number[]) => (a.length ? a.map((x) => (x >= 1000 ? `${x / 1000} Gbps` : `${x} Mbps`)).join(', ') : '');
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function FiberCoverageCheck({ address, speedMbps, lock, onLock, api, who = 'the customer' }: { address: string; speedMbps?: number; lock: string | null; onLock: (id: string | null) => void; api: FiberApi; who?: string }) {
  const [r, setR] = useState<any>(null);
  const [held, setHeld] = useState<{ id: string; expiresAt: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contact, setContact] = useState('');
  const [waiting, setWaiting] = useState(false);
  const last = useRef(address);
  const heldId = useRef<string | null>(null); heldId.current = held?.id ?? null;

  // A different address is a different answer: forget the check and let go of the port held for the old one.
  useEffect(() => {
    if (last.current === address) return;
    last.current = address;
    if (heldId.current) void api.release(heldId.current).catch(() => {});
    setR(null); setHeld(null); setError(null); setWaiting(false); onLock(null);
  }, [address]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!lock && held) setHeld(null); }, [lock]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = async () => {
    setBusy(true); setError(null); setWaiting(false);
    try {
      if (heldId.current) { await api.release(heldId.current).catch(() => {}); setHeld(null); onLock(null); }
      const q = await api.qualify({ address: address.trim(), speedMbps });
      setR(q);
      const best = q.recommended;
      if (best) {
        try {
          const h = await api.reserve({ providerId: best.providerId, dpId: best.dp?.id, speedMbps, lat: q.location.lat, lng: q.location.lng, address: address.trim() });
          setHeld({ id: h.id, expiresAt: h.expiresAt }); onLock(h.id);
        } catch (e) { setError(`${(e as Error).message} The address can still be ordered; the port is confirmed afterwards.`); }
      }
    } catch (e) { setR(null); setError((e as Error).message); } finally { setBusy(false); }
  };
  const release = async () => { if (!held) return; setBusy(true); try { await api.release(held.id); setHeld(null); onLock(null); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const join = async () => {
    const opt = r.options.find((o: any) => o.status === 'PORT_EXHAUSTED_WAITLIST'); if (!opt) return;
    setBusy(true); setError(null);
    try { await api.waitlist({ providerId: opt.providerId, dpId: opt.dp?.id, contact: contact.trim() || undefined, lat: r.location.lat, lng: r.location.lng, address: address.trim(), speedMbps }); setWaiting(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const best = r?.recommended;
  const full = r && !best && r.availability === 'PORT_EXHAUSTED_WAITLIST';
  return (
    <div className="rounded-control bg-surface2 p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><p className="text-subhead font-semibold">Fibre coverage</p><p className="text-footnote text-label2">Checks that fibre reaches {who === 'you' ? 'your' : `${who}’s`} address and holds a port while the order is finished.</p></div>
        <Button variant="secondary" disabled={busy || address.trim().length < 5} onClick={() => void check()}>{busy ? 'Checking…' : r ? 'Check again' : 'Check coverage'}</Button>
      </div>
      {address.trim().length < 5 && <p className="mt-2 text-footnote text-label2">Enter the installation address first.</p>}
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      {r && (
        <div className="mt-3 space-y-2">
          {best && (
            <div className="rounded-control bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2"><Badge tone="success">Fibre available</Badge><span className="text-subhead font-medium">{best.providerName}</span></div>
              <p className="mt-1 text-subhead text-label2">Speeds up to {tiers(best.speedTiersMbps.slice(-1))}{best.estimatedInstallDays != null ? ` · installation in about ${best.estimatedInstallDays} days` : ''}{best.ports ? ` · ${best.ports.available} port${best.ports.available === 1 ? '' : 's'} free nearby` : ''}.</p>
              {held && <p className="mt-1 text-footnote text-label2">A port is held for {who === 'you' ? 'you' : who}{held.expiresAt ? ` until ${clock(held.expiresAt)}` : ''}. <button type="button" className="text-accent" onClick={() => void release()}>Release it</button></p>}
            </div>)}
          {full && (
            <div className="rounded-control bg-surface p-3">
              <div className="flex items-center gap-2"><Badge tone="warning">No free port right now</Badge></div>
              <p className="mt-1 text-subhead text-label2">Fibre reaches this address but every port on the nearest box is taken. {waiting ? 'Added to the waitlist: we will get in touch when one is free.' : 'Join the waitlist and we will get in touch when one is free.'}</p>
              {!waiting && <div className="mt-2 flex flex-wrap gap-2"><Input aria-label="Phone or e-mail for the waitlist" placeholder="Phone or e-mail" value={contact} onChange={(e) => setContact(e.target.value)} className="max-w-xs" /><Button variant="secondary" disabled={busy || contact.trim().length < 5} onClick={() => void join()}>Join the waitlist</Button></div>}
            </div>)}
          {r.availability === 'UNSERVICEABLE' && <div className="rounded-control bg-surface p-3"><Badge tone="danger">Not available here</Badge><p className="mt-1 text-subhead text-label2">No fibre network reaches this address yet. {who === 'you' ? 'You' : 'The customer'} can choose a mobile plan instead, or try another address.</p></div>}
          {r.availability === 'UNKNOWN' && <div className="rounded-control bg-surface p-3"><Badge>Could not confirm</Badge><p className="mt-1 text-subhead text-label2">The network partner did not answer in time. The order can go ahead; the address is confirmed afterwards and {who === 'you' ? 'you are' : 'the customer is'} told if it cannot be served.</p></div>}
          {r.partial && best && <p className="text-footnote text-label2">Some networks could not be reached just now, so there may be other options.</p>}
        </div>)}
    </div>
  );
}
