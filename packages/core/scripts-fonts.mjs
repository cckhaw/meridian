// Regenerates src/billing-docs/fonts.generated.ts from @fontsource/inter (a dev dependency): node scripts-fonts.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const d = 'node_modules/@fontsource/inter/files/';
const b64 = (f) => readFileSync(d + f).toString('base64');
writeFileSync('src/billing-docs/fonts.generated.ts', `// Inter (SIL Open Font License 1.1, https://rsms.me/inter/), Latin subset, regular and bold, as WOFF: the typeface invoices are laid out and printed in.
// Generated from @fontsource/inter by scripts-fonts.mjs so the PDF renderer needs no font files at run time (it works on a serverless host).
export const INTER_REGULAR_B64 = '${b64('inter-latin-400-normal.woff')}';
export const INTER_BOLD_B64 = '${b64('inter-latin-700-normal.woff')}';
`);
