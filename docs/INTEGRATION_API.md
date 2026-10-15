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

## TM Forum 688 (event management)

`POST /api/tmf-api/eventManagement/v4/hub` with `{ "callback": "https://…", "query": "eventType=…" }` (scope `event:subscribe`) registers a listener and returns `{id, callback, query}`; `DELETE …/hub/{id}` removes it (a client removes only its own; at most 20 each). The registered listeners appear under **Events** in the hub, where an administrator can pause or remove them.

## Not built

* The stack is the one Meridian already runs on: route handlers in `apps/web`, PostgreSQL migrations, the outbox. There is no Prisma schema, NestJS gateway or GraphQL endpoint.
* The rate limiter counts in PostgreSQL (so all instances agree). A Redis-backed limiter can replace it behind the same call.
* Kafka publishing is configured here (topic mappings) and flows through the outbox; a Kafka producer is not shipped.
* The configured connections are stored and validated here. The existing adapters still read their own settings (for example the charging-system connector and the field-service connector) until each is moved onto the hub.
