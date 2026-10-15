-- Subscriber operations through the northbound API: one-time passwords for sensitive changes, plan changes scheduled for the next bill, and value-added
-- services that hang off a mobile service.

CREATE TABLE subscriber_otps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id   uuid NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('SIM_SWAP')),
  code_hash    text NOT NULL,                       -- sha256 of service + code; the code itself is only in the SMS
  attempts     integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriber_otps_service_idx ON subscriber_otps (service_id, created_at DESC);

ALTER TABLE services ADD COLUMN parent_service_id uuid;      -- a value-added service belongs to the mobile service it was added to
ALTER TABLE services ADD COLUMN sim_swapped_at timestamptz;  -- fraud screens look at recent swaps
CREATE INDEX services_parent_idx ON services (parent_service_id) WHERE parent_service_id IS NOT NULL;

CREATE TABLE pending_plan_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id   uuid NOT NULL,
  account_id   uuid NOT NULL,
  from_offer_id text NOT NULL,
  offer_id     text NOT NULL,
  effective_on date NOT NULL,                       -- the account's next bill date
  add_ons      jsonb NOT NULL DEFAULT '[]',
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPLIED','CANCELLED','FAILED')),
  detail       jsonb NOT NULL DEFAULT '{}',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  applied_at   timestamptz
);
CREATE UNIQUE INDEX pending_plan_changes_one_uq ON pending_plan_changes (service_id) WHERE status = 'PENDING';
CREATE INDEX pending_plan_changes_due_idx ON pending_plan_changes (effective_on) WHERE status = 'PENDING';
