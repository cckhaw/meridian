-- Meridian core schema (PostgreSQL / AlloyDB).
-- Sharding model: every tenant-owned row carries shard_id = abs(hashtext(customer_id)) % 1024.
-- Logical shards map to physical AlloyDB clusters via the shard_map table (router lives in app layer).
-- High-cardinality tables (services, order_lines, usage) are additionally HASH partitioned so a
-- single IoT enterprise with millions of devices does not create an unbounded hot partition.

CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TABLE shard_map (
  logical_shard smallint PRIMARY KEY CHECK (logical_shard BETWEEN 0 AND 1023),
  cluster_name  text NOT NULL,
  read_only     boolean NOT NULL DEFAULT false
);

CREATE TYPE customer_segment AS ENUM ('CONSUMER','FAMILY','ENTERPRISE','IOT_ENTERPRISE');
CREATE TYPE account_status   AS ENUM ('ACTIVE','SUSPENDED','CLOSED');
CREATE TYPE service_type     AS ENUM ('MOBILE','FIBER','IOT','SUBSCRIPTION');
CREATE TYPE service_status   AS ENUM ('PENDING','ACTIVE','SUSPENDED','PORTING_OUT','TERMINATED');
CREATE TYPE membership_role  AS ENUM ('OWNER','MEMBER','DEPARTMENT');

-- ───────────── Customer hierarchy ─────────────
CREATE TABLE customers (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  shard_id          smallint NOT NULL,
  segment           customer_segment NOT NULL,
  display_name      text NOT NULL,
  id_document_ref   text NOT NULL,           -- encrypted at rest (envelope encryption, KMS)
  market_code       char(2) NOT NULL,
  parent_customer_id uuid,
  hierarchy_path    ltree NOT NULL,          -- enterprise -> department -> sub-department
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shard_id, id)
) PARTITION BY LIST (shard_id);
CREATE INDEX customers_path_gist ON customers USING gist (hierarchy_path);

CREATE TABLE accounts (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  shard_id        smallint NOT NULL,
  customer_id     uuid NOT NULL,
  bill_cycle_day  smallint CHECK (bill_cycle_day IS NULL OR bill_cycle_day BETWEEN 1 AND 28), -- NULL = daily
  status          account_status NOT NULL DEFAULT 'ACTIVE',
  currency        char(3) NOT NULL,
  payer_account_id uuid,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shard_id, id)
) PARTITION BY LIST (shard_id);
CREATE INDEX accounts_customer_idx ON accounts (shard_id, customer_id);
CREATE INDEX accounts_cycle_idx ON accounts (bill_cycle_day) WHERE status = 'ACTIVE';

CREATE TABLE services (
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  shard_id             smallint NOT NULL,
  account_id           uuid NOT NULL,
  customer_id          uuid NOT NULL,
  type                 service_type NOT NULL,
  identifier           text NOT NULL,        -- MSISDN / circuit id / IoT device id
  iccid                text,
  offer_id             text NOT NULL,
  status               service_status NOT NULL DEFAULT 'PENDING',
  contract_start       timestamptz,
  contract_term_months smallint,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shard_id, identifier, id)   -- unique/PK on a partitioned table must include the partition key
) PARTITION BY HASH (identifier);          -- spreads multi-million-device IoT fleets; MSISDN lookups hit 1 partition
CREATE UNIQUE INDEX services_identifier_uq ON services (shard_id, type, identifier);
CREATE INDEX services_account_idx ON services (shard_id, account_id);

CREATE TABLE group_memberships (
  group_customer_id  uuid NOT NULL,
  member_customer_id uuid NOT NULL,
  shard_id           smallint NOT NULL,
  role               membership_role NOT NULL,
  PRIMARY KEY (shard_id, group_customer_id, member_customer_id)
);

-- ───────────── Order management ─────────────
CREATE TYPE order_channel AS ENUM ('SELF_SERVE','RETAIL_ASSISTED','QUICK_SALE','TELESALES','DEALER','CALL_CENTER');
CREATE TYPE order_state AS ENUM ('DRAFT','SUBMITTED','VALIDATED','PAYMENT_PENDING','PAID','FULFILMENT',
  'AWAITING_INSTALLATION','SHIPPED','DELIVERED','ACTIVATED','COMPLETED','CANCELLED','FAILED');
CREATE TYPE payment_method AS ENUM ('CREDIT_CARD','CASH','QR','INSTALLMENT','ETC_CHARGE');
CREATE TYPE payment_status AS ENUM ('PENDING','AUTHORISED','CAPTURED','FAILED','REFUNDED');

CREATE TABLE orders (
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  shard_id              smallint NOT NULL,
  customer_id           uuid NOT NULL,
  channel               order_channel NOT NULL,
  state                 order_state NOT NULL DEFAULT 'DRAFT',
  total_minor           bigint NOT NULL,
  currency              char(3) NOT NULL,
  store_id              text,
  salesperson_id        text,
  dealer_id             text,
  commission_eligible   boolean NOT NULL DEFAULT false,
  workflow_id           text,
  point_of_no_return_at timestamptz,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shard_id, id)
) PARTITION BY LIST (shard_id);
CREATE INDEX orders_customer_idx ON orders (shard_id, customer_id, created_at DESC);
CREATE INDEX orders_state_idx ON orders (state) WHERE state NOT IN ('COMPLETED','CANCELLED','FAILED');

CREATE TABLE order_lines (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  shard_id      smallint NOT NULL,
  order_id      uuid NOT NULL,
  offer_id      text NOT NULL,
  quantity      integer NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL,
  msisdn        text,
  serial_number text,
  PRIMARY KEY (shard_id, order_id, id)
) PARTITION BY HASH (order_id);
CREATE INDEX order_lines_order_idx ON order_lines (shard_id, order_id);

-- Append-only audit of state transitions (also published to Kafka topic meridian.order.events).
CREATE TABLE order_state_history (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  shard_id    smallint NOT NULL,
  order_id    uuid NOT NULL,
  from_state  order_state,
  to_state    order_state NOT NULL,
  actor       text NOT NULL,
  reason      text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shard_id, id)
);

CREATE TABLE payments (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  shard_id       smallint NOT NULL,
  order_id       uuid NOT NULL,
  method         payment_method NOT NULL,
  status         payment_status NOT NULL DEFAULT 'PENDING',
  amount_minor   bigint NOT NULL,
  currency       char(3) NOT NULL,
  installment_months smallint,
  gateway_ref    text,
  idempotency_key text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shard_id, id),
  UNIQUE (shard_id, idempotency_key)
);

CREATE TABLE installation_appointments (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  shard_id    smallint NOT NULL,
  order_id    uuid NOT NULL,
  slot_start  timestamptz NOT NULL,
  slot_end    timestamptz NOT NULL,
  technician_id text,
  status      text NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED','DISPATCHED','DONE','CANCELLED')),
  PRIMARY KEY (shard_id, id)
);

CREATE TABLE inventory_stock (
  location_id text NOT NULL,           -- store, dealer or warehouse
  sku         text NOT NULL,
  on_hand     integer NOT NULL CHECK (on_hand >= 0),
  reserved    integer NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
  PRIMARY KEY (location_id, sku)
);

CREATE TABLE inventory_reservations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL,
  location_id text NOT NULL,
  sku         text NOT NULL,
  quantity    integer NOT NULL CHECK (quantity > 0),
  released_at timestamptz,
  FOREIGN KEY (location_id, sku) REFERENCES inventory_stock (location_id, sku)
);
