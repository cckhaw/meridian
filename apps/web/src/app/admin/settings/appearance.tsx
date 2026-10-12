'use client';
import { Alert, Button, Card, Field, Input, SectionTitle } from '@meridian/ui';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { del, post, useAction } from '@/lib/api';

interface ThemeView { id: string; name: string; mood: string; light: { accent: number[]; accentFg: number[] }; dark: { accent: number[]; accentFg: number[] } }
interface Guidance { width: number; height: number; maxBytes: number; formats: string[]; note: string }
interface BrandingView { name: string; theme: string; logoUrl: string | null; logo: { width: number; height: number } | null }
const rgb = (c: number[]) => `rgb(${c.join(',')})`;

const toBase64 = (buf: ArrayBuffer) => {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

export function AppearanceSettings({ branding, themes, guidance, onSaved }: { branding: BrandingView; themes: ThemeView[]; guidance: Guidance; onSaved: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(branding.name);
  const [theme, setTheme] = useState(branding.theme);
  const save = useAction();
  const logo = useAction();
  const file = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const done = () => { onSaved(); router.refresh(); };

  const pick = async (f: File | undefined) => {
    setLocalError(null);
    if (!f) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) return setLocalError('Choose a PNG, JPEG or WebP image.');
    if (f.size > guidance.maxBytes) return setLocalError(`That file is ${(f.size / 1024).toFixed(0)} KB; the limit is ${guidance.maxBytes / 1024} KB.`);
    const r = await logo.run(async () => post('/settings/logo', { dataBase64: toBase64(await f.arrayBuffer()) }), 'Logo updated.');
    if (r) done();
    if (file.current) file.current.value = '';
  };

  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle>Logo</SectionTitle>
        <p className="mb-4 text-subhead text-label2">
          Replaces the product name at the top left and on the sign-in page. Recommended: <strong>{guidance.width} × {guidance.height} px</strong> ({guidance.formats.join(', ')}; under {guidance.maxBytes / 1024} KB). {guidance.note}
        </p>
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
        {branding.logo && <p className="mt-2 text-footnote text-label2">Current file: {branding.logo.width} × {branding.logo.height} px</p>}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input ref={file} id="logo-file" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} />
          <label htmlFor="logo-file" className="inline-flex min-h-tap cursor-pointer items-center rounded-control bg-accent px-5 text-body font-medium text-accent-fg hover:opacity-90 focus-within:ring-2">{branding.logoUrl ? 'Replace logo' : 'Upload logo'}</label>
          {branding.logoUrl && <Button variant="secondary" disabled={logo.busy} onClick={async () => { if (await logo.run(() => del('/settings/logo'), 'Logo removed.')) done(); }}>Remove</Button>}
        </div>
        {(localError || logo.error) && <div className="mt-3"><Alert>{localError ?? logo.error}</Alert></div>}
        {logo.ok && <div className="mt-3"><Alert tone="success">{logo.ok}</Alert></div>}
      </Card>

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
            <p className="mt-2 text-footnote text-label2">All seven keep text readable (WCAG AA contrast) in both light and dark mode.</p>
          </fieldset>
          {save.error && <Alert>{save.error}</Alert>}
          {save.ok && <Alert tone="success">{save.ok}</Alert>}
          <Button type="submit" disabled={save.busy}>{save.busy ? 'Saving…' : 'Save appearance'}</Button>
        </form>
      </Card>
    </div>
  );
}
