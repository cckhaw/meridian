import { behaviourOf } from '@meridian/types';
import { toMinor } from '@/lib/format';

export type StepId = 'product' | 'device' | 'addons' | 'payment' | 'customer' | 'delivery' | 'review' | 'pay';
export const STEP_TITLE: Record<StepId, string> = {
  product: 'Plan or product', device: 'Device', addons: 'Add-ons', payment: 'How to pay', customer: 'Customer', delivery: 'Delivery and installation', review: 'Review', pay: 'Payment',
};
export const STEP_HINT: Record<StepId, string> = {
  product: 'What is the customer buying?', device: 'Pick the colour and storage, or add a device.', addons: 'Extras this customer can add, and bundle savings.',
  payment: 'Pay each item in full today, or spread it over the contract.', customer: 'Who is this for? Look them up by ID, or create them.', delivery: 'Where to send things, and when the technician can come.',
  review: 'Check everything before it is submitted.', pay: 'Take payment and submit the order.',
};

export interface Item {
  key: string; offer: any; quantity: number; msisdn: string; variantId?: string;
  payMode: 'UPFRONT' | 'INSTALLMENT'; months: number; down: string;
  /** A device bought on a contract with one of the plans in the basket. */
  deal?: { planKey: string; term: number };
}
export interface Cust { id: string; displayName: string; segment?: string; kycStatus?: string; email?: string | null; phone?: string | null }

export const SERVICE_KINDS = ['SIM_ONLY', 'SIM_DEVICE', 'WEARABLE'];
export const PRODUCT_KINDS = 'SIM_ONLY,SIM_DEVICE,WEARABLE,FIBER,IOT_CONNECTIVITY';
export const DEVICE_KINDS = 'PHYSICAL_GOOD,WEARABLE';
export const MONTHS = [3, 6, 12, 24, 36];

const oneTime = (o: any) => (o.prices ?? []).filter((p: any) => p.type === 'ONE_TIME').reduce((s: number, p: any) => s + p.amount.amountMinor, 0);
/** An item can be paid by instalments when it comes with a service to bill them to and there is something upfront to spread. */
export const financeable = (o: any) => !!behaviourOf(o).service && (!behaviourOf(o).serviceNeedsFee || (o.prices ?? []).some((p: any) => p.type === 'RECURRING')) && oneTime(o) + Math.max(0, ...((o.variants ?? []).map((v: any) => v.priceDeltaMinor ?? 0))) > 0;

/** A plan a device can be bought on a contract with: a plan without a device of its own. */
export const isPlan = (o: any) => { const b = behaviourOf(o); return !!b.service && b.role === 'PLAN' && !b.goods; };

export const newItem = (offer: any): Item => ({
  key: `${offer.id}-${Math.random().toString(36).slice(2, 8)}`, offer, quantity: 1, msisdn: '',
  variantId: offer.variants?.[0]?.id, payMode: 'UPFRONT', months: Math.min(12, offer.contract?.termMonths || 12), down: '',
});

/** The request the quote and the order are built from. */
export function lineBody(i: Item, all: Item[] = []) {
  const plan = i.deal ? all.findIndex((x) => x.key === i.deal!.planKey) : -1;
  return {
    ...(i.deal && plan >= 0 ? { attachTo: plan, dealTermMonths: i.deal.term } : {}),
    offerId: i.offer.id, quantity: i.quantity, msisdn: i.msisdn || undefined,
    options: i.variantId ? { variantId: i.variantId } : undefined,
    payment: i.payMode === 'INSTALLMENT' ? { mode: 'INSTALLMENT' as const, months: i.months, downPaymentMinor: i.down ? toMinor(i.down) : 0 } : undefined,
  };
}

/** Plain-language names for common device colours, so swatches are a real colour rather than a guess. */
export const SWATCH: Record<string, string> = {
  black: '#1d1d1f', 'space black': '#2c2c2e', graphite: '#4a4a4c', grey: '#8e8e93', gray: '#8e8e93', silver: '#d1d1d6', white: '#f5f5f7', starlight: '#f0e6d3',
  gold: '#e3c8a0', 'rose gold': '#e8b4b8', pink: '#f4a7b9', red: '#e03a3e', orange: '#f5841f', yellow: '#fdd835', green: '#4caf50', blue: '#3a7bd5', 'sierra blue': '#9bb5ce', purple: '#8e6bbf', titanium: '#9a9a96',
};
