import type { Queryable } from './db.js';
import { dataKeyStatus } from './field-crypto.js';
import { guardActive } from './net-guard.js';
import { getSecurityPolicy, mfaRequiredFor } from './security-policy.js';

/**
 * A plain list of how this deployment is set up against the things that matter most (second factor, keys, outside access), so an administrator can see what still needs deciding without reading
 * the environment. It only reports: it changes nothing and shows no secret. `ATTENTION` means a weaker setting that is worth changing before real customer data; `OK` that it is in place;
 * `INFO` that it is a choice.
 */
export type PostureStatus = 'OK' | 'ATTENTION' | 'INFO';
export interface PostureCheck { id: string; title: string; status: PostureStatus; detail: string }

export async function securityPosture(q: Queryable, env: Record<string, string | undefined> = process.env): Promise<PostureCheck[]> {
  const out: PostureCheck[] = [];
  const add = (id: string, title: string, status: PostureStatus, detail: string) => out.push({ id, title, status, detail });
  const policy = await getSecurityPolicy(q);
  const staff = (await q.query(`SELECT id, roles, auth_source FROM users WHERE status='ACTIVE' AND NOT is_superuser`)).rows as Array<{ id: string; roles: string[]; authSource: string }>;
  const withMfa = new Set((await q.query(`SELECT DISTINCT user_id FROM mfa_methods WHERE confirmed_at IS NOT NULL`)).rows.map((r) => r.userId as string));

  const m = policy.mfa;
  add('mfa-required', 'Second factor for staff', m.requirement === 'ALL' ? 'OK' : m.requirement === 'ROLES' ? 'INFO' : 'ATTENTION',
    m.requirement === 'ALL' ? 'Required for everyone who signs in with a password.' : m.requirement === 'ROLES' ? `Required for ${m.roleIds.length} role${m.roleIds.length === 1 ? '' : 's'}; everyone else may choose.` : 'Optional: nobody has to set one up. Settings → Security policy.');
  const local = staff.filter((u) => u.authSource !== 'OIDC' && u.authSource !== 'SAML');
  const must = local.filter((u) => mfaRequiredFor(policy, u.roles));
  const lacking = must.filter((u) => !withMfa.has(u.id)).length;
  if (must.length) add('mfa-enrolled', 'Staff who must have a second factor and do not yet', lacking ? 'ATTENTION' : 'OK', lacking ? `${lacking} of ${must.length} have not set one up; they can reach only My profile until they do.` : `All ${must.length} have one.`);
  const admins = local.filter((u) => u.roles.includes('admin'));
  if (admins.length) { const n = admins.filter((u) => !withMfa.has(u.id)).length; add('admins-mfa', 'Administrators with a second factor', n ? 'ATTENTION' : 'OK', n ? `${n} of ${admins.length} administrators have none.` : `All ${admins.length} have one.`); }
  add('superuser-mfa', 'Super user second factor', env.MERIDIAN_SUPERUSER_TOTP_SECRET ? 'OK' : 'ATTENTION', env.MERIDIAN_SUPERUSER_TOTP_SECRET ? 'An authenticator code is needed after the password (MERIDIAN_SUPERUSER_TOTP_SECRET).' : 'Password only. Set MERIDIAN_SUPERUSER_TOTP_SECRET to ask for an authenticator code as well.');

  const sso = Number((await q.query(`SELECT count(*) AS n FROM integration_endpoints WHERE group_key='auth' AND kind IN ('IDP_OIDC','IDP_SAML') AND enabled`)).rows[0]!.n);
  add('sso', 'Single sign-on', 'INFO', sso ? `${sso} provider${sso === 1 ? '' : 's'} connected. The second factor for those sign-ins is the provider's (for SAML, require it with the accepted authentication context).` : 'None connected: everyone signs in with a Meridian password.');

  const keys = dataKeyStatus();
  add('data-key', 'Data encryption key', env.MERIDIAN_DATA_KEY ? 'OK' : 'ATTENTION', env.MERIDIAN_DATA_KEY ? `Key ${keys.currentId} is current.` : 'Using MERIDIAN_ID_PEPPER as the key. Set a separate MERIDIAN_DATA_KEY so each can be rotated on its own.');
  if (keys.retiredIds.length) add('old-keys', 'Retired data keys still configured', 'ATTENTION', `Key${keys.retiredIds.length === 1 ? '' : 's'} ${keys.retiredIds.join(', ')} can still be read. Once \`rekey\` reports nothing left to rewrite, remove them.`);
  add('ssrf', 'Outbound request guard', guardActive() ? 'OK' : 'ATTENTION', guardActive() ? 'Private, loopback and metadata addresses cannot be called.' : 'Off (development mode). It is always on in production.');
  const hosts = (env.MERIDIAN_PRIVATE_NETWORK_HOSTS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (hosts.length) add('private-hosts', 'Private-network hosts connectors may call', 'INFO', `${hosts.length} named in MERIDIAN_PRIVATE_NETWORK_HOSTS. Keep the list to what is needed.`);
  add('cron', 'Scheduled jobs', env.MERIDIAN_CRON_SECRET ? 'OK' : 'INFO', env.MERIDIAN_CRON_SECRET ? 'Run through the job secret, with no staff account involved.' : 'Not enabled (MERIDIAN_CRON_SECRET unset): the app only runs its background work while it serves requests.');
  add('proxy-hops', 'Proxies in front of the app', 'INFO', `${Number(env.MERIDIAN_TRUSTED_PROXY_HOPS ?? 1) || 1} trusted (MERIDIAN_TRUSTED_PROXY_HOPS). The sign-in rate limit uses the address the nearest one added.`);
  return out;
}
