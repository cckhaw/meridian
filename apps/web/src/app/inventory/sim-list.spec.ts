import { describe, expect, it } from 'vitest';
import { parseSimList } from './sim-list';

describe('parseSimList', () => {
  it('splits on new lines, spaces, tabs, commas and semicolons', () => {
    expect(parseSimList('8960001\n8960002\r\n8960003, 8960004;8960005\t8960006  8960007')).toEqual(['8960001', '8960002', '8960003', '8960004', '8960005', '8960006', '8960007']);
  });
  it('drops blanks and repeats and keeps the first-seen order', () => {
    expect(parseSimList(' ,; 8960002\n\n8960001,8960002 ;\n')).toEqual(['8960002', '8960001']);
    expect(parseSimList('')).toEqual([]);
  });
  it('does not split on a letter s or a backslash', () => {
    expect(parseSimList('89s60\\01')).toEqual(['89s60\\01']);
  });
});
