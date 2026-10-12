/** ISO-4217 codes for the ASEAN markets Nexus operates in. */
export type CurrencyCode =
  | 'SGD' | 'MYR' | 'THB' | 'IDR' | 'VND' | 'PHP' | 'BND' | 'KHR' | 'LAK' | 'MMK' | 'USD';

/** Money is always integer minor units (cents/satang/sen) to avoid float drift. */
export interface Money {
  amountMinor: number;
  currency: CurrencyCode;
}

export type Uuid = string;
export type IsoDateTime = string;

export interface Auditable {
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const money = (amountMinor: number, currency: CurrencyCode): Money => ({ amountMinor, currency });
