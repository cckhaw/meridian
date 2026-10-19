/**
 * Every settings screen is one entry here. The page builds its menu, search and deep links from this list, so adding a new group of settings is
 * one line: give it a group, a label, a one-line description and a few search words, and register its component in page.tsx.
 */
export interface SettingsSection { id: string; group: string; label: string; description: string; keywords: string }

/** The order groups are shown in. */
export const GROUPS = ['General', 'Security', 'Customers', 'Catalog', 'Sales and orders', 'Back office'] as const;

export const SECTIONS: SettingsSection[] = [
  { id: 'regional', group: 'General', label: 'Regional format', description: 'Currency, number and date formats, time zone, tax', keywords: 'currency money format number date time timezone tax gst sst vat dial code country' },
  { id: 'modules', group: 'General', label: 'Modules', description: 'Switch optional modules on or off, such as fibre coverage', keywords: 'module modules feature flag fibre fiber ftth coverage serviceability broadband switch on off' },
  { id: 'markets', group: 'General', label: 'Markets', description: 'Sell in one market, or in several countries', keywords: 'market markets country countries multiple single multi region territory sell availability' },
  { id: 'appearance', group: 'General', label: 'Appearance', description: 'Portal name, logo and colour theme', keywords: 'logo brand name theme colour color dark light' },
  { id: 'roles', group: 'Security', label: 'Roles and permissions', description: 'Who can do what: a role-by-permission matrix, data scope, clone and switch off', keywords: 'roles permissions rbac matrix access scope store dealer clone disable super admin catalog manager billing ops rating call center supervisor retail manager dealer agent finance fraud self care customer credit limit refund threshold' },
  { id: 'security-policy', group: 'Security', label: 'Security policy', description: 'Password rules, lockout, session timeouts, two-step sign-in, e-mail codes and password recovery', keywords: 'security policy e-mail codes signed copy order mfa two-step 2fa password strength length complexity expire expiry history reuse lockout lock failed attempts session idle timeout logout forgot reset recovery sms email otp token' },
  { id: 'customers', group: 'Customers', label: 'Customers and segments', description: 'Creating customers, the details on the customer form, and the segments', keywords: 'customer segment consumer enterprise iot create new form field address postcode city state country date birth dob gender email phone required optional hidden' },
  { id: 'bill-cycles', group: 'Customers', label: 'Bill cycles', description: 'The bill cycles an account can have, and the default', keywords: 'bill billing cycle day invoice monthly account' },
  { id: 'offer-types', group: 'Catalog', label: 'Offer types', description: 'The types of offer you can create', keywords: 'catalog offer type kind sim plan fibre device good add-on subscription' },
  { id: 'fulfilment', group: 'Catalog', label: 'Fulfilment options', description: 'How an offer is delivered: ship, collect in store, install', keywords: 'catalog fulfilment fulfillment delivery ship shipping collect pickup store install installation sim stock sku inventory' },
  { id: 'service-types', group: 'Catalog', label: 'Service types', description: 'What kinds of service an order starts, how the network and charging system hear about them, and new ones: a pass, a voucher, a top-up', keywords: 'catalog service types kinds mobile fibre iot subscription ocs charging network pass voucher roaming prepaid top-up expiry provisioning systems identifier' },
  { id: 'cancellation', group: 'Sales and orders', label: 'Cancellation', description: 'When an order can be cancelled or returned, and what it costs', keywords: 'cancel cancellation return refund fee rule policy' },
  { id: 'documents', group: 'Back office', label: 'Documents', description: 'When agreements must be signed, and how long identity documents and contracts are kept', keywords: 'document documents agreement contract terms signature sign esign kyc retention purge vault template' },
  { id: 'dunning-rules', group: 'Back office', label: 'Dunning rules', description: 'Who is chased when an invoice is overdue: ladders of reminders, late fees, bars and termination per market and customer type', keywords: 'dunning collections overdue arrears debt rule ladder reminder late fee bar soft hard terminate write off agency qr promptpay paynow duitnow qris sms whatsapp partial payment arrangement vip enterprise risk drag' },
  { id: 'early-termination', group: 'Sales and orders', label: 'Early termination', description: 'What leaving a contract early costs, by situation, with the formula behind each charge', keywords: 'early termination etc charge fee contract formula scenario subsidy device instalment balance port out non payment downgrade hardship waive penalty churn' },
  { id: 'device-financing', group: 'Sales and orders', label: 'Device financing', description: 'Pay a device over the contract, and let a credit check decide the upfront payment', keywords: 'device financing instalment installment credit check score bureau upfront payment dup down payment subsidy contract affordability' },
  { id: 'cases', group: 'Back office', label: 'Cases', description: 'How cases are classified, the service levels, and when they close', keywords: 'case cases ticket support sla service level classification category taxonomy severity escalation close reopen first response resolution incident master field service technician dispatch refund approval tier' },
  { id: 'donor-operators', group: 'Back office', label: 'Donor operators', description: 'The operators numbers can be ported in from, with their operator IDs', keywords: 'donor operator telco carrier mnp port in porting operator ID clearinghouse' },
  { id: 'numbering', group: 'Back office', label: 'Numbers & SIMs', description: 'Cooling-off periods, MSISDN holds, SIM rules and the MSISDN, ICCID and IMSI lifecycles', keywords: 'number numbers msisdn iccid imsi sim esim cooling quarantine rest recycle reservation hold lifecycle auction vip' },
];

export const sectionById = (id: string | null | undefined) => SECTIONS.find((s) => s.id === id);

/** Sections matching what was typed (every word must appear in the label, description, group or keywords). */
export function searchSections(q: string): SettingsSection[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return SECTIONS;
  return SECTIONS.filter((s) => { const hay = `${s.label} ${s.description} ${s.group} ${s.keywords}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
}
