-- KYC as one workflow for every channel.
--  * A customer's identity check no longer needs an application: a case can belong to a customer alone (created in the CRM, in the order wizard or from the customer
--    screen), so it reaches the same review queue as a store-front sign-up.
--  * A customer is NOT_VERIFIED (nothing submitted), PENDING_REVIEW (evidence submitted, a review task is open), VERIFIED or REJECTED.
--  * Identity photos are kept in the document vault (documents.kyc_case_id), not in the older kyc_documents table.

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_kyc_status_check;
ALTER TABLE customers ADD CONSTRAINT customers_kyc_status_check CHECK (kyc_status IN ('NOT_VERIFIED','PENDING_REVIEW','VERIFIED','REJECTED'));

ALTER TABLE kyc_cases ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE kyc_cases DROP CONSTRAINT IF EXISTS kyc_cases_method_check;
ALTER TABLE kyc_cases DROP CONSTRAINT IF EXISTS kyc_cases_status_check;
ALTER TABLE kyc_cases ADD CONSTRAINT kyc_cases_method_check CHECK (method IN ('DOCUMENT_REMOTE','IN_PERSON','DOCUMENT_STORE'));
ALTER TABLE kyc_cases ADD CONSTRAINT kyc_cases_status_check CHECK (status IN ('PENDING','APPROVED','REJECTED','RETURNED'));
ALTER TABLE kyc_cases
  ADD COLUMN source         text NOT NULL DEFAULT 'STOREFRONT' CHECK (source IN ('STOREFRONT','ASSISTED','CRM_ORDER','CRM_CUSTOMER')),
  ADD COLUMN submitted_at   timestamptz,
  ADD COLUMN submitted_by   text,
  ADD COLUMN order_id       uuid,                       -- the order that prompted a check made from the order wizard
  ADD COLUMN reason_code    text,                       -- why a case was rejected or sent back: NOT_AN_ID, UNREADABLE, MISMATCH, EXPIRED, SUSPECTED_FRAUD, OTHER
  ADD COLUMN fraud_reported boolean NOT NULL DEFAULT false;
UPDATE kyc_cases k SET submitted_at = k.created_at, source = CASE WHEN a.channel = 'RETAIL_ASSISTED' THEN 'ASSISTED' ELSE 'STOREFRONT' END
  FROM applications a WHERE a.id = k.application_id;
CREATE INDEX kyc_cases_customer_idx ON kyc_cases (customer_id, created_at DESC) WHERE customer_id IS NOT NULL;

ALTER TABLE documents ADD COLUMN kyc_case_id uuid;
CREATE INDEX documents_kyc_case_idx ON documents (kyc_case_id) WHERE kyc_case_id IS NOT NULL;
