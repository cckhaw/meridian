# Working with millions of records

Every list in Meridian is built so that opening a screen costs the same whether the table holds a thousand rows or a hundred million.

## The rules

1. **Nothing loads everything.** A list asks for a page (25 by default, 100 at most; 50/200 for audit, stock and similar). The browser holds only what the user has scrolled through.
2. **Keyset ("cursor") paging, never OFFSET.** Each page returns `nextCursor`; the next request sends it back as `?cursor=`. Page 1 and page 10,000 cost the same, and rows arriving while someone pages cannot duplicate or skip a row. Cursors are opaque, validated on the server and rejected if tampered with.
3. **No total counts.** Counting a huge table on every view is what makes screens slow. Lists say "N shown · Show more"; counts are shown only where they are cheap (a customer's own accounts, a group's offers via an indexed `parent_id`).
4. **Search narrows on the server, with an index.** Free text is never matched with `%term%`:

   | You type | Matched by | Index |
   |---|---|---|
   | a uuid | exact id | primary key |
   | `alice@ex` | e-mail prefix | `lower(email) text_pattern_ops` |
   | `+6591…` or `9123…` | phone / MSISDN prefix, with or without the country code from Settings → Regional format | `customers.phone`, `services.identifier` prefix indexes |
   | `alex ta` | words of a name, each as a prefix | GIN full-text on `display_name` (catalog: name + code) |
   | symbols only (`%`, `_`) | nothing — text is literal, never a pattern | |

   Orders, invoices and cases are searched through the customer match (bounded to 200 customers) or by their own number prefix.
5. **Every query is bounded.** Subqueries that feed `IN (...)` carry a `LIMIT`; per-row figures (service counts, balances) are computed for the page only; the dashboard's table-wide totals are cached (`MERIDIAN_DASHBOARD_TTL` seconds, default 30 in production).

## Where it applies

| Screen | List API | Search | Notes |
|---|---|---|---|
| Customers | `GET /customers` | name, e-mail, phone, id | segment filter |
| Customer → departments / accounts / services / groups | `/customers/:id/children`, `/accounts`, `/services?accountId=`, `/accounts/:id/groups` | name, number | loaded when the node is opened |
| Orders, invoices, cases | `/orders`, `/invoices`, `/cases` | customer, number | status filters |
| Inventory | `/inventory`, `/inventory/locations`, `/inventory/movements` | SKU prefix | locations via skip-scan; the movement history pages newest first by id |
| Audit, users, KYC, GL | `/audit`, `/users`, `/kyc/cases`, `/gl` | actor / username / — | newest first |
| Catalog | `/catalog/browse`, `/search`, `/:id/detail`, `/summary` | words in name/code | one level at a time; usage counts capped at 100,000 |
| Sales screens and the store-front | `/catalog`, `/assisted/catalog`, `/store/catalog` | words | a dozen to two dozen offers per page |

## Indexes

Migration `0008_scale_indexes.sql` adds them (btree prefix, GIN full-text, newest-first keysets). It uses plain `CREATE INDEX IF NOT EXISTS`, which blocks writes to a table while it builds. On a large live database, create the same indexes first with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (same names, copied from the file) and the migration then finds them present.

## Beyond a single database

The partitioning by `shard_id` and the keyset paging mean the same queries work per shard. The next steps when one Postgres is not enough are read replicas for lists and search (all list endpoints are read-only), a dedicated search service if you need typo tolerance or ranking, and a rollup table for the dashboard instead of live aggregates.

## Scale review: what was measured

Targets from the brief: more than 100,000 orders a day, 20 million subscribers, key lookups under 10 ms. The review loaded a synthetic database and timed the application's own queries and its own order code on **real PostgreSQL 16** (not the embedded test database), then fixed what was slow. The scripts are in `packages/core/bench/` so anyone can repeat it.

**What was loaded:** 4,000,000 customers and accounts, 4,800,000 services (mobile numbers), 4,000,000 invoices (10% open), 3,000,000 orders, in the real schema with every index and all 16 shard partitions: a 12 GB database. After `VACUUM ANALYZE`. Machine: 4 cores, 15 GB RAM, one Postgres (shared_buffers 2 GB, `fsync` off for the load only), the benchmark client on the same machine, local socket. Latencies are measured at the client and include the round trip.

### Found and fixed (migration `0033_lookup_indexes.sql`)

| Finding | Before | After |
|---|---:|---:|
| Service by id (the id alone, shard not known) | 389 ms | 2.1 ms |
| Order by id | 271 ms | 3.0 ms |
| Account by id | 288 ms | 1.9 ms |
| Customer by id | 145 ms | 2.8 ms |
| Bill run: one page of 1,000 accounts due on a cycle day | 148 ms | 5.4 ms |
| Order throughput, any number of workers (a lock on the day's order-number counter was held until each order committed) | ~10 orders/s | ~33 orders/s on this machine, still rising with cores |

* **Lookups by id alone.** Sharded tables have the primary key `(shard_id, id)`, which cannot answer "find this id" when the shard is unknown, and much of the code (every lifecycle action, every order step) does exactly that. Postgres scanned each partition. A plain index on `id` per table makes it one probe per partition. `order_lines(order_id)` and `services(order_id)` get the same.
* **Bill run.** The partial index on cycle day now carries `id` as well, so each partition returns its accounts already in order.
* **Order numbers.** The counter row for the day was updated at the start of each order and stayed locked until the order committed (about 80 ms), so orders queued behind one another whatever the number of servers. Orders now take the next value of a sequence (never waits); the number is still 1, 2, 3 each day. An order that fails after taking a number leaves a gap, as with any sequence.
* **Settings read once per transaction.** An order read the regional and market settings 19 times; they are now read once per transaction (and forgotten if the transaction changes them).

### Result after the fixes (p50 / p95 / p99 in ms)

| Query | p50 | p95 | p99 |
|---|---:|---:|---:|
| Service by mobile number (exact) | 1.2 | 2.2 | 2.6 |
| Service by id | 2.1 | 3.5 | 7.1 |
| Customer by id and shard | 0.7 | 1.2 | 2.6 |
| Customer by id | 2.8 | 4.2 | 9.0 |
| Customer search by phone prefix / e-mail prefix | 1.8 / 2.4 | 3.4 / 4.9 | 5.2 / 8.9 |
| Customer list, newest first | 2.0 | 2.8 | 4.2 |
| Order by id / by number | 3.0 / 2.0 | 4.1 / 3.8 | 7.2 / 8.1 |
| Orders of a customer | 0.9 | 1.5 | 5.7 |
| Invoices of an account | 0.6 | 1.1 | 1.5 |
| Open balance of an account | 0.4 | 0.8 | 1.8 |
| Dunning: page of overdue invoices | 2.1 | 3.2 | 4.7 |
| Claim a number in the registry | 0.4 | 0.7 | 1.0 |
| Services of an account / accounts of a customer | 3.4 / 4.8 | 5.7 / 8.8 | 7.2 / 12.5 |
| **Customer search by name words** | **36.6** | **58.5** | **107** |

### What is *not* under 10 ms, and why

* **Search by name words** (full-text, prefix match) is 37 ms at the median on 4 million customers. In a sample plan, planning the prefix search across 16 partitions took 12 ms and executing it 9 ms; with very common words the work grows (up to 100 ms at the 99th percentile). It is an interactive search box, not a key lookup, and 40 ms feels instant; if it ever needs to be faster, a prepared statement or a dedicated search service is the next step.
* **A whole order** takes about 85 ms: it is more than 100 statements in one transaction (price, eligibility, stock, number, payment, ledger, commission, history). The database spends about 20 ms of that; the rest is the round trip of each statement from the application. Orders do not wait for each other, so this is latency, not capacity.
* **Services of an account** and **accounts of a customer** are 3-5 ms (8 or 16 partitions are probed because the shard is not part of the question). Passing the shard when it is known would make them one probe.

### Capacity, honestly

* **100,000 orders a day** is 1.2 a second on average and perhaps 10 a second at the busiest hour. Measured: 33 orders a second (about 2.9 million a day) through the application's real order code on 4 shared cores, with the load generator on the same machine. That is about three times the busy hour; the database does roughly 20 ms of work per order, so a dedicated 4-core Postgres has headroom well beyond this, and the application tier scales sideways. Not measured: network latency to a managed database, or several application servers at once.
* **20 million subscribers.** Measured at 4.8 million services. Lookups are index probes whose cost grows with the depth of a B-tree, which goes from 3 to 4 levels between 4 and 20 million rows spread over 16 partitions, so the numbers above should hold within a small factor; that is an extrapolation, not a measurement. The database would be about 60 GB. Things that do grow with size: index builds (the new indexes took 30 s together at 4 million rows), `VACUUM`, and the cache: the figures are with most of the data in memory (12 GB database, 15 GB machine); a database much larger than memory will show disk latency on cold rows.
* **The embedded test database** (PGlite) is for tests and demos. Do not read its timings as production timings.

### Adding the indexes to a large live database

`0033` uses plain `CREATE INDEX IF NOT EXISTS`, which blocks writes to the table while it builds (30 s for all of them at 4 million rows; minutes at 20 million). On a large live database, create the same indexes first with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (same names, from the file) and the migration finds them present. Take the sequence part (`order_number_seq`, `order_counters.base`) in the migration as it is: it is instant.

### Repeating it

```
createdb meridian_bench                        # a real Postgres 16
BENCH_URL=postgres://… npx tsx packages/core/bench/setup.mts     # applies the migrations
psql … -v n=4000000 -f packages/core/bench/load.sql              # synthetic data (about 25 minutes for 4 million)
psql … -c 'VACUUM (ANALYZE)'
BENCH_URL=postgres://… npx tsx packages/core/bench/queries.mts 300   # latency table
BENCH_URL=postgres://… npx tsx packages/core/bench/orders.mts 8 30   # order throughput: workers, seconds
```

## Tests

`packages/core/src/scale.spec.ts` loads thousands of rows with `generate_series` and checks that every row is seen exactly once while paging (including while new rows arrive), that search finds the right records, that pages are capped, that cursors cannot be forged, and that the common queries use their indexes.
