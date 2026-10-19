-- The e-mail sender (integration endpoint kind EMAIL_GATEWAY, group 'auth') and the "E-mail codes" setting of Settings → Security policy.
--  * simulated_emails: what the sender's SIMULATOR mode records instead of sending (a few days at most; trimmed as new ones arrive)
--  * the OTP_GATEWAY settings JSON used to carry an `emailCodes` opt-in. It is now the policy switch email.codesEnabled, so a deployment that had it on keeps it on
--    (it still needs an e-mail sender in the Integration hub before any code is sent), and the key is removed from the endpoint.
CREATE TABLE simulated_emails (
  id          bigserial PRIMARY KEY,
  to_address  text NOT NULL,
  subject     text NOT NULL,
  body_text   text NOT NULL,
  body_html   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value, updated_by)
SELECT 'securityPolicy', jsonb_build_object('email', jsonb_build_object('codesEnabled', true)), 'migration 0059'
WHERE EXISTS (SELECT 1 FROM integration_endpoints WHERE kind = 'OTP_GATEWAY' AND config->'emailCodes' = 'true'::jsonb)
ON CONFLICT (key) DO UPDATE SET
  value = jsonb_set(settings.value, '{email}', COALESCE(settings.value->'email', '{}'::jsonb) || '{"codesEnabled": true}'::jsonb, true),
  updated_by = 'migration 0059', updated_at = now();

UPDATE integration_endpoints SET config = config - 'emailCodes' WHERE kind = 'OTP_GATEWAY' AND config->'emailCodes' IS NOT NULL;
