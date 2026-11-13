-- KYC review workflow: friendly case numbers, assignment to compliance officers, risk and priority, escalation, second review, QA sampling, a timeline of everything
-- that happens to a case, and officer availability. Additive and safe on a table of ~100k cases: every column is nullable or has a constant default (no table rewrite
-- except the case number, which is filled in one pass). Cases that are waiting now are NOT assigned here: the first auto-assign sweep does that.

CREATE SEQUENCE kyc_case_number_seq;
CREATE FUNCTION kyc_next_case_number() RETURNS text LANGUAGE sql AS
  $$ SELECT 'KYC-' || lpad(n::text, greatest(6, length(n::text)), '0') FROM (SELECT nextval('kyc_case_number_seq') AS n) s $$;

ALTER TABLE kyc_cases
  ADD COLUMN case_number        text,
  ADD COLUMN assigned_to        text,                         -- username of the officer who holds the case (kept after the decision as the officer of record)
  ADD COLUMN assigned_at        timestamptz,
  ADD COLUMN assigned_by        text,                         -- 'system' for automatic distribution
  ADD COLUMN assignment_source  text CHECK (assignment_source IN ('AUTO','MANUAL','CLAIMED','ESCALATED')),
  ADD COLUMN previous_assignee  text,                         -- who had it before it was sent back or reopened: it goes back to them when they are still eligible
  ADD COLUMN avoid_assignee     text,                         -- who released it to the pool: automatic distribution skips them for this round
  ADD COLUMN risk               text NOT NULL DEFAULT 'LOW' CHECK (risk IN ('LOW','MEDIUM','HIGH')),
  ADD COLUMN priority           integer NOT NULL DEFAULT 0,   -- higher is more urgent: overdue 1000, escalated 500, risk 100/200/300, orders waiting 50
  ADD COLUMN risk_assessed_at   timestamptz,
  ADD COLUMN escalated_at       timestamptz,
  ADD COLUMN escalated_by       text,
  ADD COLUMN escalation_note    text,
  ADD COLUMN sla_breached_at    timestamptz,
  ADD COLUMN first_opened_at    timestamptz,                  -- the first time the assignee opened the case
  ADD COLUMN reopened_count     integer NOT NULL DEFAULT 0,
  ADD COLUMN checklist          jsonb,                        -- what the reviewer ticked: documentLegible, photoMatchesId, detailsMatchId, notExpired, ageOk, notDuplicate, notes
  ADD COLUMN second_review      jsonb,                        -- four eyes on a high risk case: { status: AWAITING | DONE, recommended, by, at, note, ... }
  ADD COLUMN qa_assigned_to     text,                         -- a sampled approval waiting for a second look by another officer
  ADD COLUMN qa_sampled_at      timestamptz,
  ADD COLUMN qa_result          text CHECK (qa_result IN ('AGREE','DISAGREE')),
  ADD COLUMN qa_note            text,
  ADD COLUMN qa_by              text,
  ADD COLUMN qa_at              timestamptz;

UPDATE kyc_cases k SET case_number = 'KYC-' || lpad(n.rn::text, greatest(6, length(n.rn::text)), '0')
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM kyc_cases) n WHERE n.id = k.id;
SELECT setval('kyc_case_number_seq', greatest((SELECT count(*) FROM kyc_cases), 1), (SELECT count(*) > 0 FROM kyc_cases));
ALTER TABLE kyc_cases ALTER COLUMN case_number SET DEFAULT kyc_next_case_number();
ALTER TABLE kyc_cases ALTER COLUMN case_number SET NOT NULL;
CREATE UNIQUE INDEX kyc_cases_case_number_uq ON kyc_cases (case_number);

-- "My cases" and the officer's open count.
CREATE INDEX kyc_cases_assignee_idx ON kyc_cases (assigned_to, status) WHERE assigned_to IS NOT NULL;
-- The waiting list in priority order (the expression is the one every list query sorts by), and the pool nobody holds yet.
CREATE INDEX kyc_cases_pending_idx ON kyc_cases (priority DESC, (COALESCE(submitted_at, created_at)), id) WHERE status = 'PENDING';
CREATE INDEX kyc_cases_pool_idx ON kyc_cases (priority DESC, (COALESCE(submitted_at, created_at)), id) WHERE status = 'PENDING' AND assigned_to IS NULL;
-- Decided lists (newest first) and the officer's decisions.
CREATE INDEX kyc_cases_decided_idx ON kyc_cases (decided_by, decided_at) WHERE decided_at IS NOT NULL;
CREATE INDEX kyc_cases_decided_at_idx ON kyc_cases (decided_at DESC, id DESC) WHERE decided_at IS NOT NULL;
CREATE INDEX kyc_cases_qa_idx ON kyc_cases (qa_assigned_to) WHERE qa_assigned_to IS NOT NULL AND qa_result IS NULL;
-- Cases that still need a risk assessment (the first sweep after this migration works through them).
CREATE INDEX kyc_cases_unassessed_idx ON kyc_cases (risk_assessed_at NULLS FIRST) WHERE status = 'PENDING';

-- Everything that happens to a case: the timeline on the case and the source of the officer KPIs.
CREATE TABLE kyc_case_events (
  id       bigserial PRIMARY KEY,
  case_id  uuid NOT NULL REFERENCES kyc_cases(id) ON DELETE CASCADE,
  at       timestamptz NOT NULL DEFAULT now(),
  actor    text NOT NULL,                                     -- a username, or 'system'
  action   text NOT NULL CHECK (action IN ('CREATED','SUBMITTED','ASSIGNED','REASSIGNED','UNASSIGNED','CLAIMED','RELEASED','OPENED','NOTE','ESCALATED','RECOMMENDED',
                                           'SECOND_REVIEW_DECIDED','DECIDED','RETURNED','REOPENED','SLA_BREACHED','QA_SAMPLED','QA_DONE')),
  target   text,                                              -- the officer the event is about (new assignee, QA'd decider), for counting per officer
  detail   jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX kyc_case_events_case_idx ON kyc_case_events (case_id, id);
CREATE INDEX kyc_case_events_action_idx ON kyc_case_events (action, at);
CREATE INDEX kyc_case_events_target_idx ON kyc_case_events (target, at) WHERE target IS NOT NULL;

-- Decisions made by a person before this migration count in the officer reports too.
INSERT INTO kyc_case_events (case_id, at, actor, action, detail)
  SELECT k.id, k.decided_at, k.decided_by, 'DECIDED', jsonb_build_object('decision', CASE k.status WHEN 'APPROVED' THEN 'APPROVE' ELSE 'REJECT' END, 'backfilled', true)
    FROM kyc_cases k JOIN users u ON u.username = k.decided_by WHERE k.decided_at IS NOT NULL AND k.status IN ('APPROVED','REJECTED');

-- An officer who is away gets no new cases, and (by setting) hands the open ones back to the pool.
CREATE TABLE kyc_officer_status (
  username   text PRIMARY KEY,
  away       boolean NOT NULL DEFAULT false,
  away_until timestamptz,                                     -- null with away = until they say they are back
  note       text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
