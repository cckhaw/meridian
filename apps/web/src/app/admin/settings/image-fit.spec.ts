import { describe, expect, it } from 'vitest';
import { base64Bytes, fitPng, fitSizes } from './image-fit';

describe('fitSizes', () => {
  it('starts at the preset and shrinks with the aspect ratio kept', () => {
    const s = fitSizes({ width: 480, height: 120 });
    expect(s[0]).toEqual({ width: 480, height: 120 });
    expect(s.length).toBeGreaterThan(5);
    for (const x of s) { expect(x.width / x.height).toBeCloseTo(4, 0); expect(x.height).toBeGreaterThanOrEqual(16); }
    expect(s.map((x) => x.width)).toEqual([...s.map((x) => x.width)].sort((a, b) => b - a));
  });
  it('keeps a favicon square down to 16 px', () => {
    const s = fitSizes({ width: 256, height: 256 });
    expect(s.every((x) => x.width === x.height)).toBe(true);
    expect(s[s.length - 1]!.width).toBeGreaterThanOrEqual(16);
  });
});

describe('fitPng', () => {
  const fake = (perPixel: number) => ({ width, height }: { width: number; height: number }) => 'A'.repeat(Math.ceil((width * height * perPixel * 4) / 3));
  it('counts the bytes behind a base64 string', () => { expect(base64Bytes('QUJD')).toBe(3); expect(base64Bytes('QUI=')).toBe(2); expect(base64Bytes('QQ==')).toBe(1); });
  it('keeps the preset size when it already fits', () => {
    const r = fitPng(fake(1), { width: 100, height: 100 }, 20_000);
    expect(r).toMatchObject({ width: 100, height: 100, reduced: false });
  });
  it('steps down until it fits', () => {
    const r = fitPng(fake(1), { width: 256, height: 256 }, 20_000);
    expect('tooBig' in r).toBe(false);
    if (!('tooBig' in r)) { expect(r.reduced).toBe(true); expect(r.bytes).toBeLessThanOrEqual(20_000); expect(r.width).toBe(r.height); expect(r.width).toBeLessThan(256); }
  });
  it('says so when nothing fits', () => {
    const r = fitPng(fake(1000), { width: 256, height: 256 }, 100);
    expect(r).toMatchObject({ tooBig: true });
  });
});
