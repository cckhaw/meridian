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
  Breakpoints: phone <768 (bottom tab bar), tablet 768–1023 (drawer), desktop ≥1024 (sidebar).

## How the working system fits together
- `apps/web` route handlers (`src/server/router.ts`) validate input with zod and call `@meridian/core`; pages are client components over that API.
- `@meridian/core` talks to one `Db` interface (`db.ts`): `pg` when `DATABASE_URL` is set, otherwise embedded Postgres (PGlite). Migrations in
  `packages/db/migrations` are embedded into `migrations.generated.ts` (`pnpm --filter @meridian/db embed`) so bundles carry no loose SQL files.
- Orders run as an in-process state machine inside one DB transaction (`orders.ts`): a decline or stock-out ends in FAILED with compensation
  (refund, release) committed, never a half-written order. The Temporal workflow in `services/order-service` models the same states for a
  deployment that wants durable timers and human-in-the-loop steps; it is not wired to the web app.
- **Global identifiers**: `services` is sharded, so its unique index only holds per shard. MSISDNs and circuit ids are claimed in `identifier_registry`
  in the same transaction. (A test caught this: two customers on different shards could otherwise hold the same number.)
- **Ledger**: every business event posts one balanced journal (`ledger.ts`). `reconcile()` checks ledger vs invoices (AR) and vs payments (cash).
  Revenue is recognised on payment for upfront items and on invoice for recurring/instalment items.
- **Billing** is in arrears with a unique index on (account, period) so re-runs are no-ops; each account bills in its own transaction.
- Catalog for the working app lives in Postgres (JSONB). `services/catalog-service` (Mongo) keeps the same model and now shares the ETC and
  hierarchy rules from `@meridian/core`.

## Identity and access
`packages/core/src/rbac.ts` is the single source of truth: permissions, 13 roles, data scopes, modules. `auth.ts` handles credentials,
sessions, lockout and user administration; the super user is read from the environment. The API router (`apps/web/src/server/router.ts`) declares a
permission per route and enforces authentication, CSRF, the forced password change, permissions and row scope before any handler runs.
The UI builds navigation from the server's module list for the signed-in user. See [SECURITY.md](SECURITY.md) and [ROLES.md](ROLES.md).

## Payments
No gateway is bundled. `MERIDIAN_PAYMENT_MODE=manual` (production default) captures nothing automatically: cashiers record a terminal approval or
receipt reference, and a payment provider confirms online payments through the signed webhook. `simulated` (development) auto-approves cards.

## Known limitations
No MFA/SSO; flat tax rate per market; currencies assumed 2-decimal; cross-shard ownership transfer is rejected (needs the shard migration job);
dev partitions cover shards 0-15 only; usage rating/charging, returns and exchanges, invoice designer, notifications and the order-workflow designer UI are not built.
