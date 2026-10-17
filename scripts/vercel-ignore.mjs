#!/usr/bin/env node
/**
 * Vercel "Ignored Build Step" for the apps in this repository. Usage (from an app's vercel.json): node ../../scripts/vercel-ignore.mjs <app folder name>
 *
 * Vercel runs this before it builds. Exit 0 = nothing this app is made of has changed, skip the build; exit 1 = build. The Hobby plan allows only a limited
 * number of deployments a day, so a push that touches one app (or only docs) must not rebuild the other two.
 *
 * An app is made of its own folder, the workspace packages it depends on (directly or through another package) and the files that decide the install
 * (lockfile, workspace and turbo settings). If anything is unclear (no previous commit to compare with, git fails) it builds: a missed deploy is worse than a spare one.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const app = process.argv[2];
const root = resolve(new URL('..', import.meta.url).pathname);
if (!app || !existsSync(join(root, 'apps', app))) { console.log(`[ignore-build] unknown app "${app}": building`); process.exit(1); }

const read = (p) => JSON.parse(readFileSync(join(root, p, 'package.json'), 'utf8'));
const folders = [...['apps', 'packages', 'services'].flatMap((d) => (existsSync(join(root, d)) ? readdirSync(join(root, d)).map((n) => `${d}/${n}`) : []))].filter((p) => existsSync(join(root, p, 'package.json')));
const byName = new Map(folders.map((p) => [read(p).name, p]));
const needed = new Set([`apps/${app}`]);
const visit = (p) => {
  const pkg = read(p);
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) { const f = byName.get(dep); if (f && !needed.has(f)) { needed.add(f); visit(f); } }
};
visit(`apps/${app}`);
const paths = [...needed, 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json', 'tsconfig.base.json'].filter((p) => existsSync(join(root, p)));

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
try {
  const prev = process.env.VERCEL_GIT_PREVIOUS_SHA;
  let base = '';
  if (prev) { try { git('cat-file', '-e', `${prev}^{commit}`); base = prev; } catch { base = ''; } }
  if (!base) base = git('rev-parse', 'HEAD^');
  // The app's own vercel.json is left out: editing the ignore rule itself should not cost a deployment.
  const changed = git('diff', '--name-only', base, 'HEAD', '--', ...paths, `:(exclude)apps/${app}/vercel.json`);
  if (!changed) { console.log(`[ignore-build] ${app}: nothing it depends on changed since ${base.slice(0, 7)}: skipping the build`); process.exit(0); }
  console.log(`[ignore-build] ${app}: changed:\n${changed.split('\n').slice(0, 10).join('\n')}\nbuilding`);
  process.exit(1);
} catch (e) {
  console.log(`[ignore-build] ${app}: could not compare (${String(e.message).split('\n')[0]}): building`);
  process.exit(1);
}
