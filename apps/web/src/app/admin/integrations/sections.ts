/**
 * The Integration area, organised the way people think about it rather than the way the code is built:
 *   1. the systems Meridian connects TO (network, payments, identity and credit, field service, messaging), each with its status and its connection details together;
 *   2. the channels and partners that connect to Meridian (store-front, API access, inbound callbacks);
 *   3. the events Meridian shares with others (webhooks, event streams and subscriptions, the delivery queue);
 *   4. the platform underneath.
 * Every section is one entry here. `groups` names the integration registry groups (packages/core/src/integrations.ts) the section shows.
 */
export interface IntegrationSection {
  id: string; group: string; label: string; description: string; keywords: string;
  /** Registry groups shown as system cards. */
  groups?: string[];
}

export const GROUPS = ['Start here', 'Systems Meridian connects to', 'Channels and partners', 'Events Meridian shares', 'Platform'] as const;

export const SECTIONS: IntegrationSection[] = [
  { id: 'overview', group: 'Start here', label: 'Overview', description: 'What works, what needs setup, what is failing', keywords: 'overview health status attention failing needs setup summary dashboard' },

  { id: 'network', group: 'Systems Meridian connects to', label: 'Network, numbers and charging', description: 'HLR/HSS, UDM, policy, eSIM, SIM files, number porting, the charging system', groups: ['Network, numbers and charging'],
    keywords: 'network hlr hss udm pcrf pcf provisioning esim sm-dp+ smdp sim iccid imsi msisdn number porting mnp port-in port-out donor ocs charging rating diameter gy chf online charging barring' },
  { id: 'payments', group: 'Systems Meridian connects to', label: 'Payments and finance', description: 'Card and QR payments, SAP ledger export, ledger events, dealer payouts', groups: ['Payments and finance'],
    keywords: 'payment stripe card qr duitnow promptpay qris gateway terminal webhook sap general ledger journal export idoc fico ledger billing events commission payout bank finance' },
  { id: 'identity', group: 'Systems Meridian connects to', label: 'Identity, credit and collections', description: 'ID verification, the credit bureau, collections agencies', groups: ['Identity, credit and collections'],
    keywords: 'identity ekyc kyc verification id document credit bureau score check device financing upfront collections agency debt write off' },
  { id: 'field', group: 'Systems Meridian connects to', label: 'Field service and logistics', description: 'Technician dispatch, installation, couriers, warehouses', groups: ['Field service and logistics'],
    keywords: 'field service workforce wfm dispatch technician installation appointment slot courier delivery tracking warehouse stock files logistics' },
  { id: 'signin', group: 'Systems Meridian connects to', label: 'Sign-in and identity', description: 'Single sign-on, the company directory, and the SMS or WhatsApp gateway for one-time codes', groups: ['Sign-in and identity'],
    keywords: 'sso single sign-on saml oidc openid connect entra azure ad okta ping keycloak ldap active directory identity provider login authentication sms whatsapp otp one-time code 2fa mfa gateway' },
  { id: 'messaging', group: 'Systems Meridian connects to', label: 'Customer messaging', description: 'SMS, email and push notifications', groups: ['Customer messaging'], keywords: 'sms email push notification message whatsapp gateway template' },

  { id: 'storefront', group: 'Channels and partners', label: 'Online store-front', description: 'The self-serve shop and its access to Meridian', groups: ['Online store-front'], keywords: 'store front storefront shop online self serve api key kyc stripe checkout' },
  { id: 'api-access', group: 'Channels and partners', label: 'API access', description: 'Who may call Meridian’s APIs, with what rights and how often', keywords: 'api oauth client credentials token api key scope rate limit throttle idempotency call log audit subscriber operations sim swap otp northbound partner channel' },
  { id: 'callbacks', group: 'Channels and partners', label: 'Inbound callbacks', description: 'Keys that prove a callback from a payment provider, courier or dealer is genuine', keywords: 'inbound webhook callback verification key hmac signature payment courier dealer provider secret' },

  { id: 'webhooks', group: 'Events Meridian shares', label: 'Webhooks', description: 'Addresses Meridian posts events to, signed and retried', keywords: 'outbound webhook partner callback event hmac bearer retry backoff signed' },
  { id: 'streams', group: 'Events Meridian shares', label: 'Event streams and subscriptions', description: 'The event bus, topics, and systems subscribed through TM Forum 688', groups: ['Events and streaming'], keywords: 'event bus kafka topic stream tmf 688 tmf688 subscription listener hub notification mapping' },
  { id: 'deliveries', group: 'Events Meridian shares', label: 'Delivery queue', description: 'Every event on its way out, and any that failed', keywords: 'delivery queue failed retry dispatch event log pending outbox' },

  { id: 'platform', group: 'Platform', label: 'Platform and keys', description: 'Database, workflow engine, scheduler, outbox, and the keys that protect data', groups: ['Platform'], keywords: 'platform database postgres temporal workflow scheduler cron outbox mongodb secrets keys pepper data key encryption infrastructure' },
];

export const sectionById = (id: string | null | undefined) => SECTIONS.find((s) => s.id === id);
export function searchSections(q: string): IntegrationSection[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return SECTIONS;
  return SECTIONS.filter((s) => words.every((w) => `${s.label} ${s.description} ${s.group} ${s.keywords}`.toLowerCase().includes(w)));
}
