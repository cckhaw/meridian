'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Full-screen viewer for the pictures a compliance officer has to judge: zoom (buttons, wheel, pinch, double tap), rotate in quarter turns, drag to pan,
 * and step through the case's pictures. Drawn on the page itself (not inside the screen that opened it) so a blurred or transformed parent can never offset it.
 * Keys: + − 0 (fit) R / Shift+R (rotate) ← → (previous, next) Esc.
 */
export interface ViewerItem { src: string; label: string }
const MIN = 1, MAX = 8;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function ImageViewer({ items, index, onIndex, onClose }: { items: ViewerItem[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const item = items[index];
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; zoom: number } | null>(null);

  const reset = useCallback(() => { setZoom(1); setRot(0); setPan({ x: 0, y: 0 }); }, []);
  useEffect(() => { reset(); setNat(null); }, [item?.src, reset]);

  useLayoutEffect(() => {
    const el = stage.current; if (!el) return;
    const read = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The picture is fitted to the space, as it looks after rotating; zoom is relative to that fit.
  const turned = rot % 180 !== 0;
  const fit = nat && box.w && box.h ? Math.min(box.w / (turned ? nat.h : nat.w), box.h / (turned ? nat.w : nat.h)) : 1;
  const setZoomKeepingPan = useCallback((z: number) => { const next = clamp(z, MIN, MAX); setZoom(next); if (next === 1) setPan({ x: 0, y: 0 }); }, []);
  const turn = useCallback((d: 90 | -90) => { setRot((r) => (r + d + 360) % 360); setPan({ x: 0, y: 0 }); }, []);
  const step = useCallback((d: 1 | -1) => { if (items.length > 1) onIndex((index + d + items.length) % items.length); }, [index, items.length, onIndex]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') setZoomKeepingPan(zoom * 1.4);
      else if (e.key === '-') setZoomKeepingPan(zoom / 1.4);
      else if (e.key === '0') reset();
      else if (e.key === 'r' || e.key === 'R') turn(e.shiftKey ? -90 : 90);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', k);
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = overflow; };
  }, [zoom, onClose, reset, setZoomKeepingPan, step, turn]);

  // Wheel zoom needs a non-passive listener so the page behind does not scroll.
  useEffect(() => {
    const el = stage.current; if (!el) return;
    const w = (e: WheelEvent) => { e.preventDefault(); setZoomKeepingPan(zoom * Math.exp(-e.deltaY * 0.0015)); };
    el.addEventListener('wheel', w, { passive: false });
    return () => el.removeEventListener('wheel', w);
  }, [zoom, setZoomKeepingPan]);

  const down = (e: React.PointerEvent) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; gesture.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom }; } };
  const move = (e: React.PointerEvent) => {
    const p = pointers.current.get(e.pointerId); if (!p) return;
    const prev = { ...p }; p.x = e.clientX; p.y = e.clientY;
    if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      setZoomKeepingPan(gesture.current.zoom * (Math.hypot(a!.x - b!.x, a!.y - b!.y) / gesture.current.dist));
    } else if (pointers.current.size === 1 && zoom > 1) setPan((s) => ({ x: s.x + e.clientX - prev.x, y: s.y + e.clientY - prev.y }));
  };
  const up = (e: React.PointerEvent) => { pointers.current.delete(e.pointerId); if (pointers.current.size < 2) gesture.current = null; };

  if (!item || typeof document === 'undefined') return null;
  const btn = 'grid min-h-tap min-w-tap place-items-center rounded-full px-3 text-body font-medium text-white hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-40';
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={item.label} className="fixed inset-0 z-[1000] flex flex-col bg-black/90 text-white" style={{ height: '100dvh', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        <p className="min-w-0 truncate text-headline font-semibold">{item.label}{items.length > 1 && <span className="ml-2 text-footnote font-normal text-white/70">{index + 1} of {items.length}</span>}</p>
        <button type="button" className={btn} aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="relative min-h-0 flex-1">
      <div ref={stage} className="absolute inset-0 touch-none select-none overflow-hidden" style={{ cursor: zoom > 1 ? 'grab' : 'default' }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={() => (zoom > 1 ? reset() : setZoomKeepingPan(2.5))}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.src} alt={item.label} draggable={false} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
          style={nat ? { width: nat.w, height: nat.h, marginLeft: -nat.w / 2, marginTop: -nat.h / 2, transform: `translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg) scale(${fit * zoom})`, transition: pointers.current.size ? 'none' : 'transform 120ms ease-out' } : { opacity: 0 }} />
        {!nat && <p className="absolute inset-0 grid place-items-center text-subhead text-white/70" role="status">Loading…</p>}
      </div>
        {items.length > 1 && <>
          <button type="button" className={`${btn} absolute left-2 top-1/2 -translate-y-1/2 bg-black/40`} aria-label="Previous picture" onClick={() => step(-1)}>‹</button>
          <button type="button" className={`${btn} absolute right-2 top-1/2 -translate-y-1/2 bg-black/40`} aria-label="Next picture" onClick={() => step(1)}>›</button>
        </>}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1 px-3 py-3" role="toolbar" aria-label="Picture controls">
        <button type="button" className={btn} aria-label="Rotate left" onClick={() => turn(-90)}>⟲</button>
        <button type="button" className={btn} aria-label="Rotate right" onClick={() => turn(90)}>⟳</button>
        <button type="button" className={btn} aria-label="Zoom out" disabled={zoom <= MIN} onClick={() => setZoomKeepingPan(zoom / 1.4)}>−</button>
        <span className="min-w-[4.5rem] text-center text-subhead tabular-nums" aria-live="polite">{Math.round(zoom * 100)}%{rot ? ` · ${rot}°` : ''}</span>
        <button type="button" className={btn} aria-label="Zoom in" disabled={zoom >= MAX} onClick={() => setZoomKeepingPan(zoom * 1.4)}>+</button>
        <button type="button" className={btn} aria-label="Fit to screen" onClick={reset}>Fit</button>
      </div>
    </div>, document.body);
}
