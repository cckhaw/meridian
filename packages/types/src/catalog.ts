import type { Auditable, CurrencyCode, Money } from './common.js';

/** The hierarchy: Network type -> Category -> Group -> Offer -> Offer line item. */
export type NetworkType = 'mobile' | 'fiber' | 'iot' | 'none';

/** An offer type id: one of the built-in types, or one the operator added in Settings. Its behaviour comes from its template (see offer-types.ts). */
export type OfferKind = string;

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
  status: 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'RETIRED';
  /** When a SCHEDULED node goes live (ISO timestamp). */
  activeFrom?: string | null;
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
  /** RECURRING_PLUS_SUBSIDY: remaining months x monthly fee, plus the unamortised device subsidy (clawback). */
  method: 'SUBSIDY_AMORTISED' | 'REMAINING_RECURRING_PERCENT' | 'RECURRING_PLUS_SUBSIDY';
  /** Used by REMAINING_RECURRING_PERCENT and RECURRING_PLUS_SUBSIDY, 0..100. */
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
  /** Collected in a store by the customer (instead of, or as well as, being shipped). */
  requiresCollection?: boolean;
  /** The fulfilment options chosen in the catalog configuration. The flags above are derived from them when the offer is saved. */
  options?: string[];
  inventorySkus: string[];
}

/** A way to buy a device offer: its colour and storage, the stock SKU that backs it, and what it adds to (or takes off) the upfront price. */
export interface DeviceVariant {
  id: string;
  colour: string;
  storage?: string;
  sku: string;
  priceDeltaMinor?: number;
}

/**
 * A contract a device can be bought on together with any plan: the customer pays the retail price less the subsidy, the contract runs for the term,
 * and ending it early charges the unamortised subsidy.
 */
export interface DeviceDeal {
  termMonths: number;
  /** What the operator takes off the device price for this contract, in minor units. Also the amount the early-termination charge is based on. */
  subsidyMinor: number;
  /** No early-termination charge in the last months of the contract. Defaults to 1. */
  waiveInLastMonths?: number;
}

export interface OfferNode extends CatalogNodeBase {
  level: 'OFFER';
  kind: OfferKind;
  /** The behaviour template of `kind`, stored with the offer so it never needs a lookup. Absent on older offers: then `kind` is the template. */
  template?: string;
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
  /** Device colour/storage choices. When present the customer picks one; its SKU is reserved instead of the offer's own device SKUs. */
  variants?: DeviceVariant[];
  /** Contracts this device can be bought on with a plan (outright devices only). Empty/absent = sold outright only. */
  deals?: DeviceDeal[];
  /** What a customer-requested suspension costs: recurring charges paused (default), or reduced to a monthly maintenance fee. */
  suspension?: SuspensionTerms;
}

export interface SuspensionTerms {
  mode: 'PAUSE' | 'MAINTENANCE_FEE';
  /** Monthly fee while suspended, in the minor units of the deployment currency (MAINTENANCE_FEE only). */
  monthlyFeeMinor?: number;
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
  /** For RECURRING_PLUS_SUBSIDY: the two parts that make up chargeMinor. */
  recurringMinor?: number;
  clawbackMinor?: number;
  /** A VIP number multiplies the charge: 15000 = 1.5x. */
  vipMultiplierBps?: number;
}
