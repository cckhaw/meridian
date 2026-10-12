import type { Auditable, CurrencyCode, Money } from './common.js';

/** The hierarchy: Network type -> Category -> Group -> Offer -> Offer line item. */
export type NetworkType = 'mobile' | 'fiber' | 'iot' | 'none';

export type OfferKind =
  | 'SIM_ONLY'
  | 'SIM_DEVICE'
  | 'WEARABLE'
  | 'VAS'
  | 'NON_TELCO_SUBSCRIPTION'
  | 'PHYSICAL_GOOD'
  | 'FIBER'
  | 'IOT_CONNECTIVITY';

export type ContractTermMonths = 0 | 12 | 24 | 36;

export type CatalogNodeLevel = 'NETWORK_TYPE' | 'CATEGORY' | 'GROUP' | 'OFFER' | 'LINE_ITEM';

/** What a line item is, which decides how it reads (an allowance, a physical thing, a service). */
export const LINE_ITEM_TYPES = ['DATA', 'VOICE', 'SMS', 'SIM', 'DEVICE', 'ACCESSORY', 'SERVICE', 'CONTENT', 'OTHER'] as const;
export type LineItemType = (typeof LINE_ITEM_TYPES)[number];

export interface CatalogNodeBase extends Auditable {
  id: string;
  level: CatalogNodeLevel;
  code: string;
  name: string;
  /** Materialised path, e.g. "mobile/postpaid/family". Indexed in MongoDB. */
  path: string;
  parentId: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  /** Market the node is sellable in (ISO-3166 alpha-2), empty = all. */
  markets: string[];
}

export interface NetworkTypeNode extends CatalogNodeBase { level: 'NETWORK_TYPE'; networkType: NetworkType }
export interface CategoryNode extends CatalogNodeBase { level: 'CATEGORY' }
export interface GroupNode extends CatalogNodeBase { level: 'GROUP' }

export type PriceType = 'ONE_TIME' | 'RECURRING' | 'USAGE';

export interface PriceComponent {
  type: PriceType;
  amount: Money;
  /** Billing period for RECURRING. */
  periodMonths?: number;
  taxInclusive: boolean;
}

export interface DeviceSubsidy {
  /** Retail price of the device without contract. */
  deviceRetailPrice: Money;
  /** Subsidy the operator funds, recovered via ETC when a contract ends early. */
  subsidyAmount: Money;
}

export interface EarlyTerminationPolicy {
  method: 'SUBSIDY_AMORTISED' | 'REMAINING_RECURRING_PERCENT';
  /** Used by REMAINING_RECURRING_PERCENT, 0..100. */
  percentOfRemaining?: number;
  /** Cap as a fraction of subsidy for SUBSIDY_AMORTISED, default 1. */
  capSubsidyFraction?: number;
  waiveInLastMonths?: number;
}

export interface ContractTerms {
  termMonths: ContractTermMonths;
  etc?: EarlyTerminationPolicy;
  subsidy?: DeviceSubsidy;
}

export interface FulfilmentSpec {
  requiresShipping: boolean;
  requiresInstallation: boolean;
  requiresSimActivation: boolean;
  inventorySkus: string[];
}

export interface OfferNode extends CatalogNodeBase {
  level: 'OFFER';
  kind: OfferKind;
  description?: string;
  prices: PriceComponent[];
  contract?: ContractTerms;
  fulfilment: FulfilmentSpec;
  /** Third-party partner for non-telco subscriptions, e.g. "netflix". */
  partnerCode?: string;
  /** Free-form attributes, validated per kind by the catalog service. */
  characteristics: Record<string, string | number | boolean>;
  /**
   * Prerequisites. Each entry is an offer id OR a hierarchy node id (group/category/network = "any offer beneath it").
   * Every entry must be satisfied: the customer already owns a matching offer, or buys one in the same order.
   */
  requires: string[];
  /** Offers that cannot be in the same order as this one. */
  excludes: string[];
  /** Channels this offer is sold through. Empty/absent = all channels. */
  salesChannels?: string[];
}

/**
 * One component of what an offer includes, e.g. "100 GB data", "Unlimited calls", "Phone X1 128GB".
 * Line items describe the offer (shown to customers) and, when they carry an inventory SKU, drive stock reservation.
 * They are not sold on their own and do not change the offer's price.
 */
export interface LineItemNode extends CatalogNodeBase {
  level: 'LINE_ITEM';
  itemType: LineItemType;
  description?: string;
  /** Amount of the allowance, or number of units. Absent when `unlimited`. */
  quantity?: number;
  /** "GB", "min", "SMS", "unit"… */
  unit?: string;
  unlimited?: boolean;
  /** Inventory SKU reserved (quantity × number of offers ordered) when the offer is sold. */
  sku?: string;
}

export type CatalogNode = NetworkTypeNode | CategoryNode | GroupNode | OfferNode | LineItemNode;

export interface EtcQuote {
  offerId: string;
  currency: CurrencyCode;
  monthsElapsed: number;
  monthsRemaining: number;
  chargeMinor: number;
  waived: boolean;
}
