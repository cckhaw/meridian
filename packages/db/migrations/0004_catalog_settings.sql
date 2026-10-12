-- Catalog editing (ordering) and operator settings (regional format, appearance, logo).

ALTER TABLE catalog_nodes ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
CREATE INDEX catalog_nodes_sort_idx ON catalog_nodes (parent_id, sort_order, name);

-- Key/value settings, written only by the super user ('regional', 'branding').
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Small binary assets (the portal logo). Stored in the database so the app needs no writable filesystem.
CREATE TABLE assets (
  name         text PRIMARY KEY,
  content_type text NOT NULL,
  bytes        bytea NOT NULL,
  sha256       text NOT NULL,
  width        integer,
  height       integer,
  updated_by   text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
