-- Offer types get behaviour switches of their own (what an order creates, whether there are goods or a contract, where the offer is picked), and
-- operators can define new kinds of service. A type's `template` is now the preset it started from; `behaviour` (null = the preset's own) is what it does.
ALTER TABLE offer_types ADD COLUMN behaviour jsonb;

-- Kinds of service. The four built-ins are described here but their handling stays in the platform; a kind an operator adds (a roaming pass, a voucher,
-- a prepaid top-up) is created by an order like any subscription, gets a generated identifier, may expire on its own, and is provisioned by instructions
-- for the systems named here.
CREATE TABLE service_kinds (
  id                     text PRIMARY KEY CHECK (id ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  name                   text NOT NULL,
  description            text,
  is_builtin             boolean NOT NULL DEFAULT false,
  status                 text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  identifier_prefix      text NOT NULL DEFAULT 'SVC',          -- generated identifier: PREFIX + sequence
  expires                boolean NOT NULL DEFAULT false,        -- the service ends by itself
  validity_days          integer CHECK (validity_days IS NULL OR validity_days BETWEEN 1 AND 3650),  -- default length; an offer may set its own
  provision_systems      jsonb NOT NULL DEFAULT '[]',           -- systems told when the service starts and ends, for example ["PCRF","VOUCHER_PLATFORM"]
  provision_instruction  text NOT NULL DEFAULT 'PROVISION',
  deprovision_instruction text NOT NULL DEFAULT 'DEPROVISION',
  sort_order             integer NOT NULL DEFAULT 100,
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
INSERT INTO service_kinds (id, name, description, is_builtin, identifier_prefix, sort_order) VALUES
  ('MOBILE',       'Mobile',        'A mobile line with a number and a SIM.',                    true, '+', 10),
  ('FIBER',        'Fibre',         'Home fibre, set up by a technician visit.',                 true, 'FBR-', 20),
  ('IOT',          'IoT',           'Connectivity for connected devices, often in bulk.',        true, 'IOT', 30),
  ('SUBSCRIPTION', 'Subscription',  'An add-on or partner subscription billed with a plan.',     true, 'SUB-', 40);

-- A service of an operator-defined kind is stored as a subscription, tagged with its kind, and may carry the date it ends.
ALTER TABLE services ADD COLUMN service_kind text, ADD COLUMN expires_at timestamptz;
CREATE INDEX services_expiry_idx ON services (expires_at) WHERE expires_at IS NOT NULL AND status = 'ACTIVE';
