-- BSS core additions: catalog, billing, ledger, cases, commissions, lifecycle columns.
-- Money is integer minor units. Dates that are business dates (invoice periods, due dates) are `date`.

-- ───────── Customer / account / service additions ─────────
ALTER TABLE customers ADD COLUMN email text, ADD COLUMN phone text,
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN id_document_hash text;               -- HMAC of the ID document for duplicate detection
ALTER TABLE accounts  ADD COLUMN name text NOT NULL DEFAULT 'Main account',
  ADD COLUMN dunning_stage smallint NOT NULL DEFAULT 0;
ALTER TABLE services  ADD COLUMN activated_at timestamptz, ADD COLUMN terminated_at timestamptz,
  ADD COLUMN order_id uuid, ADD COLUMN suspended_reason text;
CREATE INDEX services_offer_idx ON services (offer_id);
CREATE INDEX services_status_idx ON services (status);
CREATE INDEX customers_name_idx ON customers (lower(display_name));
CREATE INDEX customers_phone_idx ON customers (phone);

CREATE SEQUENCE msisdn_seq START 91000000;       -- local number part, prefixed with the market dial code
CREATE SEQUENCE circuit_seq START 100000;
CREATE SEQUENCE invoice_seq START 1;

-- Recurring / instalment / one-off charges attached to a service, consumed by the bill run.
CREATE TABLE service_charges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shard_id         smallint NOT NULL,
  service_id       uuid NOT NULL,
  account_id       uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('INSTALLMENT','ADJUSTMENT')),
  description      text NOT NULL,
  amount_minor     bigint NOT NULL,
  tax_inclusive    boolean NOT NULL DEFAULT true,
  remaining_cycles integer NOT NULL CHECK (remaining_cycles >= 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_charges_account_idx ON service_charges (account_id) WHERE remaining_cycles > 0;

-- ───────── Product catalog (Postgres/JSONB implementation; the Mongo service mirrors this model) ─────────
CREATE TABLE catalog_nodes (
  id          text PRIMARY KEY,
  level       text NOT NULL CHECK (level IN ('NETWORK_TYPE','CATEGORY','GROUP','OFFER')),
  code        text NOT NULL,
  name        text NOT NULL,
  path        text NOT NULL UNIQUE,
  parent_id   text REFERENCES catalog_nodes(id),
  status      text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  kind        text,
  markets     text[] NOT NULL DEFAULT '{}',
  data        jsonb NOT NULL DEFAULT '{}',        -- prices, contract, fulfilment, characteristics, requires/excludes
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_nodes_parent_idx ON catalog_nodes (parent_id);
CREATE INDEX catalog_nodes_kind_idx ON catalog_nodes (level, kind, status);

-- ───────── Orders ─────────
ALTER TABLE orders ADD COLUMN account_id uuid, ADD COLUMN market_code char(2) NOT NULL DEFAULT 'SG',
  ADD COLUMN payment_method payment_method, ADD COLUMN installment_months smallint,
  ADD COLUMN pending_tasks text[] NOT NULL DEFAULT '{}',   -- INSTALL | SHIP | PICKUP outstanding before activation
  ADD COLUMN fulfilment jsonb NOT NULL DEFAULT '{}',        -- slot, tracking number, delivery address
  ADD COLUMN failure_reason text, ADD COLUMN completed_at timestamptz;
ALTER TABLE order_lines ADD COLUMN description text NOT NULL DEFAULT '', ADD COLUMN net_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN tax_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE payments ALTER COLUMN order_id DROP NOT NULL, ADD COLUMN invoice_id uuid, ADD COLUMN reference text;
ALTER TABLE payments ADD CONSTRAINT payments_target CHECK (order_id IS NOT NULL OR invoice_id IS NOT NULL);
ALTER TABLE inventory_reservations ADD COLUMN consumed_at timestamptz;

CREATE TABLE commissions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL,
  store_id       text, salesperson_id text, dealer_id text,
  basis_minor    bigint NOT NULL,
  rate_bps       integer NOT NULL,
  amount_minor   bigint NOT NULL,
  currency       char(3) NOT NULL,
  status         text NOT NULL DEFAULT 'ACCRUED' CHECK (status IN ('ACCRUED','PAID','CLAWED_BACK')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ───────── Billing ─────────
CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shard_id      smallint NOT NULL,
  number        text NOT NULL UNIQUE,
  account_id    uuid NOT NULL,
  customer_id   uuid NOT NULL,
  kind          text NOT NULL DEFAULT 'CYCLE' CHECK (kind IN ('CYCLE','FINAL','ADJUSTMENT')),
  period_start  date NOT NULL,
  period_end    date NOT NULL,                   -- inclusive
  issue_date    date NOT NULL,
  due_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','OVERDUE','PAID','VOID')),
  currency      char(3) NOT NULL,
  net_minor     bigint NOT NULL,
  tax_minor     bigint NOT NULL,
  total_minor   bigint NOT NULL,
  paid_minor    bigint NOT NULL DEFAULT 0,
  credited_minor bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (total_minor = net_minor + tax_minor)
);
-- One cycle invoice per account per period: makes bill runs idempotent and safe to retry.
CREATE UNIQUE INDEX invoices_cycle_uq ON invoices (account_id, period_start, period_end) WHERE kind = 'CYCLE';
CREATE INDEX invoices_customer_idx ON invoices (customer_id, issue_date DESC);
CREATE INDEX invoices_open_idx ON invoices (due_date) WHERE status IN ('ISSUED','OVERDUE');

CREATE TABLE invoice_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoices(id),
  service_id  uuid,
  kind        text NOT NULL CHECK (kind IN ('RECURRING','INSTALLMENT','ETC','ADJUSTMENT')),
  revenue_account text NOT NULL,                 -- GL account credited
  description text NOT NULL,
  net_minor   bigint NOT NULL,
  tax_minor   bigint NOT NULL
);
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id);

ALTER TABLE payments ADD CONSTRAINT payments_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices(id);

-- ───────── General ledger ─────────
CREATE TABLE gl_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  entry_count integer NOT NULL,
  debit_minor bigint NOT NULL,
  credit_minor bigint NOT NULL
);
CREATE TABLE gl_entries (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id    uuid NOT NULL,                   -- all lines of one business event share a journal and must balance
  entry_date    date NOT NULL,
  source_type   text NOT NULL,                   -- ORDER | INVOICE | PAYMENT | CREDIT_NOTE | REFUND
  source_id     text NOT NULL,
  account_code  text NOT NULL,
  description   text NOT NULL,
  debit_minor   bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor  bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  currency      char(3) NOT NULL,
  exported_batch_id uuid REFERENCES gl_batches(id),
  CHECK ((debit_minor = 0) <> (credit_minor = 0))
);
CREATE INDEX gl_entries_unexported_idx ON gl_entries (entry_date) WHERE exported_batch_id IS NULL;
CREATE INDEX gl_entries_source_idx ON gl_entries (source_type, source_id);

-- ───────── Cases (Customer 360) ─────────
CREATE TABLE cases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number       text NOT NULL UNIQUE,
  customer_id  uuid NOT NULL,
  service_id   uuid,
  type         text NOT NULL CHECK (type IN ('FIBER_ASSURANCE','BILLING_REFUND','MNP_PORT_OUT','GENERAL')),
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')),
  priority     text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  subject      text NOT NULL,
  notes        jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE case_seq START 1;
CREATE INDEX cases_customer_idx ON cases (customer_id, created_at DESC);
CREATE INDEX cases_open_idx ON cases (status) WHERE status IN ('OPEN','IN_PROGRESS');

-- ───────── Audit trail ─────────
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  entity     text NOT NULL,
  entity_id  text NOT NULL,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id, at DESC);

-- ───────── Global identifier registry ─────────
-- services is sharded, so its unique index only guarantees uniqueness *within a shard*. MSISDNs, circuit ids and
-- IoT ids must be unique platform-wide, so they are claimed here (unsharded, single-writer-per-key) in the same
-- transaction that creates the service. Released numbers stay registered (quarantine) until a recycling job removes them.
CREATE TABLE identifier_registry (
  type        text NOT NULL,
  identifier  text NOT NULL,
  service_id  uuid NOT NULL,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (type, identifier)
);
