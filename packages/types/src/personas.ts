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
  { id: 'admin', label: 'Administrator', summary: 'All modules', nav: [n('home', 'Overview', '/', 'house'), n('cust', 'Customers', '/customers', 'person'), n('orders', 'Orders', '/orders', 'box'), n('billing', 'Billing', '/billing', 'doc'), n('gl', 'Finance', '/finance', 'ledger'), n('catalog', 'Catalog', '/catalog', 'grid'), n('inv', 'Inventory', '/inventory', 'cube'), n('cases', 'Cases', '/cases', 'bubble'), n('mnp', 'MNP', '/mnp', 'swap'), n('rules', 'Order Rules', '/orders/designer', 'flow'), n('audit', 'Audit Log', '/admin/audit', 'list')] },
  { id: 'product-configurator', label: 'Product Configurator', summary: 'Catalog, offers, order rules', nav: [n('home', 'Overview', '/', 'house'), n('catalog', 'Catalog', '/catalog', 'grid'), n('rules', 'Order Rules', '/orders/designer', 'flow')] },
  { id: 'billing-ops', label: 'Billing Operations', summary: 'Bill runs, invoices, dunning', nav: [n('home', 'Overview', '/', 'house'), n('billing', 'Billing', '/billing', 'doc'), n('cust', 'Customers', '/customers', 'person')] },
  { id: 'rating-charging', label: 'Rating & Charging', summary: 'Tariffs and price plans', nav: [n('home', 'Overview', '/', 'house'), n('tariffs', 'Tariffs', '/catalog', 'tag')] },
  { id: 'self-serve', label: 'Self-Serve', summary: 'Shop, orders, bills', nav: [n('home', 'Home', '/', 'house'), n('shop', 'Shop', '/orders/new?channel=SELF_SERVE', 'bag'), n('orders', 'My Orders', '/orders', 'box'), n('billing', 'Bills', '/billing', 'doc')] },
  { id: 'call-center', label: 'Call Center', summary: 'Customer 360 and cases', nav: [n('home', 'Overview', '/', 'house'), n('c360', 'Customers', '/customers', 'person'), n('cases', 'Cases', '/cases', 'bubble'), n('orders', 'Orders', '/orders', 'box')] },
  { id: 'telesales', label: 'Telesales', summary: 'Outbound sales and quotes', nav: [n('home', 'Overview', '/', 'house'), n('sell', 'Sell', '/orders/new?channel=TELESALES', 'bag'), n('cust', 'Customers', '/customers', 'person'), n('orders', 'Orders', '/orders', 'box')] },
  { id: 'retail-store', label: 'Retail Store', summary: 'Assisted sales and quick-sale', nav: [n('home', 'Overview', '/', 'house'), n('sell', 'Sell', '/orders/new?channel=RETAIL_ASSISTED', 'bag'), n('quick', 'Quick sale', '/orders/new?channel=QUICK_SALE', 'coins'), n('orders', 'Orders', '/orders', 'box'), n('inv', 'Inventory', '/inventory', 'cube')] },
  { id: 'dealer', label: 'Dealer', summary: 'Partner sales and commission', nav: [n('home', 'Overview', '/', 'house'), n('sell', 'Sell', '/orders/new?channel=DEALER', 'bag'), n('orders', 'Orders', '/orders', 'box'), n('comm', 'Commission', '/dealer/commission', 'coins')] },
  { id: 'customer-service', label: 'Customer Service', summary: 'Refunds, MNP, assurance', nav: [n('home', 'Overview', '/', 'house'), n('cust', 'Customers', '/customers', 'person'), n('cases', 'Cases', '/cases', 'bubble'), n('mnp', 'MNP', '/mnp', 'swap')] },
  { id: 'finance', label: 'Finance', summary: 'GL export and reconciliation', nav: [n('home', 'Overview', '/', 'house'), n('gl', 'GL & Recon', '/finance', 'ledger'), n('billing', 'Billing', '/billing', 'doc')] },
  { id: 'fraud', label: 'Fraud', summary: 'Order and account review', nav: [n('home', 'Overview', '/', 'house'), n('orders', 'Orders', '/orders', 'box'), n('audit', 'Audit Log', '/admin/audit', 'list')] },
  { id: 'revenue-assurance', label: 'Revenue Assurance', summary: 'Ledger vs sub-ledger checks', nav: [n('home', 'Overview', '/', 'house'), n('recon', 'Reconciliation', '/finance', 'check'), n('billing', 'Billing', '/billing', 'doc')] },
];
