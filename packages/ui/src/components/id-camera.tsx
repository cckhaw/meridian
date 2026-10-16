'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from './forms';
import { Button } from './primitives';

/**
 * Live-camera photograph for identity documents. There is deliberately no file picker anywhere in this component: the picture is a frame grabbed from the
 * camera while the person looks at it, so a photo from the gallery or album cannot be chosen. (A phone's "take photo" file input is not the same thing: many
 * browsers still offer the library there. This one opens the camera stream itself.)
 *
 * The result carries how it was taken. The server checks it again: a JPEG without photo-library metadata, taken in the last minutes, of a size that can be read.
 */
export interface CapturedPhoto {
  /** The JPEG, base64 without a prefix: what the API takes. */
  dataBase64: string;
  /** The same picture as a data URL, for showing. */
  previewUrl: string;
  capture: { method: 'LIVE_CAMERA'; at: string; facing: string; width: number; height: number };
}
export type Frame = 'card' | 'face' | 'page';

const LONG_EDGE = 1600;
const MAX_BYTES = 800_000;

const ERRORS: Record<string, string> = {
  NotAllowedError: 'The camera is blocked. Allow the camera for this site in the browser settings, then try again.',
  PermissionDeniedError: 'The camera is blocked. Allow the camera for this site in the browser settings, then try again.',
  NotFoundError: 'No camera was found on this device. Use a phone or tablet, or a computer with a camera.',
  DevicesNotFoundError: 'No camera was found on this device. Use a phone or tablet, or a computer with a camera.',
  NotReadableError: 'The camera is being used by another app. Close it and try again.',
  OverconstrainedError: 'This camera cannot be used. Try another device.',
};

/** Frames that help someone line the document up. The shape is a guide only; the whole camera picture is kept. */
function Guide({ frame }: { frame: Frame }) {
  const corners = 'absolute h-6 w-6 border-white';
  if (frame === 'face') return <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-[68%] w-[52%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border-2 border-dashed border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />;
  const box = frame === 'card' ? 'aspect-[1.586] w-[86%]' : 'aspect-[0.72] h-[82%]';
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
      <div className={`relative ${box} max-h-[86%] max-w-[92%] shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]`}>
        <span className={`${corners} left-0 top-0 rounded-tl-lg border-l-4 border-t-4`} /><span className={`${corners} right-0 top-0 rounded-tr-lg border-r-4 border-t-4`} />
        <span className={`${corners} bottom-0 left-0 rounded-bl-lg border-b-4 border-l-4`} /><span className={`${corners} bottom-0 right-0 rounded-br-lg border-b-4 border-r-4`} />
      </div>
    </div>
  );
}

function CameraSheet({ title, hint, facing, frame, onDone, onClose }: { title: string; hint?: string; facing: 'environment' | 'user'; frame: Frame; onDone: (p: CapturedPhoto) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<'starting' | 'live' | 'review' | 'error'>('starting');
  const [error, setError] = useState('');
  const [shot, setShot] = useState<CapturedPhoto | null>(null);
  const [busy, setBusy] = useState(false);

  const stop = useCallback(() => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; }, []);
  const start = useCallback(async () => {
    setState('starting'); setError(''); setShot(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError(typeof window !== 'undefined' && !window.isSecureContext ? 'The camera needs a secure (https) connection.' : 'This browser cannot open the camera. Use the browser on a phone or tablet.'); setState('error'); return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      stream.current = s;
      const v = video.current;
      if (!v) { s.getTracks().forEach((t) => t.stop()); return; }
      v.srcObject = s;
      await v.play().catch(() => undefined);
      // Offer the shutter only once the camera is really delivering pictures (some devices take a moment after the stream opens).
      for (let i = 0; i < 40 && !v.videoWidth; i++) await new Promise((r) => setTimeout(r, 100));
      if (!v.videoWidth) throw Object.assign(new Error('no frames'), { name: 'NotReadableError' });
      setState('live');
    } catch (e) {
      setError(ERRORS[(e as { name?: string }).name ?? ''] ?? 'The camera could not be opened.'); setState('error');
    }
  }, [facing]);
  useEffect(() => { void start(); return stop; }, [start, stop]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  const snap = async () => {
    const v = video.current;
    if (!v || !v.videoWidth) { setError('The camera is not ready yet. Wait a moment and try again.'); return; }
    setBusy(true);
    const scale = Math.min(1, LONG_EDGE / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(v, 0, 0, w, h);
    // Try for a readable picture that still fits the upload: step the quality down only as far as needed.
    let blob: Blob | null = null;
    for (const q of [0.88, 0.8, 0.7, 0.6, 0.5]) { blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', q)); if (blob && blob.size <= MAX_BYTES) break; }
    if (!blob) { setBusy(false); setError('The picture could not be taken. Try again.'); return; }
    const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('read')); r.readAsDataURL(blob!); });
    stop();
    setShot({ dataBase64: url.slice(url.indexOf(',') + 1), previewUrl: url, capture: { method: 'LIVE_CAMERA', at: new Date().toISOString(), facing, width: w, height: h } });
    setState('review'); setBusy(false);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-[70] flex flex-col bg-black text-white" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0"><p className="truncate text-headline font-semibold">{title}</p>{hint && <p className="text-footnote text-white/75">{hint}</p>}</div>
        <button type="button" onClick={onClose} aria-label="Close the camera" className="grid min-h-tap min-w-tap place-items-center rounded-full bg-white/15 text-title3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">×</button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <video ref={video} playsInline muted autoPlay className={`absolute inset-0 h-full w-full object-cover ${state === 'live' || state === 'starting' ? '' : 'hidden'} ${facing === 'user' ? '-scale-x-100' : ''}`} aria-label="Camera view" />
        {state === 'live' && <Guide frame={frame} />}
        {state === 'review' && shot && /* eslint-disable-next-line @next/next/no-img-element */ <img src={shot.previewUrl} alt={`${title}, as taken`} className="absolute inset-0 h-full w-full object-contain" />}
        {state === 'live' && error && <p role="alert" className="absolute inset-x-4 top-3 rounded-control bg-danger/90 px-3 py-2 text-center text-subhead">{error}</p>}
        {state === 'starting' && <p className="absolute inset-0 grid place-items-center text-subhead text-white/80">Opening the camera…</p>}
        {state === 'error' && <div className="absolute inset-0 grid place-items-center p-6"><div className="max-w-sm text-center"><Alert>{error}</Alert><Button type="button" variant="secondary" className="mt-4" onClick={() => void start()}>Try again</Button></div></div>}
      </div>
      <div className="flex items-center justify-center gap-4 px-4 py-5">
        {state === 'live' && <button type="button" onClick={() => void snap()} disabled={busy} aria-label="Take the photo" className="grid h-[72px] w-[72px] place-items-center rounded-full border-4 border-white bg-white/10 transition-transform active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"><span className="h-[52px] w-[52px] rounded-full bg-white" /></button>}
        {state === 'review' && shot && <>
          <Button type="button" variant="secondary" onClick={() => void start()}>Retake</Button>
          <Button type="button" onClick={() => { onDone(shot); }}>Use this photo</Button>
        </>}
      </div>
      {state === 'live' && <p className="px-6 pb-3 text-center text-footnote text-white/75">{frame === 'face' ? 'Look at the camera in good light. The photo is taken live.' : 'Fit the whole document in the frame, flat, with no glare. The photo is taken live.'}</p>}
    </div>
  );
}

/**
 * One photograph to take. Shows a tile: what to photograph, then the picture once taken (with a way to take it again). Taking a photo opens the live camera;
 * there is no way to pick an existing picture.
 */
export function IdCamera({ label, hint, facing = 'environment', frame = 'card', value, onChange, disabled, done }: {
  label: string; hint?: string; facing?: 'environment' | 'user'; frame?: Frame; value: CapturedPhoto | null; onChange: (p: CapturedPhoto | null) => void; disabled?: boolean;
  /** A photograph is already on file (the picture itself is not shown). */
  done?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const have = !!value || !!done;
  return (
    <div className="rounded-card border border-separator bg-surface p-3">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {value ? <img src={value.previewUrl} alt={`${label}, taken`} className="h-16 w-24 shrink-0 rounded-control object-cover" />
          : <span aria-hidden className={`grid h-16 w-24 shrink-0 place-items-center rounded-control border-2 border-dashed ${done ? 'border-success text-success' : 'border-separator text-label3'}`}>{done ? '✓' : frame === 'face' ? '☺' : '▭'}</span>}
        <div className="min-w-0 flex-1">
          <p className="font-medium">{label}</p>
          <p className="text-footnote text-label2">{value ? 'Taken just now.' : done ? 'Already on file.' : hint ?? 'Take the photo with the camera.'}</p>
        </div>
        <Button type="button" variant={have ? 'secondary' : 'primary'} className="!min-h-[44px] shrink-0" disabled={disabled} onClick={() => setOpen(true)}>{have ? 'Retake' : 'Take photo'}</Button>
      </div>
      {open && <CameraSheet title={label} hint={hint} facing={facing} frame={frame} onClose={close} onDone={(p) => { onChange(p); setOpen(false); }} />}
    </div>
  );
}
