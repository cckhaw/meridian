# Project Meridian

Telco CRM & Billing suite for 20M+ subscribers (ASEAN). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```bash
pnpm install
pnpm infra:up                       # postgres, mongo, redis, kafka, temporal
DATABASE_URL=postgres://meridian:meridian@localhost:5432/meridian pnpm --filter @meridian/db migrate
pnpm --filter @meridian/order-service worker   # Temporal worker
pnpm dev                            # web :3000, catalog :4001, orders :4002
pnpm typecheck && pnpm test         # test needs network once to fetch the Temporal test server
cd services/rating-gateway && go run ./cmd/gateway   # :4003
```
