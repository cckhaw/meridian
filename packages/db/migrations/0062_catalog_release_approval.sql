-- Approval of catalog releases (maker-checker): who submitted and who decided, and the reviewers' comments (which also keep the history of what happened to a release).
-- Additive: nullable columns and one new table.

ALTER TABLE catalog_releases
  ADD COLUMN submitted_by  text,
  ADD COLUMN submitted_at  timestamptz,
  ADD COLUMN decided_by    text,                 -- who approved or rejected it the last time
  ADD COLUMN decided_at    timestamptz;

CREATE TABLE catalog_release_comments (
  id          bigserial PRIMARY KEY,
  release_id  uuid NOT NULL REFERENCES catalog_releases(id) ON DELETE CASCADE,
  author      text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('COMMENT','SUBMIT','APPROVE','REJECT','REOPEN','PUBLISH')),
  body        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_release_comments_release_idx ON catalog_release_comments (release_id, id);
