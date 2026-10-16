/**
 * The password rules that can be set in Settings → Security policy, and the checks the sign-up, change and reset screens run as the person types.
 * Pure functions with no server code, so the browser and the server judge a password the same way.
 */
export interface PasswordRules { minLength: number; requireUpper: boolean; requireLower: boolean; requireDigit: boolean; requireSymbol: boolean }
export const DEFAULT_PASSWORD_RULES: PasswordRules = { minLength: 12, requireUpper: false, requireLower: false, requireDigit: false, requireSymbol: false };

export interface PasswordCheck { id: string; label: string; ok: boolean }

/** Each rule in force, with whether this password meets it. */
export function passwordChecklist(rules: PasswordRules, password: string, username = ''): PasswordCheck[] {
  const c: PasswordCheck[] = [{ id: 'length', label: `At least ${rules.minLength} characters`, ok: password.length >= rules.minLength }];
  if (rules.requireUpper) c.push({ id: 'upper', label: 'An uppercase letter', ok: /[A-Z]/.test(password) });
  if (rules.requireLower) c.push({ id: 'lower', label: 'A lowercase letter', ok: /[a-z]/.test(password) });
  if (rules.requireDigit) c.push({ id: 'digit', label: 'A number', ok: /\d/.test(password) });
  if (rules.requireSymbol) c.push({ id: 'symbol', label: 'A symbol such as ! ? # %', ok: /[^A-Za-z0-9]/.test(password) });
  if (username) c.push({ id: 'username', label: 'Does not contain your username', ok: !password.toLowerCase().includes(username.toLowerCase()) });
  return c;
}

/** The first unmet rule as a sentence, or null when every rule is met. */
export function passwordIssue(rules: PasswordRules, password: string, username = ''): string | null {
  if (password.length > 128) return 'Use at most 128 characters.';
  const miss = passwordChecklist(rules, password, username).find((x) => !x.ok);
  if (!miss) return null;
  return ({ length: `Use at least ${rules.minLength} characters.`, upper: 'Add an uppercase letter.', lower: 'Add a lowercase letter.', digit: 'Add a number.', symbol: 'Add a symbol.', username: 'The password must not contain the username.' } as Record<string, string>)[miss.id] ?? miss.label;
}

/** A rough 0 to 4 strength for the meter: length and variety count; a few common patterns do not. It guides; the rules decide. */
export function passwordStrength(password: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!password) return { score: 0, label: '' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  let s = Math.min(4, Math.floor(password.length / 4)) + (classes >= 3 ? 1 : 0) - (new Set(password).size < 5 ? 2 : 0) - (/^(.)\1+$|^(?:0123|1234|abcd|qwer|pass|admin)/i.test(password) ? 2 : 0);
  s = Math.max(0, Math.min(4, Math.round(s * 0.8)));
  return { score: s as 0 | 1 | 2 | 3 | 4, label: ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][s]! };
}
