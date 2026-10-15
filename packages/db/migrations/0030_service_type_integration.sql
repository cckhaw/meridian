-- Service types (formerly service kinds) can all be adapted by the super user, built-in ones included: whether the network is told when a service of the
-- type starts (built-in types have never done so, so it starts off for them), and whether services of the type are provisioned into the charging system.
ALTER TABLE service_kinds
  ADD COLUMN announce_start boolean NOT NULL DEFAULT true,
  ADD COLUMN ocs_enabled    boolean NOT NULL DEFAULT true;
UPDATE service_kinds SET announce_start = false WHERE is_builtin;
