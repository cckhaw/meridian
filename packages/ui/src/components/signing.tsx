'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './primitives';

/** A drawing surface for a finger, stylus or mouse. Reports a PNG (transparent background) once something is drawn, and null when cleared. */
export function SignaturePad({ onChange, disabled, label = 'Sign here' }: { onChange: (png: string | null) => void; disabled?: boolean; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);
  const drawn = useRef(false);
  const W = 640, H = 200;
  const pos = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
  const start = (e: React.PointerEvent) => { if (disabled) return; ref.current!.setPointerCapture(e.pointerId); drawing.current = true; last.current = pos(e); };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current || disabled) return;
    const c = ref.current!.getContext('2d')!, p = pos(e), l = last.current ?? p;
    c.lineWidth = 3; c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = '#111';
    c.beginPath(); c.moveTo(l.x, l.y); c.lineTo(p.x, p.y); c.stroke(); last.current = p;
    drawn.current = true; setEmpty(false);
  };
  const end = () => { if (!drawing.current) return; drawing.current = false; last.current = null; if (drawn.current) onChange(ref.current!.toDataURL('image/png')); };
  const clear = useCallback(() => { const c = ref.current!.getContext('2d')!; c.clearRect(0, 0, W, H); drawn.current = false; setEmpty(true); onChange(null); }, [onChange]);
  useEffect(() => { if (disabled) clear(); }, [disabled]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div className={`relative overflow-hidden rounded-control border border-separator bg-white ${disabled ? 'opacity-50' : ''}`}>
        <canvas ref={ref} width={W} height={H} role="img" aria-label={label} className="block h-40 w-full touch-none cursor-crosshair"
          onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerLeave={end} />
        {empty && <span aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center text-subhead text-neutral-400">{label}</span>}
        <span aria-hidden className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-neutral-300" />
      </div>
      <div className="mt-2 flex items-center justify-between text-footnote text-label2"><span>Draw your signature with your finger or mouse.</span><Button type="button" variant="plain" className="!min-h-[36px] !px-3" onClick={clear} disabled={empty}>Clear</Button></div>
    </div>
  );
}

export interface AgreementView { versionId: string; name: string; version: string; html: string }
export interface SignedPayload { image: string; versionIds: string[]; geo?: { lat: number; lon: number; accuracy?: number } | null }

const prose = '[&_h1]:mb-2 [&_h1]:text-title3 [&_h1]:font-bold [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-headline [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:w-full [&_td]:border [&_td]:border-separator [&_td]:p-1 [&_th]:border [&_th]:border-separator [&_th]:p-1 [&_blockquote]:border-l-4 [&_blockquote]:pl-3 [&_blockquote]:text-label2 [&_[data-align=center]]:text-center [&_[data-align=right]]:text-right';

/**
 * Shows the agreements that apply, with the customer's details already filled in, and takes their signature. Reports the signature (and the versions that were on screen)
 * once they have ticked "I have read" and drawn it; null otherwise. The text comes from the server already cleaned, never from the browser.
 */
export function AgreementSigner({ agreements, required, onChange, who = 'the customer', askLocation = true }: { agreements: AgreementView[]; required: boolean; onChange: (s: SignedPayload | null) => void; who?: string; askLocation?: boolean }) {
  const [read, setRead] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [geo, setGeo] = useState<SignedPayload['geo']>(null);
  const [geoState, setGeoState] = useState<'idle' | 'asking' | 'done' | 'denied'>('idle');
  const ids = agreements.map((a) => a.versionId).join(',');
  useEffect(() => { onChange(read && image ? { image, versionIds: agreements.map((a) => a.versionId), geo } : null); }, [read, image, geo, ids]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setRead(false); setImage(null); }, [ids]);   // new text: read it again
  if (!agreements.length) return null;
  const locate = () => {
    if (!navigator.geolocation) { setGeoState('denied'); return; }
    setGeoState('asking');
    navigator.geolocation.getCurrentPosition((p) => { setGeo({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }); setGeoState('done'); }, () => { setGeo(null); setGeoState('denied'); }, { timeout: 8000, maximumAge: 60_000 });
  };
  return (
    <section aria-label="Agreements" className="space-y-3">
      <h3 className="text-headline font-semibold">{required ? 'Agreements to read and sign' : 'Agreements'}</h3>
      {agreements.map((a, i) => (
        <details key={a.versionId} open={i === 0} className="rounded-control border border-separator bg-surface2">
          <summary className="cursor-pointer select-none px-4 py-3 text-subhead font-medium">{a.name} <span className="font-normal text-label2">· {a.version}</span></summary>
          <div className={`max-h-72 overflow-auto border-t border-separator px-4 py-3 text-subhead ${prose}`} dangerouslySetInnerHTML={{ __html: a.html }} />
        </details>
      ))}
      <label className="flex min-h-tap items-start gap-3 text-body"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={read} onChange={(e) => { setRead(e.target.checked); if (e.target.checked && askLocation && geoState === 'idle') locate(); }} />
        <span>I have read {agreements.length > 1 ? 'these agreements' : 'this agreement'}{who === 'the customer' ? ' and the customer agrees' : ' and agree'} to {agreements.length > 1 ? 'them' : 'it'}.</span></label>
      {read && (
        <>
          <SignaturePad onChange={setImage} label={`Signature of ${who}`} />
          <p className="text-footnote text-label2">The signature is stored with the date, time and device address{geoState === 'done' ? ', and your location' : ''}.{geoState === 'denied' ? ' Location was not shared, which is fine.' : ''}</p>
          {required && !image && <p className="text-footnote text-danger">A signature is needed to continue.</p>}
        </>
      )}
    </section>
  );
}
