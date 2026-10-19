# Integrations

**Integration** (left menu, next to Settings; super user only) holds every connection between Meridian and another system. Its sections are grouped by what you are trying to do, and work like Settings (a menu on the left, the section on the right; on a phone the menu is the first screen):

| Group | Sections | Think of it as |
|---|---|---|
| Start here | Overview | What works, what needs setup, what is failing |
| Systems Meridian connects to | Network, numbers and charging · Payments and finance · Identity, credit and collections · Field service and logistics · Sign-in and identity · Messaging | Meridian calls them. Each system is one card: status, what it is for, what to provide, and its address and credentials (*Connection details*) together |
| Channels and partners | Online store-front · API access · Inbound callbacks | They call Meridian: the shop, apps and partners with OAuth clients or API keys, and callbacks from payment providers and couriers |
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

## Messaging: the SMS / WhatsApp gateway and the e-mail sender

Integration → **Messaging** holds Meridian's two sending endpoints. Both live in the hub's `auth` group, are saved through the same endpoint API, keep their secret encrypted and write-only (the screen shows *Secret set*, never the value), and are never exported by the migration module. Neither is a vendor integration: you give each one the address and credentials of whatever provider you use.

### SMS / WhatsApp gateway (kind `OTP_GATEWAY`)

Meridian posts JSON to it (`to`, `channel`, `text`, `templateId`, `senderId`, `variables`, `reference`; bearer token) for:

| What | Template id | When it is sent |
| --- | --- | --- |
| One-time codes (second factor, password recovery) | `MFA`, `RESET` | At once; a refused code stays in the outbox (`POST /api/jobs/deliver-otp`) |
| Staff alerts that the person ticked SMS for in My profile → Notifications | `ALERT` | At once, waiting a few seconds at most; otherwise by the heartbeat |
| Signed agreement copies for customers (one message per copy, with a secure 15-minute link) | `CONTRACT` | By the heartbeat, the hourly sweep or `POST /api/jobs/deliver-notifications` |

With no enabled gateway nothing is sent by text message: staff SMS alerts are not queued (the Notifications tab says so), and signed copies go by e-mail if the customer has an address and a sender is set up, otherwise stay queued (Settings → Documents says so). The gateway carries text only, so documents are never attached. It does not carry e-mail; that is the sender below.

### E-mail sender (kind `EMAIL_GATEWAY`)

Set up in Integration → Messaging → *E-mail sender*, entirely from fields (no JSON): a name, the **sender name** and **from address**, an optional **reply-to**, a **time limit**, an on/off switch, and a **mode**:

* **HTTPS API**: the provider's address, how the token is sent (a bearer token, a header with a name you choose, or none), the token (the endpoint's secret) and the **request body** as JSON with placeholders `{{to}}`, `{{subject}}`, `{{text}}`, `{{html}}`, `{{from}}`, `{{fromName}}`, `{{replyTo}}`. Presets fill in a generic JSON provider (token as bearer, token in a header, flat JSON); no vendor and no credential is built in, so adjust the field names to your provider's documentation. Values are put into the parsed JSON, never spliced into text, so nothing in a message can add a field; a field whose whole value is one placeholder with nothing to fill (no reply-to, no HTML) is left out.
* **SMTP**: host, port, security (STARTTLS required, TLS from the start, or none) and user; the password is the endpoint's secret. Sent with nodemailer. Without encryption is only accepted to this machine itself in production. STARTTLS fails rather than send in the clear.
* **Simulator**: records the message (last 50, a week at most; shown on the screen) and sends nothing. Messages that carry sign-in codes are recorded in clear, so use it only to try things out.

**Send a test e-mail** (per sender, to an address you type or your own) sends through exactly what is saved, even if the sender is switched off, and shows success or the provider's error; the result also shows in the Integration overview status line. One helper, `sendEmail(db, {to, subject, text, html?})` in `packages/core/src/email-gateway.ts`, is the only code that talks to a provider. It returns `{ ok, error?, retryable }`. Every call has the time limit; redirects are never followed; at most a few kilobytes of the provider's answer are read; the recipient, subject and sender fields must be one line and the recipient a single address (a line break or a second recipient is refused before anything is sent); the token and password are never in an error or a log. Timeouts, connection failures, 408, 425, 429, 5xx and SMTP 4xx are retryable; everything else is permanent. Tests replace the HTTP call with `setEmailHttp`.

What goes through it:

| What | When it is sent |
| --- | --- |
| Staff e-mail alerts (My profile → Notifications → E-mail). Short plain text, never codes, links or passwords | At once, waiting a few seconds at most; otherwise by the heartbeat. Retried after 1, 5, 15, 60 and 240 minutes, then marked failed; a bad address fails at once. With no enabled sender the row stays queued untouched and goes out once one is set up |
| Signed agreement copies (a secure 15-minute link, nothing attached) | When the customer has an address and a sender is on. A customer with both a mobile number and an address is tried on the channel set in Settings → Security policy → E-mail codes (*Signed agreement copies go first by*; default the gateway, then e-mail) and on the other if the first fails; the row records the channel that carried each copy |
| Sign-in codes by e-mail, and the link or code for password recovery | Only while Settings → Security policy → *Allow sign-in and recovery codes by e-mail* is on **and** a sender is enabled (see SECURITY.md). Sent at once with the sign-in or request; wiped from the outbox once sent |

Without an enabled sender: e-mail alerts wait in the notification outbox, signed copies use the gateway or wait, and e-mail codes are not offered anywhere. The old `"emailCodes": true` setting of the SMS gateway no longer exists; migration 0059 turned a stored `true` into the policy switch (you still have to add the sender).

Alerts and signed copies refused by a channel are retried after 1, 5, 15, 60 and 240 minutes, then marked failed with the reason (`lifecycle_outbox.attempts`, `last_error`, `failed_at`).

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
| Messaging | SMS / WhatsApp gateway | An SMS or WhatsApp gateway | Built in: Meridian posts to it |
| Messaging | E-mail sender | An e-mail API, an SMTP server or the simulator | Built in: Meridian sends through it |
| Messaging | Account notices (reminders, bar and restore) | Your own connector | Outbox: a connector you deploy delivers it |
| Payments and finance | SAP general ledger export | SAP S/4HANA or ECC (through Integration Suite, an API gateway, or file load) | Built in; needs configuring |
| Payments and finance | Billing and charging events into the ledger | Rating, charging and billing systems, or an event bus | API: the other system calls Meridian |
| Payments and finance | Dealer and agent payout files | Your bank (dealer transfers) and payroll (staff) | By hand; no connector yet |
| Identity, credit and collections | Collections agency and write-offs | A collections agency and the finance system | Outbox: a connector you deploy delivers it |
| Identity, credit and collections | Credit bureau | A credit bureau (REST) or the built-in simulator | Built in; needs configuring |
| Identity, credit and collections | Identity verification (ID check service) | A REST service (document OCR, face match, liveness), or the built-in simulator | Built; configured by response map |
| Identity, credit and collections | MyDigital ID | MyDigital ID (OpenID Connect) | Built; an alternative to the photographs |
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
