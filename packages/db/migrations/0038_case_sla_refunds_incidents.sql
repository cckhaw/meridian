-- Case SLA watchdog, refund approvals by amount, and master network incidents.

ALTER TABLE cases
  ALTER COLUMN customer_id DROP NOT NULL,                              -- a master incident belongs to the network, not to a customer
  ADD COLUMN is_master                    boolean NOT NULL DEFAULT false,
  ADD COLUMN escalation_level             smallint NOT NULL DEFAULT 0, -- 0 none, 1 after the SLA is breached, 2 when it is half as late again
  ADD COLUMN first_response_breached_at   timestamptz;
CREATE SEQUENCE IF NOT EXISTS incident_seq START 1;
CREATE INDEX cases_master_open_idx ON cases (postal_node) WHERE is_master AND status NOT IN ('RESOLVED','CLOSED_AUTO','CLOSED_VERIFIED');

-- A refund or credit asked for on a billing-dispute case. Above what the asker may approve themselves it waits for someone in a higher tier.
CREATE TABLE case_refund_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES cases (id),
  invoice_id    uuid NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  currency      char(3) NOT NULL,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','EXECUTED','REJECTED','CANCELLED')),
  required_tier smallint NOT NULL,                                     -- the lowest tier (0 first) whose limit covers the amount
  requested_by  text NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    text,
  decided_at    timestamptz,
  decision_note text,
  CHECK (status = 'PENDING' OR decided_at IS NOT NULL)
);
CREATE INDEX case_refund_case_idx ON case_refund_requests (case_id, requested_at DESC);
CREATE INDEX case_refund_pending_idx ON case_refund_requests (requested_at) WHERE status = 'PENDING';
