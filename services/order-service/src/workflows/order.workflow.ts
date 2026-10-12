import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { OrderState, OrderWorkflowDefinition } from '@meridian/types';
import type { OrderActivities } from '../activities/index.js';
import { canCancel } from '../graph/pnr.js';
import { nextNode, type Facts } from '../graph/walk.js';

const a = proxyActivities<OrderActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5, backoffCoefficient: 2, nonRetryableErrorTypes: ['ValidationError'] },
});

export const paymentConfirmed = defineSignal<[{ reference: string }]>('paymentConfirmed');
export const installationScheduled = defineSignal<[{ slot: string }]>('installationScheduled');
export const cancelRequested = defineSignal<[{ reason: string }]>('cancelRequested');
export const orderStatus = defineQuery<{ state: OrderState; pnrReached: boolean; currentNode: string | null; cancelRejected: string | null }>('orderStatus');

export interface OrderWorkflowInput {
  orderId: string;
  definition: OrderWorkflowDefinition;
  facts: Facts; // e.g. { total: 52000, channel: 'RETAIL_ASSISTED', hasFiber: false, paymentMethod: 'QR' }
}

/**
 * Executes a designer-authored graph. The graph is data, so changing a rule needs no deploy;
 * determinism holds because the walk depends only on the definition + facts passed at start.
 */
export async function orderWorkflow({ orderId, definition, facts }: OrderWorkflowInput): Promise<OrderState> {
  let state: OrderState = 'SUBMITTED';
  let pnrReached = false;
  let cancelReason: string | null = null;
  let cancelRejected: string | null = null;
  let currentNode: string | null = null;
  let payment: { reference: string } | null = null;
  let slot: string | null = null;
  const compensations: Array<() => Promise<void>> = [];

  setHandler(paymentConfirmed, (p) => { payment = p; });
  setHandler(installationScheduled, (s) => { slot = s.slot; });
  setHandler(cancelRequested, ({ reason }) => {
    const d = canCancel(state, pnrReached);
    if (d.allowed) cancelReason = reason; else cancelRejected = d.reason;
  });
  setHandler(orderStatus, () => ({ state, pnrReached, currentNode, cancelRejected }));

  const move = async (s: OrderState, why?: string) => { state = s; await a.setOrderState(orderId, s, why); };
  const compensate = async (to: OrderState, why: string) => {
    for (const undo of compensations.reverse()) await undo();
    await move(to, why);
    await a.publishEvent('meridian.order.events', orderId, { type: to, reason: why });
    return to;
  };

  let node = definition.nodes.find((n) => n.type === 'START') ?? null;
  while (node) {
    currentNode = node.id;
    if (cancelReason) return compensate('CANCELLED', cancelReason);

    switch (node.type) {
      case 'VALIDATE_ORDER': {
        const r = await a.validateOrder(orderId);
        if (!r.ok) return compensate('FAILED', r.reason ?? 'validation failed');
        await move('VALIDATED');
        break;
      }
      case 'CREDIT_CHECK':
        if (!(await a.creditCheck(orderId)).approved) return compensate('FAILED', 'credit check declined');
        break;
      case 'CAPTURE_PAYMENT': {
        await move('PAYMENT_PENDING');
        const r = await a.capturePayment(orderId, String(facts.paymentMethod ?? 'CREDIT_CARD'));
        if ('reference' in r) payment = r;
        else if (!(await condition(() => payment !== null || cancelReason !== null, '30 minutes'))) return compensate('FAILED', 'payment timeout');
        if (cancelReason) return compensate('CANCELLED', cancelReason);
        compensations.push(() => a.refundPayment(orderId));
        await move('PAID');
        break;
      }
      case 'RESERVE_INVENTORY':
        await a.reserveInventory(orderId);
        compensations.push(() => a.releaseInventory(orderId));
        await move('FULFILMENT');
        break;
      case 'SCHEDULE_INSTALLATION':
        await a.bookInstallation(orderId);
        await move('AWAITING_INSTALLATION');
        if (!(await condition(() => slot !== null || cancelReason !== null, '14 days'))) return compensate('FAILED', 'installation never scheduled');
        break;
      case 'WAIT_SIGNAL':
        await condition(() => cancelReason !== null, Number(node.config.timeoutSeconds ?? 60) * 1000);
        break;
      case 'POINT_OF_NO_RETURN':
        pnrReached = true; // cancel signals are rejected from here on
        break;
      case 'SHIP_GOODS':
        await a.shipGoods(orderId);
        await move('SHIPPED');
        break;
      case 'ACTIVATE_SERVICE':
        await a.activateService(orderId);
        await move('ACTIVATED');
        break;
      case 'NOTIFY':
        await a.notifyCustomer(orderId, String(node.config.template ?? 'order-update'));
        break;
      case 'END':
        await move('COMPLETED');
        await a.publishEvent('meridian.order.events', orderId, { type: 'COMPLETED' });
        return state;
      default: // START, CONDITION: no side effects, routing only
        break;
    }
    node = nextNode(definition, node, facts);
  }
  return compensate('FAILED', 'workflow ended without reaching END');
}
