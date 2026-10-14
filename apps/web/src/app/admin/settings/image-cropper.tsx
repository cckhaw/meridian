'use client';
import { Button } from '@meridian/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Crops and resizes a picture to an exact size in the browser, so an oversized image can be fitted to the preset dimensions before upload.
 * Drag to move, slide (or scroll) to zoom; zooming right out fits the whole picture with transparent margins. The result is a PNG at
 * exactly `target.width × target.height`.
 */
export function ImageCropper({ src, target, busy, onCancel, onDone }: {
  src: string; target: { width: number; height: number }; busy?: boolean; onCancel: () => void; onDone: (pngBase64: string) => void;
}) {
  const aspect = target.width / target.height;
  const fw = aspect > 2 ? 440 : 300; // the frame's logical size; the screen size follows its container
  const fh = fw / aspect;
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [c, setC] = useState({ x: 0, y: 0 }); // the picture point shown at the middle of the frame
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const i = new Image();
    i.onload = () => { setImg(i); setC({ x: i.naturalWidth / 2, y: i.naturalHeight / 2 }); setZoom(1); };
    i.onerror = () => setFailed(true);
    i.src = src;
  }, [src]);

  const iw = img?.naturalWidth ?? 1, ih = img?.naturalHeight ?? 1;
  const cover = Math.max(fw / iw, fh / ih), contain = Math.min(fw / iw, fh / ih);
  const minZoom = Math.min(1, contain / cover), maxZoom = 6;
  const s = cover * zoom;
  const clamp = useCallback((p: { x: number; y: number }, scale: number) => ({
    x: iw * scale >= fw ? Math.min(iw - fw / 2 / scale, Math.max(fw / 2 / scale, p.x)) : iw / 2,
    y: ih * scale >= fh ? Math.min(ih - fh / 2 / scale, Math.max(fh / 2 / scale, p.y)) : ih / 2,
  }), [iw, ih, fw, fh]);
  const cc = clamp(c, s);

  const setZ = (z: number) => { const nz = Math.min(maxZoom, Math.max(minZoom, z)); setZoom(nz); setC(clamp(c, cover * nz)); };
  const scaleOf = () => (frame.current ? fw / frame.current.getBoundingClientRect().width : 1);
  const move = (dx: number, dy: number) => setC(clamp({ x: cc.x - dx / s, y: cc.y - dy / s }, s));

  const finish = () => {
    if (!img) return;
    const cv = document.createElement('canvas');
    cv.width = target.width; cv.height = target.height;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const k = target.width / fw;
    ctx.drawImage(img, (fw / 2 - cc.x * s) * k, (fh / 2 - cc.y * s) * k, iw * s * k, ih * s * k);
    onDone(cv.toDataURL('image/png').split(',')[1]!);
  };

  if (failed) return <p role="alert" className="text-subhead text-danger">That file could not be read as a picture.</p>;
  if (!img) return <p className="text-subhead text-label2">Loading the picture…</p>;
  return (
    <div className="space-y-3">
      <p className="text-subhead text-label2">
        Your picture is {iw} × {ih} px. Drag it into place and zoom to choose what to keep; it is saved at <strong>{target.width} × {target.height} px</strong>.
      </p>
      <div
        ref={frame} tabIndex={0} role="group" aria-label="Crop area. Drag the picture, or use the arrow keys to move it and plus and minus to zoom."
        className="relative mx-auto w-full touch-none select-none overflow-hidden rounded-control border border-separator outline-none focus-visible:ring-2 focus-visible:ring-accent"
        style={{ maxWidth: fw, aspectRatio: `${target.width} / ${target.height}`, cursor: 'grab', backgroundImage: 'repeating-conic-gradient(rgb(128 128 128 / .18) 0% 25%, transparent 0% 50%)', backgroundSize: '16px 16px' }}
        onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY }; }}
        onPointerMove={(e) => { if (!drag.current) return; const k = scaleOf(); move((e.clientX - drag.current.x) * k, (e.clientY - drag.current.y) * k); drag.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onWheel={(e) => setZ(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}
        onKeyDown={(e) => {
          const step = 10;
          if (e.key === 'ArrowLeft') move(step, 0); else if (e.key === 'ArrowRight') move(-step, 0); else if (e.key === 'ArrowUp') move(0, step); else if (e.key === 'ArrowDown') move(0, -step);
          else if (e.key === '+' || e.key === '=') setZ(zoom * 1.1); else if (e.key === '-') setZ(zoom / 1.1); else return;
          e.preventDefault();
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" draggable={false} className="pointer-events-none absolute max-w-none"
          style={{ left: `${((fw / 2 - cc.x * s) / fw) * 100}%`, top: `${((fh / 2 - cc.y * s) / fh) * 100}%`, width: `${((iw * s) / fw) * 100}%`, height: `${((ih * s) / fh) * 100}%` }} />
      </div>
      <label className="mx-auto flex max-w-md items-center gap-3 text-subhead">
        <span className="shrink-0">Zoom</span>
        <input type="range" className="w-full accent-[rgb(var(--accent))]" min={Math.round(minZoom * 100)} max={maxZoom * 100} value={Math.round(zoom * 100)} onChange={(e) => setZ(Number(e.target.value) / 100)} aria-label="Zoom" />
      </label>
      <div className="flex flex-wrap justify-center gap-3">
        <Button disabled={busy} onClick={finish}>{busy ? 'Saving…' : 'Crop and save'}</Button>
        <Button variant="secondary" disabled={busy} onClick={() => { setZoom(1); setC({ x: iw / 2, y: ih / 2 }); }}>Reset</Button>
        <Button variant="plain" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
