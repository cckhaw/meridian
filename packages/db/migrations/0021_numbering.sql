-- Number Resource Management: the pools of SIM serials (ICCID), subscriber identities (IMSI) and phone numbers (MSISDN),
-- VIP number tiers and what they cost, reservations, and a trail of every state change.
-- (The brief asked for Prisma; this codebase keeps its schema in SQL migrations, and this is that schema.)

-- What a number tier costs and demands. `patterns` are the regular expressions that put a number in the tier (matched against the last 8 digits).
CREATE TABLE msisdn_vip_tier_rules (
  tier                   text PRIMARY KEY CHECK (tier IN ('DIAMOND','GOLD','SILVER','STANDARD','AUCTION')),
  label                  text NOT NULL,
  sort_order             integer NOT NULL,
  patterns               jsonb NOT NULL DEFAULT '[]',          -- [{ "code": "AAAAA", "regex": "(\\d)\\1{4,}$" }]
  one_time_fee_minor     bigint NOT NULL DEFAULT 0,            -- connection fee for choosing the number
  min_monthly_plan_minor bigint NOT NULL DEFAULT 0,            -- the plan's monthly fee must be at least this
  min_contract_months    integer NOT NULL DEFAULT 0,           -- the plan must come with a contract at least this long
  etc_multiplier_bps     integer NOT NULL DEFAULT 10000,       -- 15000 = the early-termination charge is 1.5x
  enabled                boolean NOT NULL DEFAULT true,
  updated_by             text,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE msisdn_inventory (
  msisdn           text PRIMARY KEY,                           -- E.164
  state            text NOT NULL DEFAULT 'AVAILABLE' CHECK (state IN ('AVAILABLE','RESERVED_CHECKOUT','ASSIGNED_ACTIVE','QUARANTINE_COOLING','BLOCKED_VIP','AUCTION_HOLD','PORTED_OUT')),
  tier             text NOT NULL DEFAULT 'STANDARD' CHECK (tier IN ('DIAMOND','GOLD','SILVER','STANDARD','AUCTION')),
  pattern_code     text,
  previous_state   text,                                       -- what to go back to when a reservation lapses
  reserved_by      text,
  reserved_until   timestamptz,
  service_id       uuid,
  quarantine_until date,
  batch            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX msisdn_inventory_pick_idx ON msisdn_inventory (tier, msisdn) WHERE state = 'AVAILABLE';
CREATE INDEX msisdn_inventory_state_idx ON msisdn_inventory (state, msisdn);
CREATE INDEX msisdn_inventory_prefix_idx ON msisdn_inventory (msisdn text_pattern_ops);
CREATE INDEX msisdn_inventory_reserved_idx ON msisdn_inventory (reserved_until) WHERE state = 'RESERVED_CHECKOUT';
CREATE INDEX msisdn_inventory_quarantine_idx ON msisdn_inventory (quarantine_until) WHERE state IN ('QUARANTINE_COOLING');

CREATE TABLE iccid_inventory (
  iccid            text PRIMARY KEY,
  kind             text NOT NULL DEFAULT 'PHYSICAL' CHECK (kind IN ('PHYSICAL','ESIM')),
  state            text NOT NULL DEFAULT 'WAREHOUSE_INVENTORY' CHECK (state IN ('WAREHOUSE_INVENTORY','DISTRIBUTED_DEALER','RESERVED','ACTIVE','DAMAGED_SCRAPPED','DECOMMISSIONED')),
  location_id      text,                                       -- the warehouse, store or dealer holding a physical SIM
  imsi             text,                                       -- the identity written onto it
  activation_code  text,                                       -- eSIM: the SM-DP+ activation code (LPA:1$...)
  batch            text,
  order_id         uuid,
  service_id       uuid,
  previous_state   text,
  reserved_until   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX iccid_inventory_pick_idx ON iccid_inventory (location_id, kind, iccid) WHERE state IN ('WAREHOUSE_INVENTORY','DISTRIBUTED_DEALER');
CREATE INDEX iccid_inventory_state_idx ON iccid_inventory (state, iccid);
CREATE INDEX iccid_inventory_order_idx ON iccid_inventory (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE imsi_inventory (
  imsi             text PRIMARY KEY,
  state            text NOT NULL DEFAULT 'POOL_UNASSIGNED' CHECK (state IN ('POOL_UNASSIGNED','BOUND_TO_SIM','ACTIVE','QUARANTINED','RECYCLED')),
  iccid            text,
  service_id       uuid,
  previous_msisdn  text,
  quarantine_until date,
  batch            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX imsi_inventory_pool_idx ON imsi_inventory (imsi) WHERE state = 'POOL_UNASSIGNED';
CREATE INDEX imsi_inventory_quarantine_idx ON imsi_inventory (quarantine_until) WHERE state = 'QUARANTINED';

-- Holds on numbers and SIMs while a customer is checking out. One live hold per resource.
CREATE TABLE number_reservation_locks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type  text NOT NULL CHECK (resource_type IN ('MSISDN','ICCID')),
  resource_id    text NOT NULL,
  holder         text NOT NULL,                                -- who holds it: a checkout session, an order, an auction
  token          text NOT NULL,
  state          text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','CONSUMED','RELEASED','EXPIRED')),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz
);
CREATE UNIQUE INDEX number_reservation_active_uq ON number_reservation_locks (resource_type, resource_id) WHERE state = 'ACTIVE';
CREATE INDEX number_reservation_expiry_idx ON number_reservation_locks (expires_at) WHERE state = 'ACTIVE';

CREATE TABLE identifier_lifecycle_audit (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  resource_type  text NOT NULL CHECK (resource_type IN ('MSISDN','ICCID','IMSI')),
  resource_id    text NOT NULL,
  from_state     text,
  to_state       text NOT NULL,
  actor          text NOT NULL,
  reason         text,
  detail         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX identifier_audit_resource_idx ON identifier_lifecycle_audit (resource_type, resource_id, id DESC);

-- What an order line carries: the SIM and number chosen for it, and what a VIP number added.
ALTER TABLE order_lines
  ADD COLUMN IF NOT EXISTS iccid text,
  ADD COLUMN IF NOT EXISTS sim_type text,
  ADD COLUMN IF NOT EXISTS vip_tier text,
  ADD COLUMN IF NOT EXISTS vip_fee_minor bigint NOT NULL DEFAULT 0;
-- And what the service keeps: its IMSI, and the VIP terms that apply if it ends early.
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS imsi text,
  ADD COLUMN IF NOT EXISTS vip_tier text,
  ADD COLUMN IF NOT EXISTS vip_etc_bps integer;

-- The outbox also carries domain events for the message bus (Kafka): VIP_NUMBER_AUCTION_WON and friends.
ALTER TABLE lifecycle_outbox DROP CONSTRAINT IF EXISTS lifecycle_outbox_kind_check;
ALTER TABLE lifecycle_outbox ADD CONSTRAINT lifecycle_outbox_kind_check CHECK (kind IN ('NETWORK','NOTIFY','COLLECTIONS','GL','EVENT'));

INSERT INTO msisdn_vip_tier_rules (tier, label, sort_order, patterns, one_time_fee_minor, min_monthly_plan_minor, min_contract_months, etc_multiplier_bps) VALUES
  ('DIAMOND',  'Platinum / Diamond', 1, '[{"code":"AAAAA","regex":"(\\d)\\1{4,}$"},{"code":"123456","regex":"(?:0123456|1234567|2345678|3456789|012345|123456|234567|345678|456789)$"},{"code":"654321","regex":"(?:9876543|8765432|7654321|6543210|987654|876543|765432|654321|543210)$"}]', 100000, 8000, 24, 15000),
  ('GOLD',     'Gold',               2, '[{"code":"AABBCC","regex":"(\\d)\\1(\\d)\\2(\\d)\\3$"},{"code":"ABABAB","regex":"(\\d)(\\d)\\1\\2\\1\\2$"},{"code":"AAAA","regex":"(\\d)\\1{3}$"}]', 30000, 5000, 12, 12500),
  ('SILVER',   'Silver',             3, '[{"code":"AABB","regex":"(\\d)\\1(\\d)\\2$"},{"code":"ABAB","regex":"(\\d)(\\d)\\1\\2$"},{"code":"ABABCC","regex":"(\\d)(\\d)\\1\\2(\\d)\\3$"},{"code":"1234","regex":"(?:0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321|3210)$"}]', 5000, 0, 0, 10000),
  ('STANDARD', 'Standard',           4, '[]', 0, 0, 0, 10000),
  ('AUCTION',  'Auction / special VIP', 0, '[{"code":"AAAAAAAA","regex":"(\\d)\\1{7,}$"}]', 0, 0, 24, 20000);
