import { writeFileSync } from 'node:fs';
const { rolesMarkdown } = await import('./src/roles-doc.ts');
writeFileSync(new URL('../../docs/ROLES.md', import.meta.url), rolesMarkdown());
console.log('wrote docs/ROLES.md');
