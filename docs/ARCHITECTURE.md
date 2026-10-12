# Nexus architecture

## Layout
| Path | Purpose |
|---|---|
| `packages/types` | Shared domain interfaces (catalog, customer, order, personas) |
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

## Not yet built (next slices)
Customer 360 & cases, MNP, billing engine & invoice designer, SAP GL export, retail/quick-sale UI, reverse logistics,
Kafka producers (activities are stubbed), auth/RBAC per persona, GraphQL gateway, Redis session layer, persistence of workflow definitions.
