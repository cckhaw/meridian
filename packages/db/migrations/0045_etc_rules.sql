-- Early termination charge rules: one rule per scenario (who leaves, why, when), each with its own formula. Settings → Early termination.
CREATE TABLE etc_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  enabled         boolean NOT NULL DEFAULT true,
  priority        integer NOT NULL DEFAULT 100,                 -- the highest priority that fits is used
  scenarios       text[] NOT NULL DEFAULT '{}',                 -- why the contract ends; empty = any
  segments        text[] NOT NULL DEFAULT '{}',                 -- customer segments; empty = any
  device          text NOT NULL DEFAULT 'ANY' CHECK (device IN ('ANY','WITH_DEVICE','NO_DEVICE')),
  vip             text NOT NULL DEFAULT 'ANY' CHECK (vip IN ('ANY','YES','NO')),
  min_term        integer,                                      -- contract length in months, from
  max_term        integer,                                      --   to
  min_elapsed     integer,                                      -- months already served, from
  max_elapsed     integer,                                      --   to
  formula         text NOT NULL,                                -- e.g. subsidy * remaining / term + monthlyFee * remaining * 0.25
  min_charge_minor bigint NOT NULL DEFAULT 0 CHECK (min_charge_minor >= 0),
  max_charge_minor bigint CHECK (max_charge_minor IS NULL OR max_charge_minor >= 0),
  waive_last_months integer NOT NULL DEFAULT 0 CHECK (waive_last_months >= 0),   -- no charge when this few months remain
  device_balance_percent integer NOT NULL DEFAULT 100 CHECK (device_balance_percent BETWEEN 0 AND 100),   -- share of the unpaid device instalments collected
  apply_vip_multiplier boolean NOT NULL DEFAULT true,
  version         integer NOT NULL DEFAULT 1,
  updated_by      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX etc_rules_enabled_idx ON etc_rules (priority DESC) WHERE enabled;
