import { describe, expect, it } from 'vitest';
import { fiberFlow, retailDeviceFlow } from './default-definitions.js';
import { canCancel } from './pnr.js';
import { validateDefinition } from './validate.js';
import { evaluateCondition, nextNode } from './walk.js';
import type { OrderWorkflowDefinition } from '@nexus/types';

describe('validateDefinition', () => {
  it('accepts shipped templates', () => {
    expect(validateDefinition(retailDeviceFlow)).toEqual([]);
    expect(validateDefinition(fiberFlow)).toEqual([]);
  });
  it('rejects cycles, orphans and missing branches', () => {
    const bad: OrderWorkflowDefinition = {
      ...retailDeviceFlow,
      nodes: [...retailDeviceFlow.nodes, { id: 'x', type: 'CONDITION', label: 'x', position: { x: 0, y: 0 }, config: {} }, { id: 'orphan', type: 'NOTIFY', label: 'o', position: { x: 0, y: 0 }, config: {} }],
      edges: [...retailDeviceFlow.edges, { id: 'back', from: 'e', to: 's' }, { id: 'cx', from: 'x', to: 'e', branch: 'true' }],
    };
    const errs = validateDefinition(bad);
    expect(errs.some((e) => /END .* outgoing/.test(e))).toBe(true);
    expect(errs.some((e) => /CONDITION x needs/.test(e))).toBe(true);
    expect(errs.some((e) => /unreachable/.test(e))).toBe(true);
  });
});

describe('walk', () => {
  it('routes CONDITION nodes on facts', () => {
    const def: OrderWorkflowDefinition = {
      id: 'c', name: 'c', version: 1, appliesTo: { channels: [], offerKinds: [] },
      nodes: [
        { id: 'c', type: 'CONDITION', label: '', position: { x: 0, y: 0 }, config: { field: 'total', op: 'gte', value: 100000 } },
        { id: 'hi', type: 'END', label: '', position: { x: 0, y: 0 }, config: {} },
        { id: 'lo', type: 'END', label: '', position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [{ id: '1', from: 'c', to: 'hi', branch: 'true' }, { id: '2', from: 'c', to: 'lo', branch: 'false' }],
    };
    expect(nextNode(def, def.nodes[0]!, { total: 150000 })?.id).toBe('hi');
    expect(nextNode(def, def.nodes[0]!, { total: 5 })?.id).toBe('lo');
    expect(() => evaluateCondition({ field: 'x', op: '??', value: 1 }, {})).toThrow();
  });
});

describe('canCancel', () => {
  it('blocks after PNR and in terminal states', () => {
    expect(canCancel('PAID', false)).toEqual({ allowed: true });
    expect(canCancel('PAID', true)).toMatchObject({ allowed: false });
    expect(canCancel('COMPLETED', false)).toMatchObject({ allowed: false });
  });
});
