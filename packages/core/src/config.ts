import type { CurrencyCode } from '@meridian/types';

export interface Market {
  code: string;
  name: string;
  currency: CurrencyCode;
  dialCode: string;
  /** Indirect tax in basis points (GST/VAT/SST). Review per jurisdiction before production use. */
  taxBps: number;
  taxName: string;
}

export const MARKETS: Record<string, Market> = {
  SG: { code: 'SG', name: 'Singapore', currency: 'SGD', dialCode: '+65', taxBps: 900, taxName: 'GST' },
  MY: { code: 'MY', name: 'Malaysia', currency: 'MYR', dialCode: '+60', taxBps: 800, taxName: 'SST' },
  TH: { code: 'TH', name: 'Thailand', currency: 'THB', dialCode: '+66', taxBps: 700, taxName: 'VAT' },
  ID: { code: 'ID', name: 'Indonesia', currency: 'IDR', dialCode: '+62', taxBps: 1100, taxName: 'PPN' },
  VN: { code: 'VN', name: 'Vietnam', currency: 'VND', dialCode: '+84', taxBps: 1000, taxName: 'VAT' },
  PH: { code: 'PH', name: 'Philippines', currency: 'PHP', dialCode: '+63', taxBps: 1200, taxName: 'VAT' },
};
export const market = (code: string): Market => MARKETS[code] ?? MARKETS.SG!;

/** Chart of accounts used for the SAP GL export (account codes are placeholders to map to the client's CoA). */
export const GL = {
  CASH: '1100',
  AR: '1200',
  TAX_PAYABLE: '2100',
  SERVICE_REVENUE: '4000',
  GOODS_REVENUE: '4100',
  CREDIT_NOTES: '4900', // contra-revenue
} as const;

export const GL_NAMES: Record<string, string> = {
  '1100': 'Cash and bank', '1200': 'Accounts receivable', '2100': 'Indirect tax payable',
  '4000': 'Service revenue', '4100': 'Goods revenue', '4900': 'Credit notes and refunds',
};

export const INVOICE_TERMS_DAYS = 14;
export const DUNNING = { overdueAfterDays: 0, suspendAfterDays: 15, reviewAfterDays: 45 } as const;
/** Commission paid on net order value, by channel (basis points). */
export const COMMISSION_BPS: Record<string, number> = { RETAIL_ASSISTED: 300, DEALER: 500, TELESALES: 400 };
export const LOGICAL_SHARDS = Number(process.env.MERIDIAN_LOGICAL_SHARDS ?? 16); // dev DB creates 16 of 1024 partitions
