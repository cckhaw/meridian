/**
 * What an offer type DOES is decided by the behaviour template it was built on, not by its name. Operators can add, rename and switch off
 * offer types in Settings (Catalog → Offer types), but every type is based on one of these templates, so the platform always knows how to
 * sell, fulfil and bill it. The eight built-in types use the template of the same name.
 */
export const OFFER_TEMPLATES = ['SIM_ONLY', 'SIM_DEVICE', 'WEARABLE', 'FIBER', 'IOT_CONNECTIVITY', 'VAS', 'NON_TELCO_SUBSCRIPTION', 'PHYSICAL_GOOD'] as const;
export type OfferTemplate = (typeof OFFER_TEMPLATES)[number];

export type FulfilmentMechanic = 'SHIP' | 'COLLECT' | 'INSTALL' | 'SIM';
export const FULFILMENT_MECHANICS: Array<{ id: FulfilmentMechanic; label: string; summary: string }> = [
  { id: 'SHIP', label: 'Delivered to the customer', summary: 'Posted or couriered. The order cannot be cancelled once it ships.' },
  { id: 'COLLECT', label: 'Collected in store', summary: 'The customer picks it up at a store they choose. It can be cancelled until it is collected.' },
  { id: 'INSTALL', label: 'Installed by a technician', summary: 'A visit is booked. The order cannot be cancelled once the technician is dispatched.' },
  { id: 'SIM', label: 'SIM activation', summary: 'A SIM is issued and switched on. Turn on stock tracking if you count SIM cards in inventory.' },
];

/** The kinds of service the platform ships with. Operators can define more (Settings → Catalog → Service kinds); an offer's `service` is one of these or such an id. */
export const BUILTIN_SERVICE_KINDS = ['MOBILE', 'FIBER', 'IOT', 'SUBSCRIPTION'] as const;
export type ServiceKindId = string;
export const ORDER_STEPS = ['PLAN', 'DEVICE', 'ADDON'] as const;
export type OrderStep = (typeof ORDER_STEPS)[number];
export const ORDER_STEP_LABEL: Record<OrderStep, string> = { PLAN: 'Plan or product (step 1)', DEVICE: 'Device (step 2)', ADDON: 'Add-ons (step 3)' };

export interface TemplateInfo {
  label: string;
  summary: string;
  /** The service created when the order completes (null: nothing is created, it is a one-off sale). */
  service: ServiceKindId | null;
  /** A service is created only if the offer has a monthly fee (a wearable without one is just goods). */
  serviceNeedsFee?: boolean;
  /** Includes a physical item (phone, watch, router…), so it ships or is collected and may have colours and storage. */
  goods: boolean;
  /** Sold outright: no contract, not financed, and may be rung up as a quick sale. */
  outright?: boolean;
  /** Whether a contract term is offered. */
  contract: 'none' | 'optional';
  needsPartner?: boolean;
  needsInstallation?: boolean;
  /** Where it appears when an order is taken: the main plan or product, an add-on, or goods. Worked out from `steps`. */
  role: 'PLAN' | 'ADDON' | 'GOODS';
  /** The steps of the order wizard it can be chosen in: 1 Plan or product, 2 Device, 3 Add-ons. */
  steps: OrderStep[];
  /** Only one of this kind of offer fits an order (a mobile plan: other lines join it as members or are added as add-ons). */
  exclusive?: boolean;
  /** Fulfilment mechanics suggested when the offer is created. */
  defaults: FulfilmentMechanic[];
}

export const TEMPLATES: Record<OfferTemplate, TemplateInfo> = {
  SIM_ONLY: { label: 'SIM-only plan', summary: 'A mobile plan with a SIM and no device. Creates a mobile service.', service: 'MOBILE', goods: false, contract: 'optional', role: 'PLAN', steps: ['PLAN'], exclusive: true, defaults: ['SIM'] },
  SIM_DEVICE: { label: 'Plan with a device', summary: 'A mobile plan sold with a phone, usually on contract. Creates a mobile service once the phone is delivered.', service: 'MOBILE', goods: true, contract: 'optional', role: 'PLAN', steps: ['PLAN'], exclusive: true, defaults: ['SHIP', 'SIM'] },
  WEARABLE: { label: 'Wearable', summary: 'A connected watch or band. With a monthly fee it creates a service; without one it is just goods.', service: 'MOBILE', serviceNeedsFee: true, goods: true, contract: 'optional', role: 'PLAN', steps: ['PLAN', 'DEVICE'], defaults: ['SHIP'] },
  FIBER: { label: 'Fibre broadband', summary: 'Home fibre. Needs an installation visit, and creates the service when the installation is done.', service: 'FIBER', goods: false, contract: 'optional', needsInstallation: true, role: 'PLAN', steps: ['PLAN'], defaults: ['INSTALL'] },
  IOT_CONNECTIVITY: { label: 'IoT connectivity', summary: 'Connectivity for connected devices, often bought in bulk. Creates one IoT service per device.', service: 'IOT', goods: false, contract: 'optional', role: 'PLAN', steps: ['PLAN'], defaults: ['SIM'] },
  VAS: { label: 'Add-on', summary: 'An extra on top of a plan (roaming, extra data, device care). Creates a subscription.', service: 'SUBSCRIPTION', goods: false, contract: 'optional', role: 'ADDON', steps: ['ADDON'], defaults: [] },
  NON_TELCO_SUBSCRIPTION: { label: 'Partner subscription', summary: 'A partner’s service (streaming, music…) billed with the plan. Needs the partner’s code.', service: 'SUBSCRIPTION', goods: false, contract: 'optional', needsPartner: true, role: 'ADDON', steps: ['ADDON'], defaults: [] },
  PHYSICAL_GOOD: { label: 'Outright goods', summary: 'A device or appliance sold outright, with no service and no contract.', service: null, goods: true, outright: true, contract: 'none', role: 'GOODS', steps: ['DEVICE'], defaults: ['SHIP'] },
};

/** The template an offer behaves like: stored on the offer when it is saved; for older offers the type is the template. */
export const templateOf = (o: { kind?: string | null; template?: string | null }): OfferTemplate => {
  const t = (o.template ?? o.kind ?? '') as OfferTemplate;
  return t in TEMPLATES ? t : 'VAS';
};

/** What a type's switches are: the behaviour fields an operator sets (the label and summary belong to the type, not to what it does). */
export type BehaviourSwitches = Pick<TemplateInfo, 'service' | 'serviceNeedsFee' | 'goods' | 'outright' | 'contract' | 'needsPartner' | 'needsInstallation' | 'steps' | 'exclusive'>;
export const switchesOf = (b: TemplateInfo): BehaviourSwitches => ({ service: b.service, serviceNeedsFee: !!b.serviceNeedsFee, goods: b.goods, outright: !!b.outright, contract: b.contract, needsPartner: !!b.needsPartner, needsInstallation: !!b.needsInstallation, steps: [...b.steps], exclusive: !!b.exclusive });
/** Where an offer with these steps counts as sitting: a plan if it is picked in step 1, goods if in step 2 only, otherwise an add-on. */
export const roleOfSteps = (steps: OrderStep[]): TemplateInfo['role'] => (steps.includes('PLAN') ? 'PLAN' : steps.includes('DEVICE') ? 'GOODS' : 'ADDON');

/** Problems with a set of switches, in plain words: combinations the order engine cannot sell. Empty = fine. */
export function switchProblems(b: BehaviourSwitches): string[] {
  const out: string[] = [];
  if (!Array.isArray(b.steps) || b.steps.length === 0 || b.steps.some((x) => !(ORDER_STEPS as readonly string[]).includes(x))) out.push('Choose at least one step of the order where this is picked.');
  if (b.service !== null && !/^[A-Z][A-Z0-9_]{1,31}$/.test(b.service)) out.push('The service it creates is not a valid service kind.');
  if (!b.service && !b.goods) out.push('It must create a service or include a physical item, otherwise there is nothing to sell.');
  if (b.serviceNeedsFee && !b.service) out.push('“Service only with a monthly fee” needs a service.');
  if (b.outright && (b.service || !b.goods)) out.push('Outright goods are a physical item with no service.');
  if (b.outright && b.contract !== 'none') out.push('Outright goods have no contract.');
  if (b.needsInstallation && !b.service) out.push('An installation visit is for a service: choose the service it sets up.');
  if (b.exclusive && !b.steps.includes('PLAN')) out.push('“Only one per order” applies to what is picked in step 1.');
  return out;
}

/** One sentence on what a set of switches does, for the offer type screens. */
export function describeSwitches(b: BehaviourSwitches, serviceName: (id: string) => string = (id) => id.toLowerCase()): string {
  const parts: string[] = [];
  if (b.service) parts.push(`Creates ${b.serviceNeedsFee ? 'a ' + serviceName(b.service) + ' service when it has a monthly fee' : 'a ' + serviceName(b.service) + ' service'}`);
  else parts.push('Creates no service');
  if (b.goods) parts.push(b.outright ? 'sold outright as a physical item' : 'includes a physical item');
  if (b.contract === 'optional' && !b.outright) parts.push('can be on a contract');
  if (b.needsInstallation) parts.push('needs an installation visit');
  if (b.needsPartner) parts.push('needs the partner’s code');
  parts.push(`picked in ${b.steps.map((x) => ({ PLAN: 'step 1', DEVICE: 'step 2', ADDON: 'step 3' })[x]).join(' and ')}`);
  if (b.exclusive) parts.push('one per order');
  return parts.join(', ') + '.';
}

/**
 * How an offer behaves: the switches stored on it when it was saved (`behaviour`), falling back to its template for offers saved before types had switches.
 * Because the offer carries its own switches, the order engine never has to look a type up.
 */
export const behaviourOf = (o: { kind?: string | null; template?: string | null; behaviour?: Partial<BehaviourSwitches> | null }): TemplateInfo => {
  const base = TEMPLATES[templateOf(o)];
  const own = o.behaviour;
  if (!own) return base;
  const steps = Array.isArray(own.steps) && own.steps.length ? own.steps : base.steps;
  return { ...base, ...own, steps, role: roleOfSteps(steps), defaults: base.defaults } as TemplateInfo;
};
