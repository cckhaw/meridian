-- Group plans (family / multi-line shares) and number portability into the operator (port-in).
-- Offers keep their group terms in catalog_nodes.data.group { isGroupOffer, maxGroupMembers, allowedMemberOfferIds, sharedPoolQuotaGb }.
-- A "customer group" is service_groups, and its member mapping is service_group_members; the Principal is the family head (group admin).

ALTER TABLE service_groups
  ADD COLUMN IF NOT EXISTS offer_id         text,       -- the group plan it was made for
  ADD COLUMN IF NOT EXISTS max_supplementary integer,   -- slots besides the family head; null = no limit
  ADD COLUMN IF NOT EXISTS origin           text NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL','CHECKOUT','PLAN_CHANGE'));

-- What an order line is for: a member of the group the head line opens (position of the head line), or of a group that exists already.
ALTER TABLE order_lines
  ADD COLUMN IF NOT EXISTS service_id          uuid,
  ADD COLUMN IF NOT EXISTS group_head_position integer,
  ADD COLUMN IF NOT EXISTS join_group_id       uuid,
  ADD COLUMN IF NOT EXISTS port_in             jsonb;    -- donor details when the line brings a number from another operator

-- A service's number may be temporary while its port-in is processed, and the service points at its request.
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS number_status text CHECK (number_status IN ('TEMPORARY','PORTED_IN')),
  ADD COLUMN IF NOT EXISTS port_in_id    uuid;

CREATE TABLE port_in_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','COMPLETED','REJECTED','CANCELLED','EXPIRED')),
  customer_id      uuid NOT NULL,
  order_id         uuid,
  order_line_id    uuid,
  service_id       uuid,
  donor_operator   text NOT NULL,
  donor_msisdn     text NOT NULL,                      -- the number being brought in, E.164
  holder_name      text NOT NULL,                      -- the account holder at the donor operator
  holder_id_type   text NOT NULL,
  holder_id_number text NOT NULL,
  temporary_msisdn text,                               -- a number from our pool the customer uses while the port is processed
  clearinghouse_ref text,
  requested_swap_at timestamptz,                       -- the date the donor agreed to release the number
  decided_at       timestamptz,
  completed_at     timestamptz,
  failure_reason   text,
  created_by       text
);
CREATE INDEX port_in_requests_status_idx ON port_in_requests (status, created_at);
CREATE INDEX port_in_requests_service_idx ON port_in_requests (service_id);
CREATE INDEX port_in_requests_customer_idx ON port_in_requests (customer_id, created_at);
-- A number can have only one live request at a time.
CREATE UNIQUE INDEX port_in_requests_live_number_uq ON port_in_requests (donor_msisdn) WHERE status IN ('PENDING','APPROVED');
