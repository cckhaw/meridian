-- Retail stores are master data kept in the CRM. Staff, orders and stock refer to a store by its id.
CREATE SEQUENCE store_id_seq;
CREATE TABLE stores (
  id          text PRIMARY KEY,                    -- issued by the system (STORE-00001); older ids are kept as they were
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  market_code char(2),
  address     text,
  phone       text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stores_name_uq ON stores (lower(name));
CREATE INDEX users_store_idx ON users (store_id) WHERE store_id IS NOT NULL;

-- Store ids already used by staff, orders and stock become stores (named after their id until someone renames them).
INSERT INTO stores (id, name)
  SELECT s, s FROM (
    SELECT store_id AS s FROM users WHERE store_id IS NOT NULL
    UNION SELECT store_id FROM orders WHERE store_id IS NOT NULL
    UNION SELECT location_id FROM inventory_stock WHERE location_id LIKE 'STORE-%'
  ) x ON CONFLICT DO NOTHING;
