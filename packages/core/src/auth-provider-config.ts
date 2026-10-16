/**
 * The settings of the sign-in integrations (the hub's `auth` group), checked when an administrator saves them.
 *  - IDP_OIDC  single sign-on with OpenID Connect (Microsoft Entra ID, Okta, Ping, Keycloak and any other compliant provider). `url` is the issuer.
 *  - IDP_SAML  SAML 2.0 provider settings. They are kept and checked, but Meridian does not yet accept SAML assertions (see docs/SECURITY.md).
 *  - LDAP      Active Directory / LDAP: staff accounts are synced on a schedule and sign in with their directory password. `url` is ldaps://host:636.
 *  - OTP_GATEWAY  the SMS or WhatsApp gateway that carries one-time codes (second factor, password recovery).
 */
export const AUTH_KINDS = ['IDP_OIDC', 'IDP_SAML', 'LDAP', 'OTP_GATEWAY'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];
export const OIDC_VENDORS = ['ENTRA', 'OKTA', 'PING', 'KEYCLOAK', 'OTHER'] as const;

const str = (v: unknown, max = 300) => (typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : null);
const isMap = (v: unknown): v is Record<string, string> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string' && x.length > 0 && x.length < 100) && Object.keys(v).length <= 200;

/** What is wrong with the settings of one of the sign-in integrations, or null. */
export function authEndpointProblem(kind: string, i: { url?: string | null; config?: Record<string, unknown> }): string | null {
  const c = i.config ?? {};
  if (c.roleMappings !== undefined && !isMap(c.roleMappings)) return 'Role mappings go from a group name to a role code (for example "Billing Team": "ROLE_BILLING_OPS").';
  switch (kind) {
    case 'IDP_OIDC': {
      if (!i.url) return 'Enter the issuer address (for example https://login.microsoftonline.com/<tenant>/v2.0).';
      if (!str(c.clientId)) return 'Enter the client id the provider gave you.';
      const ru = str(c.redirectUri, 500);
      if (!ru || !/^https?:\/\//.test(ru)) return 'Enter the redirect address registered with the provider (this site’s /login/sso address).';
      if (c.vendor !== undefined && !(OIDC_VENDORS as readonly string[]).includes(String(c.vendor))) return `The provider is one of ${OIDC_VENDORS.join(', ')}.`;
      return null;
    }
    case 'IDP_SAML':
      if (!i.url) return 'Enter the provider’s single sign-on address.';
      if (!str(c.entityId, 500)) return 'Enter the provider’s entity id.';
      if (!str(c.certificate, 8000) || !/-----BEGIN CERTIFICATE-----/.test(String(c.certificate))) return 'Paste the provider’s signing certificate (PEM, starting with -----BEGIN CERTIFICATE-----).';
      return null;
    case 'LDAP': {
      if (!i.url || !/^ldaps?:\/\//.test(i.url)) return 'The directory address starts with ldaps:// (or ldap:// inside a private network).';
      if (!str(c.bindDn, 500)) return 'Enter the service account that reads the directory (its distinguished name).';
      if (!str(c.baseDn, 500)) return 'Enter the place in the directory to search (the base DN).';
      const every = c.syncEveryMinutes === undefined ? 0 : Number(c.syncEveryMinutes);
      if (!Number.isInteger(every) || every < 0 || every > 10080) return 'Sync every 15 to 10,080 minutes, or 0 to sync only on request.';
      if (every > 0 && every < 15) return 'Sync every 15 to 10,080 minutes, or 0 to sync only on request.';
      return null;
    }
    case 'OTP_GATEWAY': {
      if (!i.url) return 'Enter the gateway address that accepts messages.';
      if (c.deliver !== undefined && c.deliver !== 'SMS' && c.deliver !== 'WHATSAPP') return 'Deliver codes by SMS or WHATSAPP.';
      return null;
    }
    default: return null;
  }
}
