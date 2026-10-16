-- An installation booked while the order is taken lives on its own case, so the technician visit, the callbacks from the field-service system, the
-- customer messages and "move the visit" all work exactly as for a fault visit. The case remembers its order.
ALTER TABLE cases ADD COLUMN order_id uuid;
CREATE INDEX cases_order_idx ON cases (order_id) WHERE order_id IS NOT NULL;

INSERT INTO case_taxonomy (id, parent_id, level, name, sort_order, case_type, default_severity, needs_dispatch, skills, equipment) VALUES
  ('broadband.install',     'broadband',         2, 'Installation',          5, NULL, NULL, false, '{}', '{}'),
  ('broadband.install.new', 'broadband.install', 3, 'New fibre installation', 10, 'FIBER_ASSURANCE', 'MINOR_INQUIRY', true, '{FIBER_SPLICING}', '{ONT_UNIT}')
ON CONFLICT (id) DO NOTHING;
