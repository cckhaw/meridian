import { audit } from './audit.js';
import type { Queryable } from './db.js';
import { invalid } from './errors.js';
import { ALL_PERMISSIONS, CHANNELS, isPermission, isRoleId, MODULES, ROLE_IDS, ROLES, rolePermissions, roleCreditLimit, type Permission, type RoleId, type RoleOverrides } from './rbac.js';

const KEY = 'rolePermissions';

export async function getRoleOverrides(q: Queryable): Promise<RoleOverrides> {
  const r = (await q.query(`SELECT value FROM settings WHERE key=$1`, [KEY])).rows[0]?.value as RoleOverrides | undefined;
  if (!r || typeof r !== 'object') return {};
  const out: RoleOverrides = {};
  for (const id of ROLE_IDS) {
    const o = r[id];
    if (!o) continue;
    out[id] = {
      ...(Array.isArray(o.permissions) ? { permissions: o.permissions.filter(isPermission) } : {}),
      ...('creditLimitMinor' in o ? { creditLimitMinor: o.creditLimitMinor === null ? null : Number(o.creditLimitMinor) || 0 } : {}),
    };
  }
  return out;
}

/** Permissions that can never be given to a role: the super user holds them alone. */
export const SUPERUSER_ONLY: readonly Permission[] = ['settings:manage'];
/** Permissions a role must keep, so an administrator cannot lock everyone out of this very screen. */
const KEEP: Partial<Record<RoleId, Permission[]>> = { admin: ['user:manage'] };

/** Human wording for every permission, grouped for the editor. */
const INFO: Record<string, [group: string, label: string, hint: string]> = {
  'dashboard:read': ['Overview', 'See the overview', 'The home dashboard and its figures'],
  'customer:search': ['Customers', 'Find customers', 'Search and list customers'],
  'customer:read': ['Customers', 'Open a customer', 'See the profile, accounts and services'],
  'customer:create': ['Customers', 'Create customers', 'Add a new customer'],
  'customer:write': ['Customers', 'Edit customers', 'Change a customer’s details'],
  'service:read': ['Services', 'See services', 'Lines and subscriptions of a customer'],
  'service:manage': ['Services', 'Change a service', 'Swap SIM or number, change plan'],
  'service:suspend': ['Services', 'Suspend and resume', 'Barring and un-barring a line'],
  'service:terminate': ['Services', 'Terminate', 'Close a service for good'],
  'service:transfer': ['Services', 'Transfer ownership', 'Move a service to another customer'],
  'mnp:manage': ['Services', 'Number porting', 'Port numbers in and out'],
  'order:read': ['Orders', 'See orders', 'Order list and detail'],
  'order:payment': ['Orders', 'Take payment on an order', 'Record cash or card payment at the point of sale'],
  'order:fulfil': ['Orders', 'Fulfil orders', 'Pack, ship, hand over, mark collected'],
  'order:cancel': ['Orders', 'Cancel or return', 'Cancel an order or take a return, within the cancellation rules'],
  'order:override': ['Orders', 'Approve exceptions', 'Approve a cancellation or return that policy only allows with a supervisor'],
  'billing:read': ['Billing', 'See bills', 'Invoices, balances and payments'],
  'billing:pay': ['Billing', 'Take a bill payment', 'Record a payment against an invoice'],
  'billing:credit': ['Billing', 'Issue credit notes', 'Refunds and credits, up to the credit limit'],
  'billing:run': ['Billing', 'Run billing', 'Run bill cycles and dunning'],
  'finance:read': ['Finance', 'See the ledger', 'Ledger, reconciliation and receivables'],
  'finance:export': ['Finance', 'Export journals', 'SAP journal export'],
  'catalog:read': ['Catalog', 'See the catalog', 'Offers and prices'],
  'catalog:write': ['Catalog', 'Maintain the catalog', 'Create and change offers, import offers'],
  'inventory:read': ['Inventory', 'See stock', 'Stock levels and movements'],
  'inventory:write': ['Inventory', 'Change stock', 'Receive, adjust and import stock'],
  'case:read': ['Cases', 'See cases', 'Support cases'],
  'case:create': ['Cases', 'Open cases', 'Raise a case'],
  'case:write': ['Cases', 'Work cases', 'Update and close cases'],
  'commission:read': ['Dealers and stores', 'See commission', 'Commission earned'],
  'dealer:read': ['Dealers and stores', 'See dealers', 'Dealers and their agents'],
  'dealer:manage': ['Dealers and stores', 'Maintain dealers', 'Create and edit dealers and agents'],
  'store:manage': ['Dealers and stores', 'Maintain stores', 'Create and edit retail stores'],
  'store:assist': ['Dealers and stores', 'Assist at the counter', 'Use the store-front on a customer’s behalf'],
  'kyc:attest': ['Identity checks', 'Attest ID in person', 'Confirm a customer’s identity documents at the counter'],
  'kyc:review': ['Identity checks', 'Review ID checks', 'Approve or reject online ID verification'],
  'audit:read': ['Administration', 'Read the audit log', 'Who changed what'],
  'user:manage': ['Administration', 'Manage users and roles', 'Create users and change what roles can do'],
  'settings:manage': ['Administration', 'Settings (super user only)', 'Regional, branding, gateways, API keys'],
};
const CHANNEL_NAME: Record<string, string> = { SELF_SERVE: 'online self-serve', RETAIL_ASSISTED: 'assisted at a store', QUICK_SALE: 'quick sale at a store', TELESALES: 'telesales', DEALER: 'through a dealer', CALL_CENTER: 'call center' };
for (const c of CHANNELS) INFO[`order:create:${c}`] = ['Selling', `Sell ${CHANNEL_NAME[c]}`, `Create orders on the ${c.toLowerCase().replace(/_/g, ' ')} channel`];

export interface PermissionInfo { id: Permission; group: string; label: string; hint: string; superuserOnly: boolean }
export const permissionCatalogue = (): PermissionInfo[] => ALL_PERMISSIONS.map((id) => {
  const [group, label, hint] = INFO[id] ?? ['Other', id, ''];
  return { id, group, label, hint, superuserOnly: SUPERUSER_ONLY.includes(id) };
});

export interface RoleView {
  id: RoleId; label: string; summary: string; scope: string; permissions: Permission[]; defaults: Permission[]; creditLimitMinor?: number | null; defaultCreditLimitMinor?: number | null;
  customised: boolean; users: number; modules: string[];
}

export async function listRoles(q: Queryable): Promise<RoleView[]> {
  const ov = await getRoleOverrides(q);
  const counts = new Map<string, number>();
  for (const r of (await q.query(`SELECT r AS role, count(*) AS n FROM users, unnest(roles) AS r WHERE status='ACTIVE' GROUP BY r`)).rows) counts.set(r.role as string, Number(r.n));
  return ROLE_IDS.map((id) => {
    const d = ROLES[id];
    const perms = rolePermissions(id, ov);
    return {
      id, label: d.label, summary: d.summary, scope: d.scope, permissions: perms, defaults: d.permissions, creditLimitMinor: roleCreditLimit(id, ov), defaultCreditLimitMinor: d.creditLimitMinor,
      customised: !!ov[id], users: counts.get(id) ?? 0, modules: MODULES.filter((m) => m.anyOf.some((p) => perms.includes(p))).map((m) => m.label),
    };
  });
}

export async function setRolePermissions(q: Queryable, actor: string, id: string, input: { permissions: string[]; creditLimitMinor?: number | null }): Promise<RoleView> {
  if (!isRoleId(id)) throw invalid(`unknown role ${id}`);
  const bad = input.permissions.filter((p) => !isPermission(p));
  if (bad.length) throw invalid(`unknown permission ${bad.join(', ')}`);
  const perms = [...new Set(input.permissions as Permission[])];
  const su = perms.filter((p) => SUPERUSER_ONLY.includes(p));
  if (su.length) throw invalid(`${su.join(', ')} belongs to the super user and cannot be given to a role.`);
  const lost = (KEEP[id] ?? []).filter((p) => !perms.includes(p));
  if (lost.length) throw invalid(`${ROLES[id].label} must keep “${INFO[lost[0]!]?.[1] ?? lost[0]}”, or nobody could manage roles any more.`);
  if (input.creditLimitMinor !== undefined && input.creditLimitMinor !== null && (!Number.isInteger(input.creditLimitMinor) || input.creditLimitMinor < 0)) throw invalid('The credit note limit is a whole amount, zero or more.');
  const ov = await getRoleOverrides(q);
  const before = rolePermissions(id, ov);
  const next: RoleOverrides = { ...ov, [id]: { permissions: perms, ...(input.creditLimitMinor !== undefined ? { creditLimitMinor: input.creditLimitMinor } : ov[id] && 'creditLimitMinor' in ov[id]! ? { creditLimitMinor: ov[id]!.creditLimitMinor } : {}) } };
  await save(q, actor, next);
  await audit(q, actor, 'role', id, 'update', { added: perms.filter((p) => !before.includes(p)), removed: before.filter((p) => !perms.includes(p)), creditLimitMinor: input.creditLimitMinor });
  return (await listRoles(q)).find((r) => r.id === id)!;
}

export async function resetRole(q: Queryable, actor: string, id: string): Promise<RoleView> {
  if (!isRoleId(id)) throw invalid(`unknown role ${id}`);
  const { [id]: _gone, ...rest } = await getRoleOverrides(q);
  await save(q, actor, rest);
  await audit(q, actor, 'role', id, 'reset', {});
  return (await listRoles(q)).find((r) => r.id === id)!;
}

async function save(q: Queryable, actor: string, v: RoleOverrides) {
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [KEY, JSON.stringify(v), actor]);
}
