import type { Queryable } from './db.js';
import { GATEWAYS } from './gateways.js';
import { getOcsSettings, ocsStats } from './ocs.js';
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
  | 'Online store-front' | 'Payments' | 'Network and SIM provisioning' | 'Number portability (MNP)' | 'Logistics and delivery' | 'Customer messaging'
  | 'Finance and SAP' | 'Credit and collections' | 'Identity and compliance' | 'Charging and usage' | 'Platform and events';

export const INTEGRATION_GROUPS: IntegrationGroup[] = [
  'Online store-front', 'Payments', 'Network and SIM provisioning', 'Number portability (MNP)', 'Logistics and delivery', 'Customer messaging',
  'Finance and SAP', 'Credit and collections', 'Identity and compliance', 'Charging and usage', 'Platform and events',
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
    id: 'stripe', group: 'Payments', name: 'Stripe', with: 'Stripe (card payments for the store-front and the CRM)',
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
    id: 'payment-webhook', group: 'Payments', name: 'Payment provider webhook and terminals', with: 'A payment provider, bank terminal or QR scheme that confirms payments',
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
    id: 'ocs', group: 'Network and SIM provisioning', name: 'Charging system (OCS)', with: 'Your real-time rating and charging system (voice, SMS and data)',
    summary: 'When a plan that has an OCS plan code starts, changes plan, is barred or restored, gets a new SIM or number, or ends, Meridian queues a vendor-neutral command and a connector for your OCS vendor delivers it: create the subscriber, subscribe the plan, and so on. Each vendor has its own connector, so Meridian does not depend on any one OCS. Jobs for a subscriber are delivered in order and retried when the OCS is down; one that cannot be delivered is kept for you to retry.',
    maturity: 'BUILT', direction: 'OUT',
    env: [{ name: 'MERIDIAN_OCS_TOKEN', purpose: 'Token for the generic REST connector (the name is yours to choose; it must start with MERIDIAN_OCS_)', on: 'web', secret: true }],
    endpoints: [{ method: 'POST', path: '/api/ocs/dispatch', purpose: 'Delivers due jobs to the OCS. Schedule it every minute', auth: 'Service account with billing:run' }],
    needs: ['Choose the connector for your OCS below (Generic REST needs no code; another vendor gets its own connector file)', 'Give each plan its OCS plan code in the catalog', 'Schedule POST /api/ocs/dispatch every minute', 'Services that started before the OCS was switched on are not sent'],
    doc: 'OCS.md', keywords: 'ocs charging rating real time online voice sms data subscriber provisioning huawei ericsson amdocs oracle optiva vendor connector plan',
  },
  {
    id: 'network-provisioning', group: 'Network and SIM provisioning', name: 'Network provisioning (HLR/HSS, policy control)', with: 'The core network: HLR/HSS, PCRF/PCF, plus any platform you name on a service kind',
    summary: 'When a service is barred, restored, changes plan or number, or ends, Meridian queues an instruction in the same transaction as the change; for services of a kind you define it also queues the start. A connector you deploy delivers it to the network and acknowledges it. (Charging-system provisioning has its own card above.)',
    maturity: 'OUTBOX', direction: 'OUT',
    outbox: NET(['PROVISION', 'DEPROVISION', 'PLAN_CHANGE', 'MSISDN_SWAP', 'ACTIVATE_PORTED_IN', 'THROTTLE_DATA', 'BAR_OUTGOING', 'BAR_ALL', 'RESTORE']), endpoints: POLL,
    needs: ['Build or buy an adapter that reads the outbox and talks to your HLR/HSS and PCRF', 'Authenticate it as a service account with billing:run', 'Systems and instruction names for your own service kinds are set in Settings → Service kinds'],
    configure: { label: 'Service kinds (systems and instructions)', href: '/admin/settings?section=service-kinds' }, doc: 'LIFECYCLE.md', keywords: 'hlr hss pcrf pcf provisioning network activate bar restore sim core',
  },
  {
    id: 'esim', group: 'Network and SIM provisioning', name: 'eSIM profile server (SM-DP+)', with: 'Your SM-DP+ (GSMA eSIM profile server)',
    summary: 'Creating an eSIM profile reserves an ICCID and IMSI and asks the SM-DP+ for the activation code. Today a stand-in generates a sample code; the real server replaces it behind the same one-method interface.',
    maturity: 'STUB', direction: 'OUT',
    needs: ['Implement createProfile({ iccid, imsi }) against your SM-DP+ (ES2+ interface)', 'Pass it where eSIM profiles are issued (nrm-pools.ts: issueEsimProfile)'],
    configure: { label: 'Numbers & SIMs', href: '/numbering' }, doc: 'NUMBERING.md', keywords: 'esim sm-dp+ smdp profile activation code lpa',
  },
  {
    id: 'sim-supplier', group: 'Network and SIM provisioning', name: 'SIM and number batch files', with: 'Your SIM vendor (ICCID, IMSI, eSIM codes) and your numbering plan',
    summary: 'SIM batches and number ranges arrive as files from the vendor and the regulator. Staff check and load them as CSV; nothing is fetched automatically.',
    maturity: 'MANUAL', direction: 'IN',
    needs: ['Ask the vendor for the batch file in the CSV layout of the template', 'Load it in Numbers & SIMs (check first, then load)'],
    configure: { label: 'Numbers & SIMs', href: '/numbering' }, doc: 'NUMBERING.md', keywords: 'sim vendor batch iccid imsi msisdn range import csv',
  },

  // ───────────── Number portability ─────────────
  {
    id: 'mnp-port-in', group: 'Number portability (MNP)', name: 'Port-in (numbers coming to us)', with: 'The national porting clearinghouse and the donor operators',
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
    id: 'mnp-port-out', group: 'Number portability (MNP)', name: 'Port-out (numbers leaving us)', with: 'The national porting clearinghouse and the recipient operators',
    summary: 'Staff record a port-out request. When the clearinghouse confirms the number has moved, the confirmation call ends the service: final bill, early-termination charge, deposit refund and SIM release.',
    maturity: 'ENDPOINT', direction: 'IN',
    endpoints: [{ method: 'POST', path: '/api/mnp/port-out/confirmation', purpose: 'The clearinghouse confirmed the move: { serviceId or msisdn, reference }; safe to repeat', auth: 'Service account with mnp:manage' }],
    needs: ['Have the clearinghouse connector call the confirmation endpoint', 'Until then staff complete port-outs on the service screen'],
    configure: { label: 'Number porting', href: '/mnp' }, doc: 'LIFECYCLE.md', keywords: 'mnp port out porting code recipient clearinghouse',
  },

  // ───────────── Logistics ─────────────
  {
    id: 'courier', group: 'Logistics and delivery', name: 'Courier and delivery tracking', with: 'Courier or last-mile delivery partner',
    summary: 'Staff mark an order shipped and type the tracking number; the order moves to Shipped and Delivered by hand. The order workflow’s shipGoods step is a stand-in that invents a tracking number. A courier connector would book the shipment and report status back.',
    maturity: 'MANUAL', direction: 'OUT',
    endpoints: [{ method: 'POST', path: '/api/orders/:id/actions', purpose: 'Actions ship ({ trackingNumber }), deliver, collect, return: a courier webhook handler calls these', auth: 'Service account with order permissions' }],
    needs: ['Choose the courier and get its shipment and tracking API', 'Build the connector: create the shipment when goods are ready; on delivery events call the order action'],
    configure: { label: 'Fulfilment options', href: '/admin/settings?section=fulfilment' }, doc: 'ORDERS.md', keywords: 'courier logistics delivery shipping tracking parcel last mile 3pl',
  },
  {
    id: 'installation', group: 'Logistics and delivery', name: 'Installation and field service', with: 'Field-service or technician scheduling system',
    summary: 'Fibre and similar offers need an installation. Staff schedule it and mark it done in the order. The workflow’s bookInstallation step is a stand-in; a field-service system would offer slots and report completion.',
    maturity: 'MANUAL', direction: 'OUT',
    endpoints: [{ method: 'POST', path: '/api/orders/:id/actions', purpose: 'Actions schedule_installation, complete_installation', auth: 'Service account with order permissions' }],
    needs: ['Choose the field-service system', 'Connector: send the job when an installation is needed; call the order action when the technician finishes'],
    doc: 'ORDERS.md', keywords: 'installation technician field service fibre dispatch appointment',
  },
  {
    id: 'warehouse', group: 'Logistics and delivery', name: 'Warehouse and stock files', with: 'Warehouse management system or supplier stock files',
    summary: 'Stock arrives by CSV, is moved between locations and written off in Inventory. No warehouse system is connected.',
    maturity: 'MANUAL', direction: 'IN',
    needs: ['Export stock from the warehouse system in the template layout', 'Load it in Inventory (check first, then load)'],
    configure: { label: 'Inventory', href: '/inventory' }, doc: 'ORDERS.md', keywords: 'warehouse stock inventory wms supplier csv import',
  },

  // ───────────── Customer messaging ─────────────
  {
    id: 'notifications', group: 'Customer messaging', name: 'SMS, email and push notifications', with: 'An SMS gateway and an email service',
    summary: 'Payment reminders, credit warnings, bar and restore notices, suspension and termination confirmations are queued as NOTIFY instructions with the account and the facts. A connector turns them into messages with your templates.',
    maturity: 'OUTBOX', direction: 'OUT',
    outbox: { kind: 'NOTIFY', instructions: ['PAYMENT_REMINDER', 'PAYMENT_THANKS', 'CREDIT_WARNING', 'CREDIT_LIMIT_REACHED', 'SERVICE_SOFT_BARRED', 'SERVICE_HARD_BARRED', 'FINAL_NOTICE', 'SUSPENSION_CONFIRMED', 'SERVICE_RESTORED', 'TERMINATION_CONFIRMED'] }, endpoints: POLL,
    needs: ['Pick an SMS gateway and an email service', 'Build the connector: read NOTIFY instructions, look up the customer’s contact, send, acknowledge', 'Write the message templates in each language you serve'],
    doc: 'LIFECYCLE.md', keywords: 'sms email notification message reminder push template whatsapp',
  },

  // ───────────── Finance and SAP ─────────────
  {
    id: 'sap', group: 'Finance and SAP', name: 'SAP general ledger export', with: 'SAP S/4HANA or ECC (through Integration Suite, an API gateway, or file load)',
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
    id: 'ledger-ingest', group: 'Finance and SAP', name: 'Billing and charging events into the ledger', with: 'Rating, charging and billing systems, or an event bus',
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
    id: 'commission-payouts', group: 'Finance and SAP', name: 'Dealer and agent payout files', with: 'Your bank (dealer transfers) and payroll (staff)',
    summary: 'Closing a month issues statements; Finance downloads the payout CSV, pays it through the bank or payroll, then confirms in Meridian. The file is generic; it needs mapping to your bank’s format.',
    maturity: 'MANUAL', direction: 'OUT',
    endpoints: [{ method: 'GET', path: '/api/commission/payouts/:id/file', purpose: 'Download the payout file', auth: 'commission:settle' }, { method: 'POST', path: '/api/commission/payouts/:id/confirm', purpose: 'Mark paid once the bank has paid', auth: 'commission:settle' }],
    needs: ['Map the CSV to your bank’s upload format (for example ISO 20022 pain.001)', 'Optionally automate: upload the file, then call confirm when the bank reports success'],
    configure: { label: 'Commission → Close & payouts', href: '/dealer/commission' }, doc: 'COMMISSION.md', keywords: 'commission payout bank payroll dealer agent statement pain.001',
  },

  // ───────────── Credit and collections ─────────────
  {
    id: 'credit-bureau', group: 'Credit and collections', name: 'Credit check', with: 'A credit bureau or internal scoring service',
    summary: 'The order workflow has a credit-check step before a postpaid order proceeds. Today a stand-in approves every order. Meridian’s own checks (credit limits per role, deposits, bars) do not call anything outside.',
    maturity: 'STUB', direction: 'OUT',
    needs: ['Choose the bureau or scoring service', 'Implement the creditCheck(orderId) activity in the order service and return { approved }'],
    doc: 'ORDERS.md', keywords: 'credit check bureau score underwriting risk',
  },
  {
    id: 'collections', group: 'Credit and collections', name: 'Collections agency and write-offs', with: 'A collections agency and the finance system',
    summary: 'When an account is written off, Meridian queues a COLLECTIONS hand-over (balance and invoices) and a GL write-off instruction.',
    maturity: 'OUTBOX', direction: 'OUT',
    outbox: { kind: 'COLLECTIONS', instructions: ['HAND_OVER'] }, endpoints: POLL,
    needs: ['Agree the hand-over format with the agency', 'Connector: read COLLECTIONS instructions, send to the agency, acknowledge'],
    doc: 'LIFECYCLE.md', keywords: 'collections agency debt write off hand over dunning',
  },

  // ───────────── Identity and compliance ─────────────
  {
    id: 'ekyc', group: 'Identity and compliance', name: 'Identity verification (eKYC)', with: 'An eKYC vendor (document check, liveness, registry lookup)',
    summary: 'Online applicants upload ID documents and a compliance officer reviews them (or, in automatic mode, clean applications are approved by the rules alone). In the CRM, staff sight the original ID in person. The rules below apply to the store-front, the CRM or both, as marked. No eKYC vendor is called today; automatic mode is meant to sit behind one.',
    maturity: 'MANUAL', direction: 'OUT',
    needs: ['Choose an eKYC vendor', 'Add a connector that verifies the document and selfie and feeds the result into the same checks', 'Keep automatic approval off until it exists'],
    configure: { label: 'Identity rules', href: '/admin/integrations?item=ekyc' }, doc: 'STOREFRONT.md', keywords: 'ekyc kyc identity verification liveness document id vendor compliance',
  },
  {
    id: 'secrets', group: 'Identity and compliance', name: 'Keys that protect customer data', with: 'Your secrets store',
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
    id: 'rating-gateway', group: 'Charging and usage', name: 'Online charging gateway (Diameter Gy / 5G CHF)', with: 'The packet core and online charging (OCS/CHF)',
    summary: 'The rating-gateway service is the hot path for balance reservations during sessions. It is a scaffold with an in-memory balance store; a Redis-backed store and the Diameter or Nchf front end are not built.',
    maturity: 'STUB', direction: 'BOTH',
    needs: ['Choose the protocol (Gy or Nchf) and the balance store', 'Feed balances from Meridian (usage, allowances) and send usage records to billing'],
    doc: 'ARCHITECTURE.md', keywords: 'charging rating ocs chf diameter gy nchf usage cdr balance redis prepaid',
  },

  // ───────────── Platform and events ─────────────
  {
    id: 'database', group: 'Platform and events', name: 'PostgreSQL database', with: 'PostgreSQL or AlloyDB',
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
    id: 'temporal', group: 'Platform and events', name: 'Workflow engine (Temporal)', with: 'Temporal server',
    summary: 'The order service runs the order, port-in, dunning and number-recycling workflows. Their steps call other systems (credit check, payment capture, inventory, shipping, notifications, clearinghouse) through activities that are stand-ins until real connectors replace them.',
    maturity: 'STUB', direction: 'BOTH',
    env: [{ name: 'TEMPORAL_ADDRESS', purpose: 'Temporal frontend address, default localhost:7233', on: 'order-service', required: true }],
    needs: ['Run Temporal (or Temporal Cloud) and the order-service worker', 'Replace the stand-in activities with real ones, one integration at a time'],
    doc: 'ARCHITECTURE.md', keywords: 'temporal workflow order service worker activity saga',
  },
  {
    id: 'event-bus', group: 'Platform and events', name: 'Event bus (Kafka)', with: 'Kafka or another message bus',
    summary: 'Workflows publish domain events by topic and key; today the publisher is a stand-in that logs. Inbound, the ledger accepts events over HTTP, so a Kafka consumer can post each message.',
    maturity: 'STUB', direction: 'BOTH',
    outbox: { kind: 'EVENT', instructions: ['VIP_NUMBER_AUCTION_WON', 'RECONCILIATION_MISMATCH'] },
    needs: ['Run Kafka and replace publishEvent with a producer', 'Optionally read the EVENT outbox for domain events that should leave Meridian'],
    doc: 'ARCHITECTURE.md', keywords: 'kafka event bus publish topic stream message broker',
  },
  {
    id: 'catalog-store', group: 'Platform and events', name: 'Catalog service database (MongoDB)', with: 'MongoDB',
    summary: 'The catalog service (NestJS) keeps its own document store. The portal’s own catalog lives in PostgreSQL.',
    maturity: 'BUILT', direction: 'BOTH',
    env: [{ name: 'MONGO_URL', purpose: 'MongoDB connection string', on: 'catalog-service', required: true, secret: true }],
    needs: ['Provide MongoDB if you run the catalog service'],
    doc: 'ARCHITECTURE.md', keywords: 'mongo mongodb catalog service document',
  },
  {
    id: 'outbox', group: 'Platform and events', name: 'Message outbox (adapter interface)', with: 'Any connector you build for the integrations marked “Outbox”',
    summary: 'Meridian never calls the network, messaging or collections systems inside a customer transaction. It writes an instruction in the same transaction and a connector delivers it later and acknowledges it, so nothing is lost or sent twice.',
    maturity: 'ENDPOINT', direction: 'OUT', endpoints: POLL,
    needs: ['Create a service account for each connector with billing:run', 'Make delivery idempotent: an instruction may be read again until acknowledged'],
    doc: 'OPERATIONS.md', keywords: 'outbox adapter connector queue instruction ack service account',
  },
  {
    id: 'scheduler', group: 'Platform and events', name: 'Scheduled jobs', with: 'A scheduler (cron, Vercel Cron, Kubernetes CronJob, Temporal schedule)',
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
  const ocsStats4 = await ocsStats(q), ocsSet = await getOcsSettings(q);

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
