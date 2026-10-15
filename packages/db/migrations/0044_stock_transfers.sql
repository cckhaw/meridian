-- Stock moves between warehouses and stores: a transfer is requested, dispatched (the stock leaves the sender) and received (the stock reaches the receiver).
-- While it is on the road it belongs to neither place. Goods are counted by SKU, SIM cards one by one.
CREATE SEQUENCE IF NOT EXISTS stock_transfer_seq;
CREATE TABLE stock_transfers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL UNIQUE,                       -- TRF-20261015-0007
  from_location text NOT NULL,
  to_location   text NOT NULL CHECK (to_location <> from_location),
  status        text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','IN_TRANSIT','RECEIVED','CANCELLED','RETURNED')),
  note          text,
  discrepancy   boolean NOT NULL DEFAULT false,             -- received short
  requested_by  text NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  dispatched_by text, dispatched_at timestamptz,
  received_by   text, received_at timestamptz,
  closed_by     text, closed_at timestamptz                 -- cancelled or returned
);
CREATE INDEX stock_transfers_status_idx ON stock_transfers (status, requested_at DESC);
CREATE INDEX stock_transfers_from_idx ON stock_transfers (from_location, requested_at DESC);
CREATE INDEX stock_transfers_to_idx ON stock_transfers (to_location, requested_at DESC);

CREATE TABLE stock_transfer_lines (
  transfer_id   uuid NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  sku           text NOT NULL,
  quantity      integer NOT NULL CHECK (quantity > 0),
  received      integer,                                    -- set when received
  PRIMARY KEY (transfer_id, sku)
);
CREATE TABLE stock_transfer_sims (
  transfer_id   uuid NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  iccid         text NOT NULL,
  received      boolean,
  PRIMARY KEY (transfer_id, iccid)
);

-- A SIM card on the road cannot be sold, swapped in or moved again.
ALTER TABLE iccid_inventory ADD COLUMN transfer_id uuid;
CREATE INDEX iccid_inventory_transfer_idx ON iccid_inventory (transfer_id) WHERE transfer_id IS NOT NULL;

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (kind IN ('RECEIPT','IMPORT','WRITE_OFF','COUNT','TRANSFER_OUT','TRANSFER_IN','TRANSFER_SHORT'));
