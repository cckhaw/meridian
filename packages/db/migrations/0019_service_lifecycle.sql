-- Service lifecycle: voluntary suspension, credit-limit and dunning bars, termination and number quarantine.
-- (This codebase keeps its schema in SQL migrations rather than Prisma; this is the schema extension.)

-- What state a service is in beyond ACTIVE/SUSPENDED/TERMINATED, and why.
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS suspension_kind text,            -- VOLUNTARY | CREDIT | DUNNING | FRAUD | ADMIN (null when not suspended)
  ADD COLUMN IF NOT EXISTS suspended_at    timestamptz,
  ADD COLUMN IF NOT EXISTS suspend_until   date,            -- voluntary suspensions end on this date (automatic resume)
  ADD COLUMN IF NOT EXISTS bar_level       text NOT NULL DEFAULT 'NONE' CHECK (bar_level IN ('NONE','THROTTLE','SOFT','HARD')),
  ADD COLUMN IF NOT EXISTS terminated_reason text;
CREATE INDEX IF NOT EXISTS services_suspend_until_idx ON services (suspend_until) WHERE suspend_until IS NOT NULL AND status = 'SUSPENDED';

-- An account's own credit limit (null = the default in Settings → Lifecycle) and the deposit held for it.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS credit_limit_minor bigint,
  ADD COLUMN IF NOT EXISTS deposit_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_state text NOT NULL DEFAULT 'OK' CHECK (credit_state IN ('OK','WARNED','BLOCKED'));
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS collections_at timestamptz;   -- handed to collections
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN ('ISSUED','OVERDUE','PAID','VOID','WRITTEN_OFF'));
DROP INDEX IF EXISTS invoices_open_idx;
CREATE INDEX invoices_open_idx ON invoices (due_date) WHERE status IN ('ISSUED','OVERDUE');

-- Every change of a service's state, who asked for it and why (the lifecycle audit log).
CREATE TABLE service_lifecycle_events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  service_id  uuid NOT NULL,
  account_id  uuid,
  action      text NOT NULL,                  -- SUSPEND, RESUME, BAR, UNBAR, TERMINATE, PORT_OUT, CREDIT_WARNING ...
  from_status text,
  to_status   text,
  kind        text,                           -- VOLUNTARY | CREDIT | DUNNING ...
  actor       text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX service_lifecycle_service_idx ON service_lifecycle_events (service_id, at DESC);

-- Periods a customer asked to be suspended: recurring charges are paused or reduced to a maintenance fee for these days, and
-- prorated on the bill that follows the return.
CREATE TABLE service_suspensions (
  id            bigserial PRIMARY KEY,
  service_id    uuid NOT NULL,
  account_id    uuid NOT NULL,
  started_on    date NOT NULL,
  ends_on       date,                          -- the planned (maximum) end; null once ended early/converted
  ended_on      date,                          -- the day service came back (null while suspended)
  end_reason    text,                          -- RESUMED | AUTO_RESUMED | CONVERTED_TO_DUNNING | TERMINATED
  requested_by  text NOT NULL,
  channel       text NOT NULL DEFAULT 'STAFF'  -- STAFF | SELF_SERVE
);
CREATE INDEX service_suspensions_service_idx ON service_suspensions (service_id, started_on);
CREATE INDEX service_suspensions_account_idx ON service_suspensions (account_id, started_on);

-- The dunning ladder, one run per account while something is overdue; which steps have been applied.
CREATE TABLE dunning_runs (
  id           bigserial PRIMARY KEY,
  account_id   uuid NOT NULL,
  anchor_due   date NOT NULL,                  -- the due date (D) of the oldest unpaid invoice
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAID','TERMINATED','CANCELLED')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  workflow_id  text,
  last_step    text
);
CREATE UNIQUE INDEX dunning_runs_active_uq ON dunning_runs (account_id) WHERE status = 'ACTIVE';
CREATE TABLE dunning_steps (
  id          bigserial PRIMARY KEY,
  run_id      bigint NOT NULL REFERENCES dunning_runs (id),
  step        text NOT NULL,                   -- the step code in the ladder (REMIND, SOFT_BAR, HARD_BAR, FINAL_NOTICE, TERMINATE)
  day_offset  integer NOT NULL,
  applied_on  date NOT NULL,
  outcome     jsonb NOT NULL DEFAULT '{}',
  UNIQUE (run_id, step)
);

-- A number leaves service and rests here before it can be given to anyone else.
CREATE TABLE msisdn_quarantine (
  identifier   text PRIMARY KEY,
  service_id   uuid NOT NULL,
  reason       text NOT NULL,
  since        date NOT NULL,
  release_on   date NOT NULL
);
CREATE INDEX msisdn_quarantine_release_idx ON msisdn_quarantine (release_on);

-- Things that must reach other systems. Written in the same transaction as the change, delivered by an adapter
-- (PCRF/PCF policy, HLR/HSS, SMS and email, collections, the general ledger).
CREATE TABLE lifecycle_outbox (
  id           bigserial PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL CHECK (kind IN ('NETWORK','NOTIFY','COLLECTIONS','GL')),
  service_id   uuid,
  account_id   uuid,
  instruction  text NOT NULL,                  -- THROTTLE_DATA, BAR_OUTGOING, BAR_ALL, RESTORE, DEPROVISION, REMINDER, FINAL_NOTICE ...
  payload      jsonb NOT NULL DEFAULT '{}',
  delivered_at timestamptz
);
CREATE INDEX lifecycle_outbox_pending_idx ON lifecycle_outbox (id) WHERE delivered_at IS NULL;

-- Deposits move money without an order or an invoice, so a payment can belong to an account instead.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS account_id uuid;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_target;
ALTER TABLE payments ADD CONSTRAINT payments_target CHECK (order_id IS NOT NULL OR invoice_id IS NOT NULL OR account_id IS NOT NULL);
