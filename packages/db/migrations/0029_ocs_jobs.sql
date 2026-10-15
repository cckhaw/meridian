-- Provisioning into the online charging system (OCS). Whatever the vendor, Meridian queues what has to happen to a subscriber (create with a plan, change
-- plan, bar or restore, change SIM or number, terminate) in the same transaction as the change, and a connector for the chosen vendor delivers it.
-- Jobs for one service are delivered strictly in order and retried with a back-off; one that cannot be delivered is kept (DEAD) until someone retries it.
CREATE TABLE ocs_jobs (
  id               bigserial PRIMARY KEY,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  service_id       uuid NOT NULL,
  command          text NOT NULL CHECK (command IN ('PROVISION','CHANGE_PLAN','SET_BARRING','CHANGE_IDENTITY','TERMINATE')),
  idempotency_key  text NOT NULL UNIQUE,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','SKIPPED','DEAD')),
  attempts         int NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  claimed_until    timestamptz,
  vendor           text,
  reference        text,
  detail           text,
  last_error       text,
  sent_at          timestamptz
);
CREATE INDEX ocs_jobs_due_idx ON ocs_jobs (status, next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX ocs_jobs_service_idx ON ocs_jobs (service_id, id);
