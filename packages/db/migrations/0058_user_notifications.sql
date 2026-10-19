-- In-app alerts for staff (the "In the app" channel of My profile → Notifications), and retry bookkeeping for the outbox consumers that talk to the
-- messaging gateway (user alerts, signed agreement copies).

CREATE TABLE user_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event       text NOT NULL CHECK (event IN ('caseAssigned','caseUpdates','systemAlerts','securityAlerts')),
  title       text NOT NULL,
  body        text NOT NULL,
  link        text,                                   -- an app path such as /profile?tab=security
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX user_notifications_user_idx ON user_notifications (user_id, created_at DESC);
CREATE INDEX user_notifications_unread_idx ON user_notifications (user_id) WHERE read_at IS NULL;

ALTER TABLE lifecycle_outbox
  ADD COLUMN IF NOT EXISTS attempts        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,          -- not before this time (backoff); null means now
  ADD COLUMN IF NOT EXISTS last_error      text,
  ADD COLUMN IF NOT EXISTS failed_at       timestamptz;          -- gave up after the last allowed attempt; delivered_at stays null
