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

export interface TemplateInfo {
  label: string;
  summary: string;
  /** The service created when the order completes (null: nothing is created, it is a one-off sale). */
  service: 'MOBILE' | 'FIBER' | 'IOT' | 'SUBSCRIPTION' | null;
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
  /** Where it appears when an order is taken: the main plan or product, an add-on, or goods. */
  role: 'PLAN' | 'ADDON' | 'GOODS';
  /** Fulfilment mechanics suggested when the offer is created. */
  defaults: FulfilmentMechanic[];
}

export const TEMPLATES: Record<OfferTemplate, TemplateInfo> = {
  SIM_ONLY: { label: 'SIM-only plan', summary: 'A mobile plan with a SIM and no device. Creates a mobile service.', service: 'MOBILE', goods: false, contract: 'optional', role: 'PLAN', defaults: ['SIM'] },
  SIM_DEVICE: { label: 'Plan with a device', summary: 'A mobile plan sold with a phone, usually on contract. Creates a mobile service once the phone is delivered.', service: 'MOBILE', goods: true, contract: 'optional', role: 'PLAN', defaults: ['SHIP', 'SIM'] },
  WEARABLE: { label: 'Wearable', summary: 'A connected watch or band. With a monthly fee it creates a service; without one it is just goods.', service: 'MOBILE', serviceNeedsFee: true, goods: true, contract: 'optional', role: 'PLAN', defaults: ['SHIP'] },
  FIBER: { label: 'Fibre broadband', summary: 'Home fibre. Needs an installation visit, and creates the service when the installation is done.', service: 'FIBER', goods: false, contract: 'optional', needsInstallation: true, role: 'PLAN', defaults: ['INSTALL'] },
  IOT_CONNECTIVITY: { label: 'IoT connectivity', summary: 'Connectivity for connected devices, often bought in bulk. Creates one IoT service per device.', service: 'IOT', goods: false, contract: 'optional', role: 'PLAN', defaults: ['SIM'] },
  VAS: { label: 'Add-on', summary: 'An extra on top of a plan (roaming, extra data, device care). Creates a subscription.', service: 'SUBSCRIPTION', goods: false, contract: 'optional', role: 'ADDON', defaults: [] },
  NON_TELCO_SUBSCRIPTION: { label: 'Partner subscription', summary: 'A partner’s service (streaming, music…) billed with the plan. Needs the partner’s code.', service: 'SUBSCRIPTION', goods: false, contract: 'optional', needsPartner: true, role: 'ADDON', defaults: [] },
  PHYSICAL_GOOD: { label: 'Outright goods', summary: 'A device or appliance sold outright, with no service and no contract.', service: null, goods: true, outright: true, contract: 'none', role: 'GOODS', defaults: ['SHIP'] },
};

/** The template an offer behaves like: stored on the offer when it is saved; for older offers the type is the template. */
export const templateOf = (o: { kind?: string | null; template?: string | null }): OfferTemplate => {
  const t = (o.template ?? o.kind ?? '') as OfferTemplate;
  return t in TEMPLATES ? t : 'VAS';
};
export const behaviourOf = (o: { kind?: string | null; template?: string | null }): TemplateInfo => TEMPLATES[templateOf(o)];
