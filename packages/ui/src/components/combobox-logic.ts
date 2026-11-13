/** Pure helpers behind the combobox, kept apart from React so the keyboard and filter rules can be unit tested. */
export interface ComboOption { value: string; label: string; description?: string; /** Right-aligned text, e.g. a count. */ detail?: string; disabled?: boolean; /** Shown instead of the description when the option is disabled. */ disabledReason?: string }

/** `*` matches any run of characters and `?` exactly one; everything else is literal and case does not matter. */
export function wildcardRegExp(q: string): RegExp {
  const body = q.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(body, 'i');
}
/** A typed query keeps options whose label, description or value contains it (wildcards allowed). */
export function filterOptions(options: ComboOption[], q: string): ComboOption[] {
  if (!q.trim()) return options;
  const re = wildcardRegExp(q);
  return options.filter((o) => re.test(`${o.label} ${o.description ?? ''} ${o.value}`));
}

export type Move = 'next' | 'prev' | 'first' | 'last';
/** The index to highlight after an arrow key, skipping disabled options and wrapping at the ends. -1 when nothing can be highlighted. */
export function nextActive(options: ComboOption[], active: number, move: Move): number {
  const n = options.length;
  if (!n || options.every((o) => o.disabled)) return -1;
  const ok = (i: number) => !options[i]!.disabled;
  if (move === 'first') { for (let i = 0; i < n; i++) if (ok(i)) return i; }
  if (move === 'last') { for (let i = n - 1; i >= 0; i--) if (ok(i)) return i; }
  const step = move === 'prev' ? -1 : 1;
  let i = active;
  for (let k = 0; k < n; k++) { i = (i + step + n) % n; if (ok(i)) return i; }
  return -1;
}
