import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { addressProblem, classifyAddress, guardedFetch, guardedLookup, hostProblem, resolveProblem } from './net-guard.js';

const looksLike = (cls: string, list: string[]) => it(`${cls}: ${list.join('  ')}`, () => { for (const a of list) expect(classifyAddress(a), a).toBe(cls); });

describe('classifying an address from its numbers', () => {
  looksLike('public', ['8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888']);
  looksLike('private', ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.1', '100.64.0.1', '100.127.255.254', 'fc00::1', 'fd12:3456::1', 'fec0::1']);
  looksLike('loopback', ['127.0.0.1', '127.255.255.255', '::1', '0:0:0:0:0:0:0:1', '[::1]']);
  looksLike('link-local', ['169.254.169.254', '169.254.0.1', 'fe80::1', 'fe80::a9fe:a9fe', 'febf::1']);
  looksLike('reserved', ['0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '::', 'ff02::1', '2001:db8::1']);

  it('sees through the ways an address can be dressed up: IPv4 inside IPv6, NAT64, 6to4, an IPv4 tail, zone ids, upper case', () => {
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyAddress('::ffff:7f00:1')).toBe('loopback');                    // the same address in hex, which is how a URL parser writes it
    expect(classifyAddress('::ffff:10.1.2.3')).toBe('private');
    expect(classifyAddress('::ffff:169.254.169.254')).toBe('link-local');
    expect(classifyAddress('::ffff:8.8.8.8')).toBe('public');
    expect(classifyAddress('0:0:0:0:0:ffff:192.168.0.1')).toBe('private');
    expect(classifyAddress('64:ff9b::a00:1')).toBe('private');                    // NAT64 of 10.0.0.1
    expect(classifyAddress('64:ff9b::8.8.8.8')).toBe('public');
    expect(classifyAddress('2002:7f00:1::')).toBe('loopback');                    // 6to4 of 127.0.0.1
    expect(classifyAddress('FE80::1%eth0')).toBe('link-local');
    expect(classifyAddress('FD00:EC2::254')).toBe('private');                     // the IPv6 metadata address
    expect(classifyAddress('::7f00:1')).toBe('loopback');                         // deprecated IPv4-compatible form
  });

  it('is not fooled by numeric spellings of an IPv4 address: the URL parser writes them as dotted numbers', () => {
    for (const spelling of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/']) {
      expect(hostProblem(spelling, 'client'), spelling).toMatch(/this machine/);
    }
    expect(hostProblem('http://0xa9fea9fe/', 'client')).toMatch(/link-local/);   // 169.254.169.254
    expect(hostProblem('http://[fd00:ec2::254]/', 'client')).toMatch(/private/);
  });

  it('says invalid for anything that is not an address', () => { for (const a of ['', 'example.com', '1.2.3', '1.2.3.256', ':::', '12345::1']) expect(classifyAddress(a), a).toBe('invalid'); });
});

describe('what each profile may call', () => {
  afterEach(() => { delete process.env.MERIDIAN_PRIVATE_NETWORK_HOSTS; });

  it('lets only public addresses through for a client-supplied address, and refuses internal names by their text', () => {
    expect(addressProblem('example.com', '93.184.216.34', 'client')).toBeNull();
    expect(addressProblem('db.example.com', '10.0.0.5', 'client')).toMatch(/private network/);
    for (const name of ['localhost', 'app.localhost', 'metadata.google.internal', 'printer.local', 'host.home.arpa']) expect(hostProblem(`https://${name}/x`, 'client'), name).toBeTruthy();
    expect(hostProblem('https://example.com/x', 'client')).toBeNull();
  });

  it('lets an administrator-configured connector reach a private network only if that host is named in MERIDIAN_PRIVATE_NETWORK_HOSTS; loopback and the metadata address never', () => {
    expect(addressProblem('ocs.corp.example', '10.1.2.3', 'connector')).toMatch(/private network/);
    process.env.MERIDIAN_PRIVATE_NETWORK_HOSTS = 'ocs.corp.example, 10.9.9.9';
    expect(addressProblem('ocs.corp.example', '10.1.2.3', 'connector')).toBeNull();
    expect(addressProblem('10.9.9.9', '10.9.9.9', 'connector')).toBeNull();
    expect(addressProblem('ocs.corp.example', '10.1.2.3', 'client')).toMatch(/private network/);          // the list is for connectors only
    expect(addressProblem('ocs.corp.example', '127.0.0.1', 'connector')).toMatch(/this machine/);
    expect(addressProblem('ocs.corp.example', '169.254.169.254', 'connector')).toMatch(/metadata/);
    expect(addressProblem('other.example', '10.1.2.3', 'connector')).toMatch(/private network/);
  });
});

describe('the connection is checked as it is made', () => {
  const asked = (resolver: Parameters<typeof guardedLookup>[1], host = 'x.example.com', all = true) =>
    new Promise<{ err: Error | null; out: unknown[] }>((done) => guardedLookup('client', resolver)(host, { all }, (err: unknown, ...out: unknown[]) => done({ err: (err as Error) ?? null, out })));

  it('hands the connection the very addresses it checked', async () => {
    const r = await asked(async () => [{ address: '93.184.216.34', family: 4 }]);
    expect(r.err).toBeNull();
    expect(r.out[0]).toEqual([{ address: '93.184.216.34', family: 4 }]);
    const single = await asked(async () => [{ address: '93.184.216.34', family: 4 }], 'x.example.com', false);
    expect(single.out).toEqual(['93.184.216.34', 4]);
  });

  it('refuses when any answer is private, so a name that also points inside cannot be used', async () => {
    const r = await asked(async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]);
    expect((r.err as Error & { code: string }).code).toBe('ESSRFBLOCKED');
    expect(r.err!.message).toMatch(/private network/);
    expect((await asked(async () => [{ address: '::ffff:127.0.0.1', family: 6 }])).err!.message).toMatch(/this machine/);
  });

  it('reports a name that does not resolve, and a resolver that fails', async () => {
    expect((await asked(async () => [])).err!.message).toMatch(/did not resolve/);
    expect((await asked(async () => { throw new Error('SERVFAIL'); })).err!.message).toBe('SERVFAIL');
  });

  it('checks an address when it is saved: resolves the name and says what it points to', async () => {
    expect(await resolveProblem('https://x.example.com/hook', 'client', async () => [{ address: '10.0.0.7', family: 4 }])).toMatch(/x\.example\.com resolves to a private network/);
    expect(await resolveProblem('https://x.example.com/hook', 'client', async () => [{ address: '93.184.216.34', family: 4 }])).toBeNull();
    expect(await resolveProblem('https://x.example.com/hook', 'client', async () => { throw new Error('ENOTFOUND'); })).toBeNull();   // may not exist yet
    expect(await resolveProblem('https://127.0.0.1/hook', 'client')).toMatch(/this machine/);
  });
});

describe('guardedFetch', () => {
  const prev = process.env.MERIDIAN_SSRF_GUARD;
  afterEach(() => { if (prev === undefined) delete process.env.MERIDIAN_SSRF_GUARD; else process.env.MERIDIAN_SSRF_GUARD = prev; });

  it('is the ordinary fetch while the guard is off (development, tests): a local server can be called', async () => {
    delete process.env.MERIDIAN_SSRF_GUARD;
    const srv = createServer((_q, res) => res.end('hello')).listen(0);
    try {
      const res = await guardedFetch('client')(`http://127.0.0.1:${(srv.address() as { port: number }).port}/`);
      expect(await res.text()).toBe('hello');
    } finally { srv.close(); }
  });

  it('with the guard on, refuses a local server however its address is written, without connecting', async () => {
    process.env.MERIDIAN_SSRF_GUARD = 'on';
    let hits = 0;
    const srv = createServer((_q, res) => { hits++; res.end('secret'); }).listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      for (const host of ['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '2130706433', 'localhost']) {
        await expect(guardedFetch('client')(`http://${host}:${port}/`), host).rejects.toThrow(/this machine|inside the deployment/);
      }
      await expect(guardedFetch('connector')(`http://127.0.0.1:${port}/`)).rejects.toThrow(/this machine/);
      expect(hits).toBe(0);
    } finally { srv.close(); }
  });
});

describe('in production, the places an address is saved refuse an address inside the network', () => {
  it('refuses a TM Forum listener callback by its numbers however it is written, and a webhook or connector aimed at this machine or the metadata service', async () => {
    const { freshDb } = await import('./test-helpers.js');
    const { registerTmfListener, saveHubEndpoint, saveHubWebhook } = await import('./integration-hub.js');
    const db = await freshDb();
    const was = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = 'production';
      for (const cb of ['https://127.0.0.1/x', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://2130706433/x', 'https://0x7f000001/x', 'https://169.254.169.254/latest', 'https://[fd00:ec2::254]/x', 'https://100.64.0.9/x', 'https://10.0.0.1/x', 'https://metadata.google.internal/x']) {
        await expect(registerTmfListener(db, 'client-a', { callback: cb }), cb).rejects.toThrow(/private network|cannot be called|inside the deployment/);
      }
      await expect(saveHubWebhook(db, 'admin', { kind: 'OUTBOUND', name: 'bad', targetUrl: 'https://169.254.169.254/x', events: [] } as never)).rejects.toThrow(/link-local|metadata/);
      await expect(saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'OTP_GATEWAY', name: 'bad', url: 'https://127.0.0.1/send' } as never)).rejects.toThrow(/this machine/);
    } finally { (process.env as Record<string, string | undefined>).NODE_ENV = was; await db.close(); }
  }, 60_000);
});
