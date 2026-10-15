import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { coerceCells, mapHeader } from './coerce.js';
import { entityById } from './entities.js';
import { presignUrl, objectKey, s3ConfigFromEnv } from './s3.js';
import { xlsxToCsv } from './uploads.js';

describe('pre-signed URLs', () => {
  it('match the signature in the AWS documentation for the same request', () => {
    const cfg = { bucket: 'examplebucket', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', prefix: '' };
    const url = presignUrl(cfg, 'GET', 'test.txt', { expires: 86400, now: new Date('2013-05-24T00:00:00Z') });
    expect(url).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    expect(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?')).toBe(true);
  });
  it('is off unless all the settings are there, and keeps keys tidy', () => {
    expect(s3ConfigFromEnv({})).toBeNull();
    const cfg = s3ConfigFromEnv({ MERIDIAN_MIGRATION_S3_BUCKET: 'b', MERIDIAN_MIGRATION_S3_ACCESS_KEY_ID: 'k', MERIDIAN_MIGRATION_S3_SECRET_ACCESS_KEY: 's', MERIDIAN_MIGRATION_S3_ENDPOINT: 'http://minio:9000/' })!;
    expect(objectKey(cfg, 'u1', '../we ird/na me.csv')).toBe('meridian-migration/u1/.._we_ird_na_me.csv');
    expect(presignUrl(cfg, 'PUT', 'a/b.csv').startsWith('http://minio:9000/b/a/b.csv?')).toBe(true);
  });
});

describe('spreadsheets', () => {
  it('turns the first sheet of an .xlsx file into CSV, with shared strings, empty cells and booleans', () => {
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>note, &amp; quote "x"</t></is></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c><c r="C2" t="b"><v>1</v></c></row></sheetData></worksheet>`;
    const shared = `<sst><si><t>id</t></si><si><t>amount</t></si><si><t>K-1</t></si></sst>`;
    const xlsx = zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet), 'xl/sharedStrings.xml': strToU8(shared), '[Content_Types].xml': strToU8('<Types/>') });
    expect(xlsxToCsv(xlsx)).toBe('id,amount,,"note, & quote ""x"""\r\nK-1,42,true\r\n');
  });
});

describe('cleaning a row', () => {
  const def = entityById('customers')!;
  it('maps headers, flags unknown and missing columns, and reports each bad cell with its field', () => {
    const m = mapHeader(def, ['ID', 'Segment', 'display name', 'colour']);
    expect(m.issues.map((i) => i.code).sort()).toEqual(['UNKNOWN_COLUMN']);
    const bad = mapHeader(def, ['id']);
    expect(bad.issues.map((i) => i.code)).toContain('MISSING_COLUMN');
    const h = mapHeader(def, ['id', 'segment', 'display_name', 'email', 'date_of_birth', 'kyc_status']);
    const r = coerceCells(def, h, ['K1', 'consumer', "'=x", 'nope', '1990-02-30', 'verified']);
    expect(r.issues.map((i) => i.field).sort()).toEqual(['date_of_birth', 'email']);
    expect(r.rec).toMatchObject({ segment: 'consumer', display_name: '=x', kyc_status: 'VERIFIED' });
  });
});
