-- Catalog releases: a named, ordered set of catalog changes that are NOT live until the release is published. Every change is stored as the input the existing catalog
-- function takes (createNode, updateNode, moveNode, setStatus, deleteNode, copyLineItems), so publishing replays them through those functions and every catalog rule
-- still applies. Additive: three new tables and a sequence; nothing existing changes.

CREATE SEQUENCE catalog_release_number_seq;

CREATE TABLE catalog_releases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                text NOT NULL UNIQUE DEFAULT ('REL-' || lpad(nextval('catalog_release_number_seq')::text, 4, '0')),
  name                  text NOT NULL,
  description           text,
  status                text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','APPROVED','PUBLISHED','REJECTED','CANCELLED')),
  publish_at            timestamptz,                    -- published automatically at this time (by the sweep that activates scheduled offers)
  publish_error         text,                           -- why the last scheduled publish did not happen; the sweep does not retry until the schedule is set again
  reverses_release_id   uuid REFERENCES catalog_releases(id),
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  published_by          text,
  published_at          timestamptz,
  result                jsonb,                          -- what publishing did: counts, and the state of every touched node before it (for a reverse release)
  version               integer NOT NULL DEFAULT 1
);
CREATE INDEX catalog_releases_status_idx ON catalog_releases (status, created_at DESC, id);
CREATE INDEX catalog_releases_due_idx ON catalog_releases (publish_at) WHERE publish_at IS NOT NULL AND status IN ('DRAFT','APPROVED') AND publish_error IS NULL;

CREATE TABLE catalog_release_changes (
  id            bigserial PRIMARY KEY,
  release_id    uuid NOT NULL REFERENCES catalog_releases(id) ON DELETE CASCADE,
  seq           integer NOT NULL,                       -- the order they are applied in
  op            text NOT NULL CHECK (op IN ('CREATE','UPDATE','MOVE','STATUS','DELETE','COPY_LINE_ITEMS')),
  node_id       text NOT NULL,                          -- the node the change is about (the new one, for CREATE; the target, for COPY_LINE_ITEMS)
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,     -- the input of the catalog function: { input } | { patch } | { parentId } | { status, activeFrom } | {} | { fromId }
  base_version  integer,                                -- the live node's version when it was first staged here; null for a node created in the release
  group_key     text,                                   -- ties changes that are one idea together (a new version replacing a sold offer)
  note          text,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, seq)
);
CREATE INDEX catalog_release_changes_node_idx ON catalog_release_changes (node_id);

-- A node can be in only one open release at a time; the primary key makes that safe when two people stage at once.
CREATE TABLE catalog_release_nodes (
  node_id     text PRIMARY KEY,
  release_id  uuid NOT NULL REFERENCES catalog_releases(id) ON DELETE CASCADE,
  claimed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_release_nodes_release_idx ON catalog_release_nodes (release_id);
