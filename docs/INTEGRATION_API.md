# Integration hub and northbound API gateway

Meridian exposes TM Forum Open API style endpoints to digital channels (self-care app, web portal, IVR and call centre, retail kiosks and POS, dealer apps, partner super-apps), and keeps every outside connection in one place: **Settings → Back office → Integration hub** (short link `/settings/integrations`, `settings:manage`). The older **Integration** page (`/admin/integrations`) is the status board that shows which connections are healthy; this page is where they are configured.

> This describes what is built. Things in the original design that are not: see [Not built](#not-built).

## What is built

| Area | Where |
|---|---|
| Hub configuration (endpoints, rate limits, webhooks, TMF 688 listeners, topic mappings, idempotency, call log) | `packages/core/src/integration-hub.ts`; tables in migration `0041` |
| OAuth 2.0 client credentials, JWT access tokens, secret rotation | `packages/core/src/oauth.ts` |
| API keys (store-front keys extended with northbound scopes, a channel, expiry and a signing secret) | `packages/core/src/apikeys.ts` |
| Gateway: authentication, scope check, signature check | `packages/core/src/gateway.ts` |
| Request pipeline (rate limit, idempotency, TM Forum errors, call log) | `northCall` in `apps/web/src/server/router.ts` |
| Subscriber operations (SIM swap, number change, transfer, status, plan change, value-added services) | `packages/core/src/subscriber-ops.ts`; migration `0042` |
| Settings UI | `apps/web/src/app/admin/settings/integration-hub.tsx` |

## Calling the API

Base path `/api`. Northbound endpoints are under `/api/v1/…` and `/api/tmf-api/…`.

1. **Get a token.** `POST /api/v1/oauth/token` with `grant_type=client_credentials`, `client_id`, `client_secret` (JSON, form-encoded, or HTTP Basic) and optionally `scope` (a subset of the client's scopes). The answer is `{access_token, token_type: "Bearer", expires_in, scope}`. Errors are RFC 6749: `{error, error_description}`.
2. **Call with it:** `Authorization: Bearer <access_token>`. An **API key** works the same way (`Bearer mk_…`). A key issued with *Require every request to be signed* must also send `X-Meridian-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` made with its signing secret (valid for 5 minutes either side).
3. **Check it:** `GET /api/v1/me` returns the credential, its channel and its scopes.

Each call is checked in this order: credential, scope (`403` if the credential lacks it), the channel's **rate limit** (`429` with `Retry-After`; `X-RateLimit-Limit` and `X-RateLimit-Remaining` on every answer), then, for state-changing routes, **idempotency**.

**Idempotency.** State-changing endpoints require `X-Idempotency-Key` (8 to 120 visible characters; a UUID is ideal). The first request with a key runs; a repeat with the same key and the same request returns the first answer with `Idempotent-Replay: true`; the same key with a different request is refused (`422`); a repeat while the first is still running is `409` (retry shortly). A request that failed frees its key. Keys are per credential.

**Errors** follow TM Forum guidelines: `{"code": "FORBIDDEN", "reason": "FORBIDDEN", "message": "…", "status": "403", "@type": "Error"}`.

**Scopes.** `subscriber:read`, `subscriber:write`, `sim:swap`, `msisdn:change`, `ownership:transfer`, `subscriber:status`, `subscription:change`, `vas:manage`, `order:create`, `order:read`, `order:cancel`, `billing:read`, `payment:create`, `event:subscribe`. A scope removed from a client stops working on tokens already issued; revoking a client stops all of them at once.

**Tokens** are HS256 JWTs signed with a key derived from `MERIDIAN_DATA_KEY` (falling back to `MERIDIAN_ID_PEPPER`). Rotating that key invalidates every outstanding token; clients simply ask for a new one. OIDC discovery and asymmetric (RS256) signing are not built.

## The six groups in Settings

1. **API gateway.** OAuth clients (create, edit scopes and token lifetime, **rotate the secret** with a grace period during which the old secret still works, revoke); API keys (scopes, channel, expiry, signed requests, revoke); **rate limits per channel** (defaults: self-care 100/min, retail POS 500/min, partner portal 50/min, call centre 300, others 60); the last API calls.
2. **Webhooks.** Outbound webhooks (target address, bearer or HMAC authentication, events, retries and wait) and inbound verification keys (HMAC key per provider: payment gateway, courier, dealer channel).
3. **Field service.** Dispatch-system gateways and appointment-slot sync settings.
4. **Core network.** HLR/HSS, UDM, PCRF, charging system and the SM-DP+ eSIM server: primary and fallback address (https, diameter, sftp…), timeout, credentials, protocol settings.
5. **Finance.** SAP FI-CO (SFTP or REST host, file destination) and payment providers.
6. **Events.** Which business event (`ORDER_CREATED`, `SIM_SWAPPED`, `SERVICE_SUSPENDED`, …) goes to which topic, and the TM Forum 688 subscribers.

Secrets typed into the hub are **encrypted** (AES-256-GCM, `MERIDIAN_DATA_KEY`) and never returned: a screen only shows that one is set. Credentials Meridian issues (OAuth client secrets, API keys) are kept as hashes and shown once. Every change is in the audit log, and every northbound call is in the integration call log.

## Subscriber and subscription operations

All of these are under `/api/v1`, need the scope shown and `X-Idempotency-Key`, and take a service by its id **or its number** (`{serviceId}` accepts `+6591234567`). Every answer is the service as a TMF 638 `Service` (`id`, `state`, `serviceCharacteristic`, `relatedParty`) plus a `result` describing what was done. Each operation audits who did it, tells the network and charging system through the outbox, and records an event (`SIM_SWAPPED`, `MSISDN_CHANGED`, `OWNERSHIP_TRANSFERRED`, `SERVICE_SUSPENDED`/`RESUMED`/`BARRED`/`TERMINATED`, `PLAN_CHANGED`, `VAS_CHANGED`) for the event bus.

| Call | Scope | What it does |
|---|---|---|
| `GET /v1/services/{id}` | `subscriber:read` | The service, its bar level and restriction, and the value-added services on it. |
| `POST /v1/services/{id}/otp` | `sim:swap` | Sends a six-digit one-time password by SMS to the number. Answer: `{challengeId, expiresAt, sentTo}`. At most 3 in 10 minutes. |
| `POST /v1/services/{id}/change-sim` | `sim:swap` | `{newIccid | esim: true, reason: LOST/STOLEN/DAMAGED/UPGRADE/ESIM_CONVERSION/OTHER, otpToken: "<challengeId>.<code>"}`. The new SIM must be in stock (or an eSIM profile is taken from the eSIM pool and its activation code returned). The old SIM is scrapped (lost, stolen, damaged) or decommissioned, its IMSI is quarantined, HLR/HSS/UDM/OCS updates are queued, the customer is told by SMS, and the fee (if any) is billed. The password works once and only five wrong tries are allowed. |
| `POST /v1/services/{id}/change-msisdn` | `msisdn:change` | `{targetMsisdn?, acceptCharge}`. The number is reserved from the pool (or the next free standard number is used), the old number rests in quarantine (the lifecycle setting), the VIP-tier fee plus the number-change fee must be accepted with `acceptCharge: true`, and the fee is billed. |
| `POST /v1/services/{id}/transfer-ownership` | `ownership:transfer` | `{currentAccountId?, toCustomerId, toAccountId?, creditCheckAuthorised: true}`. The new owner must be active, identity-verified (KYC), not a high credit risk and have nothing overdue; the departing owner must owe nothing. The departing owner gets a closing invoice for what is unbilled (no early-termination charge, the contract continues), instalments and the contract follow the service. |
| `POST /v1/services/{id}/status` | `subscriber:status` | `{action: SUSPEND/RESUME/SOFT_BAR/HARD_BAR/TERMINATE, reason?, months?, until?}`. A SUSPEND without a reason is the customer's voluntary suspension, capped by Settings → Lifecycle; `FRAUD` or `ADMIN` is an operator restriction. A bar put on here is lifted here; a bar billing put on lifts when the balance is paid. TERMINATE issues the closing invoice and charges the early-termination charge as usual. |
| `POST /v1/subscriptions/{id}/change-plan` | `subscription:change` | `{targetOfferId, effective: IMMEDIATE/NEXT_BILL_CYCLE, addOns?, acceptContractTerms?}`. A subscription is identified by its service. The new plan must be on sale and of the same kind of service; a cheaper plan on a running contract needs `acceptContractTerms`. IMMEDIATE moves now, pro-rates this period (billed on the next bill as an adjustment), updates the charging system and the contract, and adds the add-ons; NEXT_BILL_CYCLE schedules it for the account's next bill date and it takes effect the day after, in the daily job. `DELETE` on the same path cancels a scheduled change. |
| `POST /v1/services/{id}/vas` | `vas:manage` | `{action: ADD/REMOVE, offerId}` for roaming passes, boosters, insurance and partner subscriptions. A value-added service is its own subscription tied to the service; provisioning goes to the PCRF and OCS through the outbox, and partner offers also raise a `VAS_CHANGED` event with the partner code for the partner webhook. |

**Settings → Integration hub → API gateway → Rules for subscriber operations** sets whether a SIM swap needs the password, how long it lasts, and the fees (SIM replacement, number change, ownership transfer, plan change).

## TM Forum 688 (event management)

`POST /api/tmf-api/eventManagement/v4/hub` with `{ "callback": "https://…", "query": "eventType=…" }` (scope `event:subscribe`) registers a listener and returns `{id, callback, query}`; `DELETE …/hub/{id}` removes it (a client removes only its own; at most 20 each). The registered listeners appear under **Events** in the hub, where an administrator can pause or remove them.

## Not built

* Transfer of ownership to a **new** identity (registering the new owner in the same call) is not built: create the customer and complete KYC first (store-front applications or the customer API), then transfer.
* The SIM swap one-time password is held as a hash, but the SMS text (with the code) waits in the notification outbox until it is sent, so protect that table like any credential store.
* Network adapters (HLR/HSS, UDM, PCRF, SM-DP+) receive the instructions through the outbox; the protocol adapters themselves are connected per deployment.

* The stack is the one Meridian already runs on: route handlers in `apps/web`, PostgreSQL migrations, the outbox. There is no Prisma schema, NestJS gateway or GraphQL endpoint.
* The rate limiter counts in PostgreSQL (so all instances agree). A Redis-backed limiter can replace it behind the same call.
* Kafka publishing is configured here (topic mappings) and flows through the outbox; a Kafka producer is not shipped.
* The configured connections are stored and validated here. The existing adapters still read their own settings (for example the charging-system connector and the field-service connector) until each is moved onto the hub.
