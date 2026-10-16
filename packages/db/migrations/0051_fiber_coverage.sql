-- Fibre (FTTH) coverage and serviceability: owned and wholesale networks, their cabinets, distribution points and ports, coverage polygons,
-- the address gazetteer, port reservations, and the caches and queues around them.
--
-- This belongs to the separately deployed fibre-coverage service (apps/fiber-coverage). Nothing here references a core table, so the module can be switched
-- off, or deployed on its own database, without touching the CRM. Geometry is held as GeoJSON with a bounding box (plain B-tree indexes) so it runs on the
-- embedded database and on any managed Postgres; PostGIS can replace the box prefilter without changing the API.

CREATE TABLE fiber_providers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name                text NOT NULL,
  type                text NOT NULL CHECK (type IN ('OWNED_INFRASTRUCTURE','WHOLESALE_PARTNER')),
  agreement_id        text,
  cost_per_port_minor bigint NOT NULL DEFAULT 0 CHECK (cost_per_port_minor >= 0),
  currency            char(3) NOT NULL DEFAULT 'SGD',
  install_lead_days   integer NOT NULL DEFAULT 7 CHECK (install_lead_days BETWEEN 0 AND 365),
  sla_response_hours  integer NOT NULL DEFAULT 48 CHECK (sla_response_hours BETWEEN 0 AND 8760),
  speed_tiers_mbps    integer[] NOT NULL DEFAULT '{100,500,1000}',
  adapter_kind        text NOT NULL DEFAULT 'NONE' CHECK (adapter_kind IN ('NONE','REST','SOAP')),
  adapter_url         text,
  adapter_secret_enc  text,
  adapter_config      jsonb NOT NULL DEFAULT '{}',
  adapter_enabled     boolean NOT NULL DEFAULT false,
  enabled             boolean NOT NULL DEFAULT true,
  created_by          text NOT NULL DEFAULT 'system',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fiber_cabinets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  uuid NOT NULL REFERENCES fiber_providers(id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  state        text, city text, postal_code text,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PLANNED','DECOMMISSIONED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, code)
);

CREATE TABLE fiber_dps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id      uuid NOT NULL REFERENCES fiber_providers(id) ON DELETE CASCADE,
  cabinet_id       uuid REFERENCES fiber_cabinets(id) ON DELETE SET NULL,
  code             text NOT NULL,
  name             text NOT NULL,
  kind             text NOT NULL DEFAULT 'DP' CHECK (kind IN ('FDP','DP')),
  lat              double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng              double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  splitter_ratio   integer NOT NULL DEFAULT 8 CHECK (splitter_ratio IN (2,4,8,16,32,64)),
  radius_m         integer NOT NULL DEFAULT 150 CHECK (radius_m BETWEEN 10 AND 5000),
  address          text, state text, city text, postal_code text,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PLANNED','DECOMMISSIONED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, code)
);
CREATE INDEX fiber_dps_lat_lng_idx ON fiber_dps (lat, lng) WHERE status = 'ACTIVE';

CREATE TABLE fiber_ports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dp_id          uuid NOT NULL REFERENCES fiber_dps(id) ON DELETE CASCADE,
  port_no        integer NOT NULL CHECK (port_no >= 1),
  state          text NOT NULL DEFAULT 'AVAILABLE' CHECK (state IN ('AVAILABLE','RESERVED_CHECKOUT','RESERVED_ORDER','IN_USE','FAULTY')),
  reservation_id uuid,
  reserved_until timestamptz,
  note           text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dp_id, port_no)
);
CREATE INDEX fiber_ports_state_idx ON fiber_ports (dp_id, state);
CREATE INDEX fiber_ports_expiry_idx ON fiber_ports (reserved_until) WHERE state = 'RESERVED_CHECKOUT';

CREATE TABLE fiber_coverage_polygons (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     uuid NOT NULL REFERENCES fiber_providers(id) ON DELETE CASCADE,
  cabinet_id      uuid REFERENCES fiber_cabinets(id) ON DELETE SET NULL,
  dp_id           uuid REFERENCES fiber_dps(id) ON DELETE SET NULL,
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'SERVICE_AREA' CHECK (kind IN ('DP_BOUNDARY','CABINET_BOUNDARY','SERVICE_AREA')),
  geometry        jsonb NOT NULL,                           -- GeoJSON Polygon or MultiPolygon
  min_lat double precision NOT NULL, max_lat double precision NOT NULL,
  min_lng double precision NOT NULL, max_lng double precision NOT NULL,
  speed_tiers_mbps integer[],                              -- when set, overrides the provider's tiers inside this area
  capacity_status text NOT NULL DEFAULT 'AVAILABLE' CHECK (capacity_status IN ('AVAILABLE','EXHAUSTED')),  -- for areas with no port inventory of their own (partner files)
  source          text NOT NULL DEFAULT 'MANUAL',          -- MANUAL, IMPORT:<job id>
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fiber_polygons_bbox_idx ON fiber_coverage_polygons (min_lat, max_lat, min_lng, max_lng);
CREATE INDEX fiber_polygons_provider_idx ON fiber_coverage_polygons (provider_id);

-- Address gazetteer: national postal code -> state -> city/district -> street/building -> unit (TM Forum 673 hierarchy).
CREATE TABLE fiber_addresses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country      char(2) NOT NULL DEFAULT 'SG',
  postal_code  text NOT NULL,
  state        text, city text, district text,
  street       text, building text, unit text,
  lat          double precision NOT NULL, lng double precision NOT NULL,
  normalized_key text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fiber_addresses_postal_idx ON fiber_addresses (country, postal_code);

-- What a partner (or our own spatial lookup) said about a place, kept so a busy checkout does not hammer a partner's API.
CREATE TABLE fiber_serviceability_cache (
  provider_id uuid NOT NULL REFERENCES fiber_providers(id) ON DELETE CASCADE,
  cache_key   text NOT NULL,
  result      jsonb NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, cache_key)
);
CREATE INDEX fiber_cache_expiry_idx ON fiber_serviceability_cache (expires_at);

CREATE TABLE fiber_reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES fiber_providers(id) ON DELETE CASCADE,
  dp_id         uuid REFERENCES fiber_dps(id) ON DELETE SET NULL,
  port_id       uuid REFERENCES fiber_ports(id) ON DELETE SET NULL,
  state         text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','CONFIRMED','RELEASED','EXPIRED','ACTIVATED')),
  customer_ref  text,
  order_ref     text,
  speed_mbps    integer,
  lat double precision, lng double precision, address text,
  expires_at    timestamptz,
  created_by    text NOT NULL DEFAULT 'system',
  created_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_at  timestamptz, released_at timestamptz
);
CREATE INDEX fiber_reservations_state_idx ON fiber_reservations (state, expires_at);
CREATE INDEX fiber_reservations_customer_idx ON fiber_reservations (customer_ref) WHERE customer_ref IS NOT NULL;

CREATE TABLE fiber_waitlist (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  uuid NOT NULL REFERENCES fiber_providers(id) ON DELETE CASCADE,
  dp_id        uuid REFERENCES fiber_dps(id) ON DELETE SET NULL,
  customer_ref text, contact text,
  lat double precision, lng double precision, address text,
  speed_mbps   integer,
  status       text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','NOTIFIED','CANCELLED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  notified_at  timestamptz
);
CREATE INDEX fiber_waitlist_dp_idx ON fiber_waitlist (dp_id, status);

CREATE TABLE fiber_expansion_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dp_id        uuid NOT NULL REFERENCES fiber_dps(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','DONE','REJECTED')),
  waiting      integer NOT NULL DEFAULT 0,
  note         text,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_by   text, updated_at timestamptz
);
CREATE UNIQUE INDEX fiber_expansion_open_uq ON fiber_expansion_requests (dp_id) WHERE status IN ('OPEN','IN_PROGRESS');

CREATE TABLE fiber_import_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid REFERENCES fiber_providers(id) ON DELETE SET NULL,
  format      text NOT NULL CHECK (format IN ('CSV','GEOJSON','KML')),
  status      text NOT NULL CHECK (status IN ('CHECKED','APPLIED','FAILED')),
  summary     jsonb NOT NULL DEFAULT '{}',
  errors      jsonb NOT NULL DEFAULT '[]',
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- TM Forum 645 qualifications we have answered, so a partner or storefront can fetch one again by id.
CREATE TABLE fiber_qualifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester  text,
  request    jsonb NOT NULL,
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
