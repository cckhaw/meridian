-- Catalog configuration (Settings → Catalog): the offer types an operator can create, and the ways an offer can be fulfilled.
-- Both lists are data. What a type or option DOES comes from the behaviour template / mechanic it is based on, so the platform
-- always knows how to sell, fulfil and bill it. The built-in rows below are the defaults.
CREATE TABLE offer_types (
  id          text PRIMARY KEY,                 -- the offer's `kind`; built-ins use their template's code
  name        text NOT NULL,
  description text,
  template    text NOT NULL CHECK (template IN ('SIM_ONLY','SIM_DEVICE','WEARABLE','FIBER','IOT_CONNECTIVITY','VAS','NON_TELCO_SUBSCRIPTION','PHYSICAL_GOOD')),
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  sort_order  integer NOT NULL DEFAULT 100,
  is_builtin  boolean NOT NULL DEFAULT false,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX offer_types_name_uq ON offer_types (lower(name));
INSERT INTO offer_types (id, name, description, template, sort_order, is_builtin) VALUES
  ('SIM_ONLY',               'SIM only',            'A mobile plan with a SIM and no device.',                          'SIM_ONLY',               10, true),
  ('SIM_DEVICE',             'SIM + device',        'A mobile plan sold with a phone, usually on contract.',            'SIM_DEVICE',             20, true),
  ('WEARABLE',               'Wearable',            'A connected watch or band.',                                       'WEARABLE',               30, true),
  ('FIBER',                  'Fibre',               'Home fibre broadband, installed by a technician.',                 'FIBER',                  40, true),
  ('IOT_CONNECTIVITY',       'IoT connectivity',    'Connectivity for connected devices, bought in bulk.',              'IOT_CONNECTIVITY',       50, true),
  ('VAS',                    'Add-on',              'An extra on top of a plan: roaming, extra data, device care.',     'VAS',                    60, true),
  ('NON_TELCO_SUBSCRIPTION', 'Partner subscription','A partner’s service billed with the plan, such as streaming.',    'NON_TELCO_SUBSCRIPTION', 70, true),
  ('PHYSICAL_GOOD',          'Goods',               'A device or appliance sold outright.',                             'PHYSICAL_GOOD',          80, true);

CREATE TABLE fulfilment_options (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  description  text,
  mechanic     text NOT NULL CHECK (mechanic IN ('SHIP','COLLECT','INSTALL','SIM')),
  tracks_stock boolean NOT NULL DEFAULT false,   -- true: offers using it list the stock SKUs reserved when sold
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  sort_order   integer NOT NULL DEFAULT 100,
  is_builtin   boolean NOT NULL DEFAULT false,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fulfilment_options_name_uq ON fulfilment_options (lower(name));
INSERT INTO fulfilment_options (id, name, description, mechanic, tracks_stock, sort_order, is_builtin) VALUES
  ('SHIP',    'Delivered to the customer', 'Posted or couriered to the customer''s address.',                                  'SHIP',    true,  10, true),
  ('COLLECT', 'Collect in store',          'The customer collects it from a store they choose.',                               'COLLECT', true,  20, true),
  ('INSTALL', 'Installation visit',        'A technician visits to install it.',                                               'INSTALL', false, 30, true),
  ('SIM',     'SIM activation',            'A SIM card is issued and activated. Turn on stock tracking if you count SIM cards.', 'SIM',     false, 40, true);

-- Offers made before this existed get the option ids that match their old flags, so the offer wizard can show them.
UPDATE catalog_nodes SET data = jsonb_set(data, '{fulfilment,options}',
    to_jsonb(ARRAY_REMOVE(ARRAY[
      CASE WHEN (data->'fulfilment'->>'requiresShipping')::boolean THEN 'SHIP' END,
      CASE WHEN (data->'fulfilment'->>'requiresInstallation')::boolean THEN 'INSTALL' END,
      CASE WHEN (data->'fulfilment'->>'requiresSimActivation')::boolean THEN 'SIM' END], NULL)))
  WHERE level = 'OFFER' AND data->'fulfilment' IS NOT NULL AND data->'fulfilment' ? 'requiresShipping' AND NOT (data->'fulfilment' ? 'options');
