import { describe, expect, it } from 'vitest';
import { presignGet, s3Config, signLink, verifyLink } from './doc-store.js';

describe('document store', () => {
  it('signs S3 links exactly as AWS documents it (their published Signature V4 example)', () => {
    const url = presignGet({ endpoint: 'https://s3.amazonaws.com', bucket: 'examplebucket', region: 'us-east-1', accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', pathStyle: false },
      'test.txt', { ttl: 86400, now: new Date('2013-05-24T00:00:00Z') });
    expect(url).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    expect(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?')).toBe(true);
  });
  it('is off unless every setting is given, and refuses plain http', () => {
    expect(s3Config({})).toBeNull();
    expect(() => s3Config({ MERIDIAN_DOCS_S3_ENDPOINT: 'http://example.com', MERIDIAN_DOCS_S3_BUCKET: 'b', MERIDIAN_DOCS_S3_ACCESS_KEY: 'a', MERIDIAN_DOCS_S3_SECRET_KEY: 's' })).toThrow(/https/);
    expect(s3Config({ MERIDIAN_DOCS_S3_ENDPOINT: 'https://s3.example.com/', MERIDIAN_DOCS_S3_BUCKET: 'b', MERIDIAN_DOCS_S3_ACCESS_KEY: 'a', MERIDIAN_DOCS_S3_SECRET_KEY: 's' })?.endpoint).toBe('https://s3.example.com');
  });
  it('makes 15-minute links that cannot be altered or reused for another document', () => {
    const t = signLink('11111111-1111-1111-1111-111111111111', { now: 1_000_000 });
    expect(verifyLink(t, 1_000_000 + 14 * 60_000)?.documentId).toBe('11111111-1111-1111-1111-111111111111');
    expect(verifyLink(t, 1_000_000 + 16 * 60_000)).toBeNull();
    expect(verifyLink(t.replace('1111', '2222'), 1_000_000)).toBeNull();
    expect(verifyLink(signLink('a', { download: true, now: 1_000_000 }), 1_000_000)?.download).toBe(true);
    expect(verifyLink('nonsense')).toBeNull();
  });
});
