# Meridian architecture

## Layout
| Path | Purpose |
|---|---|
| `packages/types` | Shared domain interfaces (catalog, customer, order, personas) |
| `packages/core` | The working BSS: customers, catalog, orders, lifecycle, billing, ledger, cases, inventory, reports, seed. Runs on `pg` or embedded PGlite |
| `packages/db` | Postgres migrations (partitioned, shard-aware) + Drizzle query schema |
| `packages/ui` | Apple-HIG design system: tokens, Tailwind preset, responsive `AppShell`, theme |
| `services/catalog-service` | NestJS + MongoDB, TMF620 product catalog, ETC calculator |
| `services/order-service` | NestJS + Temporal, TMF622 ordering, graph-driven workflow, PNR |
| `services/rating-gateway` | Go online-charging hot path (scaffold) |
| `apps/web` | Next.js 15 App Router shell, catalog preview, workflow designer |

## Key decisions
- **Sharding**: `shard_id = sha256(customer_id) % 1024` is computed in the app (`packages/db/src/shard.ts`) and stored on every row.
  Customers/accounts/orders are LIST-partitioned by `shard_id`; `services` (IoT fleets) and `order_lines` are further HASH-partitioned.
  Postgres requires partition keys in every PK/unique index, so `services` is keyed `(shard_id, identifier, id)`.
  Logical → physical AlloyDB mapping lives in `shard_map`.
- **Orders as data**: designer output (`OrderWorkflowDefinition`) is validated (`graph/validate.ts`) and interpreted by one deterministic
  Temporal workflow, so rule changes ship without a deploy. Compensations (refund, release stock) run in reverse on cancel/failure.
- **Point of No Return**: a `POINT_OF_NO_RETURN` node flips a flag; later `cancelRequested` signals are rejected with a reason (`graph/pnr.ts`).
- **Money** is integer minor units everywhere.
- **Design system**: CSS-variable tokens (light default, `.dark` class), 44px minimum hit targets, safe-area insets, reduced-motion support.
  Breakpoints: phone <768 (bottom tab bar), tablet 768–1023 (drawer), desktop ≥1024 (sidebar). On desktop the sidebar's collapse button offers **Icons only** (a 72px rail: every place stays one click away, with its name on hover) or **Hide completely** (full page width, with a Show button). The choice is remembered, and Ctrl/⌘ + \ toggles between expanded and the way it was last collapsed.

## How the working system fits together
- `apps/web` route handlers (`src/server/router.ts`) validate input with zod and call `@meridian/core`; pages are client components over that API.
- `@meridian/core` talks to one `Db` interface (`db.ts`): `pg` when `DATABASE_URL` is set, otherwise embedded Postgres (PGlite). Migrations in
  `packages/db/migrations` are embedded into `migrations.generated.ts` (`pnpm --filter @meridian/db embed`) so bundles carry no loose SQL files.
- Orders run as an in-process state machine inside one DB transaction (`orders.ts`): a decline or stock-out ends in FAILED with compensation
  (refund, release) committed, never a half-written order. The Temporal workflows in `services/order-service` (orders, and the dunning ladder) model the same states for a
  deployment that wants durable timers and human-in-the-loop steps; they are not wired to the web app.
- **Global identifiers**: `services` is sharded, so its unique index only holds per shard. MSISDNs and circuit ids are claimed in `identifier_registry`
  in the same transaction. (A test caught this: two customers on different shards could otherwise hold the same number.)
- **Ledger**: every business event posts one balanced journal (`ledger.ts`). `reconcile()` checks ledger vs invoices (AR) and vs payments (cash).
  Revenue is recognised on payment for upfront items and on invoice for recurring/instalment items.
- **Billing** is in arrears with a unique index on (account, period) so re-runs are no-ops; each account bills in its own transaction. Cycles are billed through **governed bill runs** ([BILLING.md](BILLING.md)): mock, review, exclusions, approval, then production, in resumable slices.
- **Service lifecycle** (`lifecycle*.ts`, [LIFECYCLE.md](LIFECYCLE.md)): a guarded state machine (`lifecycle-state.ts`) for suspension, bars, resumption, termination and port-out; a configurable dunning ladder (`runDunning`, also modelled as a Temporal workflow with durable timers and a payment signal); credit-limit bars; every change logged to `service_lifecycle_events`, and every instruction for other systems (PCRF/PCF, HLR/HSS, SMS/e-mail, collections, GL) written to `lifecycle_outbox` in the same transaction.
- **Markets** (`settings.ts`): one market by default (the Regional country); optionally several, each with its own name, tax and dial code, and a default market. `marketMode`/`effectiveMarket` are the only places that decide whether a market filter or check applies. **Stock** (`inventory.ts`, `warehouses.ts`): locations are warehouses and stores; every receipt, CSV load and write-off leaves a row in `stock_movements`.
- Catalog for the working app lives in Postgres (JSONB). `services/catalog-service` (Mongo) keeps the same model and now shares the ETC and
  hierarchy rules from `@meridian/core`.

## Identity and access
`packages/core/src/rbac.ts` is the single source of truth: permissions, the built-in roles (16), data scopes, modules. Administrators can change what a built-in role may do and define roles of their own (`roles-config.ts`, kept in settings and read on every request), so access is decided from the defaults in `rbac.ts` plus that role book. `auth.ts` handles credentials,
sessions, lockout and user administration; the super user is read from the environment. The API router (`apps/web/src/server/router.ts`) declares a
permission per route and enforces authentication, CSRF, the forced password change, permissions and row scope before any handler runs.
The UI builds navigation from the server's module list for the signed-in user. See [SECURITY.md](SECURITY.md) and [ROLES.md](ROLES.md).

## Numbering

The **financial sub-ledger** (`ledger.ts`, `sub-ledger.ts`, `coa.ts`, `sap-exporter.ts`, `journal-batches.ts`, `reconciliation.ts`, migration `0026`) keeps `gl_entries` immutable and partitioned by month, maps lines to SAP accounts through editable posting rules, exports and reconciles. Details in [FINANCE.md](FINANCE.md).

The **commission engine** (`commission-calculator.ts`, `commission.ts`, `commission-processor.ts`, migration `0027`) evaluates plans when an order completes, keeps an append-only earnings ledger, takes commission back on early churn, and settles monthly with GL postings. Details in [COMMISSION.md](COMMISSION.md).

Dunning rules, the rule engine, late fees, payment arrangements and collection placements live in `packages/core` (`dunning-rules.ts`, `dunning-engine.ts`, `dunning-templates.ts`, `seed-dunning-rules.ts`, `collections.ts`, `emv-qr.ts`) on migration `0040`; see [DUNNING.md](DUNNING.md).

Number Resource Management lives in `packages/core` (`nrm.ts`, `nrm-pools.ts`, `number-reservation.ts`, `vip-pattern-matcher.ts`, `order-numbering.ts`) on migrations `0020` and `0021`. Locks are database row locks with an optional Redis adapter; events go through the lifecycle outbox; IMSI recycling also runs as a Temporal workflow in `services/order-service`. Details in [NUMBERING.md](NUMBERING.md).

## Payments
No gateway is bundled. `MERIDIAN_PAYMENT_MODE=manual` (production default) captures nothing automatically: cashiers record a terminal approval or
receipt reference, and a payment provider confirms online payments through the signed webhook. `simulated` (development) auto-approves cards.

## Known limitations
No MFA/SSO; one currency per deployment (markets differ in tax and dial code, not currency); currencies assumed 2-decimal; cross-shard ownership transfer is rejected (needs the shard migration job);
dev partitions cover shards 0-15 only; usage rating/charging, the invoice designer, delivery of notifications and network instructions (queued in `lifecycle_outbox`) and the order-workflow designer UI are not built.

Offer behaviour is a set of per-type **switches** stamped onto each offer when it is saved (`behaviourOf`, `offer-config.ts`), and service types (built-in and operator-defined) (`service-kinds.ts`, migration `0028`) give new services their own identifier, expiry and provisioning instructions. Details in [CATALOG.md](CATALOG.md#switches).

Every external connection is catalogued in `integrations.ts` and shown on the **Integration** page (see [INTEGRATIONS.md](INTEGRATIONS.md)).

Provisioning into the charging system goes through a vendor-neutral queue (`ocs.ts`, migration `0029`) and one connector file per vendor in `ocs-vendors/`; see [OCS.md](OCS.md).
