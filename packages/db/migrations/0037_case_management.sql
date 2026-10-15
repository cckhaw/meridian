-- Case management: a three-level taxonomy (category → sub-category → issue type), an SLA matrix by customer tier and severity, the full telecom case lifecycle,
-- the interaction registry (every customer touchpoint, bound to a case or not), and a per-case audit trail of status changes.

CREATE TABLE case_taxonomy (
  id               text PRIMARY KEY,
  parent_id        text REFERENCES case_taxonomy (id),
  level            smallint NOT NULL CHECK (level BETWEEN 1 AND 3),    -- 1 category, 2 sub-category, 3 issue type
  name             text NOT NULL,
  description      text,
  active           boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  -- Only on an issue type (level 3): what a case of this kind is.
  case_type        text CHECK (case_type IN ('FIBER_ASSURANCE','BILLING_REFUND','MNP_PORT_OUT','GENERAL')),
  default_severity text CHECK (default_severity IN ('CRITICAL_OUTAGE','MAJOR_DEGRADATION','MINOR_INQUIRY')),
  needs_dispatch   boolean NOT NULL DEFAULT false,                     -- a visit by a technician is the usual fix
  skills           text[] NOT NULL DEFAULT '{}',                       -- what the technician must hold, e.g. FIBER_SPLICING
  equipment        text[] NOT NULL DEFAULT '{}',                       -- what to reserve, e.g. ONT_UNIT
  CHECK ((level = 1) = (parent_id IS NULL))
);
CREATE INDEX case_taxonomy_parent_idx ON case_taxonomy (parent_id, sort_order);

CREATE TABLE case_sla_config (
  tier                  text NOT NULL CHECK (tier IN ('VIP','ENTERPRISE','STANDARD')),
  severity              text NOT NULL CHECK (severity IN ('CRITICAL_OUTAGE','MAJOR_DEGRADATION','MINOR_INQUIRY')),
  first_response_minutes integer NOT NULL CHECK (first_response_minutes > 0),
  resolution_minutes    integer NOT NULL CHECK (resolution_minutes > 0),
  warn_percent          smallint NOT NULL DEFAULT 80 CHECK (warn_percent BETWEEN 1 AND 99),
  updated_by            text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tier, severity),
  CHECK (first_response_minutes <= resolution_minutes)
);
INSERT INTO case_sla_config (tier, severity, first_response_minutes, resolution_minutes) VALUES
  ('VIP','CRITICAL_OUTAGE',15,240), ('VIP','MAJOR_DEGRADATION',30,720), ('VIP','MINOR_INQUIRY',120,2880),
  ('ENTERPRISE','CRITICAL_OUTAGE',30,480), ('ENTERPRISE','MAJOR_DEGRADATION',60,1440), ('ENTERPRISE','MINOR_INQUIRY',240,4320),
  ('STANDARD','CRITICAL_OUTAGE',60,720), ('STANDARD','MAJOR_DEGRADATION',240,2880), ('STANDARD','MINOR_INQUIRY',480,7200);

INSERT INTO case_taxonomy (id, parent_id, level, name, sort_order, case_type, default_severity, needs_dispatch, skills, equipment) VALUES
  ('broadband',            NULL,        1, 'Broadband / Fiber', 10, NULL, NULL, false, '{}', '{}'),
  ('mobile',               NULL,        1, 'Mobile',            20, NULL, NULL, false, '{}', '{}'),
  ('billing',              NULL,        1, 'Billing',           30, NULL, NULL, false, '{}', '{}'),
  ('porting',              NULL,        1, 'Number porting',    40, NULL, NULL, false, '{}', '{}'),
  ('general',              NULL,        1, 'General',           50, NULL, NULL, false, '{}', '{}'),
  ('broadband.down',       'broadband', 2, 'No signal / down',  10, NULL, NULL, false, '{}', '{}'),
  ('broadband.slow',       'broadband', 2, 'Slow or intermittent', 20, NULL, NULL, false, '{}', '{}'),
  ('broadband.other',      'broadband', 2, 'Other',             90, NULL, NULL, false, '{}', '{}'),
  ('mobile.nosvc',         'mobile',    2, 'No service or data', 10, NULL, NULL, false, '{}', '{}'),
  ('billing.dispute',      'billing',   2, 'Bill dispute',      10, NULL, NULL, false, '{}', '{}'),
  ('billing.other',        'billing',   2, 'Other',             90, NULL, NULL, false, '{}', '{}'),
  ('porting.out',          'porting',   2, 'Port-out',          10, NULL, NULL, false, '{}', '{}'),
  ('general.enquiry',      'general',   2, 'Enquiry',           10, NULL, NULL, false, '{}', '{}'),
  ('broadband.down.los',   'broadband.down', 3, 'LOS red light on',          10, 'FIBER_ASSURANCE', 'CRITICAL_OUTAGE',   true,  '{FIBER_SPLICING}', '{ONT_UNIT}'),
  ('broadband.down.cut',   'broadband.down', 3, 'Fibre cable cut or damaged', 20, 'FIBER_ASSURANCE', 'CRITICAL_OUTAGE',   true,  '{FIBER_SPLICING}', '{FIBER_DROP_CABLE}'),
  ('broadband.down.ont',   'broadband.down', 3, 'ONT not powering on',        30, 'FIBER_ASSURANCE', 'MAJOR_DEGRADATION', true,  '{ONT_INSTALL}', '{ONT_UNIT}'),
  ('broadband.slow.drops', 'broadband.slow', 3, 'Connection drops',           10, 'FIBER_ASSURANCE', 'MAJOR_DEGRADATION', false, '{}', '{}'),
  ('broadband.slow.speed', 'broadband.slow', 3, 'Below plan speed',           20, 'FIBER_ASSURANCE', 'MINOR_INQUIRY',     false, '{}', '{}'),
  ('broadband.other.any',  'broadband.other', 3, 'Other fibre problem',       10, 'FIBER_ASSURANCE', 'MINOR_INQUIRY',     false, '{}', '{}'),
  ('mobile.nosvc.nosignal','mobile.nosvc',   3, 'No signal',                  10, 'GENERAL',         'MAJOR_DEGRADATION', false, '{}', '{}'),
  ('mobile.nosvc.data',    'mobile.nosvc',   3, 'Data not working',           20, 'GENERAL',         'MAJOR_DEGRADATION', false, '{}', '{}'),
  ('billing.dispute.dup',  'billing.dispute', 3, 'Duplicate charge',          10, 'BILLING_REFUND',  'MINOR_INQUIRY',     false, '{}', '{}'),
  ('billing.dispute.amt',  'billing.dispute', 3, 'Wrong amount',              20, 'BILLING_REFUND',  'MINOR_INQUIRY',     false, '{}', '{}'),
  ('billing.other.any',    'billing.other',  3, 'Other billing question',     10, 'BILLING_REFUND',  'MINOR_INQUIRY',     false, '{}', '{}'),
  ('porting.out.request',  'porting.out',    3, 'Port-out request',           10, 'MNP_PORT_OUT',    'MINOR_INQUIRY',     false, '{}', '{}'),
  ('general.enquiry.any',  'general.enquiry', 3, 'General enquiry',           10, 'GENERAL',         'MINOR_INQUIRY',     false, '{}', '{}');

-- Cases: the lifecycle, the taxonomy path, the SLA clocks and who works it.
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_status_check;
UPDATE cases SET status = 'NEW' WHERE status = 'OPEN';
UPDATE cases SET status = 'CLOSED_VERIFIED' WHERE status = 'CLOSED';
ALTER TABLE cases ADD CONSTRAINT cases_status_check CHECK (status IN ('NEW','IN_PROGRESS','PENDING_CUSTOMER','PENDING_THIRD_PARTY','PENDING_DISPATCH','DISPATCHED','RESOLVED','CLOSED_AUTO','CLOSED_VERIFIED','REOPENED'));
ALTER TABLE cases ALTER COLUMN status SET DEFAULT 'NEW';
ALTER TABLE cases
  ADD COLUMN issue_type_id         text REFERENCES case_taxonomy (id),
  ADD COLUMN category_path         text,
  ADD COLUMN severity              text NOT NULL DEFAULT 'MINOR_INQUIRY' CHECK (severity IN ('CRITICAL_OUTAGE','MAJOR_DEGRADATION','MINOR_INQUIRY')),
  ADD COLUMN tier                  text NOT NULL DEFAULT 'STANDARD' CHECK (tier IN ('VIP','ENTERPRISE','STANDARD')),
  ADD COLUMN assignee              text,
  ADD COLUMN team                  text,
  ADD COLUMN channel               text,
  ADD COLUMN postal_node           text,
  ADD COLUMN master_case_id        uuid REFERENCES cases (id),
  ADD COLUMN sla_first_response_minutes integer,
  ADD COLUMN sla_resolution_minutes     integer,
  ADD COLUMN sla_warn_percent      smallint NOT NULL DEFAULT 80,
  ADD COLUMN first_response_due    timestamptz,
  ADD COLUMN first_response_at     timestamptz,
  ADD COLUMN resolution_due        timestamptz,
  ADD COLUMN sla_paused_at         timestamptz,
  ADD COLUMN sla_warned_at         timestamptz,
  ADD COLUMN sla_breached_at       timestamptz,
  ADD COLUMN resolved_at           timestamptz,
  ADD COLUMN closed_at             timestamptz,
  ADD COLUMN resolution            text,
  ADD COLUMN auto_close_at         timestamptz,                        -- a resolved case closes itself at this time unless the customer reopens it
  ADD COLUMN reopen_count          integer NOT NULL DEFAULT 0;
UPDATE cases SET issue_type_id = CASE type WHEN 'FIBER_ASSURANCE' THEN 'broadband.other.any' WHEN 'BILLING_REFUND' THEN 'billing.other.any' WHEN 'MNP_PORT_OUT' THEN 'porting.out.request' ELSE 'general.enquiry.any' END,
  priority = priority;
UPDATE cases SET severity = CASE priority WHEN 'URGENT' THEN 'CRITICAL_OUTAGE' WHEN 'HIGH' THEN 'MAJOR_DEGRADATION' ELSE 'MINOR_INQUIRY' END;
UPDATE cases SET resolved_at = updated_at WHERE status IN ('RESOLVED','CLOSED_VERIFIED');
UPDATE cases SET closed_at = updated_at WHERE status = 'CLOSED_VERIFIED';

DROP INDEX IF EXISTS cases_open_idx;
CREATE INDEX cases_active_idx ON cases (created_at DESC) WHERE status NOT IN ('RESOLVED','CLOSED_AUTO','CLOSED_VERIFIED');
CREATE INDEX cases_assignee_idx ON cases (assignee, status) WHERE assignee IS NOT NULL;
CREATE INDEX cases_resolution_due_idx ON cases (resolution_due) WHERE status NOT IN ('RESOLVED','CLOSED_AUTO','CLOSED_VERIFIED') AND sla_paused_at IS NULL;
CREATE INDEX cases_master_idx ON cases (master_case_id) WHERE master_case_id IS NOT NULL;
CREATE INDEX cases_node_idx ON cases (postal_node, status) WHERE postal_node IS NOT NULL;
CREATE INDEX cases_auto_close_idx ON cases (auto_close_at) WHERE auto_close_at IS NOT NULL;

-- Every touchpoint with a customer, on any channel, whether or not it became (or belongs to) a case.
CREATE TABLE customer_interactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL,
  case_id      uuid REFERENCES cases (id),
  service_id   uuid,
  channel      text NOT NULL CHECK (channel IN ('CALL_CENTER','RETAIL_POS','WHATSAPP','WEB_SELF_SERVE','MOBILE_APP','EMAIL','IN_STORE')),
  direction    text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  subject      text NOT NULL,
  summary      text NOT NULL DEFAULT '',
  agent        text,                                                   -- the staff member, when there is one
  session_ref  text,                                                   -- the call id, chat session or ticket id on the channel's own system
  duration_sec integer CHECK (duration_sec IS NULL OR duration_sec >= 0),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  metadata     jsonb NOT NULL DEFAULT '{}',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_interactions_customer_idx ON customer_interactions (customer_id, occurred_at DESC, id DESC);
CREATE INDEX customer_interactions_case_idx ON customer_interactions (case_id, occurred_at) WHERE case_id IS NOT NULL;
CREATE UNIQUE INDEX customer_interactions_session_uq ON customer_interactions (channel, session_ref) WHERE session_ref IS NOT NULL;

-- What happened to a case and when: every status change, assignment and SLA event.
CREATE TABLE case_audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     uuid NOT NULL REFERENCES cases (id),
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  action      text NOT NULL,                                           -- CREATED, STATUS, ASSIGNED, SEVERITY, NOTE, INTERACTION, SLA_WARNING, SLA_BREACH ...
  from_status text,
  to_status   text,
  detail      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX case_audit_log_case_idx ON case_audit_log (case_id, id);

-- A VIP customer gets the VIP row of the SLA matrix; Enterprise-segment customers get the Enterprise row; everyone else Standard.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS vip boolean NOT NULL DEFAULT false;
