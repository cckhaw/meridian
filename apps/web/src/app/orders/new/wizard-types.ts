import { behaviourOf } from '@meridian/types';
import { toMinor } from '@/lib/format';

export type StepId = 'product' | 'device' | 'addons' | 'family' | 'sim' | 'payment' | 'customer' | 'delivery' | 'review' | 'pay';
export const STEP_TITLE: Record<StepId, string> = {
  product: 'Plan or product', device: 'Device', addons: 'Add-ons', family: 'Family members', sim: 'SIM and number', payment: 'How to pay', customer: 'Customer', delivery: 'Delivery and installation', review: 'Review', pay: 'Payment',
};
export const STEP_HINT: Record<StepId, string> = {
  product: 'What is the customer buying?', device: 'Pick the colour and storage, or add a device.', addons: 'Extras this customer can add, and bundle savings.', family: 'The lines that share this plan: new numbers, or numbers brought from another operator.', sim: 'Hand over a SIM card (or issue an eSIM) and choose the number.',
  payment: 'Pay each item in full today, or spread it over the contract.', customer: 'Who is this for? Look them up by ID, or create them.', delivery: 'Where to send things, and when the technician can come.',
  review: 'Check everything before it is submitted.', pay: 'Take payment and submit the order.',
};

/** A number brought from another operator: the donor's details, and whether to give a temporary number from our pool meanwhile. */
export interface PortInForm { donorOperatorId: string; donorMsisdn: string; holderName: string; holderIdType: string; holderIdNumber: string; temporaryNumber: boolean }
export const emptyPortIn = (): PortInForm => ({ donorOperatorId: '', donorMsisdn: '', holderName: '', holderIdType: 'NATIONAL_ID', holderIdNumber: '', temporaryNumber: true });
export const portInReady = (p?: PortInForm | null) => !p || (!!p.donorOperatorId && p.donorMsisdn.replace(/\D/g, '').length >= 8 && !!p.holderName.trim() && !!p.holderIdNumber.trim());
const portInBody = (p?: PortInForm | null) => (p ? { ...p, donorMsisdn: p.donorMsisdn.replace(/[^\d+]/g, '') } : undefined);

/** The number a line holds while it is being sold: held for the customer (a chosen number), or left to the pool. */
export interface NumberHolder { msisdn: string; numberToken?: string; numberTier?: string; numberFeeMinor?: number; numberExpires?: string }
/** A member line of a group plan, taken together with the head's line. */
export interface Member extends NumberHolder { key: string; offerId: string; simType: '' | 'PHYSICAL' | 'ESIM'; portIn?: PortInForm | null }
export const newMember = (offerId: string): Member => ({ key: Math.random().toString(36).slice(2, 8), offerId, simType: 'PHYSICAL', msisdn: '' });
export const isGroupPlan = (o: any) => !!o?.group?.isGroupOffer;

export interface Item {
  key: string; offer: any; quantity: number; msisdn: string; variantId?: string;
  /** The SIM for a plan that needs one: a card's ICCID, or `simType` alone (next free card, or a fresh eSIM). `numberToken` is the hold on a chosen number. */
  iccid?: string; simType?: '' | 'PHYSICAL' | 'ESIM'; numberToken?: string; numberTier?: string; numberFeeMinor?: number; numberExpires?: string;
  payMode: 'UPFRONT' | 'INSTALLMENT'; months: number; down: string;
  /** A number brought from another operator for this line, instead of one from our pool. */
  portIn?: PortInForm | null;
  /** A group plan: its member lines. */
  members?: Member[];
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

/** The quote lists a group plan's member lines right after it, so an item's own line is further down once earlier items have members. */
export const quoteIndex = (items: Item[], k: number) => items.slice(0, k).reduce((n, x) => n + (isGroupPlan(x.offer) ? (x.members ?? []).filter((m) => m.offerId).length : 0), k);

/** What was chosen for each quote line (members included), in the quote's order, so the review can show the SIM and number beside the price. */
export const flatLines = (items: Item[]): Array<{ iccid?: string; simType?: string; msisdn?: string; portIn?: PortInForm | null }> =>
  items.flatMap((i) => [i, ...(isGroupPlan(i.offer) ? (i.members ?? []).filter((m) => m.offerId) : [])]);

/** The request the quote and the order are built from. */
export function lineBody(i: Item, all: Item[] = []) {
  const plan = i.deal ? all.findIndex((x) => x.key === i.deal!.planKey) : -1;
  return {
    ...(i.deal && plan >= 0 ? { attachTo: plan, dealTermMonths: i.deal.term } : {}),
    offerId: i.offer.id, quantity: i.quantity, msisdn: i.portIn ? undefined : i.msisdn || undefined, portIn: portInBody(i.portIn),
    members: isGroupPlan(i.offer) ? (i.members ?? []).filter((m) => m.offerId).map((m) => ({ offerId: m.offerId, simType: m.simType || undefined, msisdn: m.portIn ? undefined : m.msisdn || undefined, numberToken: !m.portIn && m.msisdn && m.numberToken ? m.numberToken : undefined, portIn: portInBody(m.portIn) })) : undefined,
    iccid: i.iccid || undefined, simType: !i.iccid && i.simType ? i.simType : undefined, numberToken: i.msisdn && i.numberToken ? i.numberToken : undefined,
    options: i.variantId ? { variantId: i.variantId } : undefined,
    payment: i.payMode === 'INSTALLMENT' ? { mode: 'INSTALLMENT' as const, months: i.months, downPaymentMinor: i.down ? toMinor(i.down) : 0 } : undefined,
  };
}

/** Plain-language names for common device colours, so swatches are a real colour rather than a guess. */
export const SWATCH: Record<string, string> = {
  black: '#1d1d1f', 'space black': '#2c2c2e', graphite: '#4a4a4c', grey: '#8e8e93', gray: '#8e8e93', silver: '#d1d1d6', white: '#f5f5f7', starlight: '#f0e6d3',
  gold: '#e3c8a0', 'rose gold': '#e8b4b8', pink: '#f4a7b9', red: '#e03a3e', orange: '#f5841f', yellow: '#fdd835', green: '#4caf50', blue: '#3a7bd5', 'sierra blue': '#9bb5ce', purple: '#8e6bbf', titanium: '#9a9a96',
};
