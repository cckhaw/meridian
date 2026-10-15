import qrcode from 'qrcode-generator';

/** QR code as a matrix of dark modules (error correction M, the version picked to fit). */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/**
 * Code 128 (character set B: printable ASCII). Each symbol is six alternating bar and space widths, in modules, beginning with a bar; the stop symbol has seven.
 * Index 0-102 are the data values, 103-105 the start codes, 106 the stop.
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
export const CODE128_PATTERNS = PATTERNS;
const START_B = 104, STOP = 106;

/** The widths (in modules, bar first) of a Code 128-B barcode for `text`, including its check symbol and stop. */
export function code128(text: string): number[] {
  if (!text.length) throw new Error('A barcode needs something to encode.');
  const values = [START_B];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error(`The barcode cannot hold “${ch}”: Code 128-B takes printable ASCII.`);
    values.push(c - 32);
  }
  const check = values.reduce((s, v, i) => s + v * (i === 0 ? 1 : i), 0) % 103;
  values.push(check, STOP);
  return values.flatMap((v) => [...PATTERNS[v]!].map(Number));
}
/** The dark bars of a barcode as [offset, width] in modules, with the 10-module quiet zone left out. */
export function code128Bars(text: string): { bars: Array<[number, number]>; modules: number } {
  const w = code128(text);
  const bars: Array<[number, number]> = [];
  let x = 0;
  w.forEach((width, i) => { if (i % 2 === 0) bars.push([x, width]); x += width; });
  return { bars, modules: x };
}
