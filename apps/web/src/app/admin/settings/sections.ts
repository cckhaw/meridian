/**
 * Every settings screen is one entry here. The page builds its menu, search and deep links from this list, so adding a new group of settings is
 * one line: give it a group, a label, a one-line description and a few search words, and register its component in page.tsx.
 */
export interface SettingsSection { id: string; group: string; label: string; description: string; keywords: string }

/** The order groups are shown in. */
export const GROUPS = ['General', 'Customers', 'Catalog', 'Sales and orders', 'Back office'] as const;

export const SECTIONS: SettingsSection[] = [
  { id: 'regional', group: 'General', label: 'Regional format', description: 'Currency, number and date formats, time zone, tax', keywords: 'currency money format number date time timezone tax gst sst vat dial code country' },
  { id: 'markets', group: 'General', label: 'Markets', description: 'Sell in one market, or in several countries', keywords: 'market markets country countries multiple single multi region territory sell availability' },
  { id: 'appearance', group: 'General', label: 'Appearance', description: 'Portal name, logo and colour theme', keywords: 'logo brand name theme colour color dark light' },
  { id: 'customers', group: 'Customers', label: 'Customers and segments', description: 'Creating customers, the details on the customer form, and the segments', keywords: 'customer segment consumer enterprise iot create new form field address postcode city state country date birth dob gender email phone required optional hidden' },
  { id: 'bill-cycles', group: 'Customers', label: 'Bill cycles', description: 'The bill cycles an account can have, and the default', keywords: 'bill billing cycle day invoice monthly daily account' },
  { id: 'offer-types', group: 'Catalog', label: 'Offer types', description: 'The types of offer you can create', keywords: 'catalog offer type kind sim plan fibre device good add-on subscription' },
  { id: 'fulfilment', group: 'Catalog', label: 'Fulfilment options', description: 'How an offer is delivered: ship, collect in store, install', keywords: 'catalog fulfilment fulfillment delivery ship shipping collect pickup store install installation sim stock sku inventory' },
  { id: 'cancellation', group: 'Sales and orders', label: 'Cancellation', description: 'When an order can be cancelled or returned, and what it costs', keywords: 'cancel cancellation return refund fee rule policy' },
  { id: 'storefront', group: 'Sales and orders', label: 'Store-front', description: 'Online shop: API keys, payments, which offers are sold', keywords: 'store front storefront online shop api key stripe payment gateway' },
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
