#!/usr/bin/env node
/**
 * Deletes the old deployments of the Vercel project once the latest production one is live, keeping a few earlier production deployments to roll back to.
 *
 * Usage: node scripts/vercel-prune.mjs <deployment id or url> [--dry-run]
 * Environment: VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID (or VERCEL_ORG_ID); KEEP_PRODUCTION_DEPLOYMENTS (default 3: the latest and the two production deployments before it; 1 keeps only the latest)
 *
 * Safety: nothing is deleted unless the deployment to keep is READY, is a production deployment and has been given its production alias (it is live). Deployments that are
 * still building or queued are never touched, and neither is anything created after the one being kept (a newer deploy that is on its way is the new "latest").
 */
const API = process.env.VERCEL_API_URL || 'https://api.vercel.com';
const IN_FLIGHT = new Set(['QUEUED', 'INITIALIZING', 'BUILDING']);

/** The deployment to keep, as the API wants it: an id, or a host name without the scheme (`vercel deploy` prints a full URL). */
export const deploymentRef = (ref) => String(ref).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

/**
 * Which deployments to delete. Pure, so it is tested without the network. The `keepProduction - 1` newest READY production deployments older than the live one stay as rollback
 * targets; everything else older goes (previews, failed and cancelled builds, older production deployments).
 */
export function pickDeletions(all, keep, { keepProduction = 1 } = {}) {
  const older = all.filter((d) => d.uid !== keep.id && Number(d.created ?? d.createdAt) < Number(keep.createdAt) && !IN_FLIGHT.has(d.state ?? d.readyState));
  const rollback = new Set(older.filter((d) => d.target === 'production' && (d.state ?? d.readyState) === 'READY').sort((a, b) => Number(b.created ?? b.createdAt) - Number(a.created ?? a.createdAt)).slice(0, Math.max(0, keepProduction - 1)).map((d) => d.uid));
  return older.filter((d) => !rollback.has(d.uid));
}

/** How many production deployments to keep, the live one included: a whole number from 1. */
export function keepCount(value) {
  const n = Number(value ?? 3);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('KEEP_PRODUCTION_DEPLOYMENTS is a whole number from 1 to 50.');
  return n;
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
  const keep = await waitUntilLive(deploymentRef(ref));
  console.log(`Live: ${keep.id} (${keep.url}), created ${new Date(keep.createdAt ?? keep.created).toISOString()}`);
  const keepProduction = keepCount(process.env.KEEP_PRODUCTION_DEPLOYMENTS || undefined);
  const doomed = pickDeletions(await listAll(process.env.VERCEL_PROJECT_ID), { id: keep.id, createdAt: keep.createdAt ?? keep.created }, { keepProduction });
  console.log(`Keeping the live deployment and up to ${keepProduction - 1} earlier production deployment${keepProduction === 2 ? '' : 's'} to roll back to.`);
  console.log(`${doomed.length} older deployment${doomed.length === 1 ? '' : 's'} to delete${dry ? ' (dry run: nothing is deleted)' : ''}.`);
  let gone = 0;
  for (const d of doomed) {
    if (dry) { console.log(`  would delete ${d.uid} ${d.url} (${d.target ?? 'preview'}, ${d.state ?? d.readyState})`); continue; }
    await call(`/v13/deployments/${d.uid}`, { method: 'DELETE' });
    gone++;
    console.log(`  deleted ${d.uid} ${d.url}`);
  }
  console.log(dry ? 'Dry run finished.' : `Deleted ${gone}; kept ${keep.id} (live) and the rollback targets.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`::error::${e.message}`); process.exit(1); });
