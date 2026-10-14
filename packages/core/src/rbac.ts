/**
 * Role-based access control: the single source of truth for who may do what.
 *
 * - A *permission* is a verb on a resource (`billing:credit`). The API checks permissions, never role names.
 * - A *role* (persona) is a named bundle of permissions plus a data scope.
 * - A user holds one or more roles; their permissions are the union.
 * - The environment-defined super user holds every permission.
 *
 * Changing this file changes access everywhere; docs/ROLES.md is generated from it and a test keeps them in sync.
 */

export const CHANNELS = ['SELF_SERVE', 'RETAIL_ASSISTED', 'QUICK_SALE', 'TELESALES', 'DEALER', 'CALL_CENTER'] as const;
export type Channel = (typeof CHANNELS)[number];

const CORE_PERMISSIONS = [
  'dashboard:read',
  'customer:search', 'customer:read', 'customer:create', 'customer:write',
  'service:read', 'service:manage', 'service:suspend', 'service:terminate', 'service:transfer',
  'service:self', // a customer suspending and resuming their own service in the portal
  'mnp:manage',
  'order:read', 'order:payment', 'order:fulfil', 'order:cancel',
  'order:override', // approve a cancellation or return the policy would only allow with a supervisor's say-so
  'billing:read', 'billing:pay', 'billing:credit', 'billing:run',
  'finance:read', 'finance:export',
  'catalog:read', 'catalog:write',
  'inventory:read', 'inventory:write',
  'inventory:writeoff', // take stock off the books with a reason: damaged, lost, expired, stolen, a count that came up short
  'warehouse:manage', // add, rename, switch off and remove warehouse locations
  'case:read', 'case:create', 'case:write',
  'commission:read',
  'dealer:read', 'dealer:manage', // dealers and their agents are master data kept in the CRM
  'store:manage', // retail stores are master data kept in the CRM; staff are bound to one when created
  'audit:read',
  'user:manage',
  'store:assist', 'kyc:attest', 'kyc:review',
  'settings:manage', // super user only: regional format, branding, payment gateways, store-front API keys
] as const;

const CHANNEL_PERMISSIONS = CHANNELS.map((c) => `order:create:${c}` as const);

export const ALL_PERMISSIONS = [...CORE_PERMISSIONS, ...CHANNEL_PERMISSIONS] as const;
export type Permission = (typeof ALL_PERMISSIONS)[number];
export const isPermission = (p: string): p is Permission => (ALL_PERMISSIONS as readonly string[]).includes(p);

export const ROLE_IDS = [
  'admin', 'product-configurator', 'billing-ops', 'rating-charging', 'self-serve', 'call-center', 'telesales',
  'retail-store', 'dealer', 'dealer-desk', 'customer-service', 'finance', 'fraud', 'revenue-assurance', 'compliance', 'inventory-ops',
] as const;
export type BuiltinRoleId = (typeof ROLE_IDS)[number];
/** A role id: one of the built-in roles, or the id of a role an administrator created. */
export type RoleId = string;
export const isBuiltinRole = (r: string): r is BuiltinRoleId => (ROLE_IDS as readonly string[]).includes(r);
/** True for a built-in role. Roles an administrator created are known only from the database; see `RoleBook`. */
export const isRoleId = isBuiltinRole;

/** What rows a role can see. `staff` = everything its permissions allow; the others are bound to one entity. */
export type DataScope = 'staff' | 'customer' | 'store' | 'dealer';

export interface RoleDef {
  id: RoleId;
  label: string;
  summary: string;
  scope: DataScope;
  /** First screen after login (the highest-priority role the user holds decides). */
  home: string;
  permissions: Permission[];
  /** Largest single credit note this role may issue, in minor units. `null` = unlimited, absent = none. */
  creditLimitMinor?: number | null;
}

const ch = (...c: Channel[]) => c.map((x) => `order:create:${x}` as Permission);

export const ROLES: Record<BuiltinRoleId, RoleDef> = {
  admin: {
    id: 'admin', label: 'Administrator', scope: 'staff', home: '/admin/users',
    summary: 'Runs the platform: manages users and roles, defines the catalog, reads everything. Cannot take payments or issue credits.',
    permissions: ['dashboard:read', 'user:manage', 'audit:read', 'catalog:read', 'catalog:write', 'customer:search', 'customer:read', 'service:read', 'order:read',
      'billing:read', 'finance:read', 'inventory:read', 'case:read', 'commission:read', 'store:manage'],
  },
  'product-configurator': {
    id: 'product-configurator', label: 'Product Configurator', scope: 'staff', home: '/catalog',
    summary: 'Designs the product catalog: offers, prices, contracts, ETC rules, fulfilment.',
    permissions: ['dashboard:read', 'catalog:read', 'catalog:write', 'inventory:read'],
  },
  'billing-ops': {
    id: 'billing-ops', label: 'Billing Operations', scope: 'staff', home: '/billing', creditLimitMinor: null,
    summary: 'Runs bill cycles and dunning, records payments, issues credit notes, handles invoice queries.',
    permissions: ['dashboard:read', 'customer:search', 'customer:read', 'service:read', 'billing:read', 'billing:pay', 'billing:credit', 'billing:run', 'case:read', 'case:create', 'case:write'],
  },
  'rating-charging': {
    id: 'rating-charging', label: 'Rating & Charging', scope: 'staff', home: '/catalog',
    summary: 'Reviews tariffs and price plans (read-only). Usage rating is not part of this release.',
    permissions: ['dashboard:read', 'catalog:read'],
  },
  'self-serve': {
    id: 'self-serve', label: 'Customer (self-serve portal)', scope: 'customer', home: '/account',
    summary: 'An end customer. Sees and acts only on their own account: shop, orders, bills, cases. Online payments are confirmed by the payment provider webhook, never by the customer.',
    permissions: ['customer:read', 'service:read', 'service:self', 'catalog:read', 'order:read', 'order:cancel', ...ch('SELF_SERVE'), 'billing:read', 'case:read', 'case:create'],
  },
  'call-center': {
    id: 'call-center', label: 'Call Center Agent', scope: 'staff', home: '/customers',
    summary: 'Handles customer queries on the Customer 360: profile, services, orders, bills, cases. Can suspend/resume, change SIM or number, take payments.',
    permissions: ['dashboard:read', 'customer:search', 'customer:read', 'customer:write', 'service:read', 'service:manage', 'service:suspend', 'order:read', ...ch('CALL_CENTER'),
      'order:payment', 'billing:read', 'billing:pay', 'case:read', 'case:create', 'case:write', 'catalog:read'],
  },
  telesales: {
    id: 'telesales', label: 'Telesales Agent', scope: 'staff', home: '/orders/new?channel=TELESALES',
    summary: 'Sells by phone: creates customers and telesales orders.',
    permissions: ['customer:search', 'customer:read', 'customer:create', 'service:read', 'catalog:read', 'order:read', ...ch('TELESALES'), 'order:payment'],
  },
  'retail-store': {
    id: 'retail-store', label: 'Retail Store', scope: 'store', home: '/orders/new?channel=RETAIL_ASSISTED',
    summary: 'Sells over the counter at one store: assisted and quick-sale orders, SIM changes, store stock. Sees only that store’s orders and stock.',
    permissions: ['customer:search', 'customer:read', 'customer:create', 'service:read', 'service:manage', 'catalog:read', 'order:read', ...ch('RETAIL_ASSISTED', 'QUICK_SALE'),
      'order:payment', 'order:fulfil', 'order:cancel', 'inventory:read', 'inventory:write', 'commission:read', 'billing:read', 'billing:pay',
      'store:assist', 'kyc:attest'],
  },
  dealer: {
    id: 'dealer', label: 'Dealer', scope: 'dealer', home: '/orders/new?channel=DEALER',
    summary: 'A partner who sells for the operator. Sees only their own orders and commission.',
    permissions: ['customer:search', 'customer:read', 'customer:create', 'catalog:read', 'order:read', ...ch('DEALER'), 'commission:read', 'dealer:read'],
  },
  'dealer-desk': {
    id: 'dealer-desk', label: 'Dealer Desk', scope: 'staff', home: '/orders/new?channel=DEALER',
    summary: 'Operator staff who keep the dealers and their agents and place orders on a dealer’s behalf, naming the dealer and the agent who sold it.',
    permissions: ['customer:search', 'customer:read', 'customer:create', 'catalog:read', 'order:read', ...ch('DEALER'), 'order:payment', 'commission:read', 'dealer:read', 'dealer:manage'],
  },
  'customer-service': {
    id: 'customer-service', label: 'Customer Service', scope: 'staff', home: '/cases', creditLimitMinor: 20_000,
    summary: 'Resolves escalated cases: refunds (up to the credit limit), termination, ownership transfer, number porting, order cancellation.',
    permissions: ['dashboard:read', 'customer:search', 'customer:read', 'customer:write', 'service:read', 'service:manage', 'service:suspend', 'service:terminate', 'service:transfer', 'mnp:manage',
      'order:read', 'order:cancel', 'order:override', 'billing:read', 'billing:credit', 'case:read', 'case:create', 'case:write', 'catalog:read'],
  },
  finance: {
    id: 'finance', label: 'Finance', scope: 'staff', home: '/finance', creditLimitMinor: null,
    summary: 'Owns the ledger: reconciliation, SAP journal export, large credit notes, receivables.',
    permissions: ['dashboard:read', 'finance:read', 'finance:export', 'billing:read', 'billing:credit', 'customer:search', 'customer:read', 'commission:read'],
  },
  fraud: {
    id: 'fraud', label: 'Fraud Analyst', scope: 'staff', home: '/orders',
    summary: 'Reviews orders and accounts: can suspend a service and cancel an order before it ships.',
    permissions: ['dashboard:read', 'customer:search', 'customer:read', 'service:read', 'service:suspend', 'order:read', 'order:cancel', 'audit:read', 'case:read', 'case:create', 'case:write', 'kyc:review'],
  },
  compliance: {
    id: 'compliance', label: 'KYC Compliance Officer', scope: 'staff', home: '/kyc',
    summary: 'Reviews identity verification for online sign-ups and referred cases: approves, rejects, or sends back for corrections. Sees identity evidence; cannot sell or change billing.',
    permissions: ['dashboard:read', 'customer:search', 'customer:read', 'kyc:review', 'audit:read', 'case:read'],
  },
  'inventory-ops': {
    id: 'inventory-ops', label: 'Operations Support', scope: 'staff', home: '/inventory',
    summary: 'Looks after stock: keeps warehouse locations, loads stock in batches or one SKU at a time, and writes stock off with a reason. Sees the stock history; cannot sell or change billing.',
    permissions: ['dashboard:read', 'catalog:read', 'inventory:read', 'inventory:write', 'inventory:writeoff', 'warehouse:manage', 'order:read'],
  },
  'revenue-assurance': {
    id: 'revenue-assurance', label: 'Revenue Assurance', scope: 'staff', home: '/finance',
    summary: 'Checks that billing, payments and the ledger agree (read-only).',
    permissions: ['dashboard:read', 'finance:read', 'billing:read', 'audit:read', 'customer:search', 'customer:read'],
  },
};

/** Priority for choosing the landing page when a user holds several roles. */
const HOME_PRIORITY: string[] = ['admin', 'customer-service', 'call-center', 'billing-ops', 'finance', 'retail-store', 'dealer', 'dealer-desk', 'telesales', 'fraud', 'compliance', 'revenue-assurance', 'inventory-ops', 'product-configurator', 'rating-charging', 'self-serve'];

// ───────────────────────── modules (navigation) ─────────────────────────
export interface ModuleDef {
  id: string;
  label: string;
  href: string;
  icon: string;
  /** Visible when the user holds ANY of these. */
  anyOf: Permission[];
}

export const MODULES: ModuleDef[] = [
  { id: 'overview', label: 'Overview', href: '/', icon: 'house', anyOf: ['dashboard:read'] },
  { id: 'customers', label: 'Customers', href: '/customers', icon: 'person', anyOf: ['customer:search'] },
  { id: 'sell', label: 'New order', href: '/orders/new', icon: 'bag', anyOf: ALL_PERMISSIONS.filter((p) => p.startsWith('order:create:')) as Permission[] },
  { id: 'orders', label: 'Orders', href: '/orders', icon: 'box', anyOf: ['order:read'] },
  { id: 'billing', label: 'Billing', href: '/billing', icon: 'doc', anyOf: ['billing:read'] },
  { id: 'cases', label: 'Cases', href: '/cases', icon: 'bubble', anyOf: ['case:read'] },
  { id: 'kyc', label: 'KYC reviews', href: '/kyc', icon: 'shield', anyOf: ['kyc:review'] },
  { id: 'mnp', label: 'Number porting', href: '/mnp', icon: 'swap', anyOf: ['mnp:manage'] },
  { id: 'catalog', label: 'Catalog', href: '/catalog', icon: 'grid', anyOf: ['catalog:read'] },
  { id: 'inventory', label: 'Inventory', href: '/inventory', icon: 'cube', anyOf: ['inventory:read'] },
  { id: 'finance', label: 'Finance', href: '/finance', icon: 'ledger', anyOf: ['finance:read'] },
  { id: 'stores', label: 'Stores', href: '/stores', icon: 'pin', anyOf: ['store:manage'] },
  { id: 'dealers', label: 'Dealers', href: '/dealers', icon: 'store', anyOf: ['dealer:read'] },
  { id: 'commission', label: 'Commission', href: '/dealer/commission', icon: 'coins', anyOf: ['commission:read'] },
  { id: 'users', label: 'Users & roles', href: '/admin/users', icon: 'people', anyOf: ['user:manage'] },
  { id: 'settings', label: 'Settings', href: '/admin/settings', icon: 'gear', anyOf: ['settings:manage'] },
  { id: 'audit', label: 'Audit log', href: '/admin/audit', icon: 'list', anyOf: ['audit:read'] },
];

// ───────────────────────── resolution helpers ─────────────────────────
export interface Principal {
  isSuperuser: boolean;
  roles: RoleId[];
  customerId?: string | null;
  storeId?: string | null;
  dealerId?: string | null;
}

/**
 * Everything an administrator can change about roles (Users & roles → Roles and permissions): the permissions and credit limit of built-in roles,
 * and roles they created. The table above is the default. The book is read from the database per request and passed to whatever decides access.
 */
export interface RoleBook {
  changes: Partial<Record<string, { permissions?: Permission[]; creditLimitMinor?: number | null }>>;
  custom: Record<string, RoleDef>;
}
export type RoleOverrides = RoleBook;
export const EMPTY_BOOK: RoleBook = { changes: {}, custom: {} };

/** A role's definition, built-in or created. */
export const roleDef = (id: RoleId, book?: RoleBook): RoleDef | undefined => book?.custom[id] ?? (isBuiltinRole(id) ? ROLES[id] : undefined);
/** The permissions a role has right now. */
export const rolePermissions = (id: RoleId, book?: RoleBook): Permission[] => book?.changes[id]?.permissions ?? roleDef(id, book)?.permissions ?? [];
export const roleCreditLimit = (id: RoleId, book?: RoleBook): number | null | undefined => {
  const c = book?.changes[id];
  return c && 'creditLimitMinor' in c ? c.creditLimitMinor : roleDef(id, book)?.creditLimitMinor;
};

export function permissionsOf(p: Pick<Principal, 'isSuperuser' | 'roles'>, book?: RoleBook): Set<Permission> {
  if (p.isSuperuser) return new Set(ALL_PERMISSIONS);
  return new Set(p.roles.flatMap((r) => rolePermissions(r, book)));
}

/** Largest credit note the principal may issue; `null` = unlimited; 0 = none. */
export function creditLimitOf(p: Pick<Principal, 'isSuperuser' | 'roles'>, book?: RoleBook): number | null {
  if (p.isSuperuser) return null;
  let max = 0;
  for (const r of p.roles) {
    const l = roleCreditLimit(r, book);
    if (l === null) return null;
    if (typeof l === 'number') max = Math.max(max, l);
  }
  return max;
}

export interface Scope { customerId?: string; storeId?: string; dealerId?: string; unrestricted: boolean }

/**
 * Data scope. A user with ANY unscoped (staff) role, or the super user, is unrestricted. Otherwise the scopes of their
 * roles apply. A scoped role whose binding is missing (retail user without a store) yields an impossible filter, never "all".
 * A role that is not known (removed since) counts as scoped to nothing, never as unrestricted.
 */
export function scopeOf(p: Principal, book?: RoleBook): Scope {
  if (p.isSuperuser || p.roles.some((r) => roleDef(r, book)?.scope === 'staff')) return { unrestricted: true };
  const s: Scope = { unrestricted: false };
  for (const r of p.roles) {
    const sc = roleDef(r, book)?.scope;
    if (sc === 'customer') s.customerId = p.customerId ?? '00000000-0000-0000-0000-000000000000';
    if (sc === 'store') s.storeId = p.storeId ?? '\u0000none';
    if (sc === 'dealer') s.dealerId = p.dealerId ?? '\u0000none';
  }
  return s;
}

export function homeOf(p: Principal, book?: RoleBook): string {
  if (p.isSuperuser) return '/';
  const r = HOME_PRIORITY.find((x) => p.roles.includes(x)) ?? p.roles.find((x) => roleDef(x, book));
  return (r && roleDef(r, book)?.home) || '/';
}

export interface NavModule { id: string; label: string; href: string; icon: string }

/** Modules this principal can open. A portal customer's "Customers" entry becomes "My account". */
export function modulesOf(p: Principal, effective?: ReadonlySet<Permission>, book?: RoleBook): NavModule[] {
  const perms = effective ?? permissionsOf(p, book);
  const scope = scopeOf(p, book);
  const out: NavModule[] = MODULES.filter((m) => m.anyOf.some((x) => perms.has(x))).map(({ id, label, href, icon }) => ({ id, label, href, icon }));
  if (scope.customerId && !perms.has('customer:search')) out.unshift({ id: 'account', label: 'My account', href: '/account', icon: 'person' });
  return out;
}

/** Required binding per role, so user creation can refuse a store user with no store. */
export function missingBinding(roles: RoleId[], b: { storeId?: string | null; dealerId?: string | null; customerId?: string | null }, book?: RoleBook): string | null {
  for (const r of roles) {
    const d = roleDef(r, book);
    if (!d) continue;
    if (d.scope === 'store' && !b.storeId) return `role "${d.label}" needs a store id`;
    if (d.scope === 'dealer' && !b.dealerId) return `role "${d.label}" needs a dealer id`;
    if (d.scope === 'customer' && !b.customerId) return `role "${d.label}" needs a linked customer`;
  }
  return null;
}
