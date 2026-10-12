-- A fifth catalog level: offer line items (the components an offer includes: data allowance, calls, device, SIM…).
-- They live in catalog_nodes under their offer (level LINE_ITEM, parent_id = the offer); their attributes are in `data`.
ALTER TABLE catalog_nodes DROP CONSTRAINT catalog_nodes_level_check;
ALTER TABLE catalog_nodes ADD CONSTRAINT catalog_nodes_level_check CHECK (level IN ('NETWORK_TYPE','CATEGORY','GROUP','OFFER','LINE_ITEM'));
