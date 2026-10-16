-- Identity hardening, part 1: password history, password-recovery tokens, and the contact details recovery needs.
-- The policy itself (password rules, lockout, session limits, recovery) is a row in `settings` (key 'securityPolicy'), so it is audited like every other setting.

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;   -- mobile number for SMS one-time codes (recovery now, second factor next)

-- The last passwords a person used, kept as hashes only, so a policy can refuse to reuse them.
CREATE TABLE password_history (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_history_user_idx ON password_history (user_id, id DESC);

-- A recovery link (e-mail) or code (SMS). Only a hash is kept; a token works once, for a short time, and a code locks after a few wrong tries.
CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('EMAIL','SMS')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  attempts   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX password_reset_tokens_hash_uq ON password_reset_tokens (token_hash);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id, created_at DESC);
