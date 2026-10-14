'use client';
import { Alert, Button, Card, Field, Input, SectionTitle } from '@meridian/ui';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { del, post, useAction } from '@/lib/api';
import { ImageCropper } from './image-cropper';

interface ThemeView { id: string; name: string; mood: string; light: { accent: number[]; accentFg: number[] }; dark: { accent: number[]; accentFg: number[] } }
interface Guidance { width: number; height: number; maxBytes: number; formats: string[]; note: string }
interface BrandingView { name: string; theme: string; logoUrl: string | null; logo: { width: number; height: number } | null; faviconUrl: string | null; favicon: { width: number; height: number } | null }
const rgb = (c: number[]) => `rgb(${c.join(',')})`;


const MAX_PICK_BYTES = 15 * 1024 * 1024;

/** A picture the operator sets (logo, favicon): choose a file of any size, crop it to the preset dimensions, save. */
function BrandImageCard({ title, intro, noun, guidance, url, current, route, previews, onSaved }: {
  title: string; intro: React.ReactNode; noun: string; guidance: Guidance; url: string | null; current: { width: number; height: number } | null; route: string;
  previews: React.ReactNode; onSaved: () => void;
}) {
  const id = `${noun}-file`;
  const file = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const up = useAction();
  const rm = useAction();

  const pick = (f: File | undefined) => {
    setLocalError(null);
    if (file.current) file.current.value = '';
    if (!f) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) return setLocalError('Choose a PNG, JPEG or WebP image.');
    if (f.size > MAX_PICK_BYTES) return setLocalError(`That file is ${(f.size / 1048576).toFixed(1)} MB; pictures up to ${MAX_PICK_BYTES / 1048576} MB can be cropped.`);
    const r = new FileReader();
    r.onload = () => setPicked(String(r.result));
    r.onerror = () => setLocalError('That file could not be read.');
    r.readAsDataURL(f);
  };
  const save = async (base64: string) => {
    if (await up.run(() => post(route, { dataBase64: base64 }), `The ${noun} was updated.`)) { setPicked(null); onSaved(); }
  };

  return (
    <Card>
      <SectionTitle>{title}</SectionTitle>
      <p className="mb-4 text-subhead text-label2">{intro}</p>
      {picked ? (
        <ImageCropper src={picked} target={{ width: guidance.width, height: guidance.height }} busy={up.busy} onCancel={() => { setPicked(null); up.clear(); }} onDone={save} />
      ) : (
        <>
          {previews}
          {current && <p className="mt-2 text-footnote text-label2">Current file: {current.width} × {current.height} px</p>}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <input ref={file} id={id} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
            <label htmlFor={id} className="inline-flex min-h-tap cursor-pointer items-center rounded-control bg-accent px-5 text-body font-medium text-accent-fg hover:opacity-90 focus-within:ring-2">{url ? `Replace ${noun}` : `Upload ${noun}`}</label>
            {url && <Button variant="secondary" disabled={rm.busy} onClick={async () => { if (await rm.run(() => del(route), `The ${noun} was removed.`)) onSaved(); }}>Remove</Button>}
          </div>
          <p className="mt-2 text-footnote text-label2">Any picture up to {MAX_PICK_BYTES / 1048576} MB works: you crop it to {guidance.width} × {guidance.height} px next.</p>
        </>
      )}
      {(localError || up.error || rm.error) && <div className="mt-3"><Alert>{localError ?? up.error ?? rm.error}</Alert></div>}
      {(up.ok || rm.ok) && !picked && <div className="mt-3"><Alert tone="success">{up.ok ?? rm.ok}</Alert></div>}
    </Card>
  );
}

export function AppearanceSettings({ branding, themes, guidance, faviconGuidance, onSaved }: { branding: BrandingView; themes: ThemeView[]; guidance: Guidance; faviconGuidance: Guidance; onSaved: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(branding.name);
  const [theme, setTheme] = useState(branding.theme);
  const save = useAction();
  const done = () => { onSaved(); router.refresh(); };

  return (
    <div className="space-y-5">
      <BrandImageCard
        title="Logo" noun="logo" route="/settings/logo" guidance={guidance} url={branding.logoUrl} current={branding.logo} onSaved={done}
        intro={<>Replaces the product name at the top left and on the sign-in page. Recommended: <strong>{guidance.width} × {guidance.height} px</strong> ({guidance.formats.join(', ')}). {guidance.note}</>}
        previews={(
          <div className="grid gap-3 sm:grid-cols-2">
            {(['bg-white', 'bg-black'] as const).map((bg) => (
              <div key={bg} className={`grid min-h-[88px] place-items-center rounded-control border border-separator p-4 ${bg}`}>
                {branding.logoUrl
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={branding.logoUrl} alt={bg === 'bg-white' ? 'Current logo on a light background' : 'Current logo on a dark background'} className="max-h-10 w-auto max-w-full object-contain" />
                  : <span className={`font-bold ${bg === 'bg-white' ? 'text-black' : 'text-white'}`}>{branding.name}</span>}
              </div>
            ))}
          </div>
        )}
      />
      <BrandImageCard
        title="Favicon" noun="favicon" route="/settings/favicon" guidance={faviconGuidance} url={branding.faviconUrl} current={branding.favicon} onSaved={done}
        intro={<>The small icon in the browser tab and bookmarks, for the CRM and the store-front. Recommended: <strong>{faviconGuidance.width} × {faviconGuidance.height} px</strong> square ({faviconGuidance.formats.join(', ')}). {faviconGuidance.note}</>}
        previews={(
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 rounded-t-control border border-separator bg-surface2 px-3 py-2 text-footnote">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {branding.faviconUrl ? <img src={branding.faviconUrl} alt="Current favicon in a browser tab" className="h-4 w-4 object-contain" /> : <span aria-hidden className="grid h-4 w-4 place-items-center rounded-sm bg-accent text-[9px] font-bold text-accent-fg">M</span>}
              <span>{branding.name}</span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {branding.faviconUrl && <img src={branding.faviconUrl} alt="Current favicon, larger" className="h-12 w-12 rounded-control border border-separator object-contain p-1" />}
            {!branding.faviconUrl && <span className="text-footnote text-label2">No favicon set: the built-in icon is used.</span>}
          </div>
        )}
      />

      <Card>
        <SectionTitle>Name and colour</SectionTitle>
        <form className="space-y-5" onSubmit={async (e) => { e.preventDefault(); if (await save.run(() => post('/settings/branding', { name, theme }), 'Appearance saved.')) done(); }}>
          <Field label="Portal name" hint="Shown in the browser tab, on invoices, and in place of the logo when none is uploaded."><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required className="sm:max-w-sm" /></Field>
          <fieldset>
            <legend className="mb-2 text-subhead font-medium">Colour theme</legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {themes.map((t) => (
                <label key={t.id} className={`relative flex cursor-pointer flex-col gap-2 rounded-card border p-3 focus-within:ring-2 focus-within:ring-accent ${theme === t.id ? 'border-accent ring-2 ring-accent' : 'border-separator'}`}>
                  <input type="radio" name="theme" value={t.id} checked={theme === t.id} onChange={() => setTheme(t.id)} className="sr-only" />
                  <span className="flex gap-1" aria-hidden>
                    <span className="h-8 flex-1 rounded-l-[10px]" style={{ background: rgb(t.light.accent) }} />
                    <span className="h-8 flex-1" style={{ background: rgb(t.dark.accent) }} />
                    <span className="h-8 flex-1 rounded-r-[10px] bg-surface2" />
                  </span>
                  <span className="font-medium">{t.name}{theme === t.id && <span className="sr-only"> (selected)</span>}</span>
                  <span className="text-footnote text-label2">{t.mood}</span>
                  <span aria-hidden className="inline-flex w-fit rounded-full px-3 py-1 text-caption font-medium" style={{ background: rgb(t.light.accent), color: rgb(t.light.accentFg) }}>Button</span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-footnote text-label2">All eight keep text readable (WCAG AA contrast) in both light and dark mode.</p>
          </fieldset>
          {save.error && <Alert>{save.error}</Alert>}
          {save.ok && <Alert tone="success">{save.ok}</Alert>}
          <Button type="submit" disabled={save.busy}>{save.busy ? 'Saving…' : 'Save appearance'}</Button>
        </form>
      </Card>
    </div>
  );
}
