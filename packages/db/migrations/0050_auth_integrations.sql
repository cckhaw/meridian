-- Sign-in integrations: single sign-on through an identity provider, directory (AD/LDAP) sync, and the SMS/WhatsApp gateway for one-time codes.
--  * integration_endpoints gains the 'auth' group (IDP_OIDC, IDP_SAML, LDAP, OTP_GATEWAY); their secrets are encrypted there like every other integration
--  * users record where they sign in from (LOCAL password, OIDC, LDAP) and the provider's own id for them
--  * sso_states: one row per sign-in in flight (state, nonce and PKCE verifier), single use
--  * directory_sync_runs: one row per directory sync, with what changed

ALTER TABLE integration_endpoints DROP CONSTRAINT IF EXISTS integration_endpoints_group_key_check;
ALTER TABLE integration_endpoints ADD CONSTRAINT integration_endpoints_group_key_check CHECK (group_key IN ('gateway','webhooks','wfm','network','finance','events','auth'));

ALTER TABLE users ADD COLUMN auth_source text NOT NULL DEFAULT 'LOCAL' CHECK (auth_source IN ('LOCAL','OIDC','LDAP'));
ALTER TABLE users ADD COLUMN external_id text;            -- OIDC subject, or the LDAP distinguished name
CREATE UNIQUE INDEX users_external_uq ON users (auth_source, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE sso_states (
  state        text PRIMARY KEY,                           -- sha256 of the random state sent to the provider
  endpoint_id  uuid NOT NULL,
  nonce        text NOT NULL,
  verifier     text NOT NULL,                              -- PKCE code verifier
  redirect_uri text NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE directory_sync_runs (
  id           bigserial PRIMARY KEY,
  endpoint_id  uuid NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','OK','FAILED')),
  created      integer NOT NULL DEFAULT 0,
  updated      integer NOT NULL DEFAULT 0,
  disabled     integer NOT NULL DEFAULT 0,
  skipped      integer NOT NULL DEFAULT 0,
  error        text,
  triggered_by text NOT NULL DEFAULT 'schedule'
);
CREATE INDEX directory_sync_runs_ep_idx ON directory_sync_runs (endpoint_id, started_at DESC);
