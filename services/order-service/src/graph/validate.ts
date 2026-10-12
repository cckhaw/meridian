import type { OrderWorkflowDefinition, WorkflowNode } from '@meridian/types';

/** Structural validation for definitions produced by the visual designer. */
export function validateDefinition(def: OrderWorkflowDefinition): string[] {
  const errs: string[] = [];
  const byId = new Map<string, WorkflowNode>();
  for (const n of def.nodes) {
    if (byId.has(n.id)) errs.push(`duplicate node id ${n.id}`);
    byId.set(n.id, n);
  }
  const starts = def.nodes.filter((n) => n.type === 'START');
  if (starts.length !== 1) errs.push(`exactly one START node required, found ${starts.length}`);
  if (!def.nodes.some((n) => n.type === 'END')) errs.push('at least one END node required');

  const out = new Map<string, typeof def.edges>();
  for (const e of def.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) { errs.push(`edge ${e.id} references a missing node`); continue; }
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
  }
  for (const n of def.nodes) {
    const edges = out.get(n.id) ?? [];
    if (n.type === 'END') { if (edges.length) errs.push(`END ${n.id} must not have outgoing edges`); continue; }
    if (n.type === 'CONDITION') {
      const branches = edges.map((e) => e.branch).sort().join(',');
      if (branches !== 'false,true') errs.push(`CONDITION ${n.id} needs exactly one true and one false edge`);
    } else if (edges.length !== 1) errs.push(`${n.type} ${n.id} needs exactly one outgoing edge, has ${edges.length}`);
  }

  // Cycle detection (the interpreter is a DAG walker; loops belong in activities/timers).
  const state = new Map<string, 1 | 2>();
  const dfs = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const e of out.get(id) ?? []) if (dfs(e.to)) return true;
    state.set(id, 2);
    return false;
  };
  if (starts[0] && dfs(starts[0].id)) errs.push('workflow contains a cycle');

  const reach = new Set<string>();
  const walk = (id: string) => { if (reach.has(id)) return; reach.add(id); (out.get(id) ?? []).forEach((e) => walk(e.to)); };
  if (starts[0]) walk(starts[0].id);
  for (const n of def.nodes) if (!reach.has(n.id)) errs.push(`node ${n.id} is unreachable`);
  return errs;
}
