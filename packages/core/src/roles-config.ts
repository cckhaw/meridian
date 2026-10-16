import { audit } from './audit.js';
import { permissionDomain, permissionKey, resolvePermission } from './permission-catalog.js';
import type { Queryable } from './db.js';
import { invalid, rejected } from './errors.js';
import { ALL_PERMISSIONS, CHANNELS, isBuiltinRole, isPermission, MODULES, ROLE_IDS, ROLES, roleCreditLimit, roleDef, rolePermissions, type DataScope, type Permission, type RoleBook, type RoleDef, type RoleId, type RoleOverrides } from './rbac.js';

const KEY = 'rolePermissions';
const CUSTOM_KEY = 'customRoles';
const DISABLED_KEY = 'disabledRoles';

/** Changes to built-in roles plus the roles administrators created, read from the database. */
export async function getRoleOverrides(q: Queryable): Promise<RoleBook> {
  const rows = (await q.query(`SELECT key, value FROM settings WHERE key IN ($1, $2, $3)`, [KEY, CUSTOM_KEY, DISABLED_KEY])).rows;
  const raw = rows.find((r) => r.key === KEY)?.value as Record<string, { permissions?: unknown; creditLimitMinor?: unknown }> | undefined;
  const list = rows.find((r) => r.key === CUSTOM_KEY)?.value as RoleDef[] | undefined;
  const off = rows.find((r) => r.key === DISABLED_KEY)?.value;
  const book: RoleBook = { changes: {}, custom: {}, disabled: Array.isArray(off) ? off.filter((x): x is string => typeof x === 'string') : [] };
  for (const c of Array.isArray(list) ? list : []) {
    if (!c?.id || isBuiltinRole(c.id)) continue;
    book.custom[c.id] = { id: c.id, label: String(c.label), summary: String(c.summary ?? ''), scope: c.scope, home: c.home || '/', permissions: (c.permissions ?? []).filter(isPermission), ...('creditLimitMinor' in c ? { creditLimitMinor: c.creditLimitMinor } : {}) };
  }
  if (raw && typeof raw === 'object') {
    for (const id of ROLE_IDS) {
      const o = raw[id];
      if (!o) continue;
      book.changes[id] = {
        ...(Array.isArray(o.permissions) ? { permissions: (o.permissions as string[]).filter(isPermission) } : {}),
        ...('creditLimitMinor' in o ? { creditLimitMinor: o.creditLimitMinor === null ? null : Number(o.creditLimitMinor) || 0 } : {}),
      };
    }
  }
  return book;
}

/** Permissions that can never be given to a role: the super user holds them alone. */
export const SUPERUSER_ONLY: readonly Permission[] = ['settings:manage'];
/** Permissions a role must keep, so an administrator cannot lock everyone out of this very screen. */
const KEEP: Partial<Record<string, Permission[]>> = { admin: ['user:manage'] };

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
  'service:self': ['Services', 'Suspend and resume own service', 'A customer pausing their own line in the portal (travel) and bringing it back'],
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
  'billing:run': ['Billing', 'Run billing', 'Mock, review and exclude in bill runs, run dunning'],
  'billing:simulate': ['Billing', 'Simulate billing', 'Forecast future bills, quote the cost of ending a service, preview a plan change (changes nothing)'],
  'billing:template': ['Billing', 'Design bill templates', 'Design, convert from legacy formats, and publish the layout of customer bills'],
  'billing:print': ['Billing', 'Print bills', 'Produce bill PDFs and print-house packages (batch PDFs, control files, manifest)'],
  'billing:approve': ['Billing', 'Approve bill runs', 'Approve a mocked bill run so invoices are issued (a second person when dual control is on)'],
  'finance:read': ['Finance', 'See the ledger', 'Ledger, reconciliation and receivables'],
  'finance:export': ['Finance', 'Export journals', 'SAP journal export'],
  'finance:configure': ['Finance', 'Configure posting rules and SAP', 'Map revenue streams to SAP accounts, cost centres and profit centres; SAP connection and daily close'],
  'ledger:ingest': ['Finance', 'Send events to the sub-ledger', 'Post payment, invoice, adjustment and early-termination events'],
  'catalog:read': ['Catalog', 'See the catalog', 'Offers and prices'],
  'catalog:write': ['Catalog', 'Maintain the catalog', 'Create and change offers, import offers'],
  'inventory:read': ['Inventory', 'See stock', 'Stock levels and movements'],
  'inventory:write': ['Inventory', 'Receive stock', 'Receive stock one SKU at a time or in a CSV batch'],
  'inventory:transfer': ['Inventory', 'Transfer stock', 'Move stock and SIM cards between warehouses and stores: request, dispatch, receive, send back'],
  'inventory:writeoff': ['Inventory', 'Write stock off', 'Take stock off the books with a reason (damaged, lost, expired, stolen)'],
  'numbering:read': ['Numbers and SIMs', 'See the pools', 'Phone numbers, SIM cards and subscriber identities, by state'],
  'numbering:select': ['Numbers and SIMs', 'Choose a number and a SIM', 'Pick a number (VIP included) and a SIM card while selling'],
  'numbering:manage': ['Numbers and SIMs', 'Manage the pools', 'Load numbers, SIMs and IMSIs, set VIP tier prices, hold numbers for auction, retire SIMs'],
  'warehouse:manage': ['Inventory', 'Maintain warehouses', 'Add, rename, switch off and remove warehouse locations'],
  'case:read': ['Cases', 'See cases', 'Support cases'],
  'case:create': ['Cases', 'Open cases', 'Raise a case'],
  'case:write': ['Cases', 'Work cases', 'Update and close cases'],
  'collections:manage': ['Billing', 'Manage collections', 'Agree payment arrangements, place overdue debt with a collection agency, export the agency file'],
  'case:supervise': ['Cases', 'Supervise cases', 'Run the SLA sweep, group cases into network incidents, take over any case'],
  'commission:read': ['Dealers and stores', 'See commission', 'Commission earned'],
  'commission:configure': ['Dealers and stores', 'Configure commission', 'Plans, rules, volume bands, claw-back policies, the dealer channel and who earns by which plan'],
  'commission:settle': ['Dealers and stores', 'Settle commission', 'Approve earnings, close the month, issue statements, create and confirm payout files'],
  'dealer:read': ['Dealers and stores', 'See dealers', 'Dealers and their agents'],
  'dealer:manage': ['Dealers and stores', 'Maintain dealers', 'Create and edit dealers and agents'],
  'store:manage': ['Dealers and stores', 'Maintain stores', 'Create and edit retail stores'],
  'store:assist': ['Dealers and stores', 'Assist at the counter', 'Use the store-front on a customer’s behalf'],
  'store:report': ['Dealers and stores', 'Store sales', 'Sales by day, salesperson and payment method for the store, with the commission earned'],
  'store:cashdrawer': ['Dealers and stores', 'Reconcile the cash drawer', 'Count the drawer at the end of the day and sign off the difference'],
  'fraud:read': ['Fraud', 'See the fraud desk', 'Alerts, SIM-swap anomalies and the blacklist'],
  'fraud:manage': ['Fraud', 'Work fraud alerts and the blacklist', 'Confirm or dismiss alerts, raise one by hand, add to and remove from the blacklist'],
  'fraud:bar': ['Fraud', 'Hard-bar a service', 'Cut a service off for fraud and lift the bar'],
  'kyc:attest': ['Identity checks', 'Attest ID in person', 'Confirm a customer’s identity documents at the counter'],
  'kyc:review': ['Identity checks', 'Review ID checks', 'Approve or reject online ID verification'],
  'audit:read': ['Administration', 'Read the audit log', 'Who changed what'],
  'migration:export': ['Administration', 'Export data', 'Download backups and migration extracts, with sensitive fields masked'],
  'migration:import': ['Administration', 'Import data', 'Load customers, services and other data from files'],
  'user:manage': ['Administration', 'Manage users and roles', 'Create users and change what roles can do'],
  'settings:manage': ['Administration', 'Settings (super user only)', 'Regional, branding, gateways, API keys'],
};
const CHANNEL_NAME: Record<string, string> = { SELF_SERVE: 'online self-serve', RETAIL_ASSISTED: 'assisted at a store', QUICK_SALE: 'quick sale at a store', TELESALES: 'telesales', DEALER: 'through a dealer', CALL_CENTER: 'call center' };
for (const c of CHANNELS) INFO[`order:create:${c}`] = ['Selling', `Sell ${CHANNEL_NAME[c]}`, `Create orders on the ${c.toLowerCase().replace(/_/g, ' ')} channel`];

export interface PermissionInfo { id: Permission; /** domain:resource:action */ key: string; domain: string; group: string; label: string; hint: string; superuserOnly: boolean }
export const permissionCatalogue = (): PermissionInfo[] => ALL_PERMISSIONS.map((id) => {
  const [group, label, hint] = INFO[id] ?? ['Other', id, ''];
  return { id, key: permissionKey(id), domain: permissionDomain(id), group, label, hint, superuserOnly: SUPERUSER_ONLY.includes(id) };
});

export interface RoleView {
  id: RoleId; label: string; summary: string; scope: string; home: string; permissions: Permission[]; defaults: Permission[]; creditLimitMinor?: number | null; defaultCreditLimitMinor?: number | null;
  customised: boolean; custom: boolean; users: number; modules: string[];
  /** The stable name outside the database (ROLE_CALL_CENTER_AGENT); a created role has none. */
  code?: string;
  /** Switched off: it keeps its users and settings but grants nothing. */
  disabled: boolean;
}

const viewOf = (id: string, book: RoleBook, users: Map<string, number>): RoleView => {
  const d = roleDef(id, book)!;
  const perms = rolePermissions(id, book);
  const custom = !!book.custom[id];
  return {
    id, label: d.label, summary: d.summary, scope: d.scope, home: d.home, permissions: perms, defaults: d.permissions, creditLimitMinor: roleCreditLimit(id, book), defaultCreditLimitMinor: d.creditLimitMinor,
    customised: !custom && !!book.changes[id], custom, users: users.get(id) ?? 0, modules: MODULES.filter((m) => m.anyOf.some((p) => perms.includes(p))).map((m) => m.label),
    code: d.code, disabled: !!book.disabled?.includes(id),
  };
};

async function holders(q: Queryable, onlyActive: boolean): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (const r of (await q.query(`SELECT r AS role, count(*) AS n FROM users, unnest(roles) AS r ${onlyActive ? `WHERE status='ACTIVE'` : ''} GROUP BY r`)).rows) m.set(r.role as string, Number(r.n));
  return m;
}

export async function listRoles(q: Queryable): Promise<RoleView[]> {
  const book = await getRoleOverrides(q);
  const users = await holders(q, true);
  return [...ROLE_IDS, ...Object.keys(book.custom).sort((a, b) => book.custom[a]!.label.localeCompare(book.custom[b]!.label))].map((id) => viewOf(id, book, users));
}

const cleanPerms = (id: string, named: string[]): Permission[] => {
  const raw = named.map((n) => resolvePermission(n) ?? n);   // a permission id, a domain:resource:action key, or an alias
  const bad = raw.filter((p) => !isPermission(p));
  if (bad.length) throw invalid(`unknown permission ${bad.join(', ')}`);
  const perms = [...new Set(raw as Permission[])];
  const su = perms.filter((p) => SUPERUSER_ONLY.includes(p));
  if (su.length) throw invalid(`${su.join(', ')} belongs to the super user and cannot be given to a role.`);
  const lost = (KEEP[id] ?? []).filter((p) => !perms.includes(p));
  if (lost.length) throw invalid(`${ROLES[id as keyof typeof ROLES].label} must keep “${INFO[lost[0]!]?.[1] ?? lost[0]}”, or nobody could manage roles any more.`);
  return perms;
};
const cleanCredit = (v: number | null | undefined) => {
  if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 0)) throw invalid('The credit note limit is a whole amount, zero or more.');
  return v;
};

/** Saves an edit from the roles screen: a created role can change in every way, a built-in role only in what it may do. */
export async function updateRole(q: Queryable, actor: string, id: string, input: CustomRoleInput): Promise<RoleView> {
  if (isBuiltinRole(id)) {
    if (input.name !== undefined || input.scope !== undefined || input.home !== undefined) throw invalid(`${ROLES[id].label} is a built-in role: only what it can do can change.`);
    return setRolePermissions(q, actor, id, { permissions: input.permissions ?? rolePermissions(id, await getRoleOverrides(q)), creditLimitMinor: input.creditLimitMinor });
  }
  return updateCustomRole(q, actor, id, input);
}

export async function setRolePermissions(q: Queryable, actor: string, id: string, input: { permissions: string[]; creditLimitMinor?: number | null }): Promise<RoleView> {
  const book = await getRoleOverrides(q);
  if (book.custom[id]) return updateCustomRole(q, actor, id, input);
  if (!isBuiltinRole(id)) throw invalid(`unknown role ${id}`);
  const perms = cleanPerms(id, input.permissions);
  const credit = cleanCredit(input.creditLimitMinor);
  const before = rolePermissions(id, book);
  const cur = book.changes[id];
  const next = { ...book.changes, [id]: { permissions: perms, ...(credit !== undefined ? { creditLimitMinor: credit } : cur && 'creditLimitMinor' in cur ? { creditLimitMinor: cur.creditLimitMinor } : {}) } };
  await save(q, actor, KEY, next);
  await audit(q, actor, 'role', id, 'update', { added: perms.filter((p) => !before.includes(p)), removed: before.filter((p) => !perms.includes(p)), creditLimitMinor: credit });
  return (await listRoles(q)).find((r) => r.id === id)!;
}

export async function resetRole(q: Queryable, actor: string, id: string): Promise<RoleView> {
  if (!isBuiltinRole(id)) throw invalid(`${id} is not a built-in role, so it has no default to go back to.`);
  const { [id]: _gone, ...rest } = (await getRoleOverrides(q)).changes;
  await save(q, actor, KEY, rest);
  await audit(q, actor, 'role', id, 'reset', {});
  return (await listRoles(q)).find((r) => r.id === id)!;
}

// ───────────────────────── roles an administrator creates ─────────────────────────
export interface CustomRoleInput { name?: string; summary?: string; scope?: DataScope; home?: string; permissions?: string[]; copyFrom?: string; creditLimitMinor?: number | null }
const CUSTOM_SCOPES: DataScope[] = ['staff', 'store', 'dealer'];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);

function cleanHome(h: string | undefined): string {
  const home = (h ?? '').trim();
  if (!home) return '/';
  if (home !== '/' && !MODULES.some((m) => m.href === home)) throw invalid('Choose a landing page from the list.');
  return home;
}

async function saveCustom(q: Queryable, actor: string, book: RoleBook) {
  await save(q, actor, CUSTOM_KEY, Object.values(book.custom));
}

export async function createCustomRole(q: Queryable, actor: string, input: CustomRoleInput): Promise<RoleView> {
  const book = await getRoleOverrides(q);
  const label = (input.name ?? '').trim();
  if (label.length < 2 || label.length > 40) throw invalid('Give the role a name of 2 to 40 characters.');
  const all = [...ROLE_IDS.map((r) => ROLES[r].label), ...Object.values(book.custom).map((c) => c.label)];
  if (all.some((l) => l.toLowerCase() === label.toLowerCase())) throw invalid(`There is already a role called ${label}.`);
  const scope = input.scope ?? 'staff';
  if (!CUSTOM_SCOPES.includes(scope)) throw invalid('A role sees all records, or only those of one store or one dealer.');
  let base = slug(label);
  if (base.length < 2) base = 'role';
  let id = base, n = 2;
  while (isBuiltinRole(id) || book.custom[id]) id = `${base}-${n++}`;
  let source = input.permissions;
  if (!source && input.copyFrom) {
    if (!roleDef(input.copyFrom, book)) throw invalid(`unknown role ${input.copyFrom}`);
    source = rolePermissions(input.copyFrom, book).filter((p) => !SUPERUSER_ONLY.includes(p));
  }
  const permissions = cleanPerms(id, source ?? []);
  const credit = cleanCredit(input.creditLimitMinor);
  const def: RoleDef = { id, label, summary: (input.summary ?? '').trim().slice(0, 200), scope, home: cleanHome(input.home), permissions, ...(credit !== undefined ? { creditLimitMinor: credit } : {}) };
  book.custom[id] = def;
  await saveCustom(q, actor, book);
  await audit(q, actor, 'role', id, 'create', { label, scope, permissions: permissions.length, copiedFrom: input.copyFrom });
  return viewOf(id, book, new Map());
}

export async function updateCustomRole(q: Queryable, actor: string, id: string, input: CustomRoleInput): Promise<RoleView> {
  const book = await getRoleOverrides(q);
  const cur = book.custom[id];
  if (!cur) throw invalid(`${id} is a built-in role: change what it can do, not what it is called.`);
  const users = await holders(q, false);
  const next: RoleDef = { ...cur };
  if (input.name !== undefined) {
    const label = input.name.trim();
    if (label.length < 2 || label.length > 40) throw invalid('Give the role a name of 2 to 40 characters.');
    const taken = [...ROLE_IDS.map((r) => ROLES[r].label), ...Object.values(book.custom).filter((c) => c.id !== id).map((c) => c.label)];
    if (taken.some((l) => l.toLowerCase() === label.toLowerCase())) throw invalid(`There is already a role called ${label}.`);
    next.label = label;
  }
  if (input.summary !== undefined) next.summary = input.summary.trim().slice(0, 200);
  if (input.home !== undefined) next.home = cleanHome(input.home);
  if (input.scope !== undefined && input.scope !== cur.scope) {
    if (!CUSTOM_SCOPES.includes(input.scope)) throw invalid('A role sees all records, or only those of one store or one dealer.');
    if (users.get(id)) throw invalid(`${cur.label} is held by ${users.get(id)} user(s), so what it can see cannot change. Create another role instead.`);
    next.scope = input.scope;
  }
  if (input.permissions !== undefined) next.permissions = cleanPerms(id, input.permissions);
  if (input.creditLimitMinor !== undefined) next.creditLimitMinor = cleanCredit(input.creditLimitMinor);
  book.custom[id] = next;
  await saveCustom(q, actor, book);
  await audit(q, actor, 'role', id, 'update', { label: next.label, scope: next.scope, permissions: next.permissions.length });
  return viewOf(id, book, users);
}

export async function deleteCustomRole(q: Queryable, actor: string, id: string): Promise<{ deleted: string }> {
  const book = await getRoleOverrides(q);
  const cur = book.custom[id];
  if (!cur) throw invalid(isBuiltinRole(id) ? `${ROLES[id].label} is a built-in role and cannot be deleted. Use Reset to default to undo your changes.` : `unknown role ${id}`);
  const n = (await holders(q, false)).get(id) ?? 0;
  if (n) throw rejected(`${cur.label} is still held by ${n} user${n === 1 ? '' : 's'} (including disabled ones). Give them another role first.`);
  delete book.custom[id];
  await saveCustom(q, actor, book);
  await audit(q, actor, 'role', id, 'delete', { label: cur.label });
  return { deleted: id };
}

async function save(q: Queryable, actor: string, key: string, v: unknown) {
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [key, JSON.stringify(v), actor]);
}

/** Switches a role off (its users keep it but it grants nothing, at once) or back on. The Administrator role cannot be switched off: nobody could manage roles any more. */
export async function setRoleDisabled(q: Queryable, actor: string, id: string, disabled: boolean): Promise<RoleView> {
  const book = await getRoleOverrides(q);
  if (!roleDef(id, book)) throw invalid(`unknown role ${id}`);
  if (disabled && KEEP[id]) throw invalid(`${roleDef(id, book)!.label} cannot be switched off: nobody could manage roles any more.`);
  const now = new Set(book.disabled ?? []);
  if (disabled) now.add(id); else now.delete(id);
  await save(q, actor, DISABLED_KEY, [...now]);
  await audit(q, actor, 'role', id, disabled ? 'disable' : 'enable', { users: (await holders(q, true)).get(id) ?? 0 });
  return (await listRoles(q)).find((r) => r.id === id)!;
}
