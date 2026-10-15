-- Bill templates: the layout of a customer's bill, designed on screen or converted from a legacy format. A template is edited as a draft and published as a
-- numbered version; issued bills are always drawn with a published version, so changing a draft never changes a bill already sent.
CREATE TABLE bill_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  source        text NOT NULL DEFAULT 'DESIGNER' CHECK (source IN ('DESIGNER','LEGACY_HTML','LEGACY_JSON','LEGACY_XML')),
  draft         jsonb NOT NULL,                       -- the TemplateSchema being edited
  report        jsonb,                                -- what a legacy conversion carried over, warned about, or dropped
  version       integer NOT NULL DEFAULT 0,           -- the latest published version, 0 when never published
  is_default    boolean NOT NULL DEFAULT false,       -- the template used when none is named; always a published one
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bill_templates_default_uq ON bill_templates (is_default) WHERE is_default;

CREATE TABLE bill_template_versions (
  template_id   uuid NOT NULL REFERENCES bill_templates (id) ON DELETE CASCADE,
  version       integer NOT NULL,
  schema        jsonb NOT NULL,
  note          text NOT NULL DEFAULT '',
  published_by  text NOT NULL,
  published_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);

-- A print-house job: which bills went out, drawn with which template version and print profile, and the manifest the printer receives.
CREATE TABLE print_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_run_id      uuid,
  template_id      uuid NOT NULL REFERENCES bill_templates (id),
  template_version integer NOT NULL,
  profile          jsonb NOT NULL,
  selection        jsonb NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  invoice_count    integer NOT NULL DEFAULT 0,
  page_count       integer NOT NULL DEFAULT 0,
  summary          jsonb NOT NULL DEFAULT '{}',
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX print_jobs_recent_idx ON print_jobs (created_at DESC);
