-- Governed bill runs: every cycle is billed in four stages (mock, review, approval, production), and the mock is kept so what was approved is what is billed.

-- One row per monthly cycle day, so each of the 28 cycles can be switched off, given its own label and its own approval rule.
CREATE TABLE bill_cycle_configs (
  cycle_day    smallint PRIMARY KEY CHECK (cycle_day BETWEEN 1 AND 28),
  label        text NOT NULL DEFAULT '',
  enabled      boolean NOT NULL DEFAULT true,
  dual_control boolean,                       -- null: follow the global setting; true/false: this cycle always/never needs a second person
  notes        text NOT NULL DEFAULT '',
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO bill_cycle_configs (cycle_day, label) SELECT d, 'Cycle ' || d FROM generate_series(1, 28) d;

CREATE TABLE bill_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('CYCLE','DAILY','SELECTIVE')),   -- a cycle day, the daily-cycle accounts, or only the accounts chosen
  cycle_day         smallint,
  as_of             date NOT NULL,                     -- the bill date: the period billed is the one ending the day before
  status            text NOT NULL CHECK (status IN ('MOCK_RUNNING','MOCK_COMPLETED','PENDING_APPROVAL','APPROVED','PRODUCTION_RUNNING','COMPLETED','FAILED','CANCELLED')),
  options           jsonb NOT NULL DEFAULT '{}',
  note              text,
  requested_by      text NOT NULL,
  submitted_by      text,
  submitted_at      timestamptz,
  approved_by       text,
  approved_at       timestamptz,
  approval_note     text,
  mock_finished_at  timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,
  accounts_total    integer NOT NULL DEFAULT 0,
  mock_net_minor    bigint NOT NULL DEFAULT 0,
  mock_tax_minor    bigint NOT NULL DEFAULT 0,
  mock_total_minor  bigint NOT NULL DEFAULT 0,
  billed_invoices   integer NOT NULL DEFAULT 0,
  billed_total_minor bigint NOT NULL DEFAULT 0,
  summary           jsonb NOT NULL DEFAULT '{}',       -- revenue by stream, tax by market, counts by problem
  stage             text,
  percent           smallint NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  claimed_until     timestamptz,
  workflow_id       text,                              -- the Temporal workflow driving this run, when one is
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bill_runs_recent_idx ON bill_runs (created_at DESC);
CREATE INDEX bill_runs_active_idx ON bill_runs (status) WHERE status IN ('MOCK_RUNNING','PRODUCTION_RUNNING');
CREATE INDEX bill_runs_cycle_idx ON bill_runs (cycle_day, as_of DESC);

-- Every account in a run, with what the mock found and what the production run did. Also the work queue: both passes walk it in account order.
CREATE TABLE bill_run_items (
  run_id            uuid NOT NULL REFERENCES bill_runs (id) ON DELETE CASCADE,
  account_id        uuid NOT NULL,
  customer_id       uuid NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','MOCKED','NO_INVOICE','EXCLUDED','BILLED','FAILED','SKIPPED')),
  period_start      date,
  period_end        date,
  net_minor         bigint NOT NULL DEFAULT 0,
  tax_minor         bigint NOT NULL DEFAULT 0,
  total_minor       bigint NOT NULL DEFAULT 0,
  line_count        integer NOT NULL DEFAULT 0,
  prev_total_minor  bigint,                            -- the account's previous cycle invoice, for the comparison
  anomalies         text[] NOT NULL DEFAULT '{}',
  excluded_reason   text,
  exclusion_id      bigint,                            -- which exclusion kept it out, so lifting that exclusion brings it back
  invoice_id        uuid,
  billed_total_minor bigint,
  error             text,
  PRIMARY KEY (run_id, account_id)
);
CREATE INDEX bill_run_items_work_idx ON bill_run_items (run_id, status, account_id);
CREATE INDEX bill_run_items_anomaly_idx ON bill_run_items (run_id, account_id) WHERE cardinality(anomalies) > 0;
CREATE INDEX bill_run_items_customer_idx ON bill_run_items (run_id, customer_id);

-- Accounts (or a whole enterprise customer with every department below it) kept out of a bill run: a legal dispute, a fraud investigation.
-- run_id empty: a standing exclusion that applies to every run until it is lifted or reaches its end date.
CREATE TABLE bill_run_exclusions (
  id          bigserial PRIMARY KEY,
  scope       text NOT NULL CHECK (scope IN ('ACCOUNT','CUSTOMER_NODE')),
  account_id  uuid,
  customer_id uuid,
  run_id      uuid REFERENCES bill_runs (id) ON DELETE CASCADE,
  reason      text NOT NULL,
  until_date  date,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_by  text,
  removed_at  timestamptz,
  CHECK ((scope = 'ACCOUNT' AND account_id IS NOT NULL) OR (scope = 'CUSTOMER_NODE' AND customer_id IS NOT NULL))
);
CREATE INDEX bill_run_exclusions_active_idx ON bill_run_exclusions (run_id) WHERE removed_at IS NULL;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bill_run_id uuid;
CREATE INDEX IF NOT EXISTS invoices_bill_run_idx ON invoices (bill_run_id) WHERE bill_run_id IS NOT NULL;
-- Accounts on the daily cycle, in id order, for the daily run's keyset walk.
CREATE INDEX IF NOT EXISTS accounts_daily_idx ON accounts (id) WHERE bill_cycle_day IS NULL AND status = 'ACTIVE';
