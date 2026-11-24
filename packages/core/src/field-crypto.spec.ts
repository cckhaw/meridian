import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataKeyStatus, decryptBytes, decryptText, encryptBytes, encryptText, keyIdOf, reencryptBytes, reencryptText } from './field-crypto.js';

const KEYS = ['MERIDIAN_DATA_KEY', 'MERIDIAN_ID_PEPPER', 'MERIDIAN_DATA_KEY_ID', 'MERIDIAN_DATA_KEYS_OLD'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

/** The form before key versions: iv | tag | ciphertext, with the key derived the same way. */
const legacy = (plain: string, secret: string, iv: Buffer = randomBytes(12)): Buffer => {
  const key = Buffer.from(hkdfSync('sha256', secret, 'meridian-field-encryption', 'aes-256-gcm', 32));
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
};
const use = (cur: string, id?: number, old?: Record<number, string>) => {
  process.env.MERIDIAN_DATA_KEY = cur;
  if (id) process.env.MERIDIAN_DATA_KEY_ID = String(id); else delete process.env.MERIDIAN_DATA_KEY_ID;
  if (old) process.env.MERIDIAN_DATA_KEYS_OLD = JSON.stringify(old); else delete process.env.MERIDIAN_DATA_KEYS_OLD;
};

describe('field encryption with key versions', () => {
  it('writes a header with the key id and reads it back; two encryptions of the same text differ', () => {
    use('secret-one-secret-one', 1);
    const a = encryptBytes(Buffer.from('S1234567A'));
    expect(a.subarray(0, 3).toString()).toBe('MFK');
    expect(keyIdOf(a)).toBe(1);
    expect(decryptBytes(a).toString()).toBe('S1234567A');
    expect(encryptText('x')).not.toBe(encryptText('x'));
    expect(decryptText(encryptText('héllo ✓'))).toBe('héllo ✓');
    expect(decryptBytes(encryptBytes(Buffer.alloc(0))).length).toBe(0);
    const big = randomBytes(300_000);
    expect(decryptBytes(encryptBytes(big)).equals(big)).toBe(true);
  });

  it('still reads data written before key versions, with the secret it was written under', () => {
    use('the-secret-of-old-times', 1);
    const old = legacy('S7654321Z', 'the-secret-of-old-times');
    expect(keyIdOf(old)).toBeNull();
    expect(decryptBytes(old).toString()).toBe('S7654321Z');
    process.env.MERIDIAN_ID_PEPPER = 'pepper-as-the-only-key'; delete process.env.MERIDIAN_DATA_KEY;     // the fallback that existed before: the pepper is the key
    expect(decryptBytes(legacy('from the pepper', 'pepper-as-the-only-key')).toString()).toBe('from the pepper');
  });

  it('survives a rotation: new writes use the new key, everything written under the old key is still read', () => {
    use('first-secret-first-secret', 1);
    const underOne = encryptBytes(Buffer.from('written under key 1'));
    const legacyOne = legacy('legacy under the first secret', 'first-secret-first-secret');
    use('second-secret-second-secret', 2, { 1: 'first-secret-first-secret' });
    expect(dataKeyStatus()).toEqual({ currentId: 2, retiredIds: [1] });
    expect(decryptBytes(underOne).toString()).toBe('written under key 1');
    expect(decryptBytes(legacyOne).toString()).toBe('legacy under the first secret');
    expect(keyIdOf(encryptBytes(Buffer.from('new')))).toBe(2);
  });

  it('says which key is missing, and refuses data that was tampered with', () => {
    use('first-secret-first-secret', 1);
    const blob = encryptBytes(Buffer.from('secret data'));
    use('second-secret-second-secret', 2);                                         // key 1 not kept
    expect(() => decryptBytes(blob)).toThrow(/encrypted with key 1, which is not configured/);
    use('first-secret-first-secret', 1);
    const flipped = Buffer.from(blob); flipped[blob.length - 1]! ^= 1;
    expect(() => decryptBytes(flipped)).toThrow(/could not be decrypted/);        // the ciphertext
    const otherKeyId = Buffer.from(blob); otherKeyId[3] = 9;
    expect(() => decryptBytes(otherKeyId)).toThrow();                              // the header is part of what is authenticated
    expect(() => decryptBytes(Buffer.from('short'))).toThrow();
  });

  it('reads an old-form blob that happens to begin with the header bytes', () => {
    use('collision-secret-collision', 1);
    const iv = Buffer.concat([Buffer.from('MFK'), Buffer.from([1]), randomBytes(8)]);   // looks exactly like a header naming key 1
    const old = legacy('still readable', 'collision-secret-collision', iv);
    expect(keyIdOf(old)).toBe(1);
    expect(decryptBytes(old).toString()).toBe('still readable');
    expect(reencryptBytes(old)).not.toBeNull();                                    // and it is rewritten into the current form, not mistaken for it
    expect(decryptBytes(reencryptBytes(old)!).toString()).toBe('still readable');
  });

  it('re-encrypts only what is not on the current key', () => {
    use('first-secret-first-secret', 1);
    const one = encryptBytes(Buffer.from('payload')), oneText = encryptText('text payload'), old = legacy('legacy payload', 'first-secret-first-secret');
    expect(reencryptBytes(one)).toBeNull();
    expect(reencryptText(oneText)).toBeNull();
    use('second-secret-second-secret', 2, { 1: 'first-secret-first-secret' });
    const moved = reencryptBytes(one)!, movedLegacy = reencryptBytes(old)!;
    expect(keyIdOf(moved)).toBe(2); expect(keyIdOf(movedLegacy)).toBe(2);
    expect(decryptBytes(moved).toString()).toBe('payload'); expect(decryptBytes(movedLegacy).toString()).toBe('legacy payload');
    expect(reencryptBytes(moved)).toBeNull();
    expect(decryptText(reencryptText(oneText)!)).toBe('text payload');
    // after the old key is dropped, only what was re-encrypted can still be read
    use('second-secret-second-secret', 2);
    expect(decryptBytes(moved).toString()).toBe('payload');
    expect(() => decryptBytes(one)).toThrow();
  });

  it('checks its configuration: ids, the old-key list, and no default key in production', () => {
    process.env.MERIDIAN_DATA_KEY = 'a-secret-that-is-long'; process.env.MERIDIAN_DATA_KEY_ID = '0';
    expect(() => encryptText('x')).toThrow(/MERIDIAN_DATA_KEY_ID must be a whole number from 1 to 255/);
    use('a-secret-that-is-long', 2, undefined); process.env.MERIDIAN_DATA_KEYS_OLD = 'not json';
    expect(() => encryptText('x')).toThrow(/must be a JSON object/);
    process.env.MERIDIAN_DATA_KEYS_OLD = JSON.stringify({ 2: 'same id as the current key' });
    expect(() => encryptText('x')).toThrow(/is the current key/);
    process.env.MERIDIAN_DATA_KEYS_OLD = JSON.stringify({ 300: 'x' });
    expect(() => encryptText('x')).toThrow(/1 to 255/);
    delete process.env.MERIDIAN_DATA_KEYS_OLD; delete process.env.MERIDIAN_DATA_KEY;
    const was = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = 'production';
      expect(() => encryptText('x')).toThrow(/no default key in production/);
    } finally { (process.env as Record<string, string | undefined>).NODE_ENV = was; }
  });
});
