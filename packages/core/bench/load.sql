-- Synthetic load for the scale benchmark. Run with: psql -v n=4000000 -f load.sql
\timing on
SET synchronous_commit = off;
DROP TABLE IF EXISTS bench_ids;
CREATE UNLOGGED TABLE bench_ids AS
  SELECT g AS n, gen_random_uuid() AS cid, gen_random_uuid() AS aid FROM generate_series(1, :n) g;
ALTER TABLE bench_ids ADD COLUMN shard smallint;
UPDATE bench_ids SET shard = (get_byte(sha256(convert_to(cid::text, 'UTF8')), 3) % 16)::smallint;
ALTER TABLE bench_ids ADD PRIMARY KEY (n);

-- customers: names from a small vocabulary so name searches match many people, like real data
INSERT INTO customers (id, shard_id, segment, display_name, id_document_ref, id_document_hash, market_code, email, phone, hierarchy_path, kyc_status, created_at)
SELECT cid, shard, 'CONSUMER',
       (ARRAY['Alex','Bea','Chen','Dev','Eli','Farah','Gita','Hui','Ivan','Jun','Kai','Lena','Mei','Noor','Omar','Priya','Quinn','Raj','Siti','Tan'])[1 + n % 20] || ' ' ||
       (ARRAY['Tan','Lim','Lee','Ng','Wong','Ong','Teo','Goh','Chua','Koh'])[1 + (n / 20) % 10] || ' ' || n,
       'S****' || (n % 1000), md5(n::text) || md5((n+1)::text), 'SG',
       'user' || n || '@example.com', '+65' || (80000000 + n)::text, ('c_' || replace(cid::text, '-', '_'))::ltree, 'VERIFIED',
       now() - (n % 900) * interval '1 day'
FROM bench_ids;
ANALYZE customers;

INSERT INTO accounts (id, shard_id, customer_id, bill_cycle_day, status, currency, name, created_at)
SELECT aid, shard, cid, 1 + n % 28, 'ACTIVE', 'SGD', 'Main account', now() - (n % 900) * interval '1 day' FROM bench_ids;
ANALYZE accounts;

-- subscribers: :n * 1.25 services, 20% of accounts with a second line
INSERT INTO services (id, shard_id, account_id, customer_id, type, identifier, offer_id, status, activated_at, contract_start, contract_term_months)
SELECT gen_random_uuid(), shard, aid, cid, 'MOBILE', '+65' || (80000000 + n)::text, 'plan-sim-5g', 'ACTIVE', now() - (n % 900) * interval '1 day', now() - (n % 900) * interval '1 day', 24
FROM bench_ids;
INSERT INTO services (id, shard_id, account_id, customer_id, type, identifier, offer_id, status, activated_at)
SELECT gen_random_uuid(), shard, aid, cid, 'MOBILE', '+65' || (90000000 + n)::text, 'plan-sim-5g', 'ACTIVE', now() - (n % 900) * interval '1 day'
FROM bench_ids WHERE n % 5 = 0;
ANALYZE services;

-- invoices: one per account, a tenth of them open (some overdue)
CREATE SEQUENCE IF NOT EXISTS bench_inv;
INSERT INTO invoices (id, shard_id, number, account_id, customer_id, kind, period_start, period_end, issue_date, due_date, status, currency, net_minor, tax_minor, total_minor, paid_minor)
SELECT gen_random_uuid(), shard, 'BENCH-' || n, aid, cid, 'CYCLE', current_date - 60, current_date - 31, current_date - 30, current_date - 16 + (n % 40),
       CASE WHEN n % 10 = 0 THEN CASE WHEN n % 20 = 0 THEN 'OVERDUE' ELSE 'ISSUED' END ELSE 'PAID' END, 'SGD', 5000, 450, 5450, CASE WHEN n % 10 = 0 THEN 0 ELSE 5450 END
FROM bench_ids;
ANALYZE invoices;

-- orders: :n * 0.75 over the last 30 days, 1.3 lines each
INSERT INTO orders (id, shard_id, customer_id, channel, state, total_minor, currency, store_id, created_at, account_id, number, market_code, payment_method)
SELECT gen_random_uuid(), shard, cid, 'SELF_SERVE', 'COMPLETED', 5450, 'SGD', NULL, now() - (n % 43200) * interval '1 minute', aid,
       to_char(now() - (n % 43200) * interval '1 minute', 'YYYYMMDD') || '-' || lpad(n::text, 7, '0'), 'SG', 'CREDIT_CARD'
FROM bench_ids WHERE n % 4 <> 0;
ANALYZE orders;
