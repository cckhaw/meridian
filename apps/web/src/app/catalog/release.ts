'use client';
import { useSyncExternalStore } from 'react';
import { api, del as rawDel, patch as rawPatch, post as rawPost } from '@/lib/api';

/**
 * The release the person is working in, if any. While one is selected, every catalog write on the Catalog screens is staged in it (`?release=<id>`) instead of going live,
 * and the forms start from the staged state. With none selected nothing here changes anything: the paths and calls are exactly the ones the screens always made.
 * (Reordering applies at once and the CSV import and bundle discounts do not go through releases.)
 */
const KEY = 'meridian.catalog.release';
const EVENT = 'meridian:release-changed';
const listeners = new Set<() => void>();
let current: string | null | undefined;

function read(): string | null {
  if (current === undefined) { try { current = window.localStorage.getItem(KEY); } catch { current = null; } }
  return current ?? null;
}
export function setActiveRelease(id: string | null) {
  current = id;
  try { if (id) window.localStorage.setItem(KEY, id); else window.localStorage.removeItem(KEY); } catch { /* the choice just does not survive a reload */ }
  listeners.forEach((l) => l());
}
/** The id of the release being worked in, or null. Re-renders when it changes. */
export function useActiveReleaseId(): string | null {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, read, () => null);
}
/** Tells whoever shows the release (the bar, the release page) that its changes moved. */
export const releaseChanged = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT)); };
export const RELEASE_EVENT = EVENT;

const SKIP = /\/reorder(\?|$)/;
/** A catalog path scoped to the release being worked in. Only writes and reads of one node's state; the rest (lists, health, releases themselves) are never scoped. */
export function inRelease(path: string, id: string | null = read()): string {
  if (!id || SKIP.test(path)) return path;
  return `${path}${path.includes('?') ? '&' : '?'}release=${encodeURIComponent(id)}`;
}
const scoped = (path: string) => (/^\/catalog(\/[^/?]+)?(\/(move|line-items\/copy-from))?(\?|$)/.test(path) && !/^\/catalog\/(releases|health|browse|search|summary)/.test(path) ? inRelease(path) : path);
const after = <T,>(r: T): T => { if ((r as { staged?: boolean } | null)?.staged) releaseChanged(); return r; };
export const post = async <T = any>(path: string, json?: unknown): Promise<T> => after(await rawPost<T>(scoped(path), json));
export const patch = async <T = any>(path: string, json: unknown): Promise<T> => after(await rawPatch<T>(scoped(path), json));
export const del = async <T = any>(path: string): Promise<T> => after(await rawDel<T>(scoped(path)));
/** The detail of a node for a form to start from: as the release would leave it, while one is selected. */
export const detailPath = (id: string) => inRelease(`/catalog/${encodeURIComponent(id)}/detail`);
export { api };
