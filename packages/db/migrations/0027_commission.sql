-- Dealer and sales-agent commission: channel hierarchy, configurable plans (rules, volume slabs, claw-back policies), an append-only earnings ledger,
-- monthly settlement statements and bank / payroll payout files. Earnings and payouts post to the GL, so Finance's posting rules carry them to SAP.
-- (The brief asked for Prisma; this codebase keeps its schema in SQL migrations, and this is that schema.)

-- ───────── channel hierarchy: master distributors, dealers, sub-dealers, franchise outlets ─────────
ALTER TABLE dealers
  ADD COLUMN tier              text NOT NULL DEFAULT 'DEALER' CHECK (tier IN ('MASTER_DISTRIBUTOR','DEALER','SUB_DEALER','FRANCHISE')),
  ADD COLUMN parent_dealer_id  text REFERENCES dealers(id),
  ADD COLUMN bank_account_name text,
  ADD COLUMN bank_account_no   text,
  ADD COLUMN bank_code         text,
  ADD COLUMN sap_vendor_no     text;                 -- the dealer's vendor account in SAP accounts payable
CREATE INDEX dealers_parent_idx ON dealers (parent_dealer_id) WHERE parent_dealer_id IS NOT NULL;

-- ───────── plans, rules, claw-back policies ─────────
CREATE TABLE commission_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  valid_from    date,
  valid_to      date,
  hold_days     integer NOT NULL DEFAULT 0 CHECK (hold_days >= 0),   -- days an earning stays PENDING before it is approved for payment
  override_bps  jsonb NOT NULL DEFAULT '[]',                         -- what each level of upline earns on the sale: [parent, grandparent, ...] in basis points of the basis
  note          text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE commission_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         uuid NOT NULL REFERENCES commission_plans(id) ON DELETE CASCADE,
  name            text NOT NULL,
  priority        integer NOT NULL DEFAULT 100,                      -- lower wins between rules that match equally well
  match_kinds     jsonb NOT NULL DEFAULT '[]',                       -- offer kinds, empty = any
  match_offer_ids jsonb NOT NULL DEFAULT '[]',                       -- specific offers, empty = any
  min_term_months integer,                                           -- contract length: 0 = SIM-only, 24 = a 24-month contract; null = no limit
  max_term_months integer,
  match_tiers     jsonb NOT NULL DEFAULT '[]',                       -- seller tiers (MASTER_DISTRIBUTOR, DEALER, ...), empty = any
  calc            text NOT NULL DEFAULT 'PERCENT' CHECK (calc IN ('PERCENT','FIXED')),
  rate_bps        integer NOT NULL DEFAULT 0 CHECK (rate_bps >= 0),
  fixed_minor     bigint  NOT NULL DEFAULT 0 CHECK (fixed_minor >= 0),
  slab_mode       text NOT NULL DEFAULT 'MARGINAL' CHECK (slab_mode IN ('MARGINAL','RETROACTIVE')),
  slabs           jsonb NOT NULL DEFAULT '[]',                       -- [{ "from": 1, "to": 50, "rateBps": 500 }, ...] counted in activations per month
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commission_rules_plan_idx ON commission_rules (plan_id, priority);
CREATE TABLE clawback_policies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id           uuid NOT NULL REFERENCES commission_plans(id) ON DELETE CASCADE,
  name              text NOT NULL,
  min_term_months   integer,                                         -- applies to contracts of at least this length (null = all)
  triggers          jsonb NOT NULL DEFAULT '["TERMINATION","PORT_OUT","ORDER_CANCELLED"]',
  tiers             jsonb NOT NULL DEFAULT '[]',                     -- [{ "withinDays": 30, "percentBps": 10000 }, { "withinDays": 90, "percentBps": 5000 }]
  include_overrides boolean NOT NULL DEFAULT true,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clawback_policies_plan_idx ON clawback_policies (plan_id);
-- Who earns by which plan: a dealer (and, below it, its sub-dealers), a staff salesperson, a store, or a whole channel.
CREATE TABLE commission_assignments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id    uuid NOT NULL REFERENCES commission_plans(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('DEALER','STAFF','STORE','CHANNEL')),
  actor_id   text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, actor_id)
);

-- ───────── the earnings ledger (append-only apart from status and the claw-back bookkeeping) ─────────
CREATE TABLE agent_ledger_entries (
  id               bigserial PRIMARY KEY,
  beneficiary_kind text NOT NULL CHECK (beneficiary_kind IN ('DEALER','STAFF','STORE','HOUSE')),
  beneficiary_id   text NOT NULL,
  dealer_id        text,
  dealer_agent_id  text,
  store_id         text,
  entry_type       text NOT NULL CHECK (entry_type IN ('EARNING','OVERRIDE','ACCELERATOR','BONUS','CLAWBACK','ADJUSTMENT')),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','CLAWED_BACK','PAID')),
  amount_minor     bigint NOT NULL,                                   -- negative for a claw-back
  basis_minor      bigint NOT NULL DEFAULT 0,
  rate_bps         integer,
  units            integer NOT NULL DEFAULT 0,                        -- activations this entry counts toward the slabs
  currency         char(3) NOT NULL,
  plan_id          uuid,
  rule_id          uuid,
  order_id         uuid,
  order_line_id    uuid,
  offer_id         text,
  period           text NOT NULL,                                     -- YYYY-MM the earning counts in
  earned_on        date NOT NULL,
  approved_at      timestamptz,
  paid_at          timestamptz,
  settlement_id    uuid,
  reverses_id      bigint REFERENCES agent_ledger_entries(id),
  clawed_units     integer NOT NULL DEFAULT 0,
  clawed_minor     bigint NOT NULL DEFAULT 0,
  note             text,
  calc             jsonb NOT NULL DEFAULT '{}',                       -- how the amount was worked out: the rule, slab and numbers
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- The same sale line can only earn once for the same beneficiary.
CREATE UNIQUE INDEX agent_ledger_once_uq ON agent_ledger_entries (order_line_id, entry_type, beneficiary_kind, beneficiary_id) WHERE entry_type IN ('EARNING','OVERRIDE') AND order_line_id IS NOT NULL;
CREATE UNIQUE INDEX agent_ledger_bonus_uq ON agent_ledger_entries (rule_id, beneficiary_kind, beneficiary_id, period) WHERE entry_type = 'BONUS';
CREATE INDEX agent_ledger_beneficiary_idx ON agent_ledger_entries (beneficiary_kind, beneficiary_id, period, status);
CREATE INDEX agent_ledger_order_idx ON agent_ledger_entries (order_id);
CREATE INDEX agent_ledger_open_idx ON agent_ledger_entries (earned_on) WHERE status IN ('PENDING','APPROVED');
CREATE INDEX agent_ledger_settlement_idx ON agent_ledger_entries (settlement_id) WHERE settlement_id IS NOT NULL;

-- Nothing about what was earned can change afterwards: no deletes, and an entry's amount, beneficiary, order and rule are fixed. Only its status, the
-- approval, payment and settlement stamps, and the claw-back bookkeeping move. A correction is a new entry.
CREATE FUNCTION agent_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'commission ledger entries cannot be deleted; post a correcting entry'; END IF;
  IF (NEW.id, NEW.beneficiary_kind, NEW.beneficiary_id, NEW.entry_type, NEW.amount_minor, NEW.basis_minor, NEW.units, NEW.currency, NEW.order_id, NEW.order_line_id, NEW.period, NEW.earned_on, NEW.plan_id, NEW.rule_id, NEW.reverses_id)
     IS DISTINCT FROM
     (OLD.id, OLD.beneficiary_kind, OLD.beneficiary_id, OLD.entry_type, OLD.amount_minor, OLD.basis_minor, OLD.units, OLD.currency, OLD.order_id, OLD.order_line_id, OLD.period, OLD.earned_on, OLD.plan_id, OLD.rule_id, OLD.reverses_id)
  THEN RAISE EXCEPTION 'a commission ledger entry cannot be edited; post a correcting entry'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_ledger_immutable BEFORE UPDATE OR DELETE ON agent_ledger_entries FOR EACH ROW EXECUTE FUNCTION agent_ledger_guard();

-- ───────── statements and payouts ─────────
CREATE SEQUENCE commission_statement_seq;
CREATE SEQUENCE commission_payout_seq;
CREATE TABLE commission_periods (
  period     text PRIMARY KEY,
  closed_at  timestamptz NOT NULL DEFAULT now(),
  closed_by  text NOT NULL,
  statements integer NOT NULL DEFAULT 0
);
CREATE TABLE commission_payout_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_no        text NOT NULL UNIQUE,
  period          text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID')),
  file_name       text NOT NULL,
  content         text NOT NULL,
  content_type    text NOT NULL DEFAULT 'text/csv',
  file_sha256     text NOT NULL,
  total_minor     bigint NOT NULL,
  statement_count integer NOT NULL,
  currency        char(3) NOT NULL,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  confirmed_by    text
);
CREATE TABLE commission_settlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_no     text NOT NULL UNIQUE,
  period           text NOT NULL,
  beneficiary_kind text NOT NULL,
  beneficiary_id   text NOT NULL,
  beneficiary_name text NOT NULL,
  payout_method    text NOT NULL CHECK (payout_method IN ('BANK','PAYROLL','HOUSE')),
  gross_minor      bigint NOT NULL,                                   -- earnings, overrides, accelerators and bonuses
  clawback_minor   bigint NOT NULL,                                   -- claw-backs netted in (zero or negative)
  net_minor        bigint NOT NULL,
  entry_count      integer NOT NULL,
  currency         char(3) NOT NULL,
  status           text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','PAYOUT_PENDING','PAID')),
  payout_batch_id  uuid REFERENCES commission_payout_batches(id),
  issued_at        timestamptz NOT NULL DEFAULT now(),
  paid_at          timestamptz
);
CREATE INDEX commission_settlements_period_idx ON commission_settlements (period, beneficiary_kind, beneficiary_id);

-- ───────── the commission already accrued by the earlier flat-rate engine becomes ledger entries ─────────
INSERT INTO agent_ledger_entries (beneficiary_kind, beneficiary_id, dealer_id, store_id, entry_type, status, amount_minor, basis_minor, rate_bps, units, currency, order_id, period, earned_on, approved_at, paid_at, note)
SELECT CASE WHEN dealer_id IS NOT NULL THEN 'DEALER' WHEN salesperson_id IS NOT NULL THEN 'STAFF' ELSE 'STORE' END,
       COALESCE(dealer_id, salesperson_id, store_id, 'HOUSE'), dealer_id, store_id, 'EARNING',
       CASE status WHEN 'PAID' THEN 'PAID' WHEN 'CLAWED_BACK' THEN 'CLAWED_BACK' ELSE 'APPROVED' END,
       amount_minor, basis_minor, rate_bps, 0, currency, order_id, to_char(created_at, 'YYYY-MM'), created_at::date, created_at,
       CASE WHEN status = 'PAID' THEN created_at END, 'Carried over from the flat-rate commission table'
  FROM commissions;

-- ───────── starting plan: what the flat rates paid, so nothing changes until Finance edits it ─────────
WITH p AS (INSERT INTO commission_plans (name, note, created_by) VALUES ('Standard commission', 'Starting plan: the flat rates by channel. Edit it or add plans in Commission → Plans.', 'system') RETURNING id),
     r AS (INSERT INTO commission_rules (plan_id, name, rate_bps) SELECT id, 'Percent of sale value', 300 FROM p RETURNING plan_id),
     c AS (INSERT INTO clawback_policies (plan_id, name, tiers) SELECT id, 'Early churn', '[{"withinDays":30,"percentBps":10000},{"withinDays":90,"percentBps":5000}]' FROM p RETURNING plan_id)
INSERT INTO commission_assignments (plan_id, kind, actor_id, created_by) SELECT id, 'CHANNEL', ch, 'system' FROM p, (VALUES ('RETAIL_ASSISTED'), ('DEALER'), ('TELESALES')) AS v(ch);
-- The earlier engine paid 3% retail, 5% dealer, 4% telesales: one rule per channel plan would need three plans, so the dealer and telesales rates are separate plans.
WITH d AS (INSERT INTO commission_plans (name, note, created_by) VALUES ('Dealer commission', 'Starting plan for the DEALER channel.', 'system') RETURNING id),
     dr AS (INSERT INTO commission_rules (plan_id, name, rate_bps) SELECT id, 'Percent of sale value', 500 FROM d RETURNING plan_id),
     dc AS (INSERT INTO clawback_policies (plan_id, name, tiers) SELECT id, 'Early churn', '[{"withinDays":30,"percentBps":10000},{"withinDays":90,"percentBps":5000}]' FROM d RETURNING plan_id)
UPDATE commission_assignments a SET plan_id = d.id FROM d WHERE a.kind = 'CHANNEL' AND a.actor_id = 'DEALER';
WITH t AS (INSERT INTO commission_plans (name, note, created_by) VALUES ('Telesales commission', 'Starting plan for the TELESALES channel.', 'system') RETURNING id),
     tr AS (INSERT INTO commission_rules (plan_id, name, rate_bps) SELECT id, 'Percent of sale value', 400 FROM t RETURNING plan_id),
     tc AS (INSERT INTO clawback_policies (plan_id, name, tiers) SELECT id, 'Early churn', '[{"withinDays":30,"percentBps":10000},{"withinDays":90,"percentBps":5000}]' FROM t RETURNING plan_id)
UPDATE commission_assignments a SET plan_id = t.id FROM t WHERE a.kind = 'CHANNEL' AND a.actor_id = 'TELESALES';

-- ───────── GL: commission expense, payable and the disbursement clearing account, with sample SAP mappings ─────────
INSERT INTO coa_mappings (name, match_account, sap_account, cost_center, profit_center, priority, note, created_by) VALUES
 ('Sales commission expense',     '6200', '620100', 'CC-SALES', NULL, 100, 'sample', 'system'),
 ('Commission payable',           '2300', '230100', NULL,       NULL, 100, 'sample', 'system'),
 ('Commission disbursement clearing', '1150', '113150', NULL,   NULL, 100, 'sample', 'system');
