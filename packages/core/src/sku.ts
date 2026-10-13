/** A stock SKU: letters, digits and . _ - / (manufacturer part numbers such as MJW44LL/A contain a slash). */
export const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,49}$/;
export const SKU_RULE = 'letters, digits, dash, dot, underscore and slash';
