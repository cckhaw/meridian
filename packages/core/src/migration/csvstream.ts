/**
 * A CSV reader for files too big to hold in memory. It works on bytes, from any starting offset, and tells where each row ENDS, so a job can stop after any row,
 * remember the offset and carry on later (even from another request) without re-reading what it has done. Quoted cells may hold commas, doubled quotes and
 * line breaks; CRLF and LF both end a row; a leading byte-order mark is skipped; a row that starts with # is a comment and is skipped; empty rows are skipped.
 */
export interface RawRow { cells: string[]; /** the first line of the row in the file, counting from 1 */ line: number; /** byte offset just after the row's line break */ end: number }

const QUOTE = 0x22, COMMA = 0x2c, LF = 0x0a, CR = 0x0d, HASH = 0x23;
const dec = new TextDecoder('utf-8');

export interface ParseResult { rows: RawRow[]; /** the offset to continue from (just after the last complete row), or the start when none is complete */ next: number; /** the line number of the row at `next` */ nextLine: number }

/**
 * Parses complete rows from `buf`, which begins at file offset `base` with line number `line`. A row is complete when its line break has been seen outside quotes,
 * or when `final` says the file ends here. At most `maxRows` rows are returned.
 */
export function parseCsvBytes(buf: Uint8Array, base: number, line: number, o: { final: boolean; maxRows?: number }): ParseResult {
  const rows: RawRow[] = [];
  const max = o.maxRows ?? Infinity;
  let i = 0;
  let curLine = line;
  if (base === 0 && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  let lastEnd = base + i, lastLine = curLine;
  if (i === 3) { /* skip the byte-order mark */ }
  while (i < buf.length && rows.length < max) {
    // A comment line: skip to its end.
    if (buf[i] === HASH) {
      let j = i;
      while (j < buf.length && buf[j] !== LF) j++;
      if (j >= buf.length && !o.final) break;
      i = j < buf.length ? j + 1 : j;
      curLine++; lastEnd = base + i; lastLine = curLine;
      continue;
    }
    const startLine = curLine;
    const cells: string[] = [];
    let cellStart = i, quoted = false, hadQuote = false, parts: Uint8Array[] = [], complete = false, j = i, touched = false;
    const endCell = (to: number) => {
      let text: string;
      if (hadQuote) { parts.push(buf.subarray(cellStart, to)); const all = Buffer.concat(parts); text = dec.decode(all); }
      else text = dec.decode(buf.subarray(cellStart, to));
      cells.push(text); parts = []; hadQuote = false;
    };
    for (; j < buf.length; j++) {
      const b = buf[j]!;
      if (quoted) {
        if (b === QUOTE) {
          if (buf[j + 1] === QUOTE) { parts.push(buf.subarray(cellStart, j + 1)); j++; cellStart = j + 1; }
          else if (j + 1 >= buf.length && !o.final) break; // cannot tell yet whether this closes the quote or starts a doubled one
          else { parts.push(buf.subarray(cellStart, j)); cellStart = j + 1; quoted = false; }
        } else if (b === LF) curLine++;
      } else if (b === QUOTE && j === cellStart) { quoted = true; hadQuote = true; touched = true; cellStart = j + 1; }
      else if (b === COMMA) { endCell(j); cellStart = j + 1; touched = true; }
      else if (b === CR) { /* part of CRLF */ }
      else if (b === LF) { endCell(j - (buf[j - 1] === CR && j - 1 >= cellStart ? 1 : 0)); complete = true; j++; curLine++; break; }
      else touched = true;
    }
    if (!complete) {
      if (o.final && !quoted && j >= buf.length && (touched || cells.length)) { endCell(buf.length); complete = true; }
      else if (o.final && quoted) throw new Error(`The file has a quotation mark that is never closed (row starting on line ${startLine}).`);
      else break;
    }
    i = j;
    lastEnd = base + i; lastLine = curLine;
    if (touched || cells.some((c) => c.length)) rows.push({ cells, line: startLine, end: base + i });
  }
  return { rows, next: lastEnd, nextLine: lastLine };
}
