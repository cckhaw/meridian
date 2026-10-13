-- 1. Dealer ids are issued by the system (DLR-00001 …). Existing ids are kept; new ones continue after the highest numbered one.
CREATE SEQUENCE dealer_id_seq;
SELECT setval('dealer_id_seq', COALESCE((SELECT max(substr(id, 5)::int) FROM dealers WHERE id ~ '^DLR-[0-9]{1,9}$'), 0) + 1, false);

-- 2. Customer segments are data the operator maintains (Settings → Customers), not a fixed list in the code.
CREATE TABLE customer_segments (
  id          text PRIMARY KEY,                    -- short code, issued from the name and never changed
  name        text NOT NULL,
  description text,
  individual  boolean NOT NULL DEFAULT false,      -- true: one customer per ID document (a person); false: companies and fleets may share one
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  sort_order  integer NOT NULL DEFAULT 100,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customer_segments_name_uq ON customer_segments (lower(name));
INSERT INTO customer_segments (id, name, description, individual, sort_order) VALUES
  ('CONSUMER',   'Consumer',   'Individuals buying for themselves or their household.', true,  10),
  ('ENTERPRISE', 'Enterprise', 'Companies, with departments and many accounts.',        false, 20),
  ('IOT',        'IoT',        'Connected-device fleets managed in bulk.',              false, 30);

-- "Family" was a kind of customer; it is now a Group of services (below), so those customers become Consumers.
ALTER TABLE customers ALTER COLUMN segment TYPE text USING (CASE segment::text WHEN 'FAMILY' THEN 'CONSUMER' WHEN 'IOT_ENTERPRISE' THEN 'IOT' ELSE segment::text END);
DROP TYPE customer_segment;
ALTER TABLE customers ADD CONSTRAINT customers_segment_fk FOREIGN KEY (segment) REFERENCES customer_segments (id);

-- Every move between segments is kept, with who and why.
CREATE TABLE customer_segment_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL,
  from_segment text NOT NULL,
  to_segment   text NOT NULL,
  reason       text NOT NULL,
  changed_by   text NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_segment_changes_idx ON customer_segment_changes (customer_id, changed_at DESC);

-- 3. Groups: services under one account that share benefits. One Principal, any number of Supplementary services; a supplementary
--    service cannot exist without the principal. The old customer-to-customer "group" links are kept, unused, under a new name.
ALTER TABLE group_memberships RENAME TO legacy_group_memberships;
CREATE TABLE service_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shard_id    smallint NOT NULL,
  customer_id uuid NOT NULL,
  account_id  uuid NOT NULL,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
  benefits    jsonb NOT NULL DEFAULT '{}',          -- { allowances: { dataGb, voiceMinutes, smsCount }, discountBps }
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);
CREATE INDEX service_groups_account_idx  ON service_groups (account_id, created_at, id) WHERE status = 'ACTIVE';
CREATE INDEX service_groups_customer_idx ON service_groups (customer_id) WHERE status = 'ACTIVE';
CREATE TABLE service_group_members (
  group_id   uuid NOT NULL REFERENCES service_groups (id),
  service_id uuid NOT NULL,
  role       text NOT NULL CHECK (role IN ('PRINCIPAL','SUPPLEMENTARY')),
  added_by   text,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, service_id)
);
CREATE UNIQUE INDEX service_group_members_service_uq ON service_group_members (service_id);                    -- a service is in at most one group
CREATE UNIQUE INDEX service_group_members_principal_uq ON service_group_members (group_id) WHERE role = 'PRINCIPAL'; -- and a group has one principal
CREATE INDEX customers_segment_idx ON customers (segment);
