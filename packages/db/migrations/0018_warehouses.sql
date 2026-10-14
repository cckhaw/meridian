-- Warehouse locations are master data kept in the CRM (like stores), and every change to stock leaves a movement behind.
CREATE SEQUENCE IF NOT EXISTS warehouse_id_seq;
CREATE TABLE warehouses (
  id          text PRIMARY KEY,                    -- WH-MAIN for the original; new ones are issued by the system (WH-00002 ...)
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  address     text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX warehouses_name_uq ON warehouses (lower(name));

-- The main warehouse, and any other non-store place that already holds stock, become warehouses.
INSERT INTO warehouses (id, name) VALUES ('WH-MAIN', 'Main warehouse') ON CONFLICT DO NOTHING;
INSERT INTO warehouses (id, name)
  SELECT DISTINCT location_id, location_id FROM inventory_stock
  WHERE location_id NOT LIKE 'STORE-%' AND location_id <> 'WH-MAIN' AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = inventory_stock.location_id)
  ON CONFLICT DO NOTHING;

CREATE TABLE stock_movements (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  location_id text NOT NULL,
  sku         text NOT NULL,
  delta       integer NOT NULL,
  on_hand     integer NOT NULL,                    -- on hand after the movement
  kind        text NOT NULL CHECK (kind IN ('RECEIPT','IMPORT','WRITE_OFF','COUNT')),
  reason      text,                                -- write-offs: DAMAGED, LOST, EXPIRED, THEFT, COUNT, OTHER
  note        text,
  actor       text NOT NULL
);
CREATE INDEX stock_movements_loc_idx ON stock_movements (location_id, at DESC);
CREATE INDEX stock_movements_sku_idx ON stock_movements (sku text_pattern_ops, at DESC);
