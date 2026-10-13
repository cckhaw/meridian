import { invalid } from './errors.js';

/** A small CSV reader: quoted cells, doubled quotes, commas and line breaks inside quotes, CRLF, a leading byte-order mark. Each row remembers the line it started on. */
export function parseCsv(text: string): Array<{ line: number; cells: string[] }> {
  const src = text.replace(/^﻿/, '');
  const rows: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [], cell = '', quoted = false, line = 1, start = 1, touched = false;
  const endCell = () => { cells.push(cell); cell = ''; };
  const endRow = () => { endCell(); if (touched || cells.some((c) => c.length)) rows.push({ line: start, cells }); cells = []; touched = false; start = line + 1; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else { if (ch === '\n') line++; cell += ch; }
    } else if (ch === '"' && cell === '') { quoted = true; touched = true; }
    else if (ch === ',') { endCell(); touched = true; }
    else if (ch === '\r') { /* part of CRLF */ }
    else if (ch === '\n') { endRow(); line++; start = line; }
    else { cell += ch; touched = true; }
  }
  if (quoted) throw invalid('The file has a quotation mark that is never closed.');
  if (cell.length || cells.length || touched) endRow();
  return rows;
}
export const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

