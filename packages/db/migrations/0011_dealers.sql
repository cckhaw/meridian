-- Dealers and their agents are master data kept in the CRM; CRM staff sell on their behalf and pick both on the order.
CREATE TABLE dealers (
  id           text PRIMARY KEY,                  -- the dealer id used on orders, users and commission
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  contact_name text,
  email        text,
  phone        text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dealer_agents (
  id         text PRIMARY KEY,
  dealer_id  text NOT NULL REFERENCES dealers(id),
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  email      text,
  phone      text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dealer_agents_dealer_idx ON dealer_agents (dealer_id, id);
ALTER TABLE orders ADD COLUMN dealer_agent_id text;

-- Dealer ids that already exist on users and orders become dealers (named after their id until someone renames them).
INSERT INTO dealers (id, name) SELECT DISTINCT d, d FROM (SELECT dealer_id AS d FROM users UNION SELECT dealer_id FROM orders) x WHERE d IS NOT NULL ON CONFLICT DO NOTHING;
