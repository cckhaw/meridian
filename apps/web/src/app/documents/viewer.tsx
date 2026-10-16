'use client';
import { Button, Modal } from '@meridian/ui';
import { useMemo } from 'react';

/**
 * Shows a document from its own address (not a copy held in the browser), under a watermark that names the person looking and when, so a photo or
 * screenshot of it can be traced. The file request is what gets logged.
 */
export function Viewer({ id, contentType, watermark, onClose }: { id: string; contentType: string; watermark: string; onClose: () => void }) {
  const src = `/api/documents/${id}/file`;
  const pattern = useMemo(() => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200"><text x="20" y="120" font-family="sans-serif" font-size="15" fill="rgba(120,120,120,0.45)" transform="rotate(-24 20 120)">${watermark.replace(/[<>&"]/g, '')} · CONFIDENTIAL</text></svg>`;
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  }, [watermark]);
  const pdf = contentType === 'application/pdf';
  return (
    <Modal title="Document" wide onClose={onClose}>
      <div className="relative overflow-hidden rounded-control border border-separator bg-surface2" onContextMenu={(e) => e.preventDefault()}>
        {pdf
          ? <iframe title="Document" src={src} className="h-[70vh] w-full bg-white" />
          // eslint-disable-next-line @next/next/no-img-element
          : <img src={src} alt="Document" draggable={false} className="mx-auto block max-h-[70vh] w-auto max-w-full select-none object-contain" />}
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ backgroundImage: pattern, backgroundRepeat: 'repeat' }} />
      </div>
      <p className="mt-2 text-footnote text-label2">This view is recorded. The watermark shows who opened it and when.</p>
      {pdf && <p className="text-footnote text-label2">If the page above stays blank, use Download: it opens the PDF in its own tab.</p>}
      <div className="mt-3 flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
    </Modal>
  );
}
