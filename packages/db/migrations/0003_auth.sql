-- Identity, sessions and request hardening.

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username             text NOT NULL,
  display_name         text NOT NULL,
  email                text,
  password_hash        text,                       -- scrypt; NULL for the environment-defined super user (never DB-authenticated)
  roles                text[] NOT NULL DEFAULT '{}',
  is_superuser         boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  must_change_password boolean NOT NULL DEFAULT false,
  failed_attempts      integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz,
  -- Data scope: a store/dealer user only sees their own orders; a portal user is bound to one customer.
  store_id             text,
  dealer_id            text,
  customer_id          uuid,
  market_code          char(2) NOT NULL DEFAULT 'SG',
  created_by           text NOT NULL DEFAULT 'system',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (is_superuser OR password_hash IS NOT NULL)
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));
CREATE UNIQUE INDEX users_customer_uq ON users (customer_id) WHERE customer_id IS NOT NULL;

-- Opaque server-side sessions: only a SHA-256 of the cookie token is stored, so a database leak cannot be replayed.
CREATE TABLE sessions (
  id           text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_epoch   text NOT NULL DEFAULT '',          -- super-user sessions die when the environment credentials rotate
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,              -- absolute lifetime
  revoked_at   timestamptz,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Failed-login ledger used for throttling by client address and by (possibly non-existent) username.
CREATE TABLE auth_attempts (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key    text NOT NULL,                           -- 'ip:<addr>' or 'user:<lowercased name>'
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_key_idx ON auth_attempts (key, at DESC);

-- Makes "place order" safe to retry (double-click, flaky network).
CREATE TABLE idempotency_keys (
  key        text NOT NULL,
  user_id    uuid NOT NULL,
  order_id   uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

ALTER TABLE orders ADD COLUMN created_by text;
