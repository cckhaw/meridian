-- Field service: technician visits booked in an external workforce-management (WFM) system for a case, and the log of what that system tells us.

CREATE TABLE workforce_appointments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          uuid NOT NULL REFERENCES cases (id),
  customer_id      uuid,
  vendor           text NOT NULL,                                       -- which WFM connector made the booking
  status           text NOT NULL DEFAULT 'RESERVED' CHECK (status IN
                     ('RESERVED','REQUESTED','SCHEDULED','ASSIGNED','EN_ROUTE','ON_SITE','COMPLETED','NO_ACCESS','RESCHEDULE_REQUIRED','CANCELLED','EXPIRED')),
  slot_start       timestamptz NOT NULL,
  slot_end         timestamptz NOT NULL,
  skills           text[] NOT NULL DEFAULT '{}',                        -- what the technician must hold
  equipment        text[] NOT NULL DEFAULT '{}',                        -- what is reserved for the visit
  address          jsonb NOT NULL DEFAULT '{}',
  reservation_ref  text,                                                -- the WFM's hold on the slot
  external_ref     text,                                                -- the WFM's job (work order) id
  technician_ref   text,
  technician_name  text,
  technician_phone text,
  notes            text NOT NULL DEFAULT '',
  outcome_note     text,
  hold_expires_at  timestamptz,                                         -- a reserved slot not confirmed by then is released
  last_event_rank  smallint NOT NULL DEFAULT 0,                         -- how far the visit has got, so a late or repeated callback cannot move it back
  last_event_at    timestamptz,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (slot_end > slot_start)
);
CREATE INDEX workforce_appointments_case_idx ON workforce_appointments (case_id, created_at DESC);
CREATE UNIQUE INDEX workforce_appointments_job_uq ON workforce_appointments (vendor, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX workforce_appointments_open_idx ON workforce_appointments (slot_start) WHERE status IN ('RESERVED','REQUESTED','SCHEDULED','ASSIGNED','EN_ROUTE','ON_SITE');

-- Everything the WFM system sends to the callback URL, once per event id: so a repeated delivery changes nothing and what was done about each event can be seen.
CREATE TABLE webhook_event_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source        text NOT NULL,
  event_id      text NOT NULL,
  event_type    text NOT NULL,
  external_ref  text,
  case_id       uuid,
  status        text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','APPLIED','IGNORED','FAILED','UNKNOWN_JOB')),
  detail        text,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  UNIQUE (source, event_id)
);
CREATE INDEX webhook_event_log_job_idx ON webhook_event_log (source, external_ref, id);
CREATE INDEX webhook_event_log_case_idx ON webhook_event_log (case_id, id) WHERE case_id IS NOT NULL;

-- A visit that does not happen when it should is something to chase: the time to look at it, and whether supervisors were told.
ALTER TABLE cases
  ADD COLUMN dispatch_due_at      timestamptz,
  ADD COLUMN dispatch_notified_at timestamptz;
