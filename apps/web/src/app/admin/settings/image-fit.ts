/** Size of the file a base64 string stands for. */
export const base64Bytes = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

/**
 * The output sizes to try, largest first: the preset size, then 15% smaller each step with the same aspect ratio,
 * stopping before either side goes under `minSide` px. A square stays exactly square.
 */
export function fitSizes(target: { width: number; height: number }, minSide = 16): Array<{ width: number; height: number }> {
  const out: Array<{ width: number; height: number }> = [];
  const aspect = target.width / target.height;
  for (let w = target.width; w >= 1; w = Math.floor(w * 0.85)) {
    const width = Math.round(w), height = Math.round(w / aspect);
    if (out.length && (width < minSide || height < minSide)) break;
    if (!out.length || width !== out[out.length - 1]!.width) out.push({ width, height });
    if (out.length > 40) break;
  }
  return out;
}

/** Draws at each size in turn until the PNG fits `maxBytes`. `render` returns the PNG as base64. Null when even the smallest size is too big. */
export function fitPng(render: (size: { width: number; height: number }) => string, target: { width: number; height: number }, maxBytes: number, minSide = 16):
  { base64: string; width: number; height: number; bytes: number; reduced: boolean } | { tooBig: true; bytes: number; width: number; height: number } {
  let last = { bytes: 0, width: target.width, height: target.height };
  for (const [i, size] of fitSizes(target, minSide).entries()) {
    const base64 = render(size), bytes = base64Bytes(base64);
    if (bytes <= maxBytes) return { base64, ...size, bytes, reduced: i > 0 };
    last = { bytes, ...size };
  }
  return { tooBig: true, ...last };
}
