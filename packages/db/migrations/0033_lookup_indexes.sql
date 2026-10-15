-- Found by the scale benchmark (packages/core/bench, 4 million customers, 4.8 million services, 3 million orders on Postgres 16).
-- A row of a sharded table is found by (shard_id, id), but much of the code finds it by id alone, and the primary key cannot serve that: Postgres read every
-- partition's table or index, 150-400 ms. A plain index on id makes it one probe per partition, under a millisecond. (A unique index on id alone is not allowed
-- on a table partitioned by shard_id, so these are ordinary indexes; the primary key still enforces uniqueness.)
CREATE INDEX IF NOT EXISTS customers_id_idx ON customers (id);
CREATE INDEX IF NOT EXISTS accounts_id_idx ON accounts (id);
CREATE INDEX IF NOT EXISTS orders_id_idx ON orders (id);
CREATE INDEX IF NOT EXISTS services_id_idx ON services (id);
-- What an order made (its lines, its services) is found by the order's id.
CREATE INDEX IF NOT EXISTS order_lines_order_id_idx ON order_lines (order_id);
CREATE INDEX IF NOT EXISTS services_order_idx ON services (order_id) WHERE order_id IS NOT NULL;
-- A bill run takes the accounts of one cycle day a page at a time in id order: with the id in the index each partition hands its rows over already sorted.
CREATE INDEX IF NOT EXISTS accounts_cycle_page_idx ON accounts (bill_cycle_day, id) WHERE status = 'ACTIVE';
DROP INDEX IF EXISTS accounts_cycle_idx;

-- Order numbers without a lock held for the whole order. The counter row of the day used to be updated at the start of every order and stayed locked until the
-- order committed, so orders queued behind each other: about 10 orders a second however many servers were taking them. Now each order takes the next value of a
-- sequence (which never waits) and the number is that value less the day's starting point, so numbers are still 1, 2, 3 … each day. The one change: an order that
-- fails after taking a number leaves a gap, as with any sequence.
CREATE SEQUENCE IF NOT EXISTS order_number_seq;
ALTER TABLE order_counters ADD COLUMN IF NOT EXISTS base bigint NOT NULL DEFAULT 0;
-- Days already counted keep their numbers; the sequence starts above every counter so nothing repeats.
SELECT setval('order_number_seq', GREATEST((SELECT COALESCE(max(last), 0) FROM order_counters), 1));
