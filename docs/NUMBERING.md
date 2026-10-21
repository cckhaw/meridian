# Numbers, SIM cards and order numbers

## Order numbers

Every order has a readable number `YYYYMMDD-NNNNN` (for example `20261014-00042`): the order date in the regional time zone, then a counter that restarts each day (kept in `order_counters`). The internal id stays the primary key; screens, search and the API (`GET /api/orders/:id`) accept either. Existing orders were numbered by their creation date when migration `0020` ran.

## Choosing a SIM and a number while selling

When an offer has SIM activation, the CRM new-order wizard adds a **SIM & number** step (for roles with `numbering:select`):

- pick a **physical SIM** from the seller's store/warehouse stock (ICCID), or issue an **eSIM** profile;
- pick a **number** by tier, prefix, suffix or digits it contains, or let the system assign a Standard number. A chosen number is held for the **reservation time** (15 minutes by default) and the countdown shows in the step;
- a VIP number adds its **one-time fee** to the order, and the offer must meet the tier's **minimum recurring plan** and **minimum contract**.

The order holds the SIM and number until it is activated, and returns both to stock if the order fails or is cancelled before activation. On activation the SIM becomes `ACTIVE`, bound to its IMSI, and the number `ASSIGNED_ACTIVE`. Whether a SIM is mandatory for non-self-serve channels is the `requireSim` setting (off by default).

## Settings

**Settings → Back office → Numbers & SIMs** (`settings:manage`) holds the cooling-off periods and holds: how long a phone number rests after termination (default 90 days, shared with the lifecycle termination rule), how long an IMSI rests (90), how long a chosen number or SIM is held at checkout (15 minutes), how long an auction winner has (48 hours), and whether every plan needs a SIM. VIP tier patterns and fees stay on the Numbers & SIMs page, under VIP tiers. The sidebar group that holds Numbers & SIMs is called **Back office**.

## Lifecycles

| Identifier | States |
| --- | --- |
| ICCID | `WAREHOUSE_INVENTORY → DISTRIBUTED_DEALER → RESERVED → ACTIVE → DAMAGED_SCRAPPED → DECOMMISSIONED` |
| IMSI | `POOL_UNASSIGNED → BOUND_TO_SIM → ACTIVE → QUARANTINED → RECYCLED → POOL_UNASSIGNED` |
| MSISDN | `AVAILABLE → RESERVED_CHECKOUT → ASSIGNED_ACTIVE → QUARANTINE_COOLING → AVAILABLE`, plus `BLOCKED_VIP`, `AUCTION_HOLD` and `PORTED_OUT` |

Illegal jumps are refused by guard tables, and every change is written to `identifier_lifecycle_audit` (`GET /api/numbering/history`).

On termination: a physical SIM is `DECOMMISSIONED` for good; an eSIM ICCID is a reusable template and returns to `WAREHOUSE_INVENTORY`; the IMSI is decoupled and quarantined (**90 days**, `imsiQuarantineDays`); the number cools in quarantine (or is marked `PORTED_OUT`). The daily lifecycle job (`POST /api/lifecycle/run`, or `POST /api/numbering/recycle`) then restores rested IMSIs to the pool and re-classifies and releases rested numbers. In the order service the same work runs as the `imsiRecycleWorkflow` Temporal workflow (signal `recycleNow`, query `recycleStatus`); its activities are stubs until wired to the HLR/HSS.

## VIP tiers

Tier rules are data (**Numbers & SIMs → VIP tiers**, `numbering:manage`). Each has a regex tested on the last 8 digits, a one-time fee, a minimum recurring plan, a minimum contract (months) and an early-termination multiplier. First match wins, in this order:

| Tier | Typical patterns | Fee | Min plan | Min contract | ETC × |
| --- | --- | --- | --- | --- | --- |
| Auction | 8 identical trailing digits | 0 (bid) | 0 | 24 | 2.0 |
| Diamond (Platinum) | AAAAA, AAAAAA, 123456, 888888 | 1,000.00 | 80.00 | 24 | 1.5 |
| Gold | AABBCC, ABABAB, AAAA, 7777 | 300.00 | 50.00 | 12 | 1.25 |
| Silver | AABB, ABAB, sequential pairs | 50.00 | 0 | 0 | 1.0 |
| Standard | everything else | 0 | 0 | 0 | 1.0 |

Patterns are validated (no nested quantifiers, bounded length) before they are saved; **Re-classify** applies changed rules to free numbers. A VIP service's early-termination charge is multiplied by its tier's multiplier.

## Loading pools

**Numbers & SIMs → Load** takes a CSV or a range for MSISDNs (up to 200,000 per load), IMSIs, and ICCIDs (SIM cards and eSIMs, `89…`, 19–20 digits; an ICCID can be bound to a free IMSI on load). Each load has a *check* step before *apply*. An MSISDN starts with its **country code and needs no + sign** (`60128001234`; spreadsheets drop the + anyway). A + is accepted and spaces or dashes are ignored, but a local number starting with 0 is refused. MSISDNs are stored as `+60128001234`. Each load has a **Download the … template** link (`GET /api/numbering/template/msisdn|imsi|sim`), a ready-to-fill sample whose MSISDNs start with the regional country code.

## Reservations and concurrency

Holding a number takes a row lock (`FOR UPDATE SKIP LOCKED`) and a record in `number_reservation_locks`, so two sellers cannot take one number. An optional `RedisLock` (Redlock-style, over the small `RedisLike` interface) can sit in front; it is **not enabled or tested against a real Redis** here. Unconfirmed holds expire after the reservation time and are swept by the daily job; numbers held by an order stay held until activation or cancellation.

## Auctions

Operations can move numbers into `AUCTION_HOLD` (`POST /api/numbering/auction/hold|release`). `POST /api/numbering/auction/settle` assigns the number to the winner and writes a `VIP_NUMBER_AUCTION_WON` event (topic `meridian.nrm.events`) to the lifecycle outbox for Kafka-style delivery.

## Roles

`numbering:read` (administrators, Inventory Operations), `numbering:select` (sellers: retail store, call centre, telesales, dealers) and `numbering:manage` (Inventory Operations). Change them under Users & roles; see [ROLES.md](ROLES.md).

## Temporary and ported-in numbers

A line that brings a number from another operator can be given a **temporary** number from the Standard pool while the port is processed; when the donor approves, the line takes the ported number (it joins the inventory as in service) and the temporary number goes to cooling-off. See [FAMILY_PLANS.md](FAMILY_PLANS.md). A port-in request that is never answered expires after **Settings → Numbers & SIMs → A port-in waits for the donor operator** days (default 14), checked by the daily job.

## Not covered yet

The storefront (self-serve) does not offer number or SIM choice; the eSIM SM-DP+ port, Redis lock, Kafka delivery and Temporal activities are interfaces or stubs; and the new screens have not been exercised in a browser.
