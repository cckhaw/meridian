-- The operators numbers can be ported in from, maintained in Settings. Each has a routing code the clearinghouse uses to route the request.
CREATE TABLE donor_operators (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  routing_code text NOT NULL,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
CREATE UNIQUE INDEX donor_operators_name_uq ON donor_operators (lower(name));
CREATE UNIQUE INDEX donor_operators_code_uq ON donor_operators (lower(routing_code));

-- A request keeps the operator as it was when the request was raised.
ALTER TABLE port_in_requests
  ADD COLUMN IF NOT EXISTS donor_operator_id uuid,
  ADD COLUMN IF NOT EXISTS donor_routing_code text;
