# Fibre coverage and serviceability (FTTH)

An optional module, deployed on its own like the store-front (`apps/fiber-coverage`, domain code in `packages/fiber`). The CRM never imports it: when the module is off, or the service is down, the CRM keeps working.

## What it answers

*Can this address be served, by whom, at which speeds, is there a free port, and how long will installation take?* — and it can hold a port while the customer checks out.

| Piece | Where |
|---|---|
| Providers: **owned** network and **wholesale partners** (agreement id, cost per port, install lead time, SLA response window, speed tiers, REST/SOAP adapter) | `fiber_providers` |
| Inventory: cabinets → distribution points (FDP/DP, splitter 1:2 to 1:64) → ports (`AVAILABLE`, `RESERVED_CHECKOUT`, `RESERVED_ORDER`, `IN_USE`, `FAULTY`) | `fiber_cabinets`, `fiber_dps`, `fiber_ports` |
| Coverage polygons (DP reach, cabinet boundary, partner service areas) | `fiber_coverage_polygons` |
| Address gazetteer (postal code → state → city → street/building → unit) | `fiber_addresses` |
| Partner answer cache, port locks, waitlist, expansion requests, import jobs, TMF 645 records | `fiber_*` (migration `0051`; no references to core tables) |

## How a check works (`GET /api/v1/coverage/qualify-address`)

1. **Locate**: GPS (`lat`, `lng`) is used as is; an address is matched against the gazetteer (exact, then the same building without the unit, then an optional plug-in geocoder, then the middle of the postcode). The answer says which (`precision`: `GPS`, `ADDRESS`, `GEOCODER`, `POSTCODE`).
2. **Own network**: distribution points whose reach covers the place, and polygons that contain it (indexed bounding boxes, then exact distance and point-in-polygon).
3. **Partners, in parallel**: a partner with a live adapter is asked (default timeout 2.5 s) and its answer cached for 24 hours; one that is slow or down is left out and listed in `partnerErrors`. A partner with no live adapter, or whose adapter is off or failed, is answered from its imported coverage files.
4. **Result**: `availability` (`AVAILABLE`, `PORT_EXHAUSTED_WAITLIST`, `UNSERVICEABLE`, and `UNKNOWN` when a partner could not be reached and nobody else covers the place), and per option: provider and owner type, speed tiers, free/total ports, the distribution point and its distance, estimated installation days, SLA hours, source. Commercial terms (cost per port, agreement id) are never returned to callers.

Pass `speedMbps` to ask for a speed: options that cannot reach it are not recommended.

## Port locks

`POST /api/v1/coverage/reservations {providerId, dpId?, customerRef, speedMbps}` claims a free port in one statement that skips rows another checkout holds, so two customers never get the same port. The lock lasts 30 minutes (Overview → Behaviour). The same customer asking again renews their lock. `…/confirm {orderRef}` turns it into a hold for the order, `…/release` frees it, `…/activate` marks it in use once installed. Expired locks count as free at once and are cleaned up by the sweep (`POST /api/admin/sweep`, or the button on Overview). A partner with no port inventory gets a soft hold recorded without a port.

When no port is free the caller can `POST /api/v1/coverage/waitlist`; the hub's **Ports and waitlist** page shows distribution points by pressure (exhausted, low, healthy; see *Low-port settings* below), tells waiting customers when a port frees up (a `FIBER_PORT_AVAILABLE` notification through the outbox), and tracks expansion requests for network planning.

### Low-port settings (map colours and levels)

Overview → Behaviour holds two settings, **“Low” when this few ports are free** (default 2) and **…or this share is free (%)** (default 15). One rule, `classifyPorts` in `packages/fiber/src/port-level.ts`, applies them everywhere: a distribution point is **exhausted** when no port is free, **low** when the free count is at or under the first setting *or* the free share of its usable ports (faulty ports left out) is at or under the second (either one is enough), otherwise **healthy**. The **Ports and waitlist** page and the **Map** both use it: the map's data (`GET /api/admin/map`) carries each point's `level` and the thresholds used (`settings`), so the dots (green, amber, red) and the colour key under the map always match the page, and a change to the settings shows the next time the map loads.

## Standard interfaces

* **TMF 645 Service Qualification**: `POST/GET /tmf-api/serviceQualificationManagement/v4/serviceQualification[/{id}]`. Each item names a place (postcode, address parts or a GeoJSON point) and, as a service characteristic, the speed wanted. `qualified` = a port at that speed; `alternate` = servable only after a wait or at another speed (alternatives are attached); `unqualified` = no coverage.
* **TMF 673 Geographic Address Management**: `GET …/geographicAddress[/{id}]` and `POST …/geographicAddressValidation`.
* Errors on `/tmf-api` use the TM Forum error shape.

Callers authenticate with an API key holding the `fiber` scope (issue one under Overview → Access keys), `Authorization: Bearer mk_…`. While the module is off every client call answers `503 MODULE_DISABLED`.

## Admin hub (`/settings/fiber-coverage`)

Sign in with a Meridian staff account that may manage settings (second factor supported; see *Sign-in codes* below). Tabs: **Overview** (master ON/OFF switch, partner adapter switches, lock/cache/timeout, access keys, recent locks), **Providers** (with a *Test* button that sends one real request to a partner and shows how its answer is read), **Network** (DPs with a port grid, cabinets, coverage areas), **Map** (Leaflet: inspect, click-to-check, draw an area), **Import** (CSV / GeoJSON / KML: check, then load all-or-nothing; templates), **Ports and waitlist**, **Try a check**.

Import: points become distribution points, areas become polygons (properties `provider`, `name`, `speedTiers`, `capacityStatus`, `dp`), a CSV with `postalCode` and no `code` column loads addresses. Rows are matched by (provider, code) for points and (provider, name) for areas, so re-sending a file updates instead of duplicating.

Partner adapter settings are data: `paths` say where in the partner's JSON (or SOAP body) to read `serviceable`, `portStatus`, `speedsMbps`, `leadDays`, `reference`; REST also takes `method`, `query`, `body` (placeholders `{{lat}} {{lng}} {{postalCode}} {{address}} {{speedMbps}}`) and `authHeader`; SOAP takes `soapAction` and a `body` template.

## Sign-in codes (SMS, e-mail, authenticator)

The hub signs in with the CRM's code, so its second-factor rules are the CRM's: a challenge lasts the policy's 1 to 30 minutes, locks after 5 wrong tries, wrong codes are throttled per address, and a locked or disabled account is refused. The code step shows only what that person has set up (an authenticator-only person sees "Code from your authenticator" and no SMS or e-mail wording or buttons). Recovery codes always work.

* **Authenticator**: checked against the stored secret; nothing is sent.
* **SMS / e-mail at sign-in**: if the person's method is SMS or e-mail, the code is queued with the challenge and the hub hands it to the gateway at once. The step then says where it went, masked (`+65•••67`, `a•••@example.com`).
* **Send me a code / Send it another way / Resend code** (`POST /api/admin/2fa/send-code {challenge, method}`): offered for each of the person's SMS or e-mail methods that this site can send. Rules, the same as the CRM's shared code: one code per method every 30 seconds (the button counts down, and the server answers `429` with `Retry-After`), 5 codes per sign-in, 10 per account per hour, plus 30 requests per address per 15 minutes. A new code replaces the old one. It answers the same for a sign-in that never existed and one that has run out ("This sign-in has expired. Sign in again."), and no answer names an account, so it cannot be used to find out who exists.
* **Who delivers**: the SMS / WhatsApp gateway and the e-mail sender (Integration hub → Messaging) and their tokens are settings in the shared database, so **the hub calls them itself**. If it cannot reach it (or the gateway refuses), it asks the CRM, with a **signed server-to-server call** (`POST {MERIDIAN_CRM_URL}/api/internal/fiber/deliver-otp`, header `X-Meridian-Signature: t=…,v1=<HMAC-SHA256>`, the same scheme as the field-service callback, valid 5 minutes, key derived from the fibre API key). The call carries only the recipient; the CRM delivers the code already waiting for it. A code that goes neither way stays queued for the CRM's `POST /api/jobs/deliver-otp` retry, and the step says "has not gone out yet".
* **Nothing to send with**: asking for an SMS code with no gateway, or an e-mail code while e-mail codes are off or no sender is enabled, answers `503 CODE_DELIVERY_UNAVAILABLE` ("… Use your authenticator app or a recovery code, or ask an administrator.") and queues nothing; the buttons are not shown.
* **E-mail codes** follow the CRM's setting: Settings → Security policy → *Allow sign-in and recovery codes by e-mail* (default off) **and** an enabled e-mail sender in Integration → Messaging. Both on: the e-mail method is offered at the hub and the code goes out through the sender (same fall-back to the CRM as SMS). Either off: the hub does not offer e-mail codes and refuses to send one. There is no setting in the SMS gateway for this any more.

Only the environment's super user can manage settings (`settings:manage` cannot be given to a role), and that account has no second factor. So today nobody completes a hub sign-in with a code: the code step is checked, and the hub then declines a person whose role may not manage fibre coverage. The code flow is ready for the day a role may.

## How Meridian uses it

The CRM and the store-front never import the module; they call the service over HTTP (`MERIDIAN_FIBER_URL`, `MERIDIAN_FIBER_API_KEY`) and carry on if it is slow, down or switched off.

* **Order screen (CRM)**: when a fibre plan is in the basket, the *Delivery and installation* step shows the **coverage check** under the installation address. It asks the service, shows the answer, and (when a port is free) holds one for the customer. Placing the order checks the hold is still there (a lock that ran out sends the agent back to check again, and no order is created) and then confirms the port for the order; if that confirmation fails the order still stands and a `FIBER_CONFIRM_FAILED` audit entry tells Fibre Ops. The port's reservation id is kept on the order (`fulfilment.fiber`).
* **Store-front**: a basket with a fibre plan now asks for the **installation address** (it used to ask only for delivery of goods), shows the same coverage check, holds the port on the application, and checkout verifies and confirms it the same way.
* **When the service is down or the answer is `UNKNOWN`**: the check says so, the order can go ahead, and the address is confirmed afterwards.
* **Waitlist**: when every port is taken the shopper or agent can leave a phone number or e-mail and joins the waitlist.

## Switching it on and off

`FEATURE_FIBER_COVERAGE_MODULE_ENABLED` (`on`/`off`; **unset means on**, so a deployment that sold fibre before this module existed keeps selling it) is the starting value. Once an administrator uses the switch (Meridian **Settings → Modules**, or the hub's Overview; both write the same setting, `modules`), the stored choice wins.

**Off** means: the coverage check is hidden, fibre installation scheduling is not offered, and fixed-broadband offers (every offer type that creates a FIBER service) are not for sale: they disappear from the order screen, the store-front and any list used for selling, and a basket that still contains one is refused ("… is not on sale right now"). The Catalog pages still show them so they can be maintained, orders already placed are untouched, and switching on restores everything. Client calls to the coverage service answer `503 MODULE_DISABLED`.

## Deploying (separate Vercel project, like the store-front)

Create a Vercel project from this repository with **root directory `apps/fiber-coverage`** (and "include source files outside the root directory" on), framework Next.js. Environment variables, the same as the CRM's wherever they say so:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | The CRM's Postgres. The hub signs in with Meridian staff accounts and shares its settings and audit log, and the tables are created by the same migrations. |
| `MERIDIAN_DATA_KEY` / `MERIDIAN_ID_PEPPER` | **Must equal the CRM's**: they encrypt the partner adapter credentials and sign-in secrets. |
| `MERIDIAN_SUPERUSER_USERNAME`, `MERIDIAN_SUPERUSER_PASSWORD` | As in the CRM, if the super user will sign in here. |
| `FEATURE_FIBER_COVERAGE_MODULE_ENABLED` | Optional starting value (unset means on). |
| `MERIDIAN_CRM_URL`, `MERIDIAN_FIBER_API_KEY` | Optional, only for sign-in codes when the hub cannot reach the SMS gateway itself: the CRM's address, and the same fibre key the CRM uses to call the hub (it only keys the signature; it is never sent). The CRM needs `MERIDIAN_FIBER_API_KEY` too, as it does already. Without them the hub still calls the gateway directly. |

On the **CRM** deployment set `MERIDIAN_FIBER_URL` (the service's address) and `MERIDIAN_FIBER_API_KEY` (a key issued in the hub's Overview → Access keys). The store-front needs nothing: it reaches the service through the CRM.

Map tiles come from OpenStreetMap; to use another tile provider change `TILES` in `src/components/map.tsx` and `img-src` in `next.config.mjs`. Schedule `POST /api/admin/sweep` is not needed for correctness (expired locks already count as free); it only tidies the table.

`pnpm --filter @meridian/fiber-coverage seed:demo` loads sample Singapore coverage into the embedded database (it refuses to write to `DATABASE_URL` without `--yes`; never use it on production).

## Not included

PostGIS (geometry is GeoJSON with bounding-box indexes so it runs on the embedded database; swap in PostGIS if a national network outgrows it), Redis (the partner cache is a table with a TTL), a bundled geocoder (`setGeocoder` takes one), live port reservation on a partner's side (partner holds are recorded here only), and a drawn fibre-line trace layer (cabinets, DPs and their reach are drawn).


## Appearance
The service looks like the CRM and the shop: it reads the brand name, theme (colours), logo and favicon from the same record as **Settings → Appearance** in the CRM (it shares the CRM database), so there is nothing to configure twice. A change in the CRM shows here within a few minutes (images are cached for 5 minutes). Light and dark follow the person's own toggle, exactly as in the CRM. If the database cannot be read the built-in Meridian look is used.
