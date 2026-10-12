import type { OrderWorkflowDefinition, WorkflowNode } from '@meridian/types';

export type Facts = Record<string, string | number | boolean>;

/** CONDITION node config: { field, op: eq|neq|gt|gte|lt|lte, value }. */
export function evaluateCondition(config: WorkflowNode['config'], facts: Facts): boolean {
  const left = facts[String(config.field)];
  const right = config.value;
  switch (config.op) {
    case 'eq': return left === right;
    case 'neq': return left !== right;
    case 'gt': return Number(left) > Number(right);
    case 'gte': return Number(left) >= Number(right);
    case 'lt': return Number(left) < Number(right);
    case 'lte': return Number(left) <= Number(right);
    default: throw new Error(`unknown operator ${String(config.op)}`);
  }
}

export function nextNode(def: OrderWorkflowDefinition, node: WorkflowNode, facts: Facts): WorkflowNode | null {
  const edges = def.edges.filter((e) => e.from === node.id);
  const edge = node.type === 'CONDITION'
    ? edges.find((e) => e.branch === String(evaluateCondition(node.config, facts)))
    : edges[0];
  return edge ? def.nodes.find((n) => n.id === edge.to) ?? null : null;
}
