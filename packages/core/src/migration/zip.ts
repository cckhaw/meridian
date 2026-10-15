import { crc32 } from 'node:zlib';

/**
 * A streaming ZIP writer: entries are written as their data arrives, so an archive of any size is produced without holding it in memory. It uses ZIP64
 * records throughout, so entries and archives over 4 GB are fine, and data descriptors, so no size has to be known before the data is written.
 */
const enc = new TextEncoder();
const u16 = (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64 = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

function dosTime(d: Date) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

export interface ZipEntryResult { name: string; crc: number; size: number; compressedSize: number }

/** Writes `entries` (name + the bytes of the entry as they come) as a ZIP archive, in chunks. `compress` turns each entry into its deflated bytes. */
export async function* zipArchive(
  entries: AsyncIterable<{ name: string; data: () => AsyncIterable<Uint8Array>; /** the entry's bytes are already deflated; this gives the uncompressed size and crc when done */ done?: () => { size: number; crc: number } }>,
  o: { now?: Date } = {},
): AsyncGenerator<Uint8Array> {
  const { time, date } = dosTime(o.now ?? new Date());
  let offset = 0;
  const central: Uint8Array[] = [];
  const out = (b: Uint8Array) => { offset += b.length; return b; };
  for await (const e of entries) {
    const name = enc.encode(e.name);
    const headerOffset = offset;
    // Local header: version 4.5 (ZIP64), flags: data descriptor follows + UTF-8 names, method 8 (deflate). Sizes are in the descriptor.
    const zip64Local = cat(u16(1), u16(16), u64(0), u64(0));
    yield out(cat(u32(0x04034b50), u16(45), u16(0x0808), u16(8), u16(time), u16(date), u32(0), u32(0xffffffff), u32(0xffffffff), u16(name.length), u16(zip64Local.length), name, zip64Local));
    let compressed = 0;
    for await (const chunk of e.data()) { compressed += chunk.length; yield out(chunk); }
    const { size, crc } = e.done!();
    yield out(cat(u32(0x08074b50), u32(crc), u64(compressed), u64(size)));
    const zip64Central = cat(u16(1), u16(24), u64(size), u64(compressed), u64(headerOffset));
    central.push(cat(u32(0x02014b50), u16(45), u16(45), u16(0x0808), u16(8), u16(time), u16(date), u32(crc), u32(0xffffffff), u32(0xffffffff), u16(name.length), u16(zip64Central.length), u16(0), u16(0), u16(0), u32(0), u32(0xffffffff), name, zip64Central));
  }
  const cdStart = offset;
  for (const c of central) yield out(c);
  const cdSize = offset - cdStart;
  const zip64EndOffset = offset;
  yield out(cat(u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(central.length), u64(central.length), u64(cdSize), u64(cdStart)));
  yield out(cat(u32(0x07064b50), u32(0), u64(zip64EndOffset), u32(1)));
  yield out(cat(u32(0x06054b50), u16(0), u16(0), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0xffffffff), u16(0)));
}

/** Running size and crc32 of the bytes that pass through. */
export class Tally {
  size = 0; crc = 0;
  add(b: Uint8Array) { this.size += b.length; this.crc = crc32(b, this.crc); }
}
