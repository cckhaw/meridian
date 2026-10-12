import type { Auditable, CurrencyCode, Money } from './common.js';

/** Level 1 of the hierarchy: Network type -> Category -> Group -> Offer. */
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

export type CatalogNodeLevel = 'NETWORK_TYPE' | 'CATEGORY' | 'GROUP' | 'OFFER';

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
  /** Offers that must/must not be bundled with this one. */
  requires: string[];
  excludes: string[];
}

export type CatalogNode = NetworkTypeNode | CategoryNode | GroupNode | OfferNode;

export interface EtcQuote {
  offerId: string;
  currency: CurrencyCode;
  monthsElapsed: number;
  monthsRemaining: number;
  chargeMinor: number;
  waived: boolean;
}
