-- SAML 2.0 single sign-on: people who sign in through a SAML identity provider are users with auth_source 'SAML', and what the sign-in needs to remember (the id of each request sent to the provider, and the id of each assertion
-- already accepted, so one cannot be replayed) lives in saml_cache for a few minutes.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_source_check;
ALTER TABLE users ADD CONSTRAINT users_auth_source_check CHECK (auth_source IN ('LOCAL','OIDC','LDAP','SAML'));

CREATE TABLE saml_cache (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX saml_cache_expiry_idx ON saml_cache (expires_at);
