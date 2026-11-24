#!/usr/bin/env node
/**
 * Deletes every deployment of the Vercel project except the latest production one, once that one is live.
 *
 * Usage: node scripts/vercel-prune.mjs <deployment id or url> [--dry-run]
 * Environment: VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID (or VERCEL_ORG_ID)
 *
 * Safety: nothing is deleted unless the deployment to keep is READY, is a production deployment and has been given its production alias (it is live). Deployments that are
 * still building or queued are never touched, and neither is anything created after the one being kept (a newer deploy that is on its way is the new "latest").
 */
const API = process.env.VERCEL_API_URL || 'https://api.vercel.com';
const IN_FLIGHT = new Set(['QUEUED', 'INITIALIZING', 'BUILDING']);

/** Which deployments to delete. Pure, so it is tested without the network. */
export function pickDeletions(all, keep) {
  return all.filter((d) => d.uid !== keep.id && Number(d.created ?? d.createdAt) < Number(keep.createdAt) && !IN_FLIGHT.has(d.state ?? d.readyState));
}

async function call(path, { method = 'GET', env = process.env, tries = 5 } = {}) {
  const team = env.VERCEL_TEAM_ID || env.VERCEL_ORG_ID;
  const url = new URL(path, API);
  if (team) url.searchParams.set('teamId', team);
  for (let i = 1; ; i++) {
    const res = await fetch(url, { method, headers: { authorization: `Bearer ${env.VERCEL_TOKEN}` } });
    if (res.status === 429 && i < tries) { await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 2 * i) * 1000)); continue; }
    if (res.status === 404 && method === 'DELETE') return null;   // already gone
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  }
}

async function waitUntilLive(ref, { timeoutMs = 5 * 60_000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const d = await call(`/v13/deployments/${encodeURIComponent(ref)}`);
    const state = d.readyState ?? d.status;
    if (state === 'ERROR' || state === 'CANCELED') throw new Error(`The deployment ${d.id} is ${state}; nothing was deleted.`);
    if (state === 'READY' && d.target === 'production' && (d.aliasAssigned || (d.alias ?? []).length)) return d;
    if (Date.now() > until) throw new Error(`The deployment ${d.id} is ${state} (target ${d.target}, aliasAssigned ${d.aliasAssigned}) and not live after ${Math.round(timeoutMs / 60000)} minutes; nothing was deleted.`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function listAll(projectId) {
  const out = [];
  let until;
  for (let page = 0; page < 100; page++) {
    const r = await call(`/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=100${until ? `&until=${until}` : ''}`);
    out.push(...(r.deployments ?? []));
    until = r.pagination?.next;
    if (!until) break;
  }
  return out;
}

async function main() {
  const [ref, ...flags] = process.argv.slice(2);
  const dry = flags.includes('--dry-run');
  for (const k of ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID']) if (!process.env[k]) throw new Error(`${k} is not set.`);
  if (!ref) throw new Error('Say which deployment to keep (its id or URL).');
  const keep = await waitUntilLive(ref);
  console.log(`Live: ${keep.id} (${keep.url}), created ${new Date(keep.createdAt ?? keep.created).toISOString()}`);
  const doomed = pickDeletions(await listAll(process.env.VERCEL_PROJECT_ID), { id: keep.id, createdAt: keep.createdAt ?? keep.created });
  console.log(`${doomed.length} older deployment${doomed.length === 1 ? '' : 's'} to delete${dry ? ' (dry run: nothing is deleted)' : ''}.`);
  let gone = 0;
  for (const d of doomed) {
    if (dry) { console.log(`  would delete ${d.uid} ${d.url} (${d.target ?? 'preview'}, ${d.state ?? d.readyState})`); continue; }
    await call(`/v13/deployments/${d.uid}`, { method: 'DELETE' });
    gone++;
    console.log(`  deleted ${d.uid} ${d.url}`);
  }
  console.log(dry ? 'Dry run finished.' : `Deleted ${gone}; kept ${keep.id}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`::error::${e.message}`); process.exit(1); });
