-- Store-front, KYC and payment gateways.
--  * api_clients: machine credentials for an externally hosted store-front (only a hash of the key is kept)
--  * applications: a sign-up / purchase in progress, before it becomes a customer and an order
--  * kyc_cases + kyc_documents: identity verification evidence (ID number and images are encrypted by the application)
--  * payment_intents + webhook_events: what a payment gateway was asked to collect, and which gateway events were already processed

ALTER TABLE customers
  ADD COLUMN kyc_status text NOT NULL DEFAULT 'NOT_VERIFIED' CHECK (kyc_status IN ('NOT_VERIFIED','VERIFIED')),
  ADD COLUMN kyc_verified_at timestamptz;

CREATE TABLE api_clients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  key_prefix   text NOT NULL UNIQUE,         -- public part of the key, used to find the row
  key_hash     text NOT NULL,                -- sha256 of the secret part
  scopes       text[] NOT NULL DEFAULT '{store}',
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE applications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid REFERENCES api_clients(id),   -- set for the external store-front
  channel     text NOT NULL CHECK (channel IN ('SELF_SERVE','RETAIL_ASSISTED')),
  status      text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','KYC_REVIEW','KYC_APPROVED','KYC_REJECTED','ORDERED','CANCELLED','EXPIRED')),
  token_hash  text,                              -- self-serve: the shopper's resume token (hash)
  customer_id uuid,                              -- existing customer (assisted) or the one created at checkout
  order_id    uuid,
  lines       jsonb NOT NULL DEFAULT '[]',
  personal    jsonb NOT NULL DEFAULT '{}',
  address     jsonb,
  consent     jsonb,
  store_id    text,
  created_by  text,                              -- staff username for assisted sales
  created_ip  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX applications_status_idx ON applications (status, created_at DESC);
CREATE INDEX applications_store_idx ON applications (store_id, created_at DESC);

CREATE TABLE kyc_cases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL UNIQUE REFERENCES applications(id),
  customer_id      uuid,
  method           text NOT NULL CHECK (method IN ('DOCUMENT_REMOTE','IN_PERSON')),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  full_name        text NOT NULL,
  date_of_birth    date NOT NULL,
  nationality      text,
  id_type          text NOT NULL,
  id_number_enc    text NOT NULL,                -- AES-256-GCM
  id_number_hash   text NOT NULL,                -- keyed hash, for duplicate detection
  id_number_masked text NOT NULL,
  id_expiry        date,
  flags            text[] NOT NULL DEFAULT '{}', -- e.g. DUPLICATE_IDENTITY, NAME_MISMATCH
  checks           jsonb NOT NULL DEFAULT '{}',
  attestation      jsonb,                        -- in-person: who sighted the original document
  decided_by       text,
  decided_at       timestamptz,
  decision_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kyc_cases_status_idx ON kyc_cases (status, created_at);

CREATE TABLE kyc_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES kyc_cases(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES applications(id),
  kind         text NOT NULL CHECK (kind IN ('ID_FRONT','ID_BACK','SELFIE','PROOF_OF_ADDRESS','SIGNATURE')),
  content_type text NOT NULL,
  size_bytes   integer NOT NULL,
  sha256       text NOT NULL,                    -- of the plain bytes
  data         bytea NOT NULL,                   -- AES-256-GCM (iv | tag | ciphertext)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kyc_documents_app_idx ON kyc_documents (application_id, kind);

CREATE TABLE payment_intents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid REFERENCES applications(id),
  order_id       uuid NOT NULL,
  gateway        text NOT NULL,
  gateway_ref    text NOT NULL,
  amount_minor   bigint NOT NULL,
  currency       char(3) NOT NULL,
  status         text NOT NULL DEFAULT 'REQUIRES_PAYMENT' CHECK (status IN ('REQUIRES_PAYMENT','SUCCEEDED','FAILED','CANCELLED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gateway, gateway_ref)
);
CREATE INDEX payment_intents_order_idx ON payment_intents (order_id);

CREATE TABLE webhook_events (
  gateway     text NOT NULL,
  event_id    text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gateway, event_id)
);
