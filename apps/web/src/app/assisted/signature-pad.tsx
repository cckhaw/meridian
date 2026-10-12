'use client';
import { Button } from '@meridian/ui';
import { useEffect, useRef, useState } from 'react';

/** A drawing surface for the customer's signature. Works with mouse, touch and pen; reports the PNG (base64) once something is drawn. */
export function SignaturePad({ onChange }: { onChange: (pngBase64: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = ref.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio; c.height = c.clientHeight * ratio;
    const g = c.getContext('2d')!;
    g.scale(ratio, ratio); g.lineWidth = 2.5; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#111';
  }, []);

  const pos = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e: React.PointerEvent) => { drawing.current = true; ref.current!.setPointerCapture(e.pointerId); const g = ref.current!.getContext('2d')!; const p = pos(e); g.beginPath(); g.moveTo(p.x, p.y); };
  const move = (e: React.PointerEvent) => { if (!drawing.current) return; const g = ref.current!.getContext('2d')!; const p = pos(e); g.lineTo(p.x, p.y); g.stroke(); if (empty) setEmpty(false); };
  const up = () => {
    if (!drawing.current) return; drawing.current = false;
    // white background so the saved image is readable wherever it is opened
    const c = ref.current!; const out = document.createElement('canvas'); out.width = c.width; out.height = c.height;
    const g = out.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height); g.drawImage(c, 0, 0);
    onChange(out.toDataURL('image/png').split(',')[1] ?? null);
  };
  const clear = () => { const c = ref.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); setEmpty(true); onChange(null); };

  return (
    <div>
      <canvas ref={ref} role="img" aria-label="Signature area: draw the customer's signature here" className="h-40 w-full touch-none rounded-control border-2 border-dashed border-separator bg-white"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="mt-1 flex items-center justify-between text-footnote text-label2"><span>{empty ? 'Customer signs above' : 'Signed'}</span><Button type="button" variant="plain" onClick={clear} className="!min-h-[32px] !px-2">Clear</Button></div>
    </div>
  );
}
