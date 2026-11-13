import { describe, expect, it } from 'vitest';
import { filterOptions, nextActive, wildcardRegExp, type ComboOption } from '../../../../../packages/ui/src/components/combobox-logic';

const o = (value: string, extra: Partial<ComboOption> = {}): ComboOption => ({ value, label: value, ...extra });
describe('combobox keyboard and filtering', () => {
  const opts = [o('amy'), o('ben', { disabled: true }), o('cat'), o('dan', { disabled: true })];
  it('moves down and up, skipping disabled options and wrapping', () => {
    expect(nextActive(opts, -1, 'next')).toBe(0);
    expect(nextActive(opts, 0, 'next')).toBe(2);
    expect(nextActive(opts, 2, 'next')).toBe(0);
    expect(nextActive(opts, 0, 'prev')).toBe(2);
    expect(nextActive(opts, 2, 'first')).toBe(0); expect(nextActive(opts, 0, 'last')).toBe(2);
  });
  it('has nothing to highlight when every option is disabled or there are none', () => {
    expect(nextActive([o('x', { disabled: true })], -1, 'next')).toBe(-1); expect(nextActive([], -1, 'next')).toBe(-1);
  });
  it('filters with wildcards and treats other characters literally', () => {
    const list = [o('siti', { label: 'Siti Aman', description: 'KYC Compliance Officer' }), o('tan', { label: 'Tan Wei' }), o('a.b', { label: 'a.b' })];
    expect(filterOptions(list, 'Tan*').map((x) => x.value)).toEqual(['tan']);
    expect(filterOptions(list, 'compliance').map((x) => x.value)).toEqual(['siti']);
    expect(filterOptions(list, 'a.b').map((x) => x.value)).toEqual(['a.b']);
    expect(filterOptions(list, '').length).toBe(3);
    expect(wildcardRegExp('*4567').test('S1234567')).toBe(true); expect(wildcardRegExp('KYC-00120?').test('KYC-001203')).toBe(true);
  });
});
