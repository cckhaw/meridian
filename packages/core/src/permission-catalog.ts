import { ALL_PERMISSIONS, CHANNELS, isPermission, type Permission } from './rbac.js';

/**
 * Every permission has two names. The id (`billing:credit`) is what the code and the database use. The key (`billing:credit_note:issue`) reads
 * `domain:resource:action`: the area, the thing, and what is done to it. Both are accepted wherever a permission is named (the roles API, the
 * guards). A few friendlier aliases name an action by the thing people say (`subscriber:sim:swap`, `billing:invoice:waive`) and mean the permission
 * that covers it, so integrations and documents can use the vocabulary of the business.
 */
const KEYS: Record<string, string> = {
  'dashboard:read': 'dashboard:overview:read',
  'customer:search': 'customer:profile:search', 'customer:read': 'customer:profile:read', 'customer:create': 'customer:profile:create', 'customer:write': 'customer:profile:update',
  'service:read': 'subscriber:service:read', 'service:manage': 'subscriber:service:manage', 'service:suspend': 'subscriber:service:suspend', 'service:self': 'subscriber:service:self_suspend',
  'service:terminate': 'subscriber:service:terminate', 'service:transfer': 'subscriber:ownership:transfer', 'mnp:manage': 'subscriber:port:manage',
  'order:read': 'order:order:read', 'order:payment': 'order:payment:take', 'order:fulfil': 'order:fulfilment:update', 'order:cancel': 'order:order:cancel', 'order:override': 'order:exception:approve',
  'billing:read': 'billing:invoice:read', 'billing:pay': 'billing:payment:record', 'billing:credit': 'billing:credit_note:issue', 'billing:run': 'billing:run:execute', 'billing:simulate': 'billing:simulation:run',
  'billing:template': 'billing:template:design', 'billing:print': 'billing:print:produce', 'billing:approve': 'billing:run:approve',
  'finance:read': 'finance:ledger:read', 'finance:export': 'finance:journal:export', 'finance:configure': 'finance:posting_rule:configure', 'ledger:ingest': 'finance:event:ingest',
  'catalog:read': 'catalog:offer:read', 'catalog:write': 'catalog:offer:write',
  'inventory:read': 'inventory:stock:read', 'inventory:write': 'inventory:stock:receive', 'inventory:transfer': 'inventory:transfer:manage', 'inventory:writeoff': 'inventory:stock:writeoff', 'warehouse:manage': 'inventory:warehouse:manage',
  'numbering:read': 'numbering:pool:read', 'numbering:select': 'numbering:number:select', 'numbering:manage': 'numbering:pool:manage',
  'case:read': 'case:case:read', 'case:create': 'case:case:create', 'case:write': 'case:case:update', 'case:supervise': 'case:sla:supervise', 'collections:manage': 'collections:debt:manage',
  'commission:read': 'commission:ledger:read', 'commission:configure': 'commission:plan:configure', 'commission:settle': 'commission:statement:settle',
  'dealer:read': 'dealer:partner:read', 'dealer:manage': 'dealer:partner:manage', 'store:manage': 'store:outlet:manage', 'store:assist': 'store:counter:assist',
  'store:report': 'store:sales:read', 'store:cashdrawer': 'store:cash_drawer:reconcile', 'fraud:read': 'fraud:alert:read', 'fraud:manage': 'fraud:alert:manage', 'fraud:bar': 'fraud:service:hard_bar',
  'kyc:attest': 'kyc:document:attest', 'kyc:review': 'kyc:case:review',
  'document:read': 'document:agreement:read', 'document:kyc': 'document:kyc:read', 'document:manage': 'document:vault:manage', 'document:template': 'document:template:author',
  'audit:read': 'audit:log:read', 'migration:export': 'migration:data:export', 'migration:import': 'migration:data:import', 'user:manage': 'iam:user:manage', 'settings:manage': 'system:settings:manage',
  'integration:manage': 'system:integration:manage',
};
for (const c of CHANNELS) KEYS[`order:create:${c}`] = `order:${c.toLowerCase()}:create`;

export const permissionKey = (id: Permission): string => KEYS[id] ?? `other:${id.replace(/:/g, '_')}:use`;
export const permissionDomain = (id: Permission): string => permissionKey(id).split(':')[0]!;

/** Names for an action people use, mapped to the permission that covers it (the permission may allow more than the alias says). */
export const PERMISSION_ALIASES: Record<string, Permission> = {
  'subscriber:sim:swap': 'service:manage', 'subscriber:msisdn:swap': 'service:manage', 'subscriber:plan:migrate': 'service:manage', 'subscriber:service:bar': 'service:suspend',
  'billing:invoice:waive': 'billing:credit', 'billing:refund:request': 'case:create', 'billing:bill_run:approve': 'billing:approve', 'billing:bill_run:execute': 'billing:run',
  'catalog:offer:publish': 'catalog:write', 'catalog:category:create': 'catalog:write',
  'finance:journal:export_sap': 'finance:export', 'finance:bad_debt:write_off': 'collections:manage',
  'case:escalation:handle': 'case:supervise', 'order:capture:assisted': 'order:create:RETAIL_ASSISTED', 'order:capture:quick_sale': 'order:create:QUICK_SALE', 'order:capture:dealer': 'order:create:DEALER',
  'stock:request:manage': 'inventory:transfer', 'fraud:sim_swap:track': 'fraud:read', 'fraud:usage_spike:alert': 'fraud:read', 'fraud:blacklist:manage': 'fraud:manage', 'fraud:service:override_bar': 'fraud:bar',
  'store:sales:track': 'store:report', 'store:commission:attribute': 'store:report', 'inventory:stock:override': 'inventory:writeoff', 'mnp:port_in:capture': 'order:create:DEALER',
};
const BY_KEY = new Map<string, Permission>([...Object.entries(KEYS)].map(([id, k]) => [k, id as Permission]));

/** A permission id, `domain:resource:action` key or alias, as the permission id; undefined when it names nothing. */
export function resolvePermission(name: string): Permission | undefined {
  const n = name.trim();
  if (isPermission(n)) return n;
  return BY_KEY.get(n) ?? PERMISSION_ALIASES[n];
}
export const ALL_PERMISSION_KEYS: string[] = (ALL_PERMISSIONS as readonly Permission[]).map(permissionKey);
