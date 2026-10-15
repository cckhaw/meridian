-- Credit profile checks for device financing: the customer's ID number goes to the credit bureau (with their consent), a score comes back, and the settings turn it
-- into the share of the device price to pay upfront. Only a hash of the ID is kept here.
CREATE TABLE credit_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid,
  id_hash       text NOT NULL,
  provider      text NOT NULL,                       -- the connection name, or SIMULATOR / FALLBACK
  source        text NOT NULL CHECK (source IN ('BUREAU','SIMULATOR','FALLBACK')),
  score         integer,
  band          text,
  provider_upfront_minor bigint,                     -- when the bureau returns the upfront amount itself
  ratio_bps     integer NOT NULL CHECK (ratio_bps BETWEEN 0 AND 10000),   -- share of the financed amount to pay upfront
  financed_minor bigint NOT NULL,                    -- what the check was asked about
  months        integer,
  currency      text NOT NULL,
  decision      text NOT NULL CHECK (decision IN ('NO_UPFRONT','UPFRONT','PAY_IN_FULL')),
  consent       jsonb NOT NULL,                      -- who agreed, how, when
  reference     text,                                -- the bureau's report reference
  order_id      uuid,
  expires_at    timestamptz NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_checks_customer_idx ON credit_checks (customer_id, created_at DESC);
CREATE INDEX credit_checks_hash_idx ON credit_checks (id_hash, created_at DESC);
