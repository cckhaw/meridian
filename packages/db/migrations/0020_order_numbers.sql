-- Order numbers people can read out: the order date, then a counter for that day (20261014-00042).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS number text;
CREATE TABLE IF NOT EXISTS order_counters (day date PRIMARY KEY, last integer NOT NULL);

-- Orders that already exist get a number from their own date, in the order they were placed.
UPDATE orders o SET number = n.num
  FROM (SELECT shard_id, id, to_char(created_at, 'YYYYMMDD') || '-' || lpad((row_number() OVER (PARTITION BY created_at::date ORDER BY created_at, id))::text, 5, '0') AS num FROM orders) n
 WHERE o.shard_id = n.shard_id AND o.id = n.id AND o.number IS NULL;
INSERT INTO order_counters (day, last)
  SELECT created_at::date, count(*) FROM orders GROUP BY created_at::date
  ON CONFLICT (day) DO UPDATE SET last = GREATEST(order_counters.last, EXCLUDED.last);
-- orders is partitioned by shard, so a unique index would have to include shard_id; the counter makes numbers unique by construction.
CREATE INDEX IF NOT EXISTS orders_number_idx ON orders (number text_pattern_ops);
