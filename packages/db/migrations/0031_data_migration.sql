-- Data migration: exports and imports are tracked as jobs, so progress, who ran what, the options used and the problems found can be seen afterwards.
-- A job is one export (many entities, downloaded once) or one import (one entity, one uploaded file, checked and then loaded in slices).
CREATE TABLE migration_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('EXPORT','IMPORT')),
  entity           text,                                   -- import: the entity being loaded
  entities         text[] NOT NULL DEFAULT '{}',           -- export: what is in the archive
  format           text NOT NULL CHECK (format IN ('CSV','JSON','NDJSON','XLSX')),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VALIDATING','VALIDATED','IMPORTING','EXPORTING','COMPLETED','FAILED','CANCELLED','ROLLED_BACK')),
  options          jsonb NOT NULL DEFAULT '{}',
  masked           boolean NOT NULL DEFAULT true,          -- export: sensitive fields masked (false only for the super user, with a reason)
  reason           text,
  file_name        text,
  file_bytes       bigint,
  upload_id        uuid,
  cursor_bytes     bigint NOT NULL DEFAULT 0,              -- import: how far into the file the current pass has got (always the start of a row)
  rows_total       bigint,
  rows_done        bigint NOT NULL DEFAULT 0,
  rows_ok          bigint NOT NULL DEFAULT 0,
  rows_error       bigint NOT NULL DEFAULT 0,
  rows_skipped     bigint NOT NULL DEFAULT 0,
  percent          smallint NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  stage            text,
  summary          jsonb NOT NULL DEFAULT '{}',
  template_version text,
  claimed_until    timestamptz,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX migration_jobs_recent_idx ON migration_jobs (created_at DESC);
CREATE INDEX migration_jobs_active_idx ON migration_jobs (status) WHERE status IN ('PENDING','VALIDATING','IMPORTING','EXPORTING');

-- Row-level problems and warnings found while checking or loading an import. Capped per job by the application.
CREATE TABLE migration_job_items (
  id        bigserial PRIMARY KEY,
  job_id    uuid NOT NULL REFERENCES migration_jobs (id) ON DELETE CASCADE,
  line      bigint NOT NULL,
  severity  text NOT NULL CHECK (severity IN ('ERROR','WARNING')),
  field     text,
  code      text NOT NULL,
  message   text NOT NULL,
  pass      text NOT NULL DEFAULT 'VALIDATE'
);
CREATE INDEX migration_job_items_job_idx ON migration_job_items (job_id, id);

-- The template of each entity as it was when last published: its version changes whenever a column does, so a file made from an old template is recognised.
CREATE TABLE data_templates (
  entity      text PRIMARY KEY,
  version     text NOT NULL,
  label       text NOT NULL,
  domain      text NOT NULL,
  phase       smallint NOT NULL,
  importable  boolean NOT NULL,
  columns     jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
