import type { OrderState } from '@meridian/types';

/**
 * Point of No Return: after the PNR node the order can no longer be cancelled by the customer,
 * because goods have shipped, a technician has been dispatched or the number is being ported.
 */
export type CancelDecision = { allowed: true } | { allowed: false; reason: string };

export function canCancel(state: OrderState, pnrReached: boolean): CancelDecision {
  if (state === 'COMPLETED' || state === 'CANCELLED' || state === 'FAILED') return { allowed: false, reason: `order already ${state}` };
  if (pnrReached) return { allowed: false, reason: 'point of no return passed; raise a return/termination instead' };
  return { allowed: true };
}
