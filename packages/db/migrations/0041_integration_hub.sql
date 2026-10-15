-- Integration hub: the settings behind the northbound API gateway and every outside system Meridian talks to.
--  * integration_endpoints: connection settings for the outside systems (WFM, network elements, SM-DP+, SAP, payment providers); secrets are encrypted by the application
--  * oauth_clients: OAuth 2.0 client-credentials clients for the northbound APIs (only a hash of the secret is kept; a rotated secret stays valid for a grace period)
--  * rate_limit_rules + rate_limit_buckets: sliding-window limits per channel
--  * webhook_subscriptions: outbound partner webhooks, inbound verification keys, and TM Forum 688 subscriptions
--  * event_topic_mappings: which internal event goes to which external topic
--  * gateway_idempotency_keys: one result per (client, X-Idempotency-Key)
--  * integration_audit_log: one row per northbound call

CREATE TABLE integration_endpoints (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_key      text NOT NULL CHECK (group_key IN ('gateway','webhooks','wfm','network','finance','events')),
  kind           text NOT NULL,                       -- e.g. WFM_GATEWAY, NETWORK_ELEMENT, SMDP_PLUS, SAP_FICO, PAYMENT_GATEWAY
  name           text NOT NULL,
  url            text,
  fallback_url   text,
  timeout_ms     integer NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 100 AND 120000),
  config         jsonb NOT NULL DEFAULT '{}',         -- non-secret settings (protocol, pool size, slot rules, matching id parameters, ...)
  secret_enc     text,                                -- encrypted credentials (client secret, password, certificate bundle, ...)
  enabled        boolean NOT NULL DEFAULT true,
  updated_by     text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_key, kind, name)
);

CREATE TABLE oauth_clients (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         text NOT NULL UNIQUE,
  name              text NOT NULL,
  channel           text NOT NULL DEFAULT 'DEFAULT',  -- decides the rate limit
  scopes            text[] NOT NULL DEFAULT '{}',
  token_ttl_seconds integer NOT NULL DEFAULT 900 CHECK (token_ttl_seconds BETWEEN 60 AND 86400),
  secret_hash       text NOT NULL,
  prev_secret_hash  text,                             -- the secret before the last rotation, valid until prev_expires_at
  prev_expires_at   timestamptz,
  rotated_at        timestamptz,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz,
  revoked_at        timestamptz
);

-- API keys (api_clients, migration 0005) gain a channel for rate limiting, an optional HMAC signing secret, and an expiry.
ALTER TABLE api_clients
  ADD COLUMN channel text NOT NULL DEFAULT 'DEFAULT',
  ADD COLUMN hmac_secret_enc text,
  ADD COLUMN expires_at timestamptz;

CREATE TABLE rate_limit_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     text NOT NULL UNIQUE,                   -- SELF_CARE, RETAIL_POS, PARTNER_PORTAL, ... or DEFAULT
  per_minute  integer NOT NULL CHECK (per_minute BETWEEN 1 AND 100000),
  enabled     boolean NOT NULL DEFAULT true,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_limit_buckets (
  subject     text NOT NULL,                          -- the client the limit applies to
  minute      bigint NOT NULL,                        -- unix minute
  hits        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, minute)
);

CREATE TABLE webhook_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('OUTBOUND','INBOUND','TMF688')),
  name          text NOT NULL,
  target_url    text,                                 -- OUTBOUND / TMF688: where notifications go
  auth_kind     text NOT NULL DEFAULT 'NONE' CHECK (auth_kind IN ('NONE','BEARER','HMAC')),
  secret_enc    text,                                 -- bearer token, or the HMAC key (outbound signing, inbound verification)
  provider      text,                                 -- INBOUND: which outside system calls us (payment gateway, courier, dealer channel)
  events        text[] NOT NULL DEFAULT '{}',         -- event types; empty = all
  query         text,                                 -- TMF688: the subscriber's filter (e.g. "eventType=ServiceOrderStateChangeEvent")
  retry_max     integer NOT NULL DEFAULT 5 CHECK (retry_max BETWEEN 0 AND 20),
  retry_backoff_seconds integer NOT NULL DEFAULT 30 CHECK (retry_backoff_seconds BETWEEN 1 AND 86400),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','FAILED')),
  client_id     text,                                 -- the OAuth/API client that registered it (TMF688), if any
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_subscriptions_kind_idx ON webhook_subscriptions (kind, status);

CREATE TABLE event_topic_mappings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  text NOT NULL,                          -- ORDER_CREATED, SIM_SWAPPED, SERVICE_SUSPENDED, ...
  topic       text NOT NULL,                          -- the external topic (Kafka topic name)
  enabled     boolean NOT NULL DEFAULT true,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_type, topic)
);

CREATE TABLE gateway_idempotency_keys (
  client_ref    text NOT NULL,
  key           text NOT NULL,
  request_hash  text NOT NULL,                        -- the same key with a different request is refused
  status        text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','DONE')),
  http_status   integer,
  response      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_ref, key)
);

CREATE TABLE integration_audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  client_ref   text,
  channel      text,
  method       text NOT NULL,
  path         text NOT NULL,
  status       integer NOT NULL,
  scope        text,
  idempotency_key text,
  ms           integer,
  detail       jsonb
);
CREATE INDEX integration_audit_log_at_idx ON integration_audit_log (at DESC);
CREATE INDEX integration_audit_log_client_idx ON integration_audit_log (client_ref, at DESC);
