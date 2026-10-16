-- Document management: one vault for identity documents and signed agreements, contract templates with legal versions, e-signatures and an
-- append-only access log. Bytes live in the database (AES-256-GCM for identity data) or in S3-compatible object storage; the vault row says where.

CREATE TABLE documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('KYC','CONTRACT','SIGNATURE')),
  category            text NOT NULL,                       -- NATIONAL_ID_FRONT, PASSPORT, SUBSCRIBER_AGREEMENT, CUSTOMER_SIGNATURE …
  customer_id         uuid,
  application_id      uuid,
  order_id            uuid,
  service_id          uuid,
  name                text NOT NULL,
  content_type        text NOT NULL,
  size_bytes          integer NOT NULL,
  sha256              text NOT NULL,                       -- of the plain bytes: what a later check compares against
  storage             text NOT NULL CHECK (storage IN ('DB','S3','KYC_LEGACY')),
  storage_key         text,                                -- object key (S3) or the store-front evidence row (KYC_LEGACY)
  data                bytea,                               -- DB storage; AES-256-GCM (iv | tag | ciphertext) when `encrypted`
  encrypted           boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PENDING_VERIFICATION','VERIFIED_AUTO','VERIFIED_MANUAL','REJECTED','EXPIRED','PURGED_RETENTION','ACTIVE','SUPERSEDED')),
  status_reason       text,
  verified_by         text,
  verified_at         timestamptz,
  expires_at          timestamptz,                         -- the document's own expiry (an ID card's validity)
  retention_until     timestamptz,                         -- never purged before this
  purged_at           timestamptz,
  template_version_id uuid,                                -- the exact legal text a contract was made from
  meta                jsonb NOT NULL DEFAULT '{}',
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_customer_idx ON documents (customer_id, created_at DESC);
CREATE INDEX documents_order_idx ON documents (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX documents_service_idx ON documents (service_id) WHERE service_id IS NOT NULL;
CREATE INDEX documents_kind_status_idx ON documents (kind, status, created_at DESC);
CREATE INDEX documents_retention_idx ON documents (retention_until) WHERE purged_at IS NULL AND retention_until IS NOT NULL;
CREATE UNIQUE INDEX documents_legacy_uq ON documents (storage_key) WHERE storage = 'KYC_LEGACY';

CREATE TABLE document_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  category          text NOT NULL CHECK (category IN ('SUBSCRIBER_AGREEMENT','FAIR_USAGE','DEVICE_INSTALMENT','PLAN_CHANGE','OTHER')),
  contexts          text[] NOT NULL DEFAULT '{ORDER}',      -- where it is signed: ORDER, PLAN_CHANGE
  offer_kinds       text[] NOT NULL DEFAULT '{}',           -- offer types it applies to; none listed = every offer
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  active_version_id uuid,
  sort_order        integer NOT NULL DEFAULT 100,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE template_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES document_templates(id),
  major        integer,
  minor        integer,
  html         text NOT NULL,
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  note         text NOT NULL DEFAULT '',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_by text,
  published_at timestamptz,
  CHECK ((status = 'DRAFT' AND major IS NULL) OR (status <> 'DRAFT' AND major IS NOT NULL AND minor IS NOT NULL))
);
CREATE UNIQUE INDEX template_versions_number_uq ON template_versions (template_id, major, minor) WHERE major IS NOT NULL;
CREATE UNIQUE INDEX template_versions_one_draft_uq ON template_versions (template_id) WHERE status = 'DRAFT';
ALTER TABLE document_templates ADD CONSTRAINT document_templates_active_fk FOREIGN KEY (active_version_id) REFERENCES template_versions(id);

CREATE TABLE document_signatures (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id           uuid NOT NULL REFERENCES documents(id),     -- the signed contract
  signature_document_id uuid REFERENCES documents(id),              -- the captured signature image
  customer_id           uuid NOT NULL,
  order_id              uuid,
  service_id            uuid,
  template_version_id   uuid NOT NULL REFERENCES template_versions(id),
  signer_name           text NOT NULL,
  signed_at             timestamptz NOT NULL DEFAULT now(),
  ip                    text,
  user_agent            text,
  geo                   jsonb,
  agent                 text,                                       -- the staff member who took the signature, when assisted
  method                text NOT NULL CHECK (method IN ('SELF_SERVE','ASSISTED','PLAN_CHANGE')),
  content_seal          text NOT NULL,                              -- SHA-256 over the final text, the signature image and who/when
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_signatures_customer_idx ON document_signatures (customer_id, signed_at DESC);
CREATE INDEX document_signatures_order_idx ON document_signatures (order_id) WHERE order_id IS NOT NULL;

-- Who looked at or changed which document. Append-only: the database refuses to change or remove a line.
CREATE TABLE document_audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id uuid,
  template_id uuid,
  customer_id uuid,
  action      text NOT NULL,
  actor       text NOT NULL,
  ip          text,
  user_agent  text,
  detail      jsonb NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_audit_doc_idx ON document_audit_log (document_id, id DESC) WHERE document_id IS NOT NULL;
CREATE INDEX document_audit_customer_idx ON document_audit_log (customer_id, id DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX document_audit_actor_idx ON document_audit_log (actor, id DESC);
CREATE FUNCTION document_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the document audit log cannot be changed'; END $$;
CREATE TRIGGER document_audit_no_update BEFORE UPDATE OR DELETE ON document_audit_log FOR EACH ROW EXECUTE FUNCTION document_audit_immutable();

-- The store-front's identity evidence already collected is part of the vault from the start (the bytes stay where they are).
INSERT INTO documents (kind, category, customer_id, application_id, name, content_type, size_bytes, sha256, storage, storage_key, encrypted, status, created_by, created_at, retention_until)
SELECT 'KYC',
       CASE d.kind WHEN 'ID_FRONT' THEN 'NATIONAL_ID_FRONT' WHEN 'ID_BACK' THEN 'NATIONAL_ID_BACK' WHEN 'PROOF_OF_ADDRESS' THEN 'PROOF_OF_ADDRESS' WHEN 'SELFIE' THEN 'SELFIE' ELSE 'CUSTOMER_SIGNATURE' END,
       c.customer_id, d.application_id, lower(d.kind), d.content_type, d.size_bytes, d.sha256, 'KYC_LEGACY', d.id::text, true,
       CASE c.status WHEN 'APPROVED' THEN 'VERIFIED_MANUAL' WHEN 'REJECTED' THEN 'REJECTED' ELSE 'PENDING_VERIFICATION' END,
       'system', d.created_at, NULL
  FROM kyc_documents d JOIN kyc_cases c ON c.id = d.case_id;
