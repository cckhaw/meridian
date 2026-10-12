export type PersonaId =
  | 'admin' | 'product-configurator' | 'billing-ops' | 'rating-charging' | 'self-serve'
  | 'call-center' | 'telesales' | 'retail-store' | 'dealer' | 'customer-service'
  | 'finance' | 'fraud' | 'revenue-assurance';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  /** SF-Symbols-style icon name resolved by the UI package. */
  icon: string;
}

export interface Persona {
  id: PersonaId;
  label: string;
  summary: string;
  nav: NavItem[];
}

const n = (id: string, label: string, href: string, icon: string): NavItem => ({ id, label, href, icon });

export const PERSONAS: Persona[] = [
  { id: 'admin', label: 'Administrator', summary: 'Tenants, roles, platform settings', nav: [n('home', 'Overview', '/', 'house'), n('users', 'Users & Roles', '/admin/users', 'people'), n('audit', 'Audit Log', '/admin/audit', 'list')] },
  { id: 'product-configurator', label: 'Product Configurator', summary: 'Catalog, offers, pricing plans', nav: [n('home', 'Overview', '/', 'house'), n('catalog', 'Catalog', '/catalog', 'grid'), n('rules', 'Order Rules', '/orders/designer', 'flow')] },
  { id: 'billing-ops', label: 'Billing Operations', summary: 'Bill runs, invoices, dunning', nav: [n('home', 'Overview', '/', 'house'), n('cycles', 'Bill Cycles', '/billing/cycles', 'calendar'), n('invoices', 'Invoice Designer', '/billing/templates', 'doc')] },
  { id: 'rating-charging', label: 'Rating & Charging', summary: 'Tariffs, balances, usage', nav: [n('home', 'Overview', '/', 'house'), n('tariffs', 'Tariffs', '/rating/tariffs', 'tag')] },
  { id: 'self-serve', label: 'Self-Serve', summary: 'My plan, bills, add-ons', nav: [n('home', 'Home', '/', 'house'), n('shop', 'Shop', '/catalog', 'bag'), n('orders', 'My Orders', '/orders', 'box')] },
  { id: 'call-center', label: 'Call Center', summary: 'Customer 360 and cases', nav: [n('home', 'Overview', '/', 'house'), n('c360', 'Customer 360', '/customers', 'person'), n('cases', 'Cases', '/cases', 'bubble')] },
  { id: 'telesales', label: 'Telesales', summary: 'Outbound campaigns and quotes', nav: [n('home', 'Overview', '/', 'house'), n('shop', 'Sell', '/catalog', 'bag'), n('orders', 'Orders', '/orders', 'box')] },
  { id: 'retail-store', label: 'Retail Store', summary: 'Assisted sales, exchanges, quick-sale', nav: [n('home', 'Overview', '/', 'house'), n('sell', 'Sell', '/catalog', 'bag'), n('orders', 'Orders', '/orders', 'box'), n('inv', 'Inventory', '/inventory', 'cube')] },
  { id: 'dealer', label: 'Dealer', summary: 'Partner sales and commission', nav: [n('home', 'Overview', '/', 'house'), n('sell', 'Sell', '/catalog', 'bag'), n('comm', 'Commission', '/dealer/commission', 'coins')] },
  { id: 'customer-service', label: 'Customer Service', summary: 'Refunds, MNP, assurance', nav: [n('home', 'Overview', '/', 'house'), n('cases', 'Cases', '/cases', 'bubble'), n('mnp', 'MNP', '/mnp', 'swap')] },
  { id: 'finance', label: 'Finance', summary: 'GL export and reconciliation', nav: [n('home', 'Overview', '/', 'house'), n('gl', 'GL Journals', '/finance/gl', 'ledger'), n('recon', 'Reconciliation', '/finance/recon', 'check')] },
  { id: 'fraud', label: 'Fraud', summary: 'Alerts and blocklists', nav: [n('home', 'Overview', '/', 'house'), n('alerts', 'Alerts', '/fraud/alerts', 'shield')] },
  { id: 'revenue-assurance', label: 'Revenue Assurance', summary: 'Leakage and reconciliation', nav: [n('home', 'Overview', '/', 'house'), n('leak', 'Leakage', '/ra/leakage', 'gauge')] },
];
