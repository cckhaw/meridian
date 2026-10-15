-- Rule-based dunning: strategies by kind of customer, each a ladder of steps with its own trigger, action and exclusions; late-fee settings; payment arrangements;
-- accounts handed to a collection agency. Where no rule exists the single ladder in Settings → Lifecycle keeps working as before.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_risk text NOT NULL DEFAULT 'NORMAL' CHECK (credit_risk IN ('NORMAL','HIGH'));   -- a history of bad credit

CREATE TABLE late_fee_configs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  name           text NOT NULL,
  mode           text NOT NULL CHECK (mode IN ('FLAT','PERCENT')),         -- a fixed charge, or a percentage of the overdue balance (a month's interest)
  flat_minor     bigint NOT NULL DEFAULT 0 CHECK (flat_minor >= 0),
  percent_bps    integer NOT NULL DEFAULT 0 CHECK (percent_bps >= 0 AND percent_bps <= 10000),
  min_minor      bigint NOT NULL DEFAULT 0 CHECK (min_minor >= 0),
  max_minor      bigint CHECK (max_minor IS NULL OR max_minor >= 0),
  taxable        boolean NOT NULL DEFAULT false,
  revenue_account text NOT NULL DEFAULT '4300',
  active         boolean NOT NULL DEFAULT true,
  updated_by     text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dunning_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  name           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  active         boolean NOT NULL DEFAULT true,
  -- Whom it applies to. Every condition that is set must hold; the rule with the highest priority (then the most conditions) wins.
  priority       integer NOT NULL DEFAULT 100,
  market         char(2),                                                  -- the customer's market, or any
  customer_kind  text NOT NULL DEFAULT 'ANY' CHECK (customer_kind IN ('ANY','INDIVIDUAL','BUSINESS')),
  segments       text[] NOT NULL DEFAULT '{}',                             -- specific customer segments, or any
  vip            text NOT NULL DEFAULT 'ANY' CHECK (vip IN ('ANY','YES','NO')),
  credit_risk    text NOT NULL DEFAULT 'ANY' CHECK (credit_risk IN ('ANY','HIGH','NORMAL')),
  partial        jsonb NOT NULL DEFAULT '{}',                              -- what a partial payment does: { thresholdPercent, action: RESET_TO_SOFT_BAR | PAUSE, pauseDays }
  version        integer NOT NULL DEFAULT 1,
  created_by     text NOT NULL DEFAULT 'system',
  updated_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dunning_rule_steps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id        uuid NOT NULL REFERENCES dunning_rules (id) ON DELETE CASCADE,
  position       integer NOT NULL,
  name           text NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  trigger_kind   text NOT NULL CHECK (trigger_kind IN ('DAYS_PAST_DUE','BALANCE')),
  days           integer CHECK (days IS NULL OR days BETWEEN 0 AND 365),   -- D+X
  balance_minor  bigint CHECK (balance_minor IS NULL OR balance_minor > 0),-- the overdue balance at or above which it applies
  action         text NOT NULL CHECK (action IN ('NOTIFY','SOFT_BAR','HARD_BAR','LATE_FEE','TERMINATE','COLLECTIONS_TRANSFER','CASE_TASK')),
  params         jsonb NOT NULL DEFAULT '{}',
  exclusions     jsonb NOT NULL DEFAULT '{}',                              -- { dispute, vip, arrangement }
  UNIQUE (rule_id, position)
);
CREATE INDEX dunning_rule_steps_rule_idx ON dunning_rule_steps (rule_id, position);

-- A run is one account's walk down a ladder: which rule, a copy of its steps as they were at the start, and where it stands.
ALTER TABLE dunning_runs
  ADD COLUMN rule_id        uuid,
  ADD COLUMN rule_code      text,
  ADD COLUMN rule_version   integer,
  ADD COLUMN ladder         jsonb,
  ADD COLUMN paused_until   date,
  ADD COLUMN resets         integer NOT NULL DEFAULT 0;
-- The log of what was done (or held back) at each step.
ALTER TABLE dunning_steps DROP CONSTRAINT IF EXISTS dunning_steps_run_id_step_key;
ALTER TABLE dunning_steps
  ADD COLUMN step_key   text,
  ADD COLUMN step_name  text,
  ADD COLUMN status     text NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED','SUPERSEDED','HELD','FAILED','REVERSED')),
  ADD COLUMN reason     text,
  ADD COLUMN executed_at timestamptz NOT NULL DEFAULT now();
UPDATE dunning_steps SET step_key = step WHERE step_key IS NULL;
CREATE UNIQUE INDEX dunning_steps_run_key_uq ON dunning_steps (run_id, step_key);
CREATE INDEX dunning_runs_account_idx ON dunning_runs (account_id, started_at DESC);

-- A customer who has agreed a plan to pay what is owed in instalments is not chased while they keep to it.
CREATE TABLE payment_arrangements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL,
  customer_id   uuid NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED','BROKEN','CANCELLED')),
  total_minor   bigint NOT NULL CHECK (total_minor > 0),
  currency      char(3) NOT NULL,
  installments  jsonb NOT NULL,                                            -- [{ dueDate, amountMinor }]
  grace_days    integer NOT NULL DEFAULT 2,
  reason        text NOT NULL DEFAULT '',
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  end_reason    text
);
CREATE INDEX payment_arrangements_account_idx ON payment_arrangements (account_id, created_at DESC);
CREATE UNIQUE INDEX payment_arrangements_active_uq ON payment_arrangements (account_id) WHERE status = 'ACTIVE';

-- Debt placed with an external collection agency, and the file it was sent in.
CREATE TABLE collection_placements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL,
  customer_id   uuid NOT NULL,
  run_id        bigint,
  balance_minor bigint NOT NULL,
  currency      char(3) NOT NULL,
  invoices      jsonb NOT NULL DEFAULT '[]',
  written_off   boolean NOT NULL DEFAULT false,                            -- the receivable is out of the ledger; the agency may still recover it
  reason        text NOT NULL DEFAULT 'NON_PAYMENT',
  status        text NOT NULL DEFAULT 'PLACED' CHECK (status IN ('PLACED','RECOVERED','RECALLED')),
  placed_at     timestamptz NOT NULL DEFAULT now(),
  batch_id      text,
  exported_at   timestamptz,
  recovered_minor bigint NOT NULL DEFAULT 0
);
CREATE INDEX collection_placements_pending_idx ON collection_placements (placed_at) WHERE exported_at IS NULL AND status = 'PLACED';
CREATE INDEX collection_placements_account_idx ON collection_placements (account_id, placed_at DESC);

-- What an account manager is asked to do before the network is touched.
INSERT INTO case_taxonomy (id, parent_id, level, name, sort_order, case_type, default_severity, needs_dispatch, skills, equipment) VALUES
  ('billing.collections',          'billing',             2, 'Collections follow-up', 20, NULL, NULL, false, '{}', '{}'),
  ('billing.collections.followup', 'billing.collections', 3, 'Overdue account follow-up', 10, 'GENERAL', 'MINOR_INQUIRY', false, '{}', '{}')
  ON CONFLICT (id) DO NOTHING;

-- A late fee is an invoice of its own; this says which dunning run charged it.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS late_fee_run_id bigint;
