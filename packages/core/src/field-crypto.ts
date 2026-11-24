import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Application-level encryption for identity data and stored secrets (ID numbers, document images, integration secrets, TOTP secrets): AES-256-GCM, with keys derived from secrets in the
 * environment, and **versioned** so a key can be replaced without a flag day.
 *
 *   Stored form:  "MFK" | key id (1 byte) | iv (12) | auth tag (16) | ciphertext        (the 4-byte header is authenticated with the data)
 *   Before key versions existed the form was  iv (12) | auth tag (16) | ciphertext  with no header; it is still read.
 *
 * Keys: the current key is MERIDIAN_DATA_KEY (falling back to MERIDIAN_ID_PEPPER, as before) and has the id MERIDIAN_DATA_KEY_ID (default 1); everything is written with it. Earlier keys
 * stay readable from MERIDIAN_DATA_KEYS_OLD, a JSON object of id → secret, e.g. {"1":"the old secret"}. To rotate: put the current secret under its id in MERIDIAN_DATA_KEYS_OLD, set a
 * new MERIDIAN_DATA_KEY with a new MERIDIAN_DATA_KEY_ID, deploy, then run `pnpm --filter @meridian/core rekey` to re-encrypt what is stored (see docs/OPERATIONS.md), and finally drop
 * the old key. Losing a key makes what was encrypted with it unreadable, so back all of them up with the database.
 */
const MAGIC = Buffer.from('MFK', 'ascii');
const HEADER = MAGIC.length + 1;
const IV = 12, TAG = 16;

interface Ring { currentId: number; current: Buffer; byId: Map<number, Buffer>; all: Buffer[] }
const derive = (secret: string): Buffer => Buffer.from(hkdfSync('sha256', secret, 'meridian-field-encryption', 'aes-256-gcm', 32));
const idOf = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 255) throw new Error(`${what} must be a whole number from 1 to 255.`);
  return n;
};

let cache: { sig: string; ring: Ring } | null = null;
function ring(): Ring {
  const env = process.env;
  const sig = [env.MERIDIAN_DATA_KEY, env.MERIDIAN_ID_PEPPER, env.MERIDIAN_DATA_KEY_ID, env.MERIDIAN_DATA_KEYS_OLD, env.NODE_ENV].join('\u0000');
  if (cache?.sig === sig) return cache.ring;
  const secret = env.MERIDIAN_DATA_KEY ?? env.MERIDIAN_ID_PEPPER;
  if (!secret && env.NODE_ENV === 'production') throw new Error('MERIDIAN_DATA_KEY (or MERIDIAN_ID_PEPPER) must be set: there is no default key in production.');
  const currentId = idOf(env.MERIDIAN_DATA_KEY_ID ?? 1, 'MERIDIAN_DATA_KEY_ID');
  const current = derive(secret ?? 'dev-only-pepper');
  const byId = new Map<number, Buffer>([[currentId, current]]);
  const all = [current];
  if (env.MERIDIAN_DATA_KEYS_OLD) {
    let old: Record<string, unknown>;
    try { old = JSON.parse(env.MERIDIAN_DATA_KEYS_OLD); if (!old || typeof old !== 'object' || Array.isArray(old)) throw new Error('not an object'); }
    catch { throw new Error('MERIDIAN_DATA_KEYS_OLD must be a JSON object of key id to secret, for example {"1":"the old secret"}.'); }
    for (const [k, v] of Object.entries(old)) {
      const id = idOf(k, `The key id “${k}” in MERIDIAN_DATA_KEYS_OLD`);
      if (typeof v !== 'string' || !v) throw new Error(`The secret for key ${id} in MERIDIAN_DATA_KEYS_OLD must be a non-empty string.`);
      if (id === currentId) throw new Error(`Key id ${id} is the current key; give a retired key its own id in MERIDIAN_DATA_KEYS_OLD.`);
      const key = derive(v);
      byId.set(id, key); all.push(key);
    }
  }
  const r = { currentId, current, byId, all };
  cache = { sig, ring: r };
  return r;
}

export function encryptBytes(plain: Buffer): Buffer {
  const { currentId, current } = ring();
  const header = Buffer.concat([MAGIC, Buffer.from([currentId])]);
  const iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', current, iv);
  c.setAAD(header);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([header, iv, c.getAuthTag(), body]);
}

const open = (key: Buffer, iv: Buffer, tag: Buffer, body: Buffer, aad?: Buffer): Buffer => {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
};

/** The key id a blob was written with, or null for the form that had no key ids (read with the current key, then the retired ones). */
export function keyIdOf(blob: Buffer): number | null {
  return blob.length >= HEADER + IV + TAG && blob.subarray(0, MAGIC.length).equals(MAGIC) ? blob[MAGIC.length]! : null;
}

export function decryptBytes(blob: Buffer): Buffer {
  const r = ring();
  const id = keyIdOf(blob);
  let named: Buffer | undefined;
  if (id !== null) {
    named = r.byId.get(id);
    if (named) {
      try { return open(named, blob.subarray(HEADER, HEADER + IV), blob.subarray(HEADER + IV, HEADER + IV + TAG), blob.subarray(HEADER + IV + TAG), blob.subarray(0, HEADER)); }
      catch { /* an old-form blob can start with the same three bytes by chance: fall through and read it as one */ }
    }
  }
  // The form without a header: no key id, so try the current key and then each retired one.
  if (blob.length >= IV + TAG) {
    for (const key of r.all) {
      try { return open(key, blob.subarray(0, IV), blob.subarray(IV, IV + TAG), blob.subarray(IV + TAG)); } catch { /* try the next key */ }
    }
  }
  if (id !== null && !named) throw new Error(`Stored data was encrypted with key ${id}, which is not configured (MERIDIAN_DATA_KEY_ID / MERIDIAN_DATA_KEYS_OLD).`);
  throw new Error('Stored data could not be decrypted with any configured key.');
}

export const encryptText = (s: string): string => encryptBytes(Buffer.from(s, 'utf8')).toString('base64');
export const decryptText = (s: string): string => decryptBytes(Buffer.from(s, 'base64')).toString('utf8');
export const sha256Hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** The same data under the current key; null when it already is. Throws if it cannot be read (the key is missing or the data is damaged). */
export function reencryptBytes(blob: Buffer): Buffer | null {
  const r = ring();
  if (keyIdOf(blob) === r.currentId) {
    try { open(r.current, blob.subarray(HEADER, HEADER + IV), blob.subarray(HEADER + IV, HEADER + IV + TAG), blob.subarray(HEADER + IV + TAG), blob.subarray(0, HEADER)); return null; }
    catch { /* an old-form blob that happens to start like a header: rewrite it */ }
  }
  return encryptBytes(decryptBytes(blob));
}
export function reencryptText(s: string): string | null {
  const out = reencryptBytes(Buffer.from(s, 'base64'));
  return out ? out.toString('base64') : null;
}
/** What is configured, without any secret: for the key-rotation report. */
export const dataKeyStatus = (): { currentId: number; retiredIds: number[] } => { const r = ring(); return { currentId: r.currentId, retiredIds: [...r.byId.keys()].filter((i) => i !== r.currentId).sort((a, b) => a - b) }; };
