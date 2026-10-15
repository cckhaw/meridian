-- Simulations: forward projections, early-termination quotes and plan-change what-ifs are computed without touching real billing, and can be saved
-- (a quote an agent gave a customer, a forecast Finance wants to keep). Nothing here is read by billing, the ledger or reports.
CREATE TABLE simulation_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('PROJECTION','TERMINATION','PLAN_CHANGE')),
  title       text NOT NULL DEFAULT '',
  account_id  uuid,
  service_id  uuid,
  cycle_day   smallint NOT NULL DEFAULT 0,          -- the account's bill cycle day, 0 for a daily cycle
  params      jsonb NOT NULL DEFAULT '{}',
  summary     jsonb NOT NULL DEFAULT '{}',
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX simulation_runs_recent_idx ON simulation_runs (created_at DESC);
CREATE INDEX simulation_runs_account_idx ON simulation_runs (account_id, created_at DESC) WHERE account_id IS NOT NULL;

-- One row per simulated bill (or settlement), partitioned by the account's bill cycle day so a cycle's simulations live together and can be dropped together.
CREATE TABLE simulation_ledger (
  cycle_day    smallint NOT NULL,
  run_id       uuid NOT NULL REFERENCES simulation_runs (id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('BILL','SETTLEMENT','PLAN_CHANGE')),
  bill_date    date NOT NULL,
  period_start date,
  period_end   date,
  net_minor    bigint NOT NULL,
  tax_minor    bigint NOT NULL,
  total_minor  bigint NOT NULL,
  balance_minor bigint,                              -- the device balance still to pay after this bill
  lines        jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (cycle_day, run_id, seq)
) PARTITION BY LIST (cycle_day);
DO $$
BEGIN
  FOR d IN 0..28 LOOP
    EXECUTE format('CREATE TABLE simulation_ledger_c%s PARTITION OF simulation_ledger FOR VALUES IN (%s)', lpad(d::text, 2, '0'), d);
  END LOOP;
END $$;
CREATE INDEX simulation_ledger_run_idx ON simulation_ledger (run_id, seq);
