-- A device bought on a contract together with a plan: which plan line it belongs to, and the contract it was bought on.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS position smallint NOT NULL DEFAULT 0;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS attach_position smallint;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS deal jsonb;
-- The plan's service remembers the contract the device was bought on, so its early-termination charge never depends on later catalog edits.
ALTER TABLE services ADD COLUMN IF NOT EXISTS deal jsonb;
