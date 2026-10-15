import { describe, expect, it } from 'vitest';
import { parseCsv } from '../csv.js';
import { parseCsvBytes } from './csvstream.js';

const enc = (s: string) => new TextEncoder().encode(s);
/** Reads a whole file through the incremental parser in windows of `win` bytes, exactly as a job resumes. */
function readAll(text: string, win: number, maxRows = Infinity) {
  const bytes = enc(text);
  const out: Array<{ cells: string[]; line: number }> = [];
  let pos = 0, line = 1;
  for (let guard = 0; guard < 100000; guard++) {
    const end = Math.min(bytes.length, pos + win);
    const r = parseCsvBytes(bytes.subarray(pos, end), pos, line, { final: end >= bytes.length, maxRows });
    out.push(...r.rows.map((x) => ({ cells: x.cells, line: x.line })));
    if (end >= bytes.length && r.next >= bytes.length) break;
    if (r.next === pos && end < bytes.length) { win *= 2; continue; } // a row larger than the window: widen it
    pos = r.next; line = r.nextLine;
    if (pos >= bytes.length) break;
  }
  return out;
}

describe('streaming CSV reader', () => {
  const tricky = [
    'id,name,note', '1,Alex,plain', '2,"Smith, Jo","says ""hi"""', '3,"two', 'lines",end', '# a comment, skipped', '', '4,Zoë 😀,ünïcode', '5,,', '6,last,row-without-newline',
  ].join('\r\n');

  it('reads quoted cells, doubled quotes, line breaks inside quotes, comments, blank rows and multi-byte text', () => {
    const rows = readAll(tricky, 1 << 20);
    expect(rows.map((r) => r.cells)).toEqual([['id', 'name', 'note'], ['1', 'Alex', 'plain'], ['2', 'Smith, Jo', 'says "hi"'], ['3', 'two\r\nlines', 'end'], ['4', 'Zoë 😀', 'ünïcode'], ['5', '', ''], ['6', 'last', 'row-without-newline']]);
    expect(rows.map((r) => r.line)).toEqual([1, 2, 3, 4, 8, 9, 10]);
  });

  it('gives the same rows whatever the size of the windows it is fed in (and at every split point)', () => {
    const want = parseCsv(tricky).filter((r) => !r.cells[0]!.startsWith('#')).map((r) => r.cells);
    for (let win = 1; win < 40; win++) expect(readAll(tricky, win).map((r) => r.cells), `window ${win}`).toEqual(want);
  });

  it('skips a byte-order mark, accepts LF line ends, and can stop after any row and resume from its end offset', () => {
    const text = '﻿a,b\n1,2\n3,4\n5,6\n';
    expect(readAll(text, 1 << 20).map((r) => r.cells)).toEqual([['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']]);
    const bytes = enc(text);
    const first = parseCsvBytes(bytes, 0, 1, { final: true, maxRows: 2 });
    expect(first.rows.map((r) => r.cells)).toEqual([['a', 'b'], ['1', '2']]);
    const rest = parseCsvBytes(bytes.subarray(first.next), first.next, first.nextLine, { final: true });
    expect(rest.rows.map((r) => r.cells)).toEqual([['3', '4'], ['5', '6']]);
    expect(rest.rows[0]!.line).toBe(3);
    expect(rest.rows.at(-1)!.end).toBe(bytes.length);
  });

  it('refuses a quote that is never closed, and agrees with the in-memory parser on a generated file', () => {
    expect(() => readAll('a,b\n1,"oops\n2,3\n', 1 << 20)).toThrow(/never closed/);
    const lines = ['x,y,z'];
    for (let i = 0; i < 500; i++) lines.push(`${i},"v ${i}, ""q""",${i % 7 ? 'plain' : '"multi\nline"'}`);
    const text = lines.join('\n') + '\n';
    expect(readAll(text, 97).map((r) => r.cells)).toEqual(parseCsv(text).map((r) => r.cells));
  });
});
