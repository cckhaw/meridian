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

## Tests

`packages/core/src/scale.spec.ts` loads thousands of rows with `generate_series` and checks that every row is seen exactly once while paging (including while new rows arrive), that search finds the right records, that pages are capped, that cursors cannot be forged, and that the common queries use their indexes.
