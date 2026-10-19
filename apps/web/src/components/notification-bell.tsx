'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, post } from '@/lib/api';

interface Item { id: string; title: string; body: string; link: string | null; createdAt: string; read: boolean }

/** The bell: the alerts sent to this person "In the app" (My profile → Notifications). Checks again every minute and whenever the window regains focus. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ items: Item[]; unread: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => { try { setData(await api('/notifications?limit=20')); } catch { /* signed out or offline: the bell just stays as it was */ } }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000), f = () => void load();
    window.addEventListener('focus', f);
    return () => { clearInterval(t); window.removeEventListener('focus', f); };
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', key); document.addEventListener('mousedown', away);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', away); };
  }, [open]);
  const read = async (id: string) => { try { await post(`/notifications/${id}/read`); } finally { await load(); } };
  const readAll = async () => { try { await post('/notifications/read-all'); } finally { await load(); } };
  const unread = data?.unread ?? 0;
  return (
    <div ref={box} className="relative">
      <button type="button" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} aria-expanded={open} aria-controls="notification-panel" onClick={() => setOpen(!open)}
        className="relative inline-flex min-h-tap min-w-tap items-center justify-center rounded-control hover:bg-label/[.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
        {unread > 0 && <span aria-hidden className="absolute right-1 top-1 min-w-[18px] rounded-full bg-accent px-1 text-center text-[11px] font-semibold leading-[18px] text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div id="notification-panel" role="region" aria-label="Notifications" className="absolute right-0 z-40 mt-1 w-[min(92vw,22rem)] rounded-card border border-separator bg-surface p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-subhead font-semibold">Notifications</h2>
            <button type="button" disabled={!unread} onClick={() => void readAll()} className="min-h-tap px-2 text-footnote text-accent disabled:text-label3">Mark all as read</button>
          </div>
          {!data?.items.length ? <p className="py-4 text-center text-footnote text-label2">Nothing yet. Alerts you switch on in My profile appear here.</p> : (
            <ul className="max-h-96 divide-y divide-separator overflow-y-auto">
              {data.items.map((n) => (
                <li key={n.id} className="py-2">
                  <div className="flex items-start gap-2">
                    <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? 'bg-transparent' : 'bg-accent'}`} />
                    <div className="min-w-0 flex-1">
                      <p className={`text-subhead ${n.read ? '' : 'font-semibold'}`}>{n.title}{!n.read && <span className="sr-only"> (unread)</span>}</p>
                      <p className="text-footnote text-label2">{n.body}</p>
                      <p className="mt-0.5 text-caption text-label3"><time dateTime={n.createdAt}>{new Date(n.createdAt).toLocaleString()}</time></p>
                      <div className="mt-1 flex gap-3 text-footnote">
                        {n.link && <Link href={n.link} className="text-accent" onClick={() => { setOpen(false); if (!n.read) void read(n.id); }}>Open</Link>}
                        {!n.read && <button type="button" className="text-accent" onClick={() => void read(n.id)}>Mark as read</button>}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 border-t border-separator pt-2 text-footnote"><Link href="/profile?tab=notifications" className="text-accent" onClick={() => setOpen(false)}>Choose which alerts reach you</Link></p>
        </div>
      )}
    </div>
  );
}
