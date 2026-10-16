-- Fraud desk and store desk.
--  * fraud_alerts: things worth a fraud analyst's look (SIM-swap anomalies, usage spikes, manual flags); one open alert per dedupe key
--  * fraud_blacklist: identity documents, numbers, SIMs, devices and e-mail addresses that may not be signed up or sold to. Only a keyed hash of the value is kept.
--  * cash_drawer_closings: a store's end-of-day cash count against what the system expects to be in the drawer

CREATE TABLE fraud_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('SIM_SWAP_ANOMALY','USAGE_SPIKE','MANUAL','OTHER')),
  severity     text NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH')),
  service_id   uuid,
  account_id   uuid,
  customer_id  uuid,
  identifier   text,
  summary      text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}',
  source       text NOT NULL DEFAULT 'SCAN',          -- SCAN (our own rules), NETWORK (a usage feed), MANUAL
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONFIRMED','DISMISSED')),
  dedupe_key   text,
  handled_by   text, handled_at timestamptz, note text,
  created_by   text NOT NULL DEFAULT 'system',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fraud_alerts_open_uq ON fraud_alerts (dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'OPEN';
CREATE INDEX fraud_alerts_status_idx ON fraud_alerts (status, created_at DESC);

CREATE TABLE fraud_blacklist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('ID_DOCUMENT','MSISDN','ICCID','IMEI','EMAIL')),
  value_hash  text NOT NULL,
  value_hint  text NOT NULL,                          -- the last few characters, so a person can tell entries apart
  reason      text NOT NULL,
  added_by    text NOT NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  removed_by  text, removed_at timestamptz
);
CREATE UNIQUE INDEX fraud_blacklist_active_uq ON fraud_blacklist (kind, value_hash) WHERE removed_at IS NULL;

CREATE TABLE cash_drawer_closings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       text NOT NULL,
  business_date  date NOT NULL,
  expected_minor bigint NOT NULL,
  counted_minor  bigint NOT NULL CHECK (counted_minor >= 0),
  variance_minor bigint NOT NULL,
  currency       char(3) NOT NULL,
  note           text,
  closed_by      text NOT NULL,
  closed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, business_date)
);
