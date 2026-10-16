-- Identity hardening, part 2: second factor (TOTP app, SMS or e-mail code), recovery codes, the sign-in challenge, and the profile details a person keeps themselves.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text;                                   -- a small picture as a data address (png, jpeg or webp, at most ~150 KB)
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{}'; -- which alerts reach the person, by e-mail, SMS or push

-- A second factor a person has set up. TOTP keeps its secret (encrypted); SMS and e-mail use the number or address on the account.
-- Not usable until confirmed with a first valid code. last_counter stops a TOTP code being used twice.
CREATE TABLE mfa_methods (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('TOTP','SMS','EMAIL')),
  secret_enc   text,
  confirmed_at timestamptz,
  last_counter bigint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

-- One-time codes that get a person in when their phone is lost. Only hashes are kept; each works once.
CREATE TABLE mfa_recovery_codes (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at   timestamptz
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

-- The step between a correct password and a session (purpose LOGIN), or a code sent while setting up SMS or e-mail (purpose ENROL).
-- Only hashes are kept. A challenge expires quickly, locks after a few wrong tries, and works once.
CREATE TABLE mfa_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('LOGIN','ENROL')),
  token_hash text NOT NULL,
  code_hash  text,                    -- the sent code, when the method is SMS or e-mail
  code_kind  text,                    -- which method the sent code belongs to
  expires_at timestamptz NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  used_at    timestamptz,
  ip         text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mfa_challenges_token_uq ON mfa_challenges (token_hash);
CREATE INDEX mfa_challenges_user_idx ON mfa_challenges (user_id, created_at DESC);
