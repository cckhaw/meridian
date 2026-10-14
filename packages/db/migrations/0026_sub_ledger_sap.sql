-- BSS sub-ledger and SAP journal export.
--  * gl_entries becomes the immutable, monthly-partitioned financial sub-ledger (double-entry lines; every journal balances).
--  * ledger_events makes event ingestion idempotent; ledger_dead_letters keeps events that could not be posted.
--  * coa_mappings lets Finance decide, without a deployment, which SAP account / cost centre / profit centre a ledger line goes to.
--  * gl_batches records each journal run (a JournalBatchRun); the exact file that was produced is kept in journal_batch_files.
--  * reconciliation_reports / reconciliation_exceptions hold the cross-check of the ledger against what was exported and what SAP acknowledged.

ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS stream text;

-- ───────── the sub-ledger: partitioned by posting month ─────────
ALTER TABLE gl_entries RENAME TO gl_entries_old;
DROP INDEX IF EXISTS gl_entries_unexported_idx;
DROP INDEX IF EXISTS gl_entries_source_idx;
CREATE SEQUENCE gl_entry_seq;
CREATE TABLE gl_entries (
  id            bigint NOT NULL DEFAULT nextval('gl_entry_seq'),
  journal_id    uuid NOT NULL,                   -- all lines of one business event share a journal and must balance
  entry_date    date NOT NULL,
  source_type   text NOT NULL,                   -- ORDER | INVOICE | PAYMENT | CREDIT_NOTE | REFUND | DEPOSIT | WRITE_OFF | EVENT
  source_id     text NOT NULL,
  account_code  text NOT NULL,                   -- the BSS account; Finance's posting rules turn it into a SAP account at export
  description   text NOT NULL,
  debit_minor   bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor  bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  currency      char(3) NOT NULL,
  exported_batch_id uuid REFERENCES gl_batches(id),
  stream        text,                            -- revenue stream: SUBSCRIPTION, USAGE, DEVICE_INSTALMENT, THIRD_PARTY, ETC, GOODS, ONE_TIME
  event_type    text,                            -- INVOICE_GENERATED, PAYMENT_SUCCESS, ADJUSTMENT_POSTED, ETC_CHARGED ...
  event_id      text,                            -- the idempotency key of an ingested event
  posted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, entry_date),
  CHECK ((debit_minor = 0) <> (credit_minor = 0))
) PARTITION BY RANGE (entry_date);

-- Monthly partitions from the oldest entry (or this month) to three years ahead, and a default partition so a stray date never fails a posting.
DO $$
DECLARE m date; last date;
BEGIN
  m := date_trunc('month', LEAST(COALESCE((SELECT min(entry_date) FROM gl_entries_old), current_date), current_date))::date;
  last := (date_trunc('month', current_date) + interval '36 months')::date;
  WHILE m <= last LOOP
    EXECUTE format('CREATE TABLE gl_entries_p%s PARTITION OF gl_entries FOR VALUES FROM (%L) TO (%L)', to_char(m, 'YYYYMM'), m, (m + interval '1 month')::date);
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;
CREATE TABLE gl_entries_default PARTITION OF gl_entries DEFAULT;

INSERT INTO gl_entries (id, journal_id, entry_date, source_type, source_id, account_code, description, debit_minor, credit_minor, currency, exported_batch_id, event_type)
SELECT id, journal_id, entry_date, source_type, source_id, account_code, description, debit_minor, credit_minor, currency, exported_batch_id,
       CASE source_type WHEN 'INVOICE' THEN 'INVOICE_GENERATED' WHEN 'PAYMENT' THEN 'PAYMENT_SUCCESS' WHEN 'CREDIT_NOTE' THEN 'ADJUSTMENT_POSTED'
                        WHEN 'REFUND' THEN 'REFUND_POSTED' WHEN 'ORDER' THEN 'ORDER_PAID' WHEN 'DEPOSIT' THEN 'DEPOSIT_RECEIVED' WHEN 'WRITE_OFF' THEN 'WRITE_OFF' ELSE source_type END
  FROM gl_entries_old;
SELECT setval('gl_entry_seq', GREATEST((SELECT COALESCE(max(id), 0) FROM gl_entries), 1));
DROP TABLE gl_entries_old;

CREATE INDEX gl_entries_unexported_idx ON gl_entries (entry_date) WHERE exported_batch_id IS NULL;
CREATE INDEX gl_entries_source_idx ON gl_entries (source_type, source_id);
CREATE INDEX gl_entries_journal_idx ON gl_entries (journal_id);
CREATE INDEX gl_entries_account_idx ON gl_entries (account_code, entry_date);
CREATE INDEX gl_entries_batch_idx ON gl_entries (exported_batch_id) WHERE exported_batch_id IS NOT NULL;

-- Immutable: a posted line is never changed or deleted. The one allowed update is stamping it with the batch that exported it, once.
CREATE FUNCTION gl_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger entries are immutable: post a reversing journal instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.exported_batch_id IS NULL AND NEW.exported_batch_id IS NOT NULL
     AND (NEW.id, NEW.journal_id, NEW.entry_date, NEW.source_type, NEW.source_id, NEW.account_code, NEW.description, NEW.debit_minor, NEW.credit_minor, NEW.currency, NEW.stream, NEW.event_type, NEW.event_id, NEW.posted_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.journal_id, OLD.entry_date, OLD.source_type, OLD.source_id, OLD.account_code, OLD.description, OLD.debit_minor, OLD.credit_minor, OLD.currency, OLD.stream, OLD.event_type, OLD.event_id, OLD.posted_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ledger entries are immutable: post a reversing journal instead' USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER gl_entries_immutable BEFORE UPDATE OR DELETE ON gl_entries FOR EACH ROW EXECUTE FUNCTION gl_entries_guard();

-- ───────── event ingestion ─────────
CREATE TABLE ledger_events (
  event_id     text PRIMARY KEY,                 -- the sender's id: the same event delivered twice posts once
  event_type   text NOT NULL,
  payload_hash text NOT NULL,                    -- the same id with a different payload is an error, not a duplicate
  journal_id   uuid,
  source       text NOT NULL DEFAULT 'API',      -- API | KAFKA | MODULE
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger_dead_letters (
  id          bigserial PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  topic       text,
  message_key text,
  payload     text NOT NULL,
  error       text NOT NULL,
  resolved_at timestamptz
);
CREATE INDEX ledger_dead_letters_open_idx ON ledger_dead_letters (id) WHERE resolved_at IS NULL;

-- ───────── chart of accounts mapping (posting rules) ─────────
CREATE TABLE coa_mappings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  priority       integer NOT NULL DEFAULT 100,    -- lower wins between rules that match equally well
  match_account  text,                            -- the BSS account (null = any)
  match_stream   text,                            -- the revenue stream (null = any, including lines with no stream)
  match_event    text,                            -- the event type (null = any)
  match_source   text,                            -- the source type (null = any)
  sap_account    text NOT NULL,                   -- SAP G/L account
  cost_center    text,
  profit_center  text,
  tax_code       text,
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  valid_from     date,
  valid_to       date,
  note           text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coa_mappings_active_idx ON coa_mappings (status, priority);

-- Sample starting rules. The SAP accounts, cost centres and profit centres are placeholders: Finance replaces them with the company's own in Finance → Posting rules.
INSERT INTO coa_mappings (name, match_account, match_stream, sap_account, cost_center, profit_center, priority, note, created_by) VALUES
 ('Cash and bank',                 '1100', NULL,                '113100', NULL,      NULL,        100, 'sample', 'system'),
 ('Accounts receivable',           '1200', NULL,                '121000', NULL,      NULL,        100, 'sample', 'system'),
 ('Indirect tax payable',          '2100', NULL,                '217000', NULL,      NULL,        100, 'sample', 'system'),
 ('Customer deposits',             '2200', NULL,                '228000', NULL,      NULL,        100, 'sample', 'system'),
 ('Bad debt expense',              '6100', NULL,                '650100', 'CC-FIN',  NULL,        100, 'sample', 'system'),
 ('Credit notes and refunds',      '4900', NULL,                '490000', NULL,      'PC-MOBILE', 100, 'sample', 'system'),
 ('Service revenue (other)',       '4000', NULL,                '400000', NULL,      'PC-MOBILE', 100, 'sample', 'system'),
 ('Subscription revenue',          '4000', 'SUBSCRIPTION',      '400100', NULL,      'PC-MOBILE', 100, 'sample', 'system'),
 ('Voice and data usage revenue',  '4000', 'USAGE',             '400200', NULL,      'PC-MOBILE', 100, 'sample', 'system'),
 ('One-time service fees',         '4000', 'ONE_TIME',          '400300', NULL,      'PC-MOBILE', 100, 'sample', 'system'),
 ('Third-party digital content',   '4000', 'THIRD_PARTY',       '420100', NULL,      'PC-DIGITAL',100, 'sample', 'system'),
 ('Early termination fees',        '4000', 'ETC',               '440100', NULL,      'PC-MOBILE', 100, 'sample', 'system'),
 ('Goods revenue (other)',         '4100', NULL,                '410000', NULL,      'PC-DEVICES',100, 'sample', 'system'),
 ('Device sales',                  '4100', 'GOODS',             '410100', NULL,      'PC-DEVICES',100, 'sample', 'system'),
 ('Device instalments',            '4100', 'DEVICE_INSTALMENT', '410200', NULL,      'PC-DEVICES',100, 'sample', 'system');

-- ───────── journal batch runs ─────────
ALTER TABLE gl_batches
  ADD COLUMN IF NOT EXISTS run_type        text NOT NULL DEFAULT 'MANUAL' CHECK (run_type IN ('SCHEDULED','MANUAL','REALTIME')),
  ADD COLUMN IF NOT EXISTS format          text NOT NULL DEFAULT 'CSV'    CHECK (format IN ('CSV','FLAT','IDOC','JSON')),
  ADD COLUMN IF NOT EXISTS status          text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','FAILED')),
  ADD COLUMN IF NOT EXISTS period_from     date,
  ADD COLUMN IF NOT EXISTS period_to       date,
  ADD COLUMN IF NOT EXISTS document_count  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS file_name       text,
  ADD COLUMN IF NOT EXISTS file_sha256     text,
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'NOT_SENT' CHECK (delivery_status IN ('NOT_SENT','DELIVERED','FAILED')),
  ADD COLUMN IF NOT EXISTS delivery_detail text,
  ADD COLUMN IF NOT EXISTS sap_reference   text,
  ADD COLUMN IF NOT EXISTS sap_debit_minor bigint,
  ADD COLUMN IF NOT EXISTS sap_credit_minor bigint,
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS error           text,
  ADD COLUMN IF NOT EXISTS created_by      text;
CREATE SEQUENCE gl_batch_seq;
ALTER TABLE gl_batches ADD COLUMN IF NOT EXISTS batch_no text;
UPDATE gl_batches SET batch_no = 'M' || lpad(nextval('gl_batch_seq')::text, 7, '0') WHERE batch_no IS NULL;
CREATE TABLE journal_batch_files (
  batch_id     uuid PRIMARY KEY REFERENCES gl_batches(id),
  content      text NOT NULL,
  content_type text NOT NULL,
  totals       jsonb NOT NULL DEFAULT '{}',   -- what the exporter computed when it wrote the file, per SAP account
  ack          jsonb                          -- what SAP reported back (totals, per account)
);

-- ───────── reconciliation ─────────
CREATE TABLE reconciliation_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  scope         text NOT NULL CHECK (scope IN ('BATCH','PERIOD')),
  batch_id      uuid REFERENCES gl_batches(id),
  period_from   date,
  period_to     date,
  status        text NOT NULL CHECK (status IN ('OK','MISMATCH')),
  ledger_debit_minor  bigint NOT NULL DEFAULT 0,
  ledger_credit_minor bigint NOT NULL DEFAULT 0,
  file_debit_minor    bigint,
  file_credit_minor   bigint,
  sap_debit_minor     bigint,
  sap_credit_minor    bigint,
  exception_count integer NOT NULL DEFAULT 0,
  created_by    text
);
CREATE INDEX reconciliation_reports_idx ON reconciliation_reports (created_at DESC);
CREATE INDEX reconciliation_reports_batch_idx ON reconciliation_reports (batch_id);
CREATE TABLE reconciliation_exceptions (
  id          bigserial PRIMARY KEY,
  report_id   uuid NOT NULL REFERENCES reconciliation_reports(id),
  code        text NOT NULL,                     -- RECONCILIATION_MISMATCH, UNMAPPED_ACCOUNT, NOT_ACKNOWLEDGED, UNEXPORTED_ENTRIES, UNBALANCED_JOURNAL ...
  severity    text NOT NULL DEFAULT 'ERROR' CHECK (severity IN ('ERROR','WARNING')),
  subject     text,                              -- the account, batch or day it is about
  expected_minor bigint,
  actual_minor   bigint,
  detail      text NOT NULL
);
CREATE INDEX reconciliation_exceptions_report_idx ON reconciliation_exceptions (report_id);
