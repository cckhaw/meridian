'use client';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { filterOptions, nextActive, type ComboOption } from './combobox-logic';

export type { ComboOption } from './combobox-logic';
export { filterOptions, nextActive, wildcardRegExp } from './combobox-logic';

const cx = (...p: Array<string | false | undefined>) => p.filter(Boolean).join(' ');

interface CoreProps {
  /** Accessible name when there is no visible <label>. A <Field> label also works: it is linked through `id`. */
  label: string;
  id?: string;
  /** A fixed list (filtered here as you type) ... */
  options?: ComboOption[];
  /** ... or a loader called, after a short pause, with what was typed. Return the matching options. */
  load?: (query: string) => Promise<ComboOption[]>;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  'aria-describedby'?: string;
}
interface CoreInternal extends CoreProps { multiple: boolean; values: string[]; onValues: (v: string[], o: ComboOption[]) => void; clearable?: boolean }

/**
 * ARIA 1.2 combobox with a listbox popup: type to search, Up/Down/Home/End to move (disabled rows are skipped), Enter to pick, Escape to close
 * (and only close: it does not also dismiss a dialog around it), Backspace on an empty box removes the last chip. The list is drawn on the page
 * and placed against the input, flipping above it when there is no room below, so a card or table with overflow hidden cannot clip it.
 * On a phone the options are 44px tall and the list never extends past the screen.
 */
function ComboCore({ label, id, options, load, placeholder, emptyText = 'No match', disabled, className, multiple, values, onValues, clearable, ...rest }: CoreInternal) {
  const uid = useId();
  const inputId = id ?? `${uid}-in`;
  const listId = `${uid}-list`;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<ComboOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; max: number } | null>(null);
  // Labels of everything seen so far, so a chip or the closed input can name a value that is not in the current result list.
  const known = useRef(new Map<string, ComboOption>());
  const shown = useMemo(() => (load ? remote : filterOptions(options ?? [], q)), [load, remote, options, q]);
  for (const o of [...(options ?? []), ...remote]) known.current.set(o.value, o);

  useEffect(() => {
    if (!load || !open) return;
    let live = true; setLoading(true); setFailed(false);
    const t = setTimeout(() => { load(q).then((r) => { if (live) { setRemote(r); setLoading(false); } }).catch(() => { if (live) { setRemote([]); setFailed(true); setLoading(false); } }); }, remote.length === 0 && q === '' ? 0 : 220);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open, load]);
  useEffect(() => { setActive(nextActive(shown, -1, 'first')); }, [shown]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  useLayoutEffect(() => {
    if (!open || !root.current) { setPos(null); return; }
    const place = () => {
      const r = root.current!.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 8, above = r.top - 8;
      const up = below < 200 && above > below;
      const max = Math.max(160, Math.min(320, up ? above : below));
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 8) - 8)), width: r.width, max, ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { const t = e.target as Node; if (!root.current?.contains(t) && !list.current?.contains(t)) { setOpen(false); setQ(''); } };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const choose = useCallback((o: ComboOption) => {
    if (o.disabled) return;
    if (multiple) {
      const next = values.includes(o.value) ? values.filter((v) => v !== o.value) : [...values, o.value];
      onValues(next, next.map((v) => known.current.get(v)!).filter(Boolean));
      setQ(''); input.current?.focus();
    } else { onValues([o.value], [o]); setOpen(false); setQ(''); }
  }, [multiple, values, onValues]);

  const onKey = (e: React.KeyboardEvent) => {
    const moves: Record<string, 'next' | 'prev' | 'first' | 'last'> = { ArrowDown: 'next', ArrowUp: 'prev', Home: 'first', End: 'last' };
    if (moves[e.key] && (open || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive((a) => nextActive(shown, a, moves[e.key]!));
    } else if (e.key === 'Enter' && open) { e.preventDefault(); const o = shown[active]; if (o) choose(o); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQ(''); }
    else if (e.key === 'Backspace' && multiple && q === '' && values.length) onValues(values.slice(0, -1), values.slice(0, -1).map((v) => known.current.get(v)!).filter(Boolean));
    else if (e.key === 'Tab') { setOpen(false); setQ(''); }
  };

  const selected = !multiple && values[0] ? known.current.get(values[0]) : undefined;
  const status = loading ? 'Searching' : failed ? 'Could not load the list' : shown.length === 0 ? emptyText : `${shown.length} ${shown.length === 1 ? 'result' : 'results'}`;
  return (
    <div className={cx('relative', className)}>
      <div ref={root} className={cx('flex min-h-tap w-full flex-wrap items-center gap-1.5 rounded-control border border-separator bg-surface px-2 py-1 focus-within:ring-2 focus-within:ring-accent', disabled && 'opacity-50')}>
        {multiple && values.map((v) => (
          <span key={v} className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent/10 py-0.5 pl-2.5 pr-1 text-subhead text-accent">
            <span className="truncate">{known.current.get(v)?.label ?? v}</span>
            <button type="button" disabled={disabled} aria-label={`Remove ${known.current.get(v)?.label ?? v}`} onClick={() => { const n = values.filter((x) => x !== v); onValues(n, n.map((x) => known.current.get(x)!).filter(Boolean)); }} className="grid h-6 w-6 place-items-center rounded-full hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">×</button>
          </span>
        ))}
        <input ref={input} id={inputId} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-haspopup="listbox"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined} aria-describedby={rest['aria-describedby']}
          aria-label={label} autoComplete="off" spellCheck={false} disabled={disabled}
          placeholder={multiple && values.length ? '' : (selected ? undefined : placeholder)}
          value={open || multiple ? q : (selected?.label ?? '')}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => { if (!disabled) setOpen(true); }} onClick={() => setOpen(true)} onKeyDown={onKey}
          className={cx('min-h-[36px] min-w-[8rem] flex-1 bg-transparent px-1 text-body text-label placeholder:text-label2 focus-visible:outline-none', !multiple && selected && !open && 'font-medium')} />
        {clearable && !multiple && values[0] && !disabled && <button type="button" aria-label={`Clear ${label}`} onClick={() => { onValues([], []); setQ(''); input.current?.focus(); }} className="grid h-8 w-8 place-items-center rounded-full text-label2 hover:bg-label/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">×</button>}
        <button type="button" tabIndex={-1} aria-label={open ? `Close ${label} list` : `Open ${label} list`} onMouseDown={(e) => e.preventDefault()} onClick={() => { setOpen((o) => !o); input.current?.focus(); }} disabled={disabled} className="grid h-8 w-8 place-items-center rounded-full text-label2 hover:bg-label/10">
          <svg aria-hidden viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m2.5 4.5 3.5 3.5 3.5-3.5" /></svg>
        </button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">{open ? status : ''}</span>
      {open && pos && typeof document !== 'undefined' && createPortal(
        <ul ref={list} id={listId} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined} onMouseDown={(e) => e.preventDefault()}
          style={{ position: 'fixed', left: pos.left, width: Math.max(pos.width, 220), top: pos.top, bottom: pos.bottom, maxHeight: pos.max }}
          className="z-[950] overflow-y-auto overscroll-contain rounded-card border border-separator bg-surface py-1 shadow-card">
          {(loading || failed || shown.length === 0) && <li role="presentation" className="px-4 py-3 text-subhead text-label2">{loading ? 'Searching…' : failed ? 'Could not load the list. Keep typing to try again.' : emptyText}</li>}
          {shown.map((o, i) => {
            const on = values.includes(o.value);
            return (
              <li key={o.value} id={`${listId}-${i}`} data-i={i} role="option" aria-selected={on} aria-disabled={o.disabled || undefined}
                onMouseEnter={() => { if (!o.disabled) setActive(i); }} onClick={() => choose(o)}
                className={cx('flex min-h-tap cursor-pointer items-center gap-3 px-4 py-1.5 text-subhead', i === active && 'bg-accent/10', o.disabled && 'cursor-not-allowed opacity-50')}>
                {multiple && <span aria-hidden className={cx('grid h-5 w-5 shrink-0 place-items-center rounded border text-caption', on ? 'border-accent bg-accent text-accent-fg' : 'border-separator')}>{on ? '✓' : ''}</span>}
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate', on && !multiple && 'font-semibold text-accent')}>{o.label}</span>
                  {(o.disabled ? o.disabledReason ?? o.description : o.description) && <span className="block truncate text-footnote text-label2">{o.disabled ? o.disabledReason ?? o.description : o.description}</span>}
                  {o.warning && !o.disabled && <span className="block truncate text-footnote font-medium text-warning">{o.warning}</span>}
                </span>
                {o.detail && <span className="shrink-0 text-footnote tabular-nums text-label2">{o.detail}</span>}
                {on && !multiple && <span aria-hidden className="text-accent">✓</span>}
              </li>
            );
          })}
        </ul>, document.body)}
    </div>
  );
}

/** Pick one. `value` is the chosen option's value (null = none). Use `options` for a short fixed list or `load` for type-ahead from the server. */
export function Combobox({ value, onChange, clearable = true, ...p }: CoreProps & { value: string | null; onChange: (value: string | null, option?: ComboOption) => void; clearable?: boolean; /** Name shown for `value` before the list has been fetched. */ valueLabel?: string }) {
  const { valueLabel, ...core } = p as CoreProps & { valueLabel?: string };
  const opts = useMemo(() => (valueLabel && value ? [...(core.options ?? []), ...((core.options ?? []).some((o) => o.value === value) ? [] : [{ value, label: valueLabel }])] : core.options), [core.options, valueLabel, value]);
  return <ComboCore {...core} options={opts} multiple={false} values={value ? [value] : []} clearable={clearable} onValues={(v, o) => onChange(v[0] ?? null, o[0])} />;
}
/** Pick several: chosen options become removable chips and the list stays open. `value` is the list of chosen values. */
export function MultiCombobox({ value, onChange, ...p }: CoreProps & { value: string[]; onChange: (value: string[], options: ComboOption[]) => void }) {
  return <ComboCore {...p} multiple values={value} onValues={onChange} />;
}
