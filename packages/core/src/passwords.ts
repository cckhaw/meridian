import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw, salt, len, opts, (e, k) => (e ? rej(e) : res(k))));

// OWASP-recommended scrypt cost; stored with the hash so it can be raised later without invalidating old hashes.
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 64;
const opts = (n: number, r: number, p: number): ScryptOptions => ({ N: n, r, p, maxmem: 128 * n * r * 2 });

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, opts(N, R, P));
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, opts(Number(n), Number(r), Number(p)));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A real hash to verify against when the username does not exist, so response time does not reveal which usernames are valid. */
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword('meridian-timing-equaliser-not-a-credential'));

const COMMON = new Set(['password', 'password123', 'passw0rd', 'qwertyuiop', 'letmein', 'welcome', 'admin', 'administrator', 'changeme', 'meridian', 'iloveyou', '123456789012', 'qwerty123456']);

/** NIST 800-63B style: length and a blocklist matter more than composition rules. Returns an error message or null. */
export function passwordProblem(password: string, username = ''): string | null {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 128) return 'Use at most 128 characters.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower.replace(/[^a-z0-9]/g, '')) || COMMON.has(lower)) return 'That password is too common.';
  if (username && lower.includes(username.toLowerCase())) return 'The password must not contain the username.';
  if (new Set(password).size < 5) return 'Use a less repetitive password.';
  return null;
}

/** Random temporary password without look-alike characters, shown once to the administrator. */
export function temporaryPassword(len = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
