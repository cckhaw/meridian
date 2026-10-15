# Charging system (OCS) integration

Plans that carry an **OCS plan code** are provisioned into your online charging system: the subscriber is created and subscribed to the plan, moved when the plan changes, barred or restored, given the new SIM or number, and closed when the service ends. The connector is chosen **per vendor**, so Meridian does not depend on any one charging system.

| Piece | Where |
|---|---|
| The contract (vendor-neutral commands and what a connector must do) | `packages/core/src/ocs-vendors/types.ts` |
| Connectors, one file per vendor, and the registry | `packages/core/src/ocs-vendors/` (`generic-rest.ts`, `simulator.ts`, `index.ts`) |
| Queue, delivery, retries, settings | `packages/core/src/ocs.ts`, table `ocs_jobs` (migration `0029`) |
| Screen | Integration → Charging system (OCS) |
| Plan code on an offer | Catalog → edit the offer → Availability → Charging system (OCS), shown once the OCS is on |

## How it works

1. **A change happens** in Meridian (an order starts a service, a plan changes, a service is barred, restored, gets a new SIM or number, or ends). In the **same transaction**, a job is written to `ocs_jobs` in vendor-neutral terms (`OcsRequest`).
2. **A dispatcher** delivers due jobs to the connector of the chosen vendor: `POST /api/ocs/dispatch` (service account with `billing:run`; schedule it **every minute**) or **Run now** on the screen.
3. **Order and retries.** Jobs of one subscriber are delivered strictly in order: a later job waits for the earlier ones. When the OCS is down, a job is retried after 1 min, 5 min, 30 min, 2 h and 12 h; a refusal (the OCS says the plan is unknown, say) is not retried. A job that fails for good is kept (**Failed**) and Ops hear through an `OCS_JOB_FAILED` event in the outbox; later jobs of that subscriber wait behind it until you press **Retry**.
4. Each job carries an idempotency key, passed to the vendor, so a repeat is harmless.

| Command | Sent when | What the vendor is asked |
|---|---|---|
| `PROVISION` | A service with a plan code starts (order, or a ported-in number arriving) | Create the subscriber and subscribe the plan. Never sent twice for a service |
| `CHANGE_PLAN` | A line moves to another plan (for example to a group plan) | Move the subscriber. If it was never in the OCS, this becomes `PROVISION` |
| `SET_BARRING` | Any bar, throttle, suspension (voluntary, credit, dunning, fraud) or restore | Level `NONE`, `THROTTLE`, `SOFT` or `HARD`. Emergency calls are always allowed |
| `CHANGE_IDENTITY` | New SIM, new number, or a temporary number replaced by the ported-in one | From and to |
| `TERMINATE` | The service ends (customer, expiry, port-out) | Close the subscriber |

What a request carries: the service id, number (MSISDN) or circuit, type and kind, ICCID and IMSI, the customer and account ids, segment, market, the account's credit limit, and the plan code with its parameters. No names or contact details are sent.

**Only subscribers that were provisioned get later commands.** Turning the OCS on does not send services that started before, and an offer without a plan code is never sent. The screen lists the plans on sale that have no code.

## Choosing and configuring a connector

* **Simulator:** accepts everything (or refuses everything, to see retries). For development and demos.
* **Generic REST / JSON:** for a charging system with a REST interface, configured instead of coded. For each command, set the method, a path and a JSON body, with `{{placeholders}}` (`msisdn`, `imsi`, `iccid`, `planCode`, `planParams`, `creditLimitMinor`, `barLevel`, `newIdentifier`, `expiresAt` and more; the screen lists them). A value that is exactly one placeholder keeps its type. Values are put into the parsed JSON, never glued into text, so they cannot break it. A command with no path is skipped and recorded as skipped; `PROVISION` is required. HTTP 2xx is success; 409 is treated as "already there"; 408, 425, 429 and 5xx and network errors are retried; other 4xx are not.
* **Secrets:** the token lives in a server environment variable whose name starts with `MERIDIAN_OCS_` (for example `MERIDIAN_OCS_TOKEN`); the screen stores only the name. Plain `http` is accepted only for localhost outside production.
* Settings are kept per vendor, so switching vendor does not lose the other's.

## Adding a vendor

When a charging system does not fit the generic connector (SOAP, Diameter, several calls for one command, its own session handling), write one file in `packages/core/src/ocs-vendors/`:

```ts
export const acmeVendor: OcsVendor = {
  id: 'acme', label: 'Acme OCS', summary: '…', real: true,
  fields: [{ key: 'endpoint', label: 'Endpoint', kind: 'url', required: true }, …], // the screen is drawn from these
  defaults: () => ({ … }),
  validate: (raw) => /* check and clean, throw a plain-words error */,
  create: (config, env) => ({
    vendor: 'acme',
    problem: () => /* what is missing, or null */,
    async handle(req) { /* turn req.command into Acme's calls; return { ok: true, reference } or { ok: false, retryable, detail } */ },
    async test() { … },
  }),
};
```

and add it to `OCS_VENDORS` in `index.ts`. Nothing else changes: orders, lifecycle and billing only ever see the contract.

## Limits

* Only the **generic REST** connector and a **simulator** are provided. No named vendor's connector is included: those need that vendor's interface specification and a test system.
* An add-on offer creates its own subscription in Meridian and is not linked to the line it extends, so it is sent as its own subscriber, not as an extra product on the line's number.
* Services are **not** back-filled when the OCS is switched on, and the CSV offer import does not carry the plan code yet.
* Balances, top-ups and usage are not part of this: Meridian provisions, the OCS charges.
* One charging system at a time.
