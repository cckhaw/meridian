import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Application-level encryption for identity data (ID numbers, document images): AES-256-GCM with a key derived from MERIDIAN_DATA_KEY
 * (falling back to MERIDIAN_ID_PEPPER, which production already requires). Losing the key makes the data unreadable, so back it up with the database.
 * Stored form: iv (12) | auth tag (16) | ciphertext.
 */
const key = (): Buffer => {
  const secret = process.env.MERIDIAN_DATA_KEY ?? process.env.MERIDIAN_ID_PEPPER ?? 'dev-only-pepper';
  return Buffer.from(hkdfSync('sha256', secret, 'meridian-field-encryption', 'aes-256-gcm', 32));
};

export function encryptBytes(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
export function decryptBytes(blob: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key(), blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}
export const encryptText = (s: string): string => encryptBytes(Buffer.from(s, 'utf8')).toString('base64');
export const decryptText = (s: string): string => decryptBytes(Buffer.from(s, 'base64')).toString('utf8');
export const sha256Hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
