-- Orders are fulfilled in independent parts ("groups"): service activation, goods delivery and installation. Each part has its own
-- point of no return, so a shipped phone no longer locks a fibre line that has not started, and each part is cancelled and refunded on its own.
CREATE TABLE order_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('ACTIVATION','GOODS','INSTALL')),
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','LOCKED','DONE','CANCELLED','RETURNED')),
  locked_at     timestamptz,                 -- point of no return reached: shipped / technician dispatched
  done_at       timestamptz,                 -- delivered / installed / activated
  cancelled_at  timestamptz,
  due_at        timestamptz,                 -- service-level target (installation)
  at_risk       boolean NOT NULL DEFAULT false,
  refunded_minor bigint NOT NULL DEFAULT 0,
  fee_minor     bigint NOT NULL DEFAULT 0,   -- retained on cancellation (late installation cancel, return deductions)
  details       jsonb NOT NULL DEFAULT '{}', -- tracking number, appointment slot, cancel/return reason
  UNIQUE (order_id, kind)
);
CREATE INDEX order_groups_open_idx ON order_groups (kind, status, due_at) WHERE status IN ('PENDING','LOCKED');

ALTER TABLE order_lines
  ADD COLUMN fulfil_group text NOT NULL DEFAULT 'ACTIVATION' CHECK (fulfil_group IN ('ACTIVATION','GOODS','INSTALL')),
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED','RETURNED')),
  ADD COLUMN options jsonb NOT NULL DEFAULT '{}',            -- chosen device variant (colour, storage, sku)
  ADD COLUMN pay_mode text NOT NULL DEFAULT 'UPFRONT' CHECK (pay_mode IN ('UPFRONT','INSTALLMENT')),
  ADD COLUMN installment_months smallint,
  ADD COLUMN down_payment_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN paid_now_minor bigint NOT NULL DEFAULT 0,       -- what is taken at checkout for this line (upfront price or down payment)
  ADD COLUMN discount_minor bigint NOT NULL DEFAULT 0,       -- bundle discount already included in net/tax
  ADD COLUMN discount_rules text[] NOT NULL DEFAULT '{}';
-- Existing orders: the whole upfront amount was paid at checkout, except instalment orders which paid nothing.
UPDATE order_lines l SET paid_now_minor = CASE WHEN o.payment_method = 'INSTALLMENT' THEN 0 ELSE COALESCE(l.net_minor, 0) + COALESCE(l.tax_minor, 0) END,
  pay_mode = CASE WHEN o.payment_method = 'INSTALLMENT' THEN 'INSTALLMENT' ELSE 'UPFRONT' END, installment_months = o.installment_months
  FROM orders o WHERE o.id = l.order_id;

ALTER TABLE orders ADD COLUMN refunded_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN refunded_minor bigint NOT NULL DEFAULT 0;
UPDATE payments SET refunded_minor = amount_minor WHERE status = 'REFUNDED' AND amount_minor > 0;   -- earlier refunds were always whole
ALTER TABLE inventory_reservations ADD COLUMN fulfil_group text;   -- which part of the order the stock belongs to (null = whole order)

-- Bundle discounts: "fibre + a phone plan = 10% off the device". Rules are data, edited by catalog managers.
CREATE TABLE bundle_rules (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  data       jsonb NOT NULL,                 -- { when: ["kind:FIBER","kind:SIM_DEVICE"], target: "kind:SIM_DEVICE", percentBps | amountMinor }
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-offer device variants live in the offer's data (colour, storage, sku, price difference); nothing to migrate.

-- Existing lines and in-flight orders join the new model.
UPDATE order_lines l SET fulfil_group = CASE WHEN (c.data->'fulfilment'->>'requiresInstallation')::boolean THEN 'INSTALL'
                                             WHEN (c.data->'fulfilment'->>'requiresShipping')::boolean THEN 'GOODS' ELSE 'ACTIVATION' END
  FROM catalog_nodes c WHERE c.id = l.offer_id;
UPDATE order_lines l SET status = 'CANCELLED' FROM orders o WHERE o.id = l.order_id AND o.state IN ('CANCELLED','FAILED');
INSERT INTO order_groups (order_id, kind, status, locked_at)
  SELECT o.id, 'GOODS', CASE WHEN o.point_of_no_return_at IS NOT NULL THEN 'LOCKED' ELSE 'PENDING' END, o.point_of_no_return_at
    FROM orders o WHERE 'SHIP' = ANY(o.pending_tasks) AND o.state NOT IN ('COMPLETED','CANCELLED','FAILED');
INSERT INTO order_groups (order_id, kind, status, locked_at, due_at)
  SELECT o.id, 'INSTALL', CASE WHEN (o.fulfilment->>'dispatched')::boolean THEN 'LOCKED' ELSE 'PENDING' END, o.point_of_no_return_at, o.created_at + interval '14 days'
    FROM orders o WHERE 'INSTALL' = ANY(o.pending_tasks) AND o.state NOT IN ('COMPLETED','CANCELLED','FAILED');
