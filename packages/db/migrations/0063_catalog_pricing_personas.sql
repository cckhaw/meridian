-- Sample baskets ("personas") the release what-if prices before and after a release. The basket is a pricing input (channel, lines, payment) without a customer.
CREATE TABLE catalog_pricing_personas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  basket      jsonb NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
