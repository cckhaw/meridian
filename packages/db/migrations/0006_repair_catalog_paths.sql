-- Catalog paths must be built from node ids (parent path + '/' + id). Catalogs seeded by earlier releases stored codes for some levels
-- (e.g. 'mobile/postpaid/device/...' under a group whose id is 'grp-device'), which hid those offers from path-based checks such as the store-front.
-- Rebuild every path from the parent chain; already-correct rows are untouched.
WITH RECURSIVE t AS (
  SELECT id, id::text AS np FROM catalog_nodes WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, t.np || '/' || c.id FROM catalog_nodes c JOIN t ON c.parent_id = t.id
)
UPDATE catalog_nodes n SET path = t.np FROM t WHERE n.id = t.id AND n.path <> t.np;
