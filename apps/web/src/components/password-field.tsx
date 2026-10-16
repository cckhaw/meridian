'use client';
import { Field, Input } from '@meridian/ui';
import { DEFAULT_PASSWORD_RULES, passwordChecklist, passwordIssue, passwordStrength, type PasswordRules } from '@meridian/types';
import { useApi } from '@/lib/api';

/** The password rules currently in force (Settings → Security policy), for the meter and the checklist. */
export function usePasswordRules(): PasswordRules {
  const { data } = useApi<{ rules: PasswordRules }>('/auth/password-policy');
  return data?.rules ?? DEFAULT_PASSWORD_RULES;
}

const TONE = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'];

/** A new-password input with a strength meter and a live checklist of the rules, so people see what is missing before they submit. */
export function PasswordField({ label = 'New password', value, onChange, username = '', hint }: { label?: string; value: string; onChange: (v: string) => void; username?: string; hint?: string }) {
  const rules = usePasswordRules();
  const checks = passwordChecklist(rules, value, username);
  const s = passwordStrength(value);
  return (
    <div>
      <Field label={label} hint={hint ?? 'A long passphrase works well.'}>
        <Input type="password" autoComplete="new-password" required value={value} onChange={(e) => onChange(e.target.value)} aria-describedby="pw-rules" />
      </Field>
      <div className="mt-2" aria-live="polite">
        <div className="flex gap-1" role="img" aria-label={value ? `Strength: ${s.label}` : 'Strength meter'}>
          {[1, 2, 3, 4].map((i) => <span key={i} className={`h-1.5 flex-1 rounded-full ${value && s.score >= i ? TONE[s.score] : 'bg-label/15'}`} />)}
        </div>
        <p className="mt-1 h-4 text-footnote text-label2">{value ? s.label : ''}</p>
      </div>
      <ul id="pw-rules" className="mt-1 grid gap-0.5 text-footnote sm:grid-cols-2">
        {checks.map((c) => <li key={c.id} className={c.ok ? 'text-success' : 'text-label2'}><span aria-hidden>{c.ok ? '✓' : '○'}</span> {c.label}</li>)}
      </ul>
    </div>
  );
}

/** Whether the password meets the rules (the server checks again). */
export const meetsRules = (rules: PasswordRules, value: string, username = '') => passwordIssue(rules, value, username) === null;
