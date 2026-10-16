/**
 * The settings of the identity providers (the hub's `identity` group), checked when an administrator saves them.
 *  - KYC_OCR          a REST service that reads the ID photographs. `url` is where the photographs are posted. `config.mode` is REST (a real service) or SIMULATOR (a built-in stand-in for trying things out).
 *  - KYC_MYDIGITALID  MyDigital ID, an OpenID Connect provider. `url` is the issuer.
 */
export const IDENTITY_KINDS = ['KYC_OCR', 'KYC_MYDIGITALID'] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

const str = (v: unknown, max = 300) => (typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : null);
const isPath = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.$\[\]-]{1,100}$/.test(v);
const ratio = (v: unknown) => v === undefined || (typeof v === 'number' && v >= 0 && v <= 1);

export function identityEndpointProblem(kind: string, i: { url?: string | null; config?: Record<string, unknown> }): string | null {
  const c = i.config ?? {};
  if (c.autoApprove !== undefined && typeof c.autoApprove !== 'boolean') return 'Automatic approval is on or off.';
  if (c.autoReject !== undefined && typeof c.autoReject !== 'boolean') return 'Automatic rejection is on or off.';
  switch (kind) {
    case 'KYC_OCR': {
      const mode = c.mode ?? 'REST';
      if (mode !== 'REST' && mode !== 'SIMULATOR') return 'The mode is REST or SIMULATOR.';
      if (mode === 'REST' && !i.url) return 'Enter the address of the ID check service.';
      if (c.authKind !== undefined && !['NONE', 'BEARER', 'HEADER'].includes(String(c.authKind))) return 'Authentication is NONE, BEARER or HEADER.';
      if (c.authKind === 'HEADER' && !str(c.authHeader, 60)) return 'Enter the name of the header that carries the key.';
      if (c.map !== undefined) {
        if (!c.map || typeof c.map !== 'object' || Array.isArray(c.map) || !Object.values(c.map as Record<string, unknown>).every(isPath)) return 'Each field of the answer is given as a path such as extracted.fullName.';
      }
      for (const k of ['passValues', 'failValues']) if (c[k] !== undefined && !(Array.isArray(c[k]) && (c[k] as unknown[]).every((x) => typeof x === 'string' && x.length < 40) && (c[k] as unknown[]).length <= 20)) return `${k === 'passValues' ? 'The values that mean pass' : 'The values that mean fail'} are a list of words.`;
      if (!ratio(c.faceMatchMin) || !ratio(c.faceFailBelow)) return 'The face-match limits are between 0 and 1 (a score of 0 to 100 is read as a percentage).';
      if (typeof c.faceMatchMin === 'number' && typeof c.faceFailBelow === 'number' && c.faceFailBelow > c.faceMatchMin) return 'The score below which a case fails cannot be higher than the score that passes.';
      return null;
    }
    case 'KYC_MYDIGITALID': {
      if (!i.url) return 'Enter the issuer address of MyDigital ID.';
      if (!str(c.clientId)) return 'Enter the client id MyDigital ID gave you.';
      if (!str(c.redirectUriStore, 500) && !str(c.redirectUriCrm, 500)) return 'Enter at least one redirect address registered with MyDigital ID (for the CRM, the store-front, or both).';
      for (const k of ['redirectUriStore', 'redirectUriCrm']) if (c[k] !== undefined && c[k] !== '' && !/^https?:\/\//.test(String(c[k]))) return 'Redirect addresses start with https://.';
      for (const k of ['authorizationEndpoint', 'tokenEndpoint', 'jwksUri']) if (c[k] !== undefined && c[k] !== '' && !/^https?:\/\//.test(String(c[k]))) return `The ${k} must be an address.`;
      if (c.claims !== undefined) {
        if (!c.claims || typeof c.claims !== 'object' || Array.isArray(c.claims) || !Object.values(c.claims as Record<string, unknown>).every((v) => typeof v === 'string' && v.length < 60)) return 'Claims map our fields to the claim names MyDigital ID sends.';
      }
      return null;
    }
    default: return null;
  }
}
