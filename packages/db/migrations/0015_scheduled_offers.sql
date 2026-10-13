-- An offer (or any catalog node) can be scheduled to go live on a future date.
ALTER TABLE catalog_nodes DROP CONSTRAINT IF EXISTS catalog_nodes_status_check;
ALTER TABLE catalog_nodes ADD CONSTRAINT catalog_nodes_status_check CHECK (status IN ('DRAFT','SCHEDULED','ACTIVE','RETIRED'));
ALTER TABLE catalog_nodes ADD COLUMN IF NOT EXISTS active_from timestamptz;
CREATE INDEX IF NOT EXISTS catalog_nodes_due_idx ON catalog_nodes (active_from) WHERE status = 'SCHEDULED';
