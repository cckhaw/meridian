# Integrations

**Integration** (left menu, next to Settings; super user only) holds every connection between Meridian and another system. Its sections are grouped by what you are trying to do, and work like Settings (a menu on the left, the section on the right; on a phone the menu is the first screen):

| Group | Sections | Think of it as |
|---|---|---|
| Start here | Overview | What works, what needs setup, what is failing |
| Systems Meridian connects to | Network, numbers and charging · Payments and finance · Identity, credit and collections · Field service and logistics · Customer messaging | Meridian calls them. Each system is one card: status, what it is for, what to provide, and its address and credentials (*Connection details*) together |
| Channels and partners that connect to Meridian | Online store-front · API access · Inbound callbacks | They call Meridian: the shop, apps and partners with OAuth clients or API keys, and callbacks from payment providers and couriers |
| Events Meridian shares | Webhooks · Event streams and subscriptions · Delivery queue | Meridian tells others what happened |
| Platform | Platform and keys | The database, workflow engine, scheduler, outbox and the keys that protect data |

Search finds a section or a system by name (for example SAP, Kafka or courier). Old links (`?item=stripe`, `?view=hub`) still land in the right place.

## One place per integration, with where it applies

Stripe and identity verification each have **one** card; the settings inside say where they apply: the store-front, the CRM (staff selling), or both.

* **Payment gateways.** For each gateway, tick *Store-front* (customers pay by card at online checkout) and/or *CRM*. In the CRM, an order waiting for card payment shows **Get card payment link**: staff send the customer a Stripe-hosted page to open on their own phone. Card details are never typed into the CRM. The order is released by Stripe's signed webhook (`checkout.session.completed`), exactly as online. A gateway without a payment link (the development test gateway) cannot be switched on for the CRM.
* **Identity verification (KYC).** Each line is marked *Store-front*, *CRM* or both. Sign-up approval mode is store-front only. The in-person check is always a person, in the CRM. Minimum age applies to both. *Verified identity before a service is sold*: online it is always required; for the CRM it is a switch.
* **Store-front.** API keys, terms and privacy links, and how long unfinished sign-ups are kept.

The list lives in `packages/core/src/integrations.ts`; the page reads `GET /api/integrations`. Adding an integration is one entry there.

Charging-system (OCS) provisioning has its own guide: [OCS.md](OCS.md).

## How each one connects

| Pattern | Meaning |
|---|---|
| **Built in** | Meridian has a working connector (Stripe, SAP over REST, the store API). It needs keys or settings. |
| **Outbox** | Meridian never calls the network, messaging or collections systems inside a customer transaction. It writes an instruction in the same transaction (`lifecycle_outbox`); a connector reads `GET /api/lifecycle/outbox?pending=1`, delivers, and acknowledges with `POST /api/lifecycle/outbox/ack`. |
| **API** | Meridian offers an endpoint and the other system calls it (payment webhook, ledger events, port-out confirmation, scheduled jobs). |
| **By hand** | A person moves a file or types a reference (SIM batches, courier tracking, payout files). No connector exists yet. |
| **Stand-in** | The interface exists and a stand-in answers (eSIM SM-DP+, credit check, the rating gateway, the event bus, Temporal activities). |

## Status

* **Connected:** configured, or a connector has been seen acknowledging instructions.
* **Needs setup:** a key, URL or setting is missing.
* **Needs a connector:** instructions are queued (or would be) and nothing has acknowledged any.
* **Ready for calls:** the endpoint is there, waiting for the other system.
* **Set elsewhere:** configured on another deployment (store-front, order service, catalog service) that this page cannot see.
* **By hand / Stand-in:** no real system is connected.

“Connected” for an outbox integration is inferred, not proven: it means at least one instruction was acknowledged. Delivery health beyond that is the connector's to report.

## What is covered

| Group | Integration | With | How |
|---|---|---|---|
| Online store-front | Online store-front | The self-serve web shop (apps/storefront) and any other client you build | Built in; needs configuring |
| Payments and finance | Stripe | Stripe (cards and wallets for the store-front) | Built in; needs configuring |
| Payments and finance | Payment provider webhook and terminals | A payment provider, bank terminal or QR scheme that confirms payments | API: the other system calls Meridian |
| Network, numbers and charging | Network provisioning (HLR/HSS, policy control) | The core network: HLR/HSS, PCRF/PCF, plus any platform you name on a service type | Outbox: a connector you deploy delivers it |
| Network, numbers and charging | eSIM profile server (SM-DP+) | Your SM-DP+ (GSMA eSIM profile server) | Stand-in; real connector to be written |
| Network, numbers and charging | SIM and number batch files | Your SIM vendor (ICCID, IMSI, eSIM codes) and your numbering plan | By hand; no connector yet |
| Network, numbers and charging | Port-in (numbers coming to us) | The national porting clearinghouse and the donor operators | Outbox: a connector you deploy delivers it |
| Network, numbers and charging | Port-out (numbers leaving us) | The national porting clearinghouse and the recipient operators | API: the other system calls Meridian |
| Field service and logistics | Courier and delivery tracking | Courier or last-mile delivery partner | By hand; no connector yet |
| Field service and logistics | Installation and field service | Field-service or technician scheduling system | By hand; no connector yet |
| Field service and logistics | Warehouse and stock files | Warehouse management system or supplier stock files | By hand; no connector yet |
| Customer messaging | SMS, email and push notifications | An SMS gateway and an email service | Outbox: a connector you deploy delivers it |
| Payments and finance | SAP general ledger export | SAP S/4HANA or ECC (through Integration Suite, an API gateway, or file load) | Built in; needs configuring |
| Payments and finance | Billing and charging events into the ledger | Rating, charging and billing systems, or an event bus | API: the other system calls Meridian |
| Payments and finance | Dealer and agent payout files | Your bank (dealer transfers) and payroll (staff) | By hand; no connector yet |
| Identity, credit and collections | Collections agency and write-offs | A collections agency and the finance system | Outbox: a connector you deploy delivers it |
| Identity, credit and collections | Credit bureau | A credit bureau (REST) or the built-in simulator | Built in; needs configuring |
| Identity, credit and collections | Identity verification (eKYC) | An eKYC vendor (document check, liveness, registry lookup) | By hand; no connector yet |
| Platform | Keys that protect customer data | Your secrets store | Built in; needs configuring |
| Network, numbers and charging | Online charging gateway (Diameter Gy / 5G CHF) | The packet core and online charging (OCS/CHF) | Stand-in; real connector to be written |
| Platform | PostgreSQL database | PostgreSQL or AlloyDB | Built in; needs configuring |
| Platform | Workflow engine (Temporal) | Temporal server | Stand-in; real connector to be written |
| Events and streaming | Event bus (Kafka) | Kafka or another message bus | Stand-in; real connector to be written |
| Platform | Catalog service database (MongoDB) | MongoDB | Built in; needs configuring |
| Platform | Message outbox (adapter interface) | Any connector you build for the integrations marked “Outbox” | API: the other system calls Meridian |
| Platform | Scheduled jobs | A scheduler (cron, Vercel Cron, Kubernetes CronJob, Temporal schedule) | API: the other system calls Meridian |

## Not covered

Nothing in the code calls these, so they are not listed as integrations: single sign-on (sign-in is local, with the super user in the environment), e-invoicing or tax-authority filing, and address or postcode lookup. Say if you need one and it becomes an entry.

Each system's address and credentials are set on the system itself, under **Integration** (open the system, then *Connection details*). API credentials and rate limits are under **Integration → API access**, webhooks and subscriptions under **Events Meridian shares**; see [INTEGRATION_API.md](INTEGRATION_API.md).
