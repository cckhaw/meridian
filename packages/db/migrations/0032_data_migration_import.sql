-- Importing: uploaded files wait here, in pieces, until a job has read them; and every record a job creates is remembered against the key it had in the old system.
CREATE TABLE migration_uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by    text NOT NULL,
  file_name     text NOT NULL,
  total_bytes   bigint NOT NULL,
  chunk_bytes   integer NOT NULL,
  chunks        integer NOT NULL,
  storage       text NOT NULL DEFAULT 'DB' CHECK (storage IN ('DB','S3')),
  object_key    text,
  format        text CHECK (format IN ('CSV','NDJSON')),     -- what the job reads, after a JSON document or a spreadsheet has been turned into rows
  rows_hint     bigint,
  sha256        text,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETE','DISCARDED')),
  note          jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE TABLE migration_blobs (
  upload_id  uuid NOT NULL REFERENCES migration_uploads (id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  data       bytea NOT NULL,
  PRIMARY KEY (upload_id, seq)
);

-- The key a record had in the old system -> the id Meridian gave it. This lets other files point at records by their old key, makes loading the same file twice safe
-- (a key that is already here is skipped, not duplicated), and lets a job's own records be taken out again.
CREATE TABLE migration_refs (
  entity       text NOT NULL,
  ref          text NOT NULL,
  internal_id  text NOT NULL,
  job_id       uuid,
  created      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity, ref)
);
CREATE INDEX migration_refs_job_idx ON migration_refs (job_id) WHERE job_id IS NOT NULL;

-- Keys seen so far in the file being checked, so a row can point at a record that appears earlier in the same file.
CREATE TABLE migration_keys (
  job_id  uuid NOT NULL REFERENCES migration_jobs (id) ON DELETE CASCADE,
  key     text NOT NULL,
  PRIMARY KEY (job_id, key)
);

-- Opening balances are invoices of this kind.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_kind_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_kind_check CHECK (kind IN ('CYCLE','FINAL','ADJUSTMENT','OPENING'));

-- Taking a load out again runs in slices too, so it has a status of its own.
ALTER TABLE migration_jobs DROP CONSTRAINT IF EXISTS migration_jobs_status_check;
ALTER TABLE migration_jobs ADD CONSTRAINT migration_jobs_status_check CHECK (status IN ('PENDING','VALIDATING','VALIDATED','IMPORTING','EXPORTING','COMPLETED','FAILED','CANCELLED','ROLLING_BACK','ROLLED_BACK'));
DROP INDEX IF EXISTS migration_jobs_active_idx;
CREATE INDEX migration_jobs_active_idx ON migration_jobs (status) WHERE status IN ('PENDING','VALIDATING','IMPORTING','EXPORTING','ROLLING_BACK');
