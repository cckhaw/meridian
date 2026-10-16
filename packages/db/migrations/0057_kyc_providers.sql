-- Identity providers: an OCR / face-match service behind the camera photographs, and MyDigital ID as an alternative way to prove identity.
ALTER TABLE integration_endpoints DROP CONSTRAINT IF EXISTS integration_endpoints_group_key_check;
ALTER TABLE integration_endpoints ADD CONSTRAINT integration_endpoints_group_key_check CHECK (group_key IN ('gateway','webhooks','wfm','network','finance','events','auth','identity'));

ALTER TABLE kyc_cases DROP CONSTRAINT IF EXISTS kyc_cases_method_check;
ALTER TABLE kyc_cases ADD CONSTRAINT kyc_cases_method_check CHECK (method IN ('DOCUMENT_REMOTE','IN_PERSON','DOCUMENT_STORE','MYDIGITAL_ID'));

-- One redirect to an identity provider and back. State, nonce and the PKCE verifier are kept here and used once; the result is read by whoever started it.
CREATE TABLE kyc_provider_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL CHECK (provider IN ('MYDIGITAL_ID')),
  context        text NOT NULL CHECK (context IN ('STORE','CRM_NEW','CRM_EXISTING')),
  state_hash     text NOT NULL UNIQUE,
  nonce          text NOT NULL,
  verifier       text NOT NULL,
  redirect_uri   text NOT NULL,
  application_id uuid,
  customer_id    uuid,
  draft          jsonb,                       -- the new customer as typed, kept until the identity is proved
  status         text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE','FAILED')),
  message        text,
  result         jsonb,
  created_by      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
CREATE INDEX kyc_provider_sessions_exp_idx ON kyc_provider_sessions (expires_at);
