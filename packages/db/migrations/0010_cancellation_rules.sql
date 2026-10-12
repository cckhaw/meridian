-- Cancellation, return and escalation rules, edited in Settings → Cancellation. The standard policy is installed the first time it is needed.
CREATE TABLE cancellation_rules (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  action     text NOT NULL CHECK (action IN ('CANCEL','RETURN','FLAG_AT_RISK','AUTO_CANCEL')),
  group_kind text NOT NULL CHECK (group_kind IN ('GOODS','INSTALL','ACTIVATION','ANY')),
  priority   integer NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  data       jsonb NOT NULL,                       -- { when: [...], outcome: {...}, message, showInTerms }
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cancellation_rules_order_idx ON cancellation_rules (action, priority, id);

-- When a part of an order was opened, so "days open" rules and the sweep do not need the order row.
ALTER TABLE order_groups ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
UPDATE order_groups g SET created_at = o.created_at FROM orders o WHERE o.id = g.order_id;
