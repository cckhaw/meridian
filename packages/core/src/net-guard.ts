import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Outbound-request guard (SSRF). Anything the server calls on an address somebody typed in (a webhook, a TM Forum listener, a connector) must not reach the deployment's own network or
 * the cloud metadata service. Checking the host name text is not enough: a name can resolve to a private address (and change its answer between the check and the connection, "DNS
 * rebinding"), an address can be written as a number, in hex, or as an IPv4 address inside an IPv6 one. So:
 *
 *  - every address is **classified from its numbers**, whatever way it was written (`classifyAddress`);
 *  - the check is made **on the address the connection is really made to**: the guard is the connection's own DNS lookup, so there is one resolution, which is both checked and used;
 *  - if **any** address a name resolves to is not allowed, the connection is refused.
 *
 * Two profiles: `client` (an address a client of the API supplied, such as a TM Forum listener callback) may reach only public addresses; `connector` (an address an administrator
 * configured, such as an SMS gateway) may in addition reach private networks that are named in MERIDIAN_PRIVATE_NETWORK_HOSTS. Loopback, link-local (the metadata service), unspecified,
 * multicast and reserved addresses are never reachable. The guard is on in production (it cannot be switched off there) and when MERIDIAN_SSRF_GUARD=on, so development and tests can
 * talk to localhost.
 */
export type AddressClass = 'public' | 'private' | 'loopback' | 'link-local' | 'reserved' | 'invalid';
export type GuardProfile = 'client' | 'connector';

const v4 = (s: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
};

function classifyV4(o: number[]): AddressClass {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  if (a === 0 || a >= 224) return 'reserved';                                                   // "this" network, multicast, reserved, broadcast
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'reserved';                          // 192.0.0.0/24 and the documentation range 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';                                   // benchmarking
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'reserved';
  return 'public';
}

/** Eight 16-bit groups of an IPv6 address, or null when it is not one. Handles `::` and an IPv4 tail. */
function groupsV6(input: string): number[] | null {
  let s = input.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) { const o = v4(tail[1]!); if (!o) return null; s = `${s.slice(0, tail.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`; }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (p: string) => (p === '' ? [] : p.split(':'));
  const head = parse(halves[0]!), rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + rest.length > 7) return null;
  const all = halves.length === 1 ? head : [...head, ...Array(8 - head.length - rest.length).fill('0'), ...rest];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

function classifyV6(g: number[]): AddressClass {
  const embedded = (hi: number, lo: number) => classifyV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 7) && g[7] === 0) return 'reserved';                                            // ::
  if (zeros(0, 7) && g[7] === 1) return 'loopback';                                            // ::1
  if (zeros(0, 5) && g[5] === 0xffff) return embedded(g[6]!, g[7]!);                            // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeros(0, 6)) return embedded(g[6]!, g[7]!) === 'public' ? 'reserved' : embedded(g[6]!, g[7]!); // ::a.b.c.d (IPv4-compatible, deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return embedded(g[6]!, g[7]!);           // 64:ff9b::a.b.c.d (NAT64)
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!);                                           // 6to4 carries an IPv4 address
  if ((g[0]! & 0xfe00) === 0xfc00) return 'private';                                            // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return 'link-local';                                         // fe80::/10
  if ((g[0]! & 0xffc0) === 0xfec0) return 'private';                                            // fec0::/10 site-local (deprecated)
  if ((g[0]! & 0xff00) === 0xff00) return 'reserved';                                           // multicast
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return 'reserved';                    // documentation, Teredo
  if (g[0] === 0x0100 && zeros(1, 4)) return 'reserved';                                        // discard-only
  return 'public';
}

/** What kind of address this is, from its numbers, however it is written (dotted, IPv6, IPv4 in IPv6). A host name is `invalid`: resolve it first. */
export function classifyAddress(address: string): AddressClass {
  const a = address.trim().replace(/^\[|\]$/g, '');
  const t = isIP(a.split('%')[0]!);
  if (t === 4) { const o = v4(a); return o ? classifyV4(o) : 'invalid'; }
  if (t === 6) { const g = groupsV6(a); return g ? classifyV6(g) : 'invalid'; }
  return 'invalid';
}

const NAME_PRIVATE = /(^|\.)(localhost|internal|local|localdomain|home\.arpa|intranet|corp|lan)$/;
export const guardActive = (): boolean => process.env.NODE_ENV === 'production' || process.env.MERIDIAN_SSRF_GUARD === 'on';
const allowedPrivate = (): Set<string> => new Set((process.env.MERIDIAN_PRIVATE_NETWORK_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

/** Why an address (or the name it came from) may not be called, or null. `host` is what was in the URL, `address` what it resolved to (the same for a literal address). */
export function addressProblem(host: string, address: string, profile: GuardProfile): string | null {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const c = classifyAddress(address);
  if (c === 'public') return null;
  if (c === 'private' && profile === 'connector' && (allowedPrivate().has(h) || allowedPrivate().has(address.toLowerCase()))) return null;
  const what = c === 'private' ? 'a private network' : c === 'loopback' ? 'this machine' : c === 'link-local' ? 'a link-local address (such as the cloud metadata service)' : c === 'invalid' ? 'an unreadable address' : 'a reserved address';
  return `${host} is ${what}; an address inside the deployment's network cannot be called.`;
}

/** The check that needs no network: a literal address is classified, a name is judged by its text. Resolution happens when the connection is made. */
export function hostProblem(url: string, profile: GuardProfile): string | null {
  let u: URL; try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return addressProblem(host, host, profile);
  if (NAME_PRIVATE.test(host.toLowerCase()) && !(profile === 'connector' && allowedPrivate().has(host.toLowerCase()))) return `${host} is an address inside the deployment's network; it cannot be called.`;
  return null;
}

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
const systemResolver: Resolver = (host) => new Promise((resolve, reject) => dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));

/** A `lookup` for a socket connection: resolves the name once, refuses if any answer is not allowed, and hands the connection those very addresses. */
export function guardedLookup(profile: GuardProfile, resolve: Resolver = systemResolver) {
  return (host: string, options: { all?: boolean } | number | undefined, cb: (...a: unknown[]) => void) => {
    const wantAll = typeof options === 'object' && !!options?.all;
    resolve(host).then((addrs) => {
      if (!addrs.length) return cb(Object.assign(new Error(`${host} did not resolve`), { code: 'ENOTFOUND' }));
      for (const a of addrs) { const p = addressProblem(host, a.address, profile); if (p) return cb(Object.assign(new Error(p), { code: 'ESSRFBLOCKED' })); }
      return wantAll ? cb(null, addrs) : cb(null, addrs[0]!.address, addrs[0]!.family);
    }, (e) => cb(e));
  };
}

const agents = new Map<GuardProfile, Agent>();
const agentFor = (profile: GuardProfile) => agents.get(profile) ?? agents.set(profile, new Agent({ connect: { lookup: guardedLookup(profile) as never } })).get(profile)!;

type Fetch = (url: string, init?: Record<string, unknown>) => Promise<Response>;
/**
 * `fetch` for an address somebody typed in. With the guard on, a literal private address is refused at once and a name is checked as the connection resolves it (redirects too:
 * every connection goes through the same lookup). With it off (development, tests) it is the ordinary `fetch`.
 */
export function guardedFetch(profile: GuardProfile): Fetch {
  return async (url, init) => {
    if (!guardActive()) return fetch(url, init as RequestInit);
    const p = hostProblem(url, profile);
    if (p) throw Object.assign(new Error(p), { code: 'ESSRFBLOCKED' });
    return undiciFetch(url, { ...(init as object), dispatcher: agentFor(profile) } as never) as unknown as Promise<Response>;
  };
}

/** For when an address is saved: resolves the name now and says why it cannot be used. A name that does not resolve yet is not an error here (it may not exist yet). */
export async function resolveProblem(url: string, profile: GuardProfile, resolve: Resolver = systemResolver): Promise<string | null> {
  const text = hostProblem(url, profile);
  if (text) return text;
  let host: string; try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return null; }
  if (isIP(host)) return null;
  let addrs: Array<{ address: string }>; try { addrs = await resolve(host); } catch { return null; }
  for (const a of addrs) { const p = addressProblem(host, a.address, profile); if (p) return `${host} resolves to ${p.replace(/^.* is /, '')}`; }
  return null;
}

/** `fetch` for the connectors an administrator configures (SMS, e-mail, identity checks, partners, directory). */
export const connectorFetch: Fetch = guardedFetch('connector');
/** `fetch` for addresses a client of the API supplies (TM Forum listener callbacks). */
export const clientFetch: Fetch = guardedFetch('client');
