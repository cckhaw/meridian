import type { Queryable } from './db.js';
import { emailCodesStatus, emailSenderStatus } from './email-gateway.js';
import { fiberStatus } from './fiber-client.js';
import { GATEWAYS } from './gateways.js';
import { getOcsSettings, ocsStats } from './ocs.js';
import { getWfmSettings } from './workforce.js';
import { WFM_VENDORS } from './wfm/index.js';
import { OCS_VENDORS } from './ocs-vendors/index.js';
import { getSapSettings } from './sap-exporter.js';
import { getStoreSettings } from './store-settings.js';

/**
 * Every place Meridian talks to another system, written down once. The Integration page is built from this list, so adding an integration
 * is one entry here: say what it is, how it connects, what the operator has to provide, and what Meridian can tell about its health.
 *
 * Nothing in this file returns a secret: environment variables are reported as set or not set, never by value.
 */
export type IntegrationGroup =
  | 'Network, numbers and charging' | 'Payments and finance' | 'Identity, credit and collections' | 'Field service and logistics' | 'Messaging' | 'Sign-in and identity' | 'Online store-front' | 'Events and streaming' | 'Platform';

export const INTEGRATION_GROUPS: IntegrationGroup[] = [
  'Network, numbers and charging', 'Payments and finance', 'Identity, credit and collections', 'Field service and logistics', 'Messaging', 'Sign-in and identity', 'Online store-front', 'Events and streaming', 'Platform',
];

/**
 * How far the Meridian side goes today:
 * BUILT         Meridian has a working connector or endpoint; it only needs configuring.
 * OUTBOX        Meridian writes instructions to the message outbox. A connector you deploy reads them and acknowledges them.
 * ENDPOINT      Meridian offers an API for the other system to call; nothing is sent from Meridian.
 * MANUAL        A person moves a file or types a reference. No connector exists yet.
 * STUB          The interface exists and a stand-in answers; a real connector replaces the stand-in.
 */
export type Maturity = 'BUILT' | 'OUTBOX' | 'ENDPOINT' | 'MANUAL' | 'STUB';

/** What Meridian can tell about this integration right now. */
export type IntegrationStatus =
  | 'CONNECTED'      // configured, or the other side has been seen acknowledging messages
  | 'NEEDS_SETUP'    // Meridian can do it, but a key, URL or setting is missing
  | 'LISTENING'      // Meridian offers an endpoint and waits for the other system to call it
  | 'WAITING'        // instructions are queued and nothing has acknowledged any yet
  | 'MANUAL'         // done by hand
  | 'STAND_IN'       // a stand-in answers, no real system
  | 'REMOTE';        // configured on another deployment (store-front, order service, catalog service), which this page cannot see

export interface EnvVar { name: string; purpose: string; /** The deployment it is set on. */ on: 'web' | 'storefront' | 'order-service' | 'catalog-service'; required?: boolean; secret?: boolean }
export interface Endpoint { method: 'GET' | 'POST' | 'PATCH'; path: string; purpose: string; auth: string }
export interface OutboxUse { kind: 'NETWORK' | 'NOTIFY' | 'COLLECTIONS' | 'GL' | 'EVENT'; instructions: string[] }

export interface IntegrationDef {
  id: string;
  group: IntegrationGroup;
  name: string;
  /** Who it connects to, in the operator's words. */
  with: string;
  summary: string;
  maturity: Maturity;
  /** What flows, from Meridian's point of view. */
  direction: 'OUT' | 'IN' | 'BOTH';
  env?: EnvVar[];
  /** Endpoints the other system calls (inbound), or Meridian-hosted ones a connector uses. */
  endpoints?: Endpoint[];
  outbox?: OutboxUse;
  /** What the operator has to provide or do to finish it. */
  needs: string[];
  /** Where in the portal its settings live. */
  configure?: { label: string; href: string };
  doc?: string;
  keywords?: string;
}

const NET = (instructions: string[]): OutboxUse => ({ kind: 'NETWORK', instructions });
const POLL: Endpoint[] = [
  { method: 'GET', path: '/api/lifecycle/outbox?pending=1', purpose: 'Read the instructions waiting to be delivered', auth: 'Service account with billing:run' },
  { method: 'POST', path: '/api/lifecycle/outbox/ack', purpose: 'Acknowledge the ones delivered: { "ids": ["…"] }', auth: 'Service account with billing:run' },
];

export const INTEGRATIONS: IntegrationDef[] = [
  // ───────────── Online store-front ─────────────
  {
    id: 'storefront', group: 'Online store-front', name: 'Online store-front', with: 'The self-serve web shop (apps/storefront) and any other client you build',
    summary: 'Customers browse, sign up, verify identity and pay on the store-front. It reaches Meridian only through the store API, with an API key. Its API keys, terms links and sign-up retention are managed here. Payment and identity verification have their own cards, because they apply to the CRM as well.',
    maturity: 'BUILT', direction: 'BOTH',
    env: [
      { name: 'MERIDIAN_API_URL', purpose: 'Base address of this portal, for example https://crm.example.com', on: 'storefront', required: true },
      { name: 'MERIDIAN_API_KEY', purpose: 'An API key issued below; sent as a Bearer token', on: 'storefront', required: true, secret: true },
    ],
    endpoints: [
      { method: 'GET', path: '/api/store/config', purpose: 'Store rules, terms and the payment gateways on offer', auth: 'API key' },
      { method: 'GET', path: '/api/store/catalog', purpose: 'Offers sold online', auth: 'API key' },
      { method: 'POST', path: '/api/store/quote', purpose: 'Price a basket', auth: 'API key' },
      { method: 'POST', path: '/api/store/applications', purpose: 'Start an application; then documents, KYC, checkout and payment under /api/store/applications/:id', auth: 'API key + application token' },
    ],
    needs: ['Issue an API key below and set MERIDIAN_API_URL and MERIDIAN_API_KEY on the store-front deployment', 'Set the terms and privacy links'],
    configure: { label: 'API keys and terms', href: '/admin/integrations?item=storefront' }, doc: 'STOREFRONT.md', keywords: 'store front storefront shop web api key self serve online',
  },

  // ───────────── Payments ─────────────
  {
    id: 'stripe', group: 'Payments and finance', name: 'Stripe', with: 'Stripe (card payments for the store-front and the CRM)',
    summary: 'In the store-front the customer pays by card in the browser. In the CRM, staff send the customer a Stripe payment link from the order and the customer pays on their own phone. Either way the order is confirmed only by Stripe’s signed webhook, and card numbers never reach Meridian. You choose below where Stripe is used: store-front, CRM or both.',
    maturity: 'BUILT', direction: 'BOTH',
    env: [
      { name: 'MERIDIAN_STRIPE_SECRET_KEY', purpose: 'Secret key (sk_live_… or sk_test_…)', on: 'web', required: true, secret: true },
      { name: 'MERIDIAN_STRIPE_PUBLISHABLE_KEY', purpose: 'Publishable key (pk_…), shown to the store-front', on: 'web', required: true },
      { name: 'MERIDIAN_STRIPE_WEBHOOK_SECRET', purpose: 'Signing secret of the webhook endpoint (whsec_…)', on: 'web', required: true, secret: true },
    ],
    endpoints: [{ method: 'POST', path: '/api/webhooks/gateway/stripe', purpose: 'Stripe calls this: payment_intent.succeeded, payment_intent.payment_failed and checkout.session.completed', auth: 'Stripe signature' }],
    needs: ['Set the three keys on the web deployment', 'In Stripe, add the webhook endpoint above', 'Switch Stripe on for the store-front, the CRM or both (below)'],
    configure: { label: 'Where Stripe is used', href: '/admin/integrations?item=stripe' }, doc: 'STOREFRONT.md', keywords: 'stripe card payment gateway online pay',
  },
  {
    id: 'payment-webhook', group: 'Payments and finance', name: 'Payment provider webhook and terminals', with: 'A payment provider, bank terminal or QR scheme that confirms payments',
    summary: 'For any provider other than Stripe: it calls a signed webhook when a payment succeeds. Without it (manual mode), staff record the terminal’s approval or receipt number by hand.',
    maturity: 'ENDPOINT', direction: 'IN',
    env: [
      { name: 'MERIDIAN_PAYMENT_MODE', purpose: 'manual (staff record payments) or simulated (development only)', on: 'web' },
      { name: 'MERIDIAN_PAYMENT_WEBHOOK_SECRET', purpose: 'Signs webhook calls (HMAC-SHA256, 16+ characters). Unset: the endpoint is off', on: 'web', required: true, secret: true },
    ],
    endpoints: [{ method: 'POST', path: '/api/webhooks/payment', purpose: 'Confirm a payment by reference; replays are harmless', auth: 'x-meridian-signature: sha256=<hmac of the body>' }],
    needs: ['Set MERIDIAN_PAYMENT_WEBHOOK_SECRET', 'Have the provider’s integration call the endpoint (see docs/OPERATIONS.md for the body)', 'Never run in simulated mode in production'],
    doc: 'OPERATIONS.md', keywords: 'payment webhook terminal qr bank provider confirm',
  },

  // ───────────── Network and SIM provisioning ─────────────
  {
    id: 'ocs', group: 'Network, numbers and charging', name: 'Charging system (OCS)', with: 'Your real-time rating and charging system (voice, SMS and data)',
    summary: 'When a plan that has an OCS plan code starts, changes plan, is barred or restored, gets a new SIM or number, or ends, Meridian queues a vendor-neutral command and a connector for your OCS vendor delivers it: create the subscriber, subscribe the plan, and so on. Each vendor has its own connector, so Meridian does not depend on any one OCS. Jobs for a subscriber are delivered in order and retried when the OCS is down; one that cannot be delivered is kept for you to retry.',
    maturity: 'BUILT', direction: 'OUT',
    env: [{ name: 'MERIDIAN_OCS_TOKEN', purpose: 'Token for the generic REST connector (the name is yours to choose; it must start with MERIDIAN_OCS_)', on: 'web', secret: true }],
    endpoints: [{ method: 'POST', path: '/api/ocs/dispatch', purpose: 'Delivers due jobs to the OCS. Schedule it every minute', auth: 'Service account with billing:run' }],
    needs: ['Choose the connector for your OCS below (Generic REST needs no code; another vendor gets its own connector file)', 'Give each plan its OCS plan code in the catalog', 'Schedule POST /api/ocs/dispatch every minute', 'Services that started before the OCS was switched on are not sent'],
    doc: 'OCS.md', keywords: 'ocs charging rating real time online voice sms data subscriber provisioning huawei ericsson amdocs oracle optiva vendor connector plan',
  },
  {
    id: 'wfm', group: 'Field service and logistics', name: 'Field service (workforce management)', with: 'Your field-service system: Salesforce Field Service, Oracle Field Service Cloud, TOA, or a partner’s dispatch tool',
    summary: 'When a fault needs a technician, an agent asks the system which windows are free for the skills the issue needs, holds one while on the call, and turns it into a job. The system reports the visit (assigned, on the way, on site, done, customer not at home, needs another time) by calling Meridian’s signed callback address, and Meridian moves the case and tells the customer by SMS or WhatsApp.',
    maturity: 'BUILT', direction: 'BOTH',
    env: [{ name: 'MERIDIAN_WFM_WEBHOOK_SECRET', purpose: 'The secret the field-service system signs its callbacks with (at least 16 characters; the name is set in the field-service connection below)', on: 'web', secret: true }, { name: 'MERIDIAN_WFM_TOKEN', purpose: 'Token for the REST connector (the name is yours to choose; it must start with MERIDIAN_WFM_)', on: 'web', secret: true }],
    endpoints: [{ method: 'POST', path: '/api/v1/cases/webhooks/wfm-callback', purpose: 'The field-service system reports a visit. Signed with X-WFM-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">', auth: 'HMAC signature' }, { method: 'POST', path: '/api/cases/sla-sweep', purpose: 'Also delivers queued cancellations to the system. Schedule it every minute', auth: 'Service account with case:supervise' }],
    needs: ['Choose the system in the field-service connection below and switch it on (the REST contract needs no code; the simulator is for trying it out)', 'Set the environment variable named there (MERIDIAN_WFM_WEBHOOK_SECRET unless you rename it) and give the same secret to the field-service system', 'Have the system call the callback address listed below as the technician’s app reports', 'Give each issue type that needs a technician its skills and equipment (Settings → Cases)'],
    doc: 'CASES.md', keywords: 'wfm field service workforce technician truck roll dispatch appointment slot visit salesforce toa oracle engineer callback webhook',
  },
  {
    id: 'network-provisioning', group: 'Network, numbers and charging', name: 'Network provisioning (HLR/HSS, policy control)', with: 'The core network: HLR/HSS, PCRF/PCF, plus any platform you name on a service kind',
    summary: 'When a service is barred, restored, changes plan or number, or ends, Meridian queues an instruction in the same transaction as the change; for service types that are set to tell the network when they start (your own types by default, built-in ones when you switch it on) it also queues the start. A connector you deploy delivers it to the network and acknowledges it. (Charging-system provisioning has its own card above.)',
    maturity: 'OUTBOX', direction: 'OUT',
    outbox: NET(['PROVISION', 'DEPROVISION', 'PLAN_CHANGE', 'MSISDN_SWAP', 'ACTIVATE_PORTED_IN', 'THROTTLE_DATA', 'BAR_OUTGOING', 'BAR_ALL', 'RESTORE']), endpoints: POLL,
    needs: ['Build or buy an adapter that reads the outbox and talks to your HLR/HSS and PCRF', 'Authenticate it as a service account with billing:run', 'For each service type (Mobile, Fibre, IoT, Subscription and your own) you set the systems and the start and end instructions in Settings → Service types'],
    configure: { label: 'Service types (systems and instructions)', href: '/admin/settings?section=service-types' }, doc: 'LIFECYCLE.md', keywords: 'hlr hss pcrf pcf provisioning network activate bar restore sim core',
  },
  {
    id: 'esim', group: 'Network, numbers and charging', name: 'eSIM profile server (SM-DP+)', with: 'Your SM-DP+ (GSMA eSIM profile server)',
    summary: 'Creating an eSIM profile reserves an ICCID and IMSI and asks the SM-DP+ for the activation code. Today a stand-in generates a sample code; the real server replaces it behind the same one-method interface.',
    maturity: 'STUB', direction: 'OUT',
    needs: ['Implement createProfile({ iccid, imsi }) against your SM-DP+ (ES2+ interface)', 'Pass it where eSIM profiles are issued (nrm-pools.ts: issueEsimProfile)'],
    configure: { label: 'Numbers & SIMs', href: '/numbering' }, doc: 'NUMBERING.md', keywords: 'esim sm-dp+ smdp profile activation code lpa',
  },
  {
    id: 'sim-supplier', group: 'Network, numbers and charging', name: 'SIM and number batch files', with: 'Your SIM vendor (ICCID, IMSI, eSIM codes) and your numbering plan',
    summary: 'SIM batches and number ranges arrive as files from the vendor and the regulator. Staff check and load them as CSV; nothing is fetched automatically.',
    maturity: 'MANUAL', direction: 'IN',
    needs: ['Ask the vendor for the batch file in the CSV layout of the template', 'Load it in Numbers & SIMs (check first, then load)'],
    configure: { label: 'Numbers & SIMs', href: '/numbering' }, doc: 'NUMBERING.md', keywords: 'sim vendor batch iccid imsi msisdn range import csv',
  },

  // ───────────── Number portability ─────────────
  {
    id: 'mnp-port-in', group: 'Network, numbers and charging', name: 'Port-in (numbers coming to us)', with: 'The national porting clearinghouse and the donor operators',
    summary: 'An order with a number to bring in files a port-in request. Meridian queues PORT_IN_REQUEST for the clearinghouse connector (or a Temporal workflow that does the same). The clearinghouse’s decision and completion come back through the MNP endpoints.',
    maturity: 'OUTBOX', direction: 'BOTH',
    outbox: NET(['PORT_IN_REQUEST']),
    endpoints: [
      { method: 'POST', path: '/api/mnp/port-in/:id/decision', purpose: 'Record the donor’s answer: { approved, reference, reason }', auth: 'Service account with mnp:manage' },
      { method: 'POST', path: '/api/mnp/port-in/:id/complete', purpose: 'The number has moved; the service takes it', auth: 'Service account with mnp:manage' },
      { method: 'POST', path: '/api/mnp/port-in/:id/cancel', purpose: 'Expire or withdraw the request', auth: 'Service account with mnp:manage' },
    ],
    needs: ['Keep the list of donor operators and their MNP operator IDs up to date (Settings → Donor operators)', 'Connect to the clearinghouse’s API (submit, decision, completion), or have staff work the Number porting screen', 'Swap the number on the HLR/HSS when the port completes'],
    configure: { label: 'Donor operators', href: '/admin/settings?section=donor-operators' }, doc: 'NUMBERING.md', keywords: 'mnp porting port in clearinghouse donor operator number portability',
  },
  {
    id: 'mnp-port-out', group: 'Network, numbers and charging', name: 'Port-out (numbers leaving us)', with: 'The national porting clearinghouse and the recipient operators',
    summary: 'Staff record a port-out request. When the clearinghouse confirms the number has moved, the confirmation call ends the service: final bill, early-termination charge, deposit refund and SIM release.',
    maturity: 'ENDPOINT', direction: 'IN',
    endpoints: [{ method: 'POST', path: '/api/mnp/port-out/confirmation', purpose: 'The clearinghouse confirmed the move: { serviceId or msisdn, reference }; safe to repeat', auth: 'Service account with mnp:manage' }],
    needs: ['Have the clearinghouse connector call the confirmation endpoint', 'Until then staff complete port-outs on the service screen'],
    configure: { label: 'Number porting', href: '/mnp' }, doc: 'LIFECYCLE.md', keywords: 'mnp port out porting code recipient clearinghouse',
  },

  // ───────────── Logistics ─────────────
  {
    id: 'courier', group: 'Field service and logistics', name: 'Courier and delivery tracking', with: 'Courier or last-mile delivery partner',
    summary: 'Staff mark an order shipped and type the tracking number; the order moves to Shipped and Delivered by hand. The order workflow’s shipGoods step is a stand-in that invents a tracking number. A courier connector would book the shipment and report status back.',
    maturity: 'MANUAL', direction: 'OUT',
    endpoints: [{ method: 'POST', path: '/api/orders/:id/actions', purpose: 'Actions ship ({ trackingNumber }), deliver, collect, return: a courier webhook handler calls these', auth: 'Service account with order permissions' }],
    needs: ['Choose the courier and get its shipment and tracking API', 'Build the connector: create the shipment when goods are ready; on delivery events call the order action'],
    configure: { label: 'Fulfilment options', href: '/admin/settings?section=fulfilment' }, doc: 'ORDERS.md', keywords: 'courier logistics delivery shipping tracking parcel last mile 3pl',
  },
  {
    id: 'installation', group: 'Field service and logistics', name: 'Installation and field service', with: 'Field-service or technician scheduling system',
    summary: 'Fibre and similar offers need an installation. Staff can always schedule it and mark it done in the order. Connect the field service system (the card above) and customers pick a live installation window while the order is taken, and the system’s callback marks the visit done.',
    maturity: 'MANUAL', direction: 'OUT',
    endpoints: [{ method: 'POST', path: '/api/orders/:id/actions', purpose: 'Actions schedule_installation, complete_installation', auth: 'Service account with order permissions' }],
    needs: ['Connect the field service system in the card above (installation windows and the completion callback come from there)', 'Without it, staff use the order actions to schedule and complete the installation by hand'],
    doc: 'ORDERS.md', keywords: 'installation technician field service fibre dispatch appointment',
  },
  {
    id: 'warehouse', group: 'Field service and logistics', name: 'Warehouse and stock files', with: 'Warehouse management system or supplier stock files',
    summary: 'Stock arrives by CSV, is moved between locations and written off in Inventory. No warehouse system is connected.',
    maturity: 'MANUAL', direction: 'IN',
    needs: ['Export stock from the warehouse system in the template layout', 'Load it in Inventory (check first, then load)'],
    configure: { label: 'Inventory', href: '/inventory' }, doc: 'ORDERS.md', keywords: 'warehouse stock inventory wms supplier csv import',
  },

  // ───────────── Sign-in and identity ─────────────
  {
    id: 'sso-oidc', group: 'Sign-in and identity', name: 'Single sign-on (OpenID Connect)', with: 'Microsoft Entra ID (Azure AD), Okta, Ping Identity, Keycloak or any OpenID Connect provider',
    summary: 'Staff sign in with their company account. Meridian sends them to the provider (authorisation code with PKCE), checks the signed id_token, and creates or updates their Meridian account with the role their groups map to. The provider’s own second factor applies, so Meridian does not ask for another. The Administrator role is never granted from a group.',
    maturity: 'BUILT', direction: 'BOTH',
    endpoints: [
      { method: 'GET', path: '/api/auth/sso/providers', purpose: 'The sign-in buttons', auth: 'None' },
      { method: 'POST', path: '/api/auth/sso/start', purpose: 'Where to send the browser: { providerId }', auth: 'None' },
      { method: 'POST', path: '/api/auth/sso/callback', purpose: 'The return from the provider: { state, code }', auth: 'None (single-use state and PKCE verifier)' },
    ],
    needs: ['Register Meridian with the provider as a web application and give it the redirect address shown below', 'Add the connection below: issuer, client id, client secret, and which group gets which role'],
    doc: 'SECURITY.md', keywords: 'sso single sign-on oidc openid connect entra azure ad okta ping keycloak idp login',
  },
  {
    id: 'sso-saml', group: 'Sign-in and identity', name: 'Single sign-on (SAML 2.0)', with: 'A SAML 2.0 identity provider',
    summary: 'The provider’s address, entity id and signing certificate are stored and checked. Meridian does not accept SAML assertions yet, so sign-in through SAML is not available; use OpenID Connect, which every major provider also offers.',
    maturity: 'STUB', direction: 'IN',
    needs: ['Prefer OpenID Connect where the provider supports it', 'A SAML assertion consumer needs a vetted SAML library and a security review before it is switched on'],
    doc: 'SECURITY.md', keywords: 'saml 2.0 assertion idp sso adfs',
  },
  {
    id: 'ldap', group: 'Sign-in and identity', name: 'Active Directory / LDAP', with: 'Microsoft Active Directory or another LDAP directory',
    summary: 'Meridian reads the people in the directory on a schedule, creates their accounts with the role their groups map to, keeps names, e-mail and phone current, and switches off people who have left. They sign in with their directory password, which Meridian checks with the directory and never stores. Local accounts are never taken over.',
    maturity: 'BUILT', direction: 'BOTH',
    needs: ['A read-only service account for the directory and the place to search (base DN)', 'Add the connection below, map directory groups to roles, then press Sync now', 'Call POST /api/jobs/directory-sync from your scheduler every few minutes; each directory syncs when its own interval is due'],
    doc: 'SECURITY.md', keywords: 'ldap active directory ad sync directory group role mapping ldaps bind',
  },
  {
    id: 'fiber-coverage', group: 'Field service and logistics', name: 'Fibre coverage and serviceability', with: 'The fibre coverage service (apps/fiber-coverage), which in turn asks wholesale fibre partners',
    summary: 'A separately deployed service answers “can this address be served, by whom, at what speed, is there a free port?” (own network plus wholesale partners, with a 24-hour partner cache) and holds a port while the customer checks out. The order screen and the store-front call it when a fibre plan is chosen. Switch it off in Settings → Modules and the coverage check, fibre installation steps and fixed-broadband plans are hidden. TM Forum 645 and 673 are offered for partners.',
    maturity: 'BUILT', direction: 'BOTH',
    env: [
      { name: 'MERIDIAN_FIBER_URL', purpose: 'Base address of the coverage service, for example https://fiber.example.com', on: 'web', required: false },
      { name: 'MERIDIAN_FIBER_API_KEY', purpose: 'A key with the fibre scope, issued in the service’s hub (Overview → Access keys)', on: 'web', required: false, secret: true },
      { name: 'FEATURE_FIBER_COVERAGE_MODULE_ENABLED', purpose: 'Starting value of the module switch (on or off; unset means on). Settings → Modules overrides it', on: 'web', required: false },
    ],
    endpoints: [
      { method: 'POST', path: '/api/v1/coverage/qualify-address', purpose: 'Availability matrix for an address or GPS point (on the coverage service)', auth: 'API key, fibre scope' },
      { method: 'POST', path: '/api/v1/coverage/reservations', purpose: 'Hold a port while a customer checks out; then …/confirm, …/release', auth: 'API key, fibre scope' },
    ],
    needs: ['Deploy apps/fiber-coverage as its own project (see docs/FIBER_COVERAGE.md) and sign in to its hub to add providers, distribution points and coverage', 'Issue a key in the hub and set MERIDIAN_FIBER_URL and MERIDIAN_FIBER_API_KEY on this deployment', 'Switch the module on in Settings → Modules'],
    configure: { label: 'Settings → Modules', href: '/admin/settings?section=modules' }, doc: 'FIBER_COVERAGE.md', keywords: 'fibre fiber ftth coverage serviceability broadband port reservation address qualification tmf 645 673 wholesale partner dp splitter',
  },
  // ───────────── Messaging ─────────────
  {
    id: 'otp-gateway', group: 'Messaging', name: 'SMS / WhatsApp gateway', with: 'An SMS or WhatsApp messaging gateway (Twilio, Infobip, a local aggregator)',
    summary: 'Meridian’s endpoint for text messages. It carries the sign-in codes for the second factor and for password recovery, the text-message alerts staff switch on in My profile (security alerts, case alerts, system alerts), and the signed agreement copies sent to customers (one message per copy with a secure 15-minute link; nothing is attached). Each message is posted as JSON with a bearer token. A code is wiped from the outbox once the gateway accepts it. Alerts and signed copies that the gateway refuses are retried after 1, 5, 15, 60 and 240 minutes and then marked failed. Without an enabled gateway nothing is sent by text message: codes wait in the notification outbox, staff SMS alerts are not queued, and signed copies go by e-mail if an e-mail sender is set up and otherwise stay queued. E-mail has its own sender, next to this one.',
    maturity: 'BUILT', direction: 'OUT', outbox: { kind: 'NOTIFY', instructions: ['MFA_OTP', 'PASSWORD_RESET', 'USER_ALERT', 'CONTRACT_SIGNED'] },
    needs: ['Add the gateway below: address, token, sender id, SMS or WhatsApp, and approved template ids for WhatsApp (MFA, RESET, ALERT, CONTRACT)', 'Signed copies also need the public address of this site (Settings, Security, Password recovery) to build their links', 'Call POST /api/jobs/deliver-otp and POST /api/jobs/deliver-notifications from your scheduler to retry codes, alerts and signed copies the gateway refused'],
    doc: 'INTEGRATIONS.md', keywords: 'sms whatsapp otp one-time code gateway twilio infobip 2fa mfa password recovery',
  },
  {
    id: 'email-gateway', group: 'Messaging', name: 'E-mail sender', with: 'An e-mail provider with an HTTPS API, an SMTP server, or the built-in simulator',
    summary: 'Meridian’s endpoint for e-mail. It sends the e-mail alerts staff switch on in My profile, the signed agreement copies for customers who have an e-mail address (a secure 15-minute link, nothing attached), and, when Settings → Security policy → E-mail codes is switched on, sign-in codes for the second factor and the link or code for password recovery. Choose how it sends: an HTTPS API (address, token, and the request body your provider expects, with placeholders; one-click presets for a generic JSON provider), SMTP (host, port, STARTTLS, TLS or none, user and password), or the simulator, which records the message and sends nothing. Failed alerts and signed copies are retried after 1, 5, 15, 60 and 240 minutes and then marked failed; a code is wiped from the outbox once it has been sent. Without an enabled sender, e-mail alerts stay queued in the notification outbox and e-mail codes are not offered anywhere.',
    maturity: 'BUILT', direction: 'OUT',
    needs: ['Add the sender below: sender name and from address (and a reply-to if you want one), then the mode: HTTPS API or SMTP with the details your provider gave you', 'Press “Send a test e-mail” and check that it arrives', 'To use it for sign-in and recovery codes, switch on “Allow sign-in and recovery codes by e-mail” in Settings → Security policy', 'Signed copies also need the public address of this site (Settings, Security, Password recovery) to build their links', 'Call POST /api/jobs/deliver-otp and POST /api/jobs/deliver-notifications from your scheduler to retry what the sender refused'],
    configure: { label: 'Settings → Security policy (E-mail codes)', href: '/admin/settings?section=security-policy' }, doc: 'INTEGRATIONS.md', keywords: 'email e-mail smtp mail sender https api provider sendgrid mailgun ses postmark simulator codes alerts signed copies from reply-to',
  },
  {
    id: 'notifications', group: 'Messaging', name: 'Account notices (reminders, bar and restore)', with: 'Your own connector, reading the notification outbox',
    summary: 'Payment reminders, credit warnings, bar and restore notices, suspension and termination confirmations are queued as NOTIFY instructions with the account and the facts. Meridian does not send these itself: a connector you build turns them into messages with your templates. (Sign-in codes, staff alerts and signed agreement copies are different: Meridian sends those itself through the SMS / WhatsApp gateway and the e-mail sender above.)',
    maturity: 'OUTBOX', direction: 'OUT',
    outbox: { kind: 'NOTIFY', instructions: ['PAYMENT_REMINDER', 'PAYMENT_THANKS', 'CREDIT_WARNING', 'CREDIT_LIMIT_REACHED', 'SERVICE_SOFT_BARRED', 'SERVICE_HARD_BARRED', 'FINAL_NOTICE', 'SUSPENSION_CONFIRMED', 'SERVICE_RESTORED', 'TERMINATION_CONFIRMED'] }, endpoints: POLL,
    needs: ['Build the connector: read NOTIFY instructions, look up the customer’s contact, send, acknowledge (it can use your SMS provider and e-mail service directly)', 'Write the message templates in each language you serve'],
    doc: 'LIFECYCLE.md', keywords: 'sms email notification message reminder push template whatsapp account notice',
  },

  // ───────────── Finance and SAP ─────────────
  {
    id: 'sap', group: 'Payments and finance', name: 'SAP general ledger export', with: 'SAP S/4HANA or ECC (through Integration Suite, an API gateway, or file load)',
    summary: 'The sub-ledger turns business events into balanced journals, maps them to SAP accounts, cost centres and tax codes, and exports them in batches (FLAT, IDoc, JSON or CSV). Delivery is manual download, or REST to your endpoint. SFTP and RFC need a connector deployed with the integration.',
    maturity: 'BUILT', direction: 'OUT',
    env: [
      { name: 'MERIDIAN_SAP_TOKEN', purpose: 'Bearer token for REST delivery', on: 'web', secret: true },
      { name: 'MERIDIAN_SAP_COMPANY_CODE', purpose: 'Default company code written to the export', on: 'web' },
    ],
    needs: ['Map accounts in Finance → Posting rules', 'Choose format and delivery in Finance → SAP settings; for REST give the endpoint and set MERIDIAN_SAP_TOKEN', 'Switch on the automatic daily close when ready'],
    configure: { label: 'Finance → SAP settings', href: '/finance' }, doc: 'FINANCE.md', keywords: 'sap gl general ledger journal export idoc posting account cost centre erp',
  },
  {
    id: 'ledger-ingest', group: 'Payments and finance', name: 'Billing and charging events into the ledger', with: 'Rating, charging and billing systems, or an event bus',
    summary: 'Other systems post business events (invoice generated, payment success, adjustment, refund) to Meridian’s sub-ledger. Bad events are kept as dead letters and never dropped; they can be retried.',
    maturity: 'ENDPOINT', direction: 'IN',
    endpoints: [
      { method: 'POST', path: '/api/ledger/events', purpose: 'One event or a batch of up to 500', auth: 'Service account with ledger:ingest' },
      { method: 'GET', path: '/api/ledger/dead-letters', purpose: 'Events that could not be posted', auth: 'finance:read' },
    ],
    needs: ['Have the source system call the endpoint, or read your event bus and post each message', 'Watch dead letters in Finance'],
    configure: { label: 'Finance', href: '/finance' }, doc: 'FINANCE.md', keywords: 'ledger events ingest kafka sub-ledger dead letter billing charging rating',
  },
  {
    id: 'commission-payouts', group: 'Payments and finance', name: 'Dealer and agent payout files', with: 'Your bank (dealer transfers) and payroll (staff)',
    summary: 'Closing a month issues statements; Finance downloads the payout CSV, pays it through the bank or payroll, then confirms in Meridian. The file is generic; it needs mapping to your bank’s format.',
    maturity: 'MANUAL', direction: 'OUT',
    endpoints: [{ method: 'GET', path: '/api/commission/payouts/:id/file', purpose: 'Download the payout file', auth: 'commission:settle' }, { method: 'POST', path: '/api/commission/payouts/:id/confirm', purpose: 'Mark paid once the bank has paid', auth: 'commission:settle' }],
    needs: ['Map the CSV to your bank’s upload format (for example ISO 20022 pain.001)', 'Optionally automate: upload the file, then call confirm when the bank reports success'],
    configure: { label: 'Commission → Close & payouts', href: '/dealer/commission' }, doc: 'COMMISSION.md', keywords: 'commission payout bank payroll dealer agent statement pain.001',
  },

  // ───────────── Credit and collections ─────────────
  {
    id: 'credit-bureau', group: 'Identity, credit and collections', name: 'Credit bureau and device financing', with: 'A credit bureau (REST) that scores a customer from their ID number, and the rules for paying a device over the contract',
    summary: 'The credit bureau behind device financing (and, later, the order workflow’s credit-check step, where a stand-in still approves every order today), and the device financing settings below its connection. A device on a contract is paid over the contract. With the credit check on, Meridian sends the customer’s ID number (with their consent; only a hash is kept) to the bureau. A score comes back and the score bands set the upfront payment, or the bureau returns the upfront amount itself. Without a bureau, or when it fails, the fallback share applies (or the sale stops, as you choose). A built-in simulator lets you try the flow.',
    maturity: 'BUILT', direction: 'OUT',
    needs: ['Add the bureau below (kind: credit bureau): address, key, and the names of the ID field and the score or upfront field in its answer', 'Below the connection, set the financing rules, the score bands and what to do when the bureau fails, then use “Try it”'],
    doc: 'FINANCING.md', keywords: 'device financing credit check bureau score upfront payment dup instalment consent id number',
  },
  {
    id: 'collections', group: 'Identity, credit and collections', name: 'Collections agency and write-offs', with: 'A collections agency and the finance system',
    summary: 'When an account is written off, Meridian queues a COLLECTIONS hand-over (balance and invoices) and a GL write-off instruction.',
    maturity: 'OUTBOX', direction: 'OUT',
    outbox: { kind: 'COLLECTIONS', instructions: ['HAND_OVER'] }, endpoints: POLL,
    needs: ['Agree the hand-over format with the agency', 'Connector: read COLLECTIONS instructions, send to the agency, acknowledge'],
    doc: 'LIFECYCLE.md', keywords: 'collections agency debt write off hand over dunning',
  },

  // ───────────── Identity and compliance ─────────────
  {
    id: 'ekyc', group: 'Identity, credit and collections', name: 'Identity verification (ID check service)', with: 'An ID check service over REST (document OCR, face match, liveness), or the built-in simulator',
    summary: 'Applicants and customers photograph their ID with the live camera, as always. With a service connected, the photographs and the typed details go to it after the local rules: a clean pass is verified at once and the waiting order released; a doubtful answer opens a review task with the service’s verdict in front of the reviewer; a fail rejects the case and cancels and refunds the order. If the service cannot be reached the case drops to manual review and nobody is rejected because of it. A service that only checks the document is fine: what it does not return is not judged. The rules below apply to the store-front, the CRM or both, as marked.',
    maturity: 'BUILT', direction: 'OUT',
    needs: ['Add the service below: its address, the key, and where its answer keeps the verdict, extracted fields and scores (the defaults suit a typical service)', 'Set the face-match limits, and whether a clean pass is approved without a person', 'Try it first with the simulator: an ID number ending 9999 fails, 0000 goes to review, 5555 simulates an outage'],
    configure: { label: 'Identity rules', href: '/admin/integrations?item=ekyc' }, doc: 'KYC.md', keywords: 'ekyc kyc identity verification liveness document id vendor compliance ocr face match provider',
  },
  {
    id: 'mydigitalid', group: 'Identity, credit and collections', name: 'MyDigital ID', with: 'MyDigital ID (an OpenID Connect identity provider)',
    summary: 'A second way to prove identity, offered next to the photographs. The customer approves in their MyDigital ID app and comes back; Meridian checks the signed answer and compares the name, ID number and date of birth with what was entered, then the same rules (age, expiry, duplicates) run. A confirmed identity is verified without photographs; if anything does not match, nothing is created and the customer can correct the details or take the photographs instead.',
    maturity: 'BUILT', direction: 'BOTH',
    endpoints: [{ method: 'GET', path: '/api/kyc/mydigitalid/callback', purpose: 'Where MyDigital ID returns the browser in the CRM (register it as the CRM redirect address)', auth: 'None; the one-time state proves the attempt' }],
    needs: ['Register Meridian with MyDigital ID and receive a client id and secret', 'Register the redirect addresses: the CRM one shown above, and the store-front’s /apply/mydigitalid', 'Add the connection below (issuer, client id, secret, redirect addresses) and use “Test the connection”', 'Check the claim names MyDigital ID sends for the name, ID number and date of birth'],
    doc: 'KYC.md', keywords: 'mydigital id mydigitalid digital identity oidc kyc malaysia government login',
  },
  {
    id: 'secrets', group: 'Platform', name: 'Keys that protect customer data', with: 'Your secrets store',
    summary: 'The ID pepper hashes ID documents for duplicate detection; the data key encrypts identity data at rest (AES-256-GCM, falls back to the pepper). The super-user login lives only in the environment. Losing the data key makes the data unreadable.',
    maturity: 'BUILT', direction: 'IN',
    env: [
      { name: 'MERIDIAN_ID_PEPPER', purpose: '16+ characters; never change once customers exist', on: 'web', required: true, secret: true },
      { name: 'MERIDIAN_DATA_KEY', purpose: 'Encryption key for identity data; back it up with the database', on: 'web', secret: true },
      { name: 'MERIDIAN_SUPERUSER_USERNAME', purpose: 'Break-glass super user', on: 'web', required: true },
      { name: 'MERIDIAN_SUPERUSER_PASSWORD', purpose: '12+ characters', on: 'web', required: true, secret: true },
    ],
    needs: ['Keep all four in your secrets manager, not in the repository', 'Plan key backup and rotation'],
    doc: 'SECURITY.md', keywords: 'secret key pepper encryption super user password vault',
  },

  // ───────────── Charging and usage ─────────────
  {
    id: 'rating-gateway', group: 'Network, numbers and charging', name: 'Online charging gateway (Diameter Gy / 5G CHF)', with: 'The packet core and online charging (OCS/CHF)',
    summary: 'The rating-gateway service is the hot path for balance reservations during sessions. It is a scaffold with an in-memory balance store; a Redis-backed store and the Diameter or Nchf front end are not built.',
    maturity: 'STUB', direction: 'BOTH',
    needs: ['Choose the protocol (Gy or Nchf) and the balance store', 'Feed balances from Meridian (usage, allowances) and send usage records to billing'],
    doc: 'ARCHITECTURE.md', keywords: 'charging rating ocs chf diameter gy nchf usage cdr balance redis prepaid',
  },

  // ───────────── Platform and events ─────────────
  {
    id: 'database', group: 'Platform', name: 'PostgreSQL database', with: 'PostgreSQL or AlloyDB',
    summary: 'The system of record. Without DATABASE_URL the portal runs on an embedded demo database that is lost on restart (refused in production).',
    maturity: 'BUILT', direction: 'BOTH',
    env: [
      { name: 'DATABASE_URL', purpose: 'Connection string (sslmode=require)', on: 'web', required: true, secret: true },
      { name: 'PG_POOL_MAX', purpose: 'Connections per instance; 1–3 on serverless', on: 'web' },
    ],
    needs: ['Provide a managed Postgres, with backups', 'Migrations apply on start'],
    doc: 'OPERATIONS.md', keywords: 'database postgres postgresql alloydb neon pool backup',
  },
  {
    id: 'temporal', group: 'Platform', name: 'Workflow engine (Temporal)', with: 'Temporal server',
    summary: 'The order service runs the order, port-in, dunning and number-recycling workflows. Their steps call other systems (credit check, payment capture, inventory, shipping, notifications, clearinghouse) through activities that are stand-ins until real connectors replace them.',
    maturity: 'STUB', direction: 'BOTH',
    env: [{ name: 'TEMPORAL_ADDRESS', purpose: 'Temporal frontend address, default localhost:7233', on: 'order-service', required: true }],
    needs: ['Run Temporal (or Temporal Cloud) and the order-service worker', 'Replace the stand-in activities with real ones, one integration at a time'],
    doc: 'ARCHITECTURE.md', keywords: 'temporal workflow order service worker activity saga',
  },
  {
    id: 'event-bus', group: 'Events and streaming', name: 'Event bus (Kafka)', with: 'Kafka or another message bus',
    summary: 'Workflows publish domain events by topic and key; today the publisher is a stand-in that logs. Inbound, the ledger accepts events over HTTP, so a Kafka consumer can post each message.',
    maturity: 'STUB', direction: 'BOTH',
    outbox: { kind: 'EVENT', instructions: ['VIP_NUMBER_AUCTION_WON', 'RECONCILIATION_MISMATCH'] },
    needs: ['Run Kafka and replace publishEvent with a producer', 'Optionally read the EVENT outbox for domain events that should leave Meridian'],
    doc: 'ARCHITECTURE.md', keywords: 'kafka event bus publish topic stream message broker',
  },
  {
    id: 'catalog-store', group: 'Platform', name: 'Catalog service database (MongoDB)', with: 'MongoDB',
    summary: 'The catalog service (NestJS) keeps its own document store. The portal’s own catalog lives in PostgreSQL.',
    maturity: 'BUILT', direction: 'BOTH',
    env: [{ name: 'MONGO_URL', purpose: 'MongoDB connection string', on: 'catalog-service', required: true, secret: true }],
    needs: ['Provide MongoDB if you run the catalog service'],
    doc: 'ARCHITECTURE.md', keywords: 'mongo mongodb catalog service document',
  },
  {
    id: 'outbox', group: 'Platform', name: 'Message outbox (adapter interface)', with: 'Any connector you build for the integrations marked “Outbox”',
    summary: 'Meridian never calls the network, messaging or collections systems inside a customer transaction. It writes an instruction in the same transaction and a connector delivers it later and acknowledges it, so nothing is lost or sent twice.',
    maturity: 'ENDPOINT', direction: 'OUT', endpoints: POLL,
    needs: ['Create a service account for each connector with billing:run', 'Make delivery idempotent: an instruction may be read again until acknowledged'],
    doc: 'OPERATIONS.md', keywords: 'outbox adapter connector queue instruction ack service account',
  },
  {
    id: 'scheduler', group: 'Platform', name: 'Scheduled jobs', with: 'A scheduler (cron, Vercel Cron, Kubernetes CronJob, Temporal schedule)',
    summary: 'Nothing in Meridian runs itself. Schedule the bill run, the daily lifecycle job (suspensions, dunning, number recycling, SAP close, commission) and, if you use them, the others. All are safe to re-run.',
    maturity: 'ENDPOINT', direction: 'IN',
    endpoints: [
      { method: 'POST', path: '/api/billing/run', purpose: 'Bill cycle run', auth: 'Service account with billing:run' },
      { method: 'POST', path: '/api/lifecycle/run', purpose: 'Daily lifecycle job', auth: 'Service account with billing:run' },
      { method: 'POST', path: '/api/ocs/dispatch', purpose: 'Deliver due jobs to the charging system (every minute)', auth: 'Service account with billing:run' },
      { method: 'POST', path: '/api/commission/run', purpose: 'Commission approvals, claw-backs, monthly close', auth: 'commission:settle' },
      { method: 'POST', path: '/api/jobs/expire-applications', purpose: 'Expire unfinished store-front sign-ups (hourly)', auth: 'Service account with billing:run' },
      { method: 'POST', path: '/api/numbering/recycle', purpose: 'Release rested numbers and IMSIs', auth: 'numbering:manage' },
    ],
    needs: ['Create a service account and a schedule that calls the first two once a day'],
    doc: 'OPERATIONS.md', keywords: 'schedule cron job daily bill run lifecycle batch timer',
  },
];

export const integrationById = (id: string) => INTEGRATIONS.find((i) => i.id === id);

export interface OutboxCount { kind: string; instruction: string; pending: number; delivered: number; lastDeliveredAt: string | null; oldestPendingAt: string | null }
export interface IntegrationState {
  id: string;
  status: IntegrationStatus;
  /** One line that says why, in plain words. */
  detail: string;
  env: Array<EnvVar & { set: boolean | null }>;
  pending: number;
  delivered: number;
  lastDeliveredAt: string | null;
  oldestPendingAt: string | null;
}

const isSet = (env: NodeJS.ProcessEnv, v: EnvVar): boolean | null => (v.on === 'web' ? !!(env[v.name] ?? '').trim() : null);
const MAT_STATUS: Record<Maturity, IntegrationStatus> = { BUILT: 'NEEDS_SETUP', OUTBOX: 'WAITING', ENDPOINT: 'LISTENING', MANUAL: 'MANUAL', STUB: 'STAND_IN' };

/** The state of every integration, computed from the environment (names only), the settings and the outbox. Safe to show to the super user. */
export async function integrationOverview(q: Queryable, env: NodeJS.ProcessEnv = process.env): Promise<{ groups: IntegrationGroup[]; items: Array<IntegrationDef & { state: IntegrationState }>; outbox: OutboxCount[] }> {
  const outbox = (await q.query(
    `SELECT kind, instruction, count(*) FILTER (WHERE delivered_at IS NULL)::int AS pending, count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
            max(delivered_at) AS last_delivered_at, min(created_at) FILTER (WHERE delivered_at IS NULL) AS oldest_pending_at
       FROM lifecycle_outbox GROUP BY kind, instruction`)).rows.map((r: any) => ({
    kind: r.kind, instruction: r.instruction, pending: r.pending, delivered: r.delivered,
    lastDeliveredAt: r.lastDeliveredAt ? new Date(r.lastDeliveredAt).toISOString() : null, oldestPendingAt: r.oldestPendingAt ? new Date(r.oldestPendingAt).toISOString() : null,
  })) as OutboxCount[];
  const sap = await getSapSettings(q);
  const store = await getStoreSettings(q);
  const keys = (await q.query(`SELECT count(*)::int AS n FROM api_clients WHERE status='ACTIVE'`)).rows[0]?.n ?? 0;
  const donors = (await q.query(`SELECT count(*)::int AS n FROM donor_operators WHERE status='ACTIVE'`)).rows[0]?.n ?? 0;
  const embedded = !(env.DATABASE_URL ?? '').trim();
  const fibre = await fiberStatus(q);
  const authCounts = new Map<string, number>((await q.query(`SELECT kind, count(*)::int AS n FROM integration_endpoints WHERE group_key='auth' AND enabled GROUP BY kind`)).rows.map((r) => [r.kind as string, r.n as number]));
  const identityCounts = new Map<string, number>((await q.query(`SELECT kind, count(*)::int AS n FROM integration_endpoints WHERE group_key='identity' AND enabled GROUP BY kind`)).rows.map((r) => [r.kind as string, r.n as number]));
  const lastSync = ((await q.query(`SELECT max(finished_at) AS at FROM directory_sync_runs WHERE status='OK'`)).rows[0]?.at as string | null) ?? null;
  const emailStatus = await emailSenderStatus(q), emailCodes = await emailCodesStatus(q);
  const ocsStats4 = await ocsStats(q), ocsSet = await getOcsSettings(q), wfmSet = await getWfmSettings(q);

  const items = INTEGRATIONS.map((def) => {
    const vars = (def.env ?? []).map((v) => ({ ...v, set: isSet(env, v) }));
    const mine = def.outbox ? outbox.filter((o) => o.kind === def.outbox!.kind && def.outbox!.instructions.includes(o.instruction)) : [];
    const pending = mine.reduce((n, o) => n + o.pending, 0), delivered = mine.reduce((n, o) => n + o.delivered, 0);
    const lastDeliveredAt = mine.map((o) => o.lastDeliveredAt).filter(Boolean).sort().pop() ?? null;
    const oldestPendingAt = mine.map((o) => o.oldestPendingAt).filter(Boolean).sort()[0] ?? null;
    const missing = vars.filter((v) => v.required && v.set === false).map((v) => v.name);
    let status: IntegrationStatus = MAT_STATUS[def.maturity];
    let detail = '';

    switch (def.id) {
      case 'fiber-coverage': {
        const fs = fibre;
        if (!fs.enabled) { status = 'MANUAL'; detail = 'Switched off in Settings → Modules. Fibre plans and the coverage check are hidden.'; }
        else if (!fs.configured) { status = 'NEEDS_SETUP'; detail = 'Switched on, but MERIDIAN_FIBER_URL and MERIDIAN_FIBER_API_KEY are not set, so the coverage check is unavailable.'; }
        else { status = 'CONNECTED'; detail = `Switched on and connected to ${fs.host}.`; }
        break;
      }
      case 'email-gateway': {
        const es = emailStatus;
        if (!es.enabled) { status = 'NEEDS_SETUP'; detail = 'No e-mail sender is enabled. E-mail alerts wait in the outbox and e-mail codes are not offered.'; }
        else if (es.mode === 'SIMULATOR') { status = 'STAND_IN'; detail = `${es.name}: the simulator records messages and sends nothing.${es.lastTest ? ` Last test ${es.lastTest.ok ? 'recorded' : 'failed'} ${es.lastTest.at.slice(0, 16).replace('T', ' ')} UTC.` : ''}`; }
        else {
          status = es.lastTest && !es.lastTest.ok ? 'NEEDS_SETUP' : 'CONNECTED';
          detail = `${es.name}: sending as ${es.from} through ${es.mode === 'SMTP' ? 'SMTP' : 'the HTTPS API'}${es.target ? ` at ${es.target}` : ''}. ${es.lastTest ? (es.lastTest.ok ? `Last test e-mail sent ${es.lastTest.at.slice(0, 16).replace('T', ' ')} UTC.` : `The last test e-mail failed: ${es.lastTest.error ?? 'no reason given'}`) : 'No test e-mail sent yet.'}${emailCodes.switchedOn ? ' E-mail codes are on.' : ' E-mail codes are off.'}`;
        }
        break;
      }
      case 'sso-oidc': case 'sso-saml': case 'ldap': case 'otp-gateway': {
        const kind = { 'sso-oidc': 'IDP_OIDC', 'sso-saml': 'IDP_SAML', ldap: 'LDAP', 'otp-gateway': 'OTP_GATEWAY' }[def.id]!;
        const n = authCounts.get(kind) ?? 0;
        if (def.id === 'sso-saml') { status = 'STAND_IN'; detail = n ? `${n} provider${n === 1 ? '' : 's'} stored. Sign-in through SAML is not available yet.` : 'Not available yet; use OpenID Connect.'; }
        else if (!n) { status = 'NEEDS_SETUP'; detail = 'Nothing connected yet.'; }
        else { status = 'CONNECTED'; detail = def.id === 'ldap' ? `${n} director${n === 1 ? 'y' : 'ies'} connected.${lastSync ? ` Last sync ${lastSync.slice(0, 16).replace('T', ' ')} UTC.` : ' Not synced yet.'}` : `${n} connected.`; }
        break;
      }
      case 'ekyc': case 'mydigitalid': {
        const n = identityCounts.get(def.id === 'ekyc' ? 'KYC_OCR' : 'KYC_MYDIGITALID') ?? 0;
        if (!n) { status = 'MANUAL'; detail = def.id === 'ekyc' ? 'No service connected: every case waits for a person (or the rules alone in automatic mode).' : 'Not set up; customers use the photographs.'; }
        else { status = 'CONNECTED'; detail = def.id === 'ekyc' ? 'A service checks the photographs before a person is asked.' : 'Offered to customers next to the photographs.'; }
        break;
      }
      case 'storefront':
        if (keys > 0) { status = 'REMOTE'; detail = `${keys} active API key${keys === 1 ? '' : 's'}. The store-front’s own settings are on its deployment.`; }
        else { status = 'NEEDS_SETUP'; detail = 'No API key has been issued.'; }
        break;
      case 'stripe': {
        const sf = store.gateways.enabled.includes('stripe'), crm = (store.gateways.crm ?? []).includes('stripe'), on = sf || crm, ok = GATEWAYS.stripe?.configured(env) ?? false;
        const where = [sf && 'store-front', crm && 'CRM'].filter(Boolean).join(' and ');
        status = ok && on ? 'CONNECTED' : 'NEEDS_SETUP';
        detail = ok ? (on ? `Keys set. Stripe is on for the ${where}.` : 'Keys set, but Stripe is not switched on for the store-front or the CRM yet.') : `Missing ${missing.join(', ')}.`;
        break;
      }
      case 'payment-webhook': {
        const hooked = !!(env.MERIDIAN_PAYMENT_WEBHOOK_SECRET ?? '').trim();
        status = hooked ? 'CONNECTED' : 'MANUAL';
        detail = hooked ? 'Webhook is on.' : 'Webhook is off; staff record payments by hand.';
        break;
      }
      case 'sap': {
        const rest = sap.transport === 'REST';
        const tokenSet = !!(env.MERIDIAN_SAP_TOKEN ?? '').trim();
        if (sap.transport === 'MANUAL') { status = 'MANUAL'; detail = 'Files are downloaded and loaded by hand.'; }
        else if (rest && sap.endpoint && tokenSet) { status = 'CONNECTED'; detail = `Delivering ${sap.format} to ${new URL(sap.endpoint).host}.`; }
        else if (rest) { status = 'NEEDS_SETUP'; detail = !sap.endpoint ? 'REST is chosen but no endpoint is set.' : 'REST is chosen but MERIDIAN_SAP_TOKEN is not set.'; }
        else { status = 'NEEDS_SETUP'; detail = `${sap.transport} delivery needs a connector that is not part of this deployment. Files can still be downloaded.`; }
        break;
      }
      case 'ocs': {
        const o = ocsSet, st = ocsStats4;
        const v = o.vendor ? OCS_VENDORS[o.vendor] : null;
        if (!o.vendor || !o.enabled) { status = 'NEEDS_SETUP'; detail = o.vendor ? `${v?.label ?? o.vendor} is chosen but switched off.` : 'No connector chosen yet.'; }
        else if (st.dead > 0) { status = 'NEEDS_SETUP'; detail = `${st.dead} job${st.dead === 1 ? '' : 's'} could not be delivered to ${v?.label}. Retry them below.`; }
        else if (!v?.real) { status = 'STAND_IN'; detail = `${v?.label}: nothing is sent to a real system.`; }
        else { status = 'CONNECTED'; detail = `${v.label}. ${st.sent} delivered, ${st.pending} waiting.${st.unmappedOffers ? ` ${st.unmappedOffers} plan${st.unmappedOffers === 1 ? ' has' : 's have'} no OCS plan code.` : ''}`; }
        break;
      }
      case 'wfm': {
        const w = wfmSet, v = w.vendor ? WFM_VENDORS[w.vendor] : null;
        if (!w.vendor || !w.enabled) { status = 'NEEDS_SETUP'; detail = w.vendor ? `${v?.label ?? w.vendor} is chosen but switched off.` : 'No field-service system chosen yet.'; }
        else if (!(env[w.webhookSecretEnv] ?? '').trim()) { status = 'NEEDS_SETUP'; detail = `${w.webhookSecretEnv} is not set, so callbacks cannot be accepted.`; }
        else if (!v?.real) { status = 'STAND_IN'; detail = `${v?.label}: no real technician is booked.`; }
        else { status = 'CONNECTED'; detail = `${v.label}. Callbacks are accepted.`; }
        break;
      }
      case 'database': status = embedded ? 'STAND_IN' : 'CONNECTED'; detail = embedded ? 'Running on the embedded demo database.' : 'Connected to the configured database.'; break;
      case 'secrets': status = missing.length ? 'NEEDS_SETUP' : 'CONNECTED'; detail = missing.length ? `Missing ${missing.join(', ')}.` : 'Required keys are set.'; break;
      case 'mnp-port-in': detail = donors ? `${donors} donor operator${donors === 1 ? '' : 's'} listed.` : 'No donor operators listed yet.'; break;
      case 'temporal': case 'catalog-store': status = 'REMOTE'; detail = 'Set on the service’s own deployment; this page cannot see it.'; break;
      default: break;
    }

    if (def.outbox && (def.maturity === 'OUTBOX') ) {
      if (delivered > 0) { status = 'CONNECTED'; detail = `${delivered} delivered${lastDeliveredAt ? `, last ${lastDeliveredAt.slice(0, 10)}` : ''}${pending ? `; ${pending} waiting` : ''}.`; }
      else if (pending > 0) { status = 'WAITING'; detail = `${pending} instruction${pending === 1 ? '' : 's'} waiting; nothing has acknowledged any yet, so no connector is reading them.`; }
      else { status = 'WAITING'; detail = def.id === 'mnp-port-in' && donors ? `${donors} donor operator${donors === 1 ? '' : 's'} listed. No port-in has been filed yet.` : 'No connector yet. Nothing is queued so far.'; }
    } else if (!detail) {
      detail = { BUILT: missing.length ? `Missing ${missing.join(', ')}.` : 'Ready.', OUTBOX: '', ENDPOINT: 'Ready for the other system to call.', MANUAL: 'Done by hand. No connector yet.', STUB: 'A stand-in answers; no real system is connected.' }[def.maturity];
      if (def.maturity === 'BUILT' && !missing.length && status === 'NEEDS_SETUP') status = 'CONNECTED';
    }
    return { ...def, state: { id: def.id, status, detail, env: vars, pending, delivered, lastDeliveredAt, oldestPendingAt } };
  });
  return { groups: INTEGRATION_GROUPS, items, outbox };
}
