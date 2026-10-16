import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDb, type Db } from './db.js';
import { createCustomer } from './customers.js';
import { seedReference } from './seed.js';

import { crc32, deflateSync } from 'node:zlib';
/** A small valid PNG (white with a black diagonal) standing in for a drawn signature. */
export function signaturePng(w = 240, h = 80): Buffer {
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type), len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 255);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; const x = Math.floor((y / h) * w); for (let k = 0; k < 6 && x + k < w; k++) { const o = y * (w * 3 + 1) + 1 + (x + k) * 3; raw[o] = raw[o + 1] = raw[o + 2] = 0; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/**
 * A structurally valid JPEG of the given size, as the live camera produces it (no photo-library metadata) or, with `exif`, as a gallery photo carries it. Each call is a
 * different picture unless a `seed` is given, so two cases never share an image by accident.
 */
export function idPhoto(o: { w?: number; h?: number; exif?: boolean; seed?: string } = {}): Buffer {
  const seg = (m: number, data: Buffer) => { const len = Buffer.alloc(2); len.writeUInt16BE(data.length + 2); return Buffer.concat([Buffer.from([0xff, m]), len, data]); };
  const sof = Buffer.alloc(15); sof[0] = 8; sof.writeUInt16BE(o.h ?? 800, 1); sof.writeUInt16BE(o.w ?? 1280, 3); sof[5] = 3; sof.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 6);
  const sos = Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    ...(o.exif ? [seg(0xe1, Buffer.from('Exif\0\0II*\0\x08\0\0\0\0\0', 'latin1'))] : []),
    seg(0xfe, Buffer.from(o.seed ?? randomUUID(), 'latin1')), seg(0xc0, sof), seg(0xda, sos), Buffer.from('mock-scan-data'), Buffer.from([0xff, 0xd9]),
  ]);
}
/** What the capture screen reports for a photo taken now. */
export const liveCapture = (at: Date = new Date()) => ({ method: 'LIVE_CAMERA' as const, at: at.toISOString(), facing: 'environment' });
export const signatureDataUrl = () => `data:image/png;base64,${signaturePng().toString('base64')}`;

/** Fresh isolated embedded database with the reference catalog and stock. */
export async function freshDb(): Promise<Db> {
  // TEST_DATABASE_URL=postgres://... runs the suite against a real server (one throwaway database per call).
  const admin = process.env.TEST_DATABASE_URL;
  let url = '';
  if (admin) {
    const name = `meridian_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const c = new pg.Client({ connectionString: admin });
    await c.connect();
    await c.query(`CREATE DATABASE ${name}`);
    await c.end();
    url = admin.replace(/\/[^/]*$/, `/${name}`);
  }
  const db = await openDb({ url });
  await seedReference(db);
  return db;
}
let n = 0;
export const newCustomer = async (db: Db, o: Partial<Parameters<typeof createCustomer>[1]> = {}) =>
  createCustomer(db, { segment: 'CONSUMER', displayName: `Test Customer ${++n}`, idDocument: `T${n}${Math.random().toString(36).slice(2, 8)}`, ...o });

/** Pretend a customer's services went live `days` ago, so a bill run has something to bill. */
export const backdate = (db: Db, customerId: string, days: number) =>
  db.query(`UPDATE services SET activated_at = now() - ($2 || ' days')::interval, contract_start = now() - ($2 || ' days')::interval WHERE customer_id=$1`, [customerId, String(days)]);
