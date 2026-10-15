# Integrations

**Integration** (left menu, below Settings; super user only) lists every connection between Meridian and another system, grouped by function. Each entry says what it is for, how it connects, what you must provide, the environment variables involved (shown as *set* or *not set*, never by value), the API the other side calls, the outbox instructions Meridian queues, and a live status. The store-front's API keys and terms moved here from Settings (old links still land in the right place).

## One place per integration, with where it applies

Stripe and identity verification each have **one** card; the settings inside say where they apply: the store-front, the CRM (staff selling), or both.

* **Payment gateways.** For each gateway, tick *Store-front* (customers pay by card at online checkout) and/or *CRM*. In the CRM, an order waiting for card payment shows **Get card payment link**: staff send the customer a Stripe-hosted page to open on their own phone. Card details are never typed into the CRM. The order is released by Stripe's signed webhook (`checkout.session.completed`), exactly as online. A gateway without a payment link (the development test gateway) cannot be switched on for the CRM.
* **Identity verification (KYC).** Each line is marked *Store-front*, *CRM* or both. Sign-up approval mode is store-front only. The in-person check is always a person, in the CRM. Minimum age applies to both. *Verified identity before a service is sold*: online it is always required; for the CRM it is a switch.
* **Store-front.** API keys, terms and privacy links, and how long unfinished sign-ups are kept.

The list lives in `packages/core/src/integrations.ts`; the page reads `GET /api/integrations`. Adding an integration is one entry there.

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
| Payments | Stripe | Stripe (cards and wallets for the store-front) | Built in; needs configuring |
| Payments | Payment provider webhook and terminals | A payment provider, bank terminal or QR scheme that confirms payments | API: the other system calls Meridian |
| Network and SIM provisioning | Network provisioning (HLR/HSS, policy control) | The core network: HLR/HSS, PCRF/PCF, plus any platform you name on a service kind | Outbox: a connector you deploy delivers it |
| Network and SIM provisioning | eSIM profile server (SM-DP+) | Your SM-DP+ (GSMA eSIM profile server) | Stand-in; real connector to be written |
| Network and SIM provisioning | SIM and number batch files | Your SIM vendor (ICCID, IMSI, eSIM codes) and your numbering plan | By hand; no connector yet |
| Number portability (MNP) | Port-in (numbers coming to us) | The national porting clearinghouse and the donor operators | Outbox: a connector you deploy delivers it |
| Number portability (MNP) | Port-out (numbers leaving us) | The national porting clearinghouse and the recipient operators | API: the other system calls Meridian |
| Logistics and delivery | Courier and delivery tracking | Courier or last-mile delivery partner | By hand; no connector yet |
| Logistics and delivery | Installation and field service | Field-service or technician scheduling system | By hand; no connector yet |
| Logistics and delivery | Warehouse and stock files | Warehouse management system or supplier stock files | By hand; no connector yet |
| Customer messaging | SMS, email and push notifications | An SMS gateway and an email service | Outbox: a connector you deploy delivers it |
| Finance and SAP | SAP general ledger export | SAP S/4HANA or ECC (through Integration Suite, an API gateway, or file load) | Built in; needs configuring |
| Finance and SAP | Billing and charging events into the ledger | Rating, charging and billing systems, or an event bus | API: the other system calls Meridian |
| Finance and SAP | Dealer and agent payout files | Your bank (dealer transfers) and payroll (staff) | By hand; no connector yet |
| Credit and collections | Credit check | A credit bureau or internal scoring service | Stand-in; real connector to be written |
| Credit and collections | Collections agency and write-offs | A collections agency and the finance system | Outbox: a connector you deploy delivers it |
| Identity and compliance | Identity verification (eKYC) | An eKYC vendor (document check, liveness, registry lookup) | By hand; no connector yet |
| Identity and compliance | Keys that protect customer data | Your secrets store | Built in; needs configuring |
| Charging and usage | Online charging gateway (Diameter Gy / 5G CHF) | The packet core and online charging (OCS/CHF) | Stand-in; real connector to be written |
| Platform and events | PostgreSQL database | PostgreSQL or AlloyDB | Built in; needs configuring |
| Platform and events | Workflow engine (Temporal) | Temporal server | Stand-in; real connector to be written |
| Platform and events | Event bus (Kafka) | Kafka or another message bus | Stand-in; real connector to be written |
| Platform and events | Catalog service database (MongoDB) | MongoDB | Built in; needs configuring |
| Platform and events | Message outbox (adapter interface) | Any connector you build for the integrations marked “Outbox” | API: the other system calls Meridian |
| Platform and events | Scheduled jobs | A scheduler (cron, Vercel Cron, Kubernetes CronJob, Temporal schedule) | API: the other system calls Meridian |

## Not covered

Nothing in the code calls these, so they are not listed as integrations: single sign-on (sign-in is local, with the super user in the environment), e-invoicing or tax-authority filing, and address or postcode lookup. Say if you need one and it becomes an entry.
