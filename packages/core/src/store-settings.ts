import { audit } from './audit.js';
import type { Queryable } from './db.js';
import { invalid } from './errors.js';
import { GATEWAYS, type PaymentGateway } from './gateways.js';

export const ID_TYPES = ['NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENCE', 'RESIDENCE_PERMIT'] as const;
export type IdType = (typeof ID_TYPES)[number];

export interface StoreSettings {
  /** manual: every online sign-up is reviewed by a person. auto: applications that pass every rule are approved without review (use with an eKYC provider). */
  kycMode: 'manual' | 'auto';
  minAge: number;
  /** When on, staff in the CRM cannot sell a service to a customer who has not been KYC-verified. (The store-front always requires an approved identity application.) */
  requireKycForServices: boolean;
  /**
   * When identity must be settled. BEFORE_ACTIVATION (the default): an order can be taken while the identity check is in review, and the service is activated
   * only once it is approved (a rejection cancels and refunds the order). BEFORE_ORDER: nothing is sold until the identity is verified.
   */
  kycGate: 'BEFORE_ORDER' | 'BEFORE_ACTIVATION';
  /** Hours a review task may wait before it is shown as overdue. */
  kycSlaHours: number;
  /** Identity photos must be taken live with the device camera in the app. Switch off only for a partner that sends scans through the API. */
  kycRequireLiveCapture: boolean;
  termsUrl: string;
  privacyUrl: string;
  /** Shown to the customer and recorded with their consent; bump it when the terms change. */
  termsVersion: string;
  applicationTtlHours: number;
  /**
   * Payment gateways: `enabled` are offered in the store-front (with `default` as the first choice); `crm` are offered to staff in the CRM, who send the
   * customer a card payment link from the order. A gateway can be on in either, both or neither.
   */
  gateways: { enabled: string[]; default: string | null; crm?: string[] };
}

export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  kycMode: 'manual', minAge: 18, requireKycForServices: false, kycGate: 'BEFORE_ACTIVATION', kycSlaHours: 4, kycRequireLiveCapture: true, termsUrl: '', privacyUrl: '', termsVersion: '1', applicationTtlHours: 72, gateways: { enabled: [], default: null, crm: [] },
};

export async function getStoreSettings(q: Queryable): Promise<StoreSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='store'`)).rows[0]?.value ?? {};
  const merged = { ...DEFAULT_STORE_SETTINGS, ...v, gateways: { ...DEFAULT_STORE_SETTINGS.gateways, ...(v.gateways ?? {}) } } as StoreSettings;
  // Settings saved before the gate existed carried only the on/off switch: on meant "nothing is sold until verified".
  merged.kycGate = v.kycGate ?? (v.requireKycForServices ? 'BEFORE_ORDER' : 'BEFORE_ACTIVATION');
  merged.requireKycForServices = merged.kycGate === 'BEFORE_ORDER';
  return merged;
}

export async function setStoreSettings(q: Queryable, actor: string, input: StoreSettings): Promise<StoreSettings> {
  if (!['manual', 'auto'].includes(input.kycMode)) throw invalid('kycMode must be manual or auto');
  if (input.kycGate === undefined) input = { ...input, kycGate: input.requireKycForServices ? 'BEFORE_ORDER' : 'BEFORE_ACTIVATION' };
  if (!['BEFORE_ORDER', 'BEFORE_ACTIVATION'].includes(input.kycGate)) throw invalid('kycGate must be BEFORE_ORDER or BEFORE_ACTIVATION');
  input = { ...input, requireKycForServices: input.kycGate === 'BEFORE_ORDER', kycSlaHours: input.kycSlaHours ?? DEFAULT_STORE_SETTINGS.kycSlaHours, kycRequireLiveCapture: input.kycRequireLiveCapture ?? true };
  if (!Number.isInteger(input.kycSlaHours) || input.kycSlaHours < 1 || input.kycSlaHours > 24 * 14) throw invalid('the review target is 1 hour to 14 days');
  if (!Number.isInteger(input.minAge) || input.minAge < 0 || input.minAge > 100) throw invalid('minimum age must be between 0 and 100');
  if (!Number.isInteger(input.applicationTtlHours) || input.applicationTtlHours < 1 || input.applicationTtlHours > 24 * 30) throw invalid('applications can be kept open for 1 hour to 30 days');
  for (const u of [input.termsUrl, input.privacyUrl]) if (u && !/^https?:\/\/\S+$/.test(u)) throw invalid('terms and privacy links must be http(s) URLs');
  if (!input.termsVersion.trim() || input.termsVersion.length > 20) throw invalid('terms version must be 1–20 characters');
  for (const g of [...input.gateways.enabled, ...(input.gateways.crm ?? [])]) if (!GATEWAYS[g]) throw invalid(`unknown payment gateway ${g}`);
  if (input.gateways.default && !input.gateways.enabled.includes(input.gateways.default)) throw invalid('the default gateway must be one of the enabled gateways');
  input = { ...input, gateways: { ...input.gateways, crm: [...new Set(input.gateways.crm ?? [])] } };
  const before = await getStoreSettings(q);
  await q.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ('store', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [JSON.stringify(input), actor],
  );
  await audit(q, actor, 'settings', 'store', 'update', { from: before, to: input });
  return input;
}

/** Gateways that are switched on in Settings AND have their keys configured here. Nothing is offered that cannot take a payment. */
export async function activeGateways(q: Queryable, env: NodeJS.ProcessEnv = process.env, where: 'STOREFRONT' | 'CRM' = 'STOREFRONT'): Promise<{ list: PaymentGateway[]; default: PaymentGateway | null }> {
  const s = await getStoreSettings(q);
  // Store-front: none chosen yet means offer whatever is configured. CRM: only what was switched on for staff (a payment link is opt-in).
  const enabled = where === 'CRM' ? s.gateways.crm ?? [] : s.gateways.enabled.length ? s.gateways.enabled : Object.keys(GATEWAYS);
  const list = enabled.map((id) => GATEWAYS[id]!).filter((g) => g && g.configured(env));
  const def = list.find((g) => g.id === s.gateways.default) ?? list[0] ?? null;
  return { list, default: def };
}
