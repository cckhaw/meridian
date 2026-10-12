import type { OrderWorkflowDefinition, WorkflowNode, WorkflowNodeType } from '@nexus/types';

let y = 0;
const n = (id: string, type: WorkflowNodeType, label: string, config: WorkflowNode['config'] = {}): WorkflowNode =>
  ({ id, type, label, position: { x: 240, y: (y += 110) }, config });

/** Retail device sale: pay, reserve stock, hand over (PNR at ship), activate. */
export const retailDeviceFlow: OrderWorkflowDefinition = {
  id: 'retail-device', name: 'Retail device sale', version: 1,
  appliesTo: { channels: ['RETAIL_ASSISTED', 'QUICK_SALE'], offerKinds: ['SIM_DEVICE', 'WEARABLE', 'PHYSICAL_GOOD'] },
  nodes: [
    n('s', 'START', 'Start'), n('v', 'VALIDATE_ORDER', 'Validate'), n('c', 'CREDIT_CHECK', 'Credit check', {}),
    n('p', 'CAPTURE_PAYMENT', 'Capture payment'), n('i', 'RESERVE_INVENTORY', 'Reserve stock'),
    n('pnr', 'POINT_OF_NO_RETURN', 'Point of no return'), n('a', 'ACTIVATE_SERVICE', 'Activate'), n('e', 'END', 'Done'),
  ],
  edges: [['s', 'v'], ['v', 'c'], ['c', 'p'], ['p', 'i'], ['i', 'pnr'], ['pnr', 'a'], ['a', 'e']].map(([from, to], k) => ({ id: `e${k}`, from: from!, to: to! })),
};

/** Fiber self-serve: needs installation booking; PNR when technician is dispatched. */
export const fiberFlow: OrderWorkflowDefinition = {
  id: 'fiber-install', name: 'Fiber with installation', version: 1,
  appliesTo: { channels: ['SELF_SERVE', 'TELESALES', 'CALL_CENTER'], offerKinds: ['FIBER'] },
  nodes: [
    n('s', 'START', 'Start'), n('v', 'VALIDATE_ORDER', 'Validate'), n('p', 'CAPTURE_PAYMENT', 'Capture payment'),
    n('inst', 'SCHEDULE_INSTALLATION', 'Schedule installation'), n('pnr', 'POINT_OF_NO_RETURN', 'Technician dispatched'),
    n('a', 'ACTIVATE_SERVICE', 'Activate'), n('e', 'END', 'Done'),
  ],
  edges: [['s', 'v'], ['v', 'p'], ['p', 'inst'], ['inst', 'pnr'], ['pnr', 'a'], ['a', 'e']].map(([from, to], k) => ({ id: `e${k}`, from: from!, to: to! })),
};
