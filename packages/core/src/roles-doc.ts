import { ALL_PERMISSIONS, MODULES, ROLE_IDS, ROLES, type Permission } from './rbac.js';

const money = (m?: number | null) => (m === null ? 'unlimited' : m ? (m / 100).toFixed(2) : 'none');

/** docs/ROLES.md, generated from the same table the API enforces. `pnpm --filter @meridian/core docs:roles` rewrites the file. */
export function rolesMarkdown(): string {
  const L: string[] = [];
  L.push('# Roles and permissions', '', '<!-- GENERATED from packages/core/src/rbac.ts by `pnpm --filter @meridian/core docs:roles`. Do not edit by hand; a test fails if it drifts. -->', '');
  L.push('The API checks **permissions**, never role names. A user holds one or more **roles**; their permissions are the union. The environment-defined **super user** holds every permission.', '');
  L.push('**Scope** decides *which rows* a role can see: `All records`, or only the user’s own `store`, `dealer` or `customer`. A user with any unscoped role sees everything their permissions allow. A scoped role with a missing binding sees nothing (fails closed).', '');
  L.push('## Summary', '', '| Role | Scope | Landing page | Credit notes up to | Purpose |', '|---|---|---|---|---|');
  for (const id of ROLE_IDS) { const r = ROLES[id]; L.push(`| **${r.label}** (\`${r.id}\`) | ${r.scope === 'staff' ? 'All records' : `Own ${r.scope}`} | \`${r.home}\` | ${money(r.creditLimitMinor)} | ${r.summary} |`); }
  L.push('', '## Modules each role can open', '', `| Module | ${ROLE_IDS.map((r) => ROLES[r].label).join(' | ')} |`, `|---|${ROLE_IDS.map(() => ':-:').join('|')}|`);
  for (const m of MODULES) L.push(`| ${m.label} | ${ROLE_IDS.map((r) => (m.anyOf.some((p) => ROLES[r].permissions.includes(p)) ? '✓' : '')).join(' | ')} |`);
  L.push('', '## Permission matrix', '', `| Permission | ${ROLE_IDS.map((r) => ROLES[r].label).join(' | ')} |`, `|---|${ROLE_IDS.map(() => ':-:').join('|')}|`);
  for (const p of ALL_PERMISSIONS as readonly Permission[]) L.push(`| \`${p}\` | ${ROLE_IDS.map((r) => (ROLES[r].permissions.includes(p) ? '✓' : '')).join(' | ')} |`);
  L.push('', '## Separation of duties', '',
    '- Administrators manage users and the catalog but **cannot take payments or issue credit notes**.',
    '- Call-center agents can take payments and change SIM/number but **cannot issue credits or terminate**: they escalate to Customer Service.',
    '- Customer Service can refund up to a limit; Billing Operations and Finance have no limit.',
    '- Only users holding `order:payment` can state that money was received, and in production they must give the terminal approval or receipt number.',
    '- Customers in the self-serve portal can never confirm their own payment; that comes from the payment provider webhook.',
    '- Who sold an order is taken from the signed-in session, never from the request, so commission cannot be forged.', '');
  return L.join('\n');
}
