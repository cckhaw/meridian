import { condition, defineQuery, defineSignal, proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import type { PortDecision, PortInActivities, PortInDetails } from '../activities/port-in.js';

const a = proxyActivities<PortInActivities>({ startToCloseTimeout: '2 minutes', retry: { maximumAttempts: 8, backoffCoefficient: 2, initialInterval: '5 seconds' } });

/** The national clearinghouse's callback: the donor approved or refused (workflow id `port-in-<portInId>`). */
export const portDecisionSignal = defineSignal<[PortDecision]>('portDecision');
export type PortInState = 'SUBMITTED' | 'APPROVED' | 'COMPLETED' | 'REJECTED' | 'EXPIRED' | 'NEEDS_ATTENTION';
export const portInStatus = defineQuery<{ state: PortInState; reference: string | null }>('portInStatus');

export interface PortInWorkflowInput extends PortInDetails {
  /** How long the donor operator has to answer. */
  expiryDays?: number;
}

/**
 * A number brought in from another operator, for a single line or a family line alike. The line already works on a temporary number from our pool (or waits,
 * if none was given). This workflow files the request, waits durably for the donor's answer, and on approval switches the number over: the network swaps the
 * temporary MSISDN for the ported one (same IMSI and SIM), then the CRM gives the service its new number. The service id never changes, so the plan, the group
 * and its shared quota, discounts and billing carry on untouched. No answer in time: the request expires and the line keeps what it has.
 */
export async function portInWorkflow(input: PortInWorkflowInput): Promise<PortInState> {
  let state: PortInState = 'SUBMITTED';
  let reference: string | null = null;
  let decision: PortDecision | undefined;
  setHandler(portDecisionSignal, (d) => { decision ??= d; }); // the first answer wins; a repeated callback changes nothing
  setHandler(portInStatus, () => ({ state, reference }));

  reference = (await a.submitToClearinghouse(input)).reference;
  const answered = await condition(() => decision !== undefined, (input.expiryDays ?? 14) * 86_400_000);
  if (!answered || !decision) {
    await a.expirePortIn(input.portInId, `no answer from ${input.donorOperator} in ${input.expiryDays ?? 14} days`);
    await a.publishEvent('meridian.mnp.events', input.portInId, { type: 'PORT_IN_EXPIRED', donorMsisdn: input.donorMsisdn });
    return (state = 'EXPIRED');
  }
  await a.recordDecision(input.portInId, { ...decision, reference: decision.reference ?? reference });
  if (!decision.approved) {
    await a.publishEvent('meridian.mnp.events', input.portInId, { type: 'PORT_IN_REJECTED', donorMsisdn: input.donorMsisdn, reason: decision.reason ?? null });
    return (state = 'REJECTED');
  }
  state = 'APPROVED';
  if (decision.effectiveAt) { const wait = new Date(decision.effectiveAt).getTime() - Date.now(); if (wait > 0) await sleep(wait); } // the donor releases the number on an agreed date
  try {
    await a.swapMsisdnOnNetwork({ serviceId: input.serviceId, from: input.temporaryMsisdn, to: input.donorMsisdn });
    await a.completePortIn(input.portInId);
  } catch (e) {
    // The retries are spent: someone has to look. Nothing is half-done on the CRM side, because it is only changed by the last step.
    await a.publishEvent('meridian.mnp.events', input.portInId, { type: 'PORT_IN_NEEDS_ATTENTION', donorMsisdn: input.donorMsisdn, error: String((e as Error).message ?? e) });
    return (state = 'NEEDS_ATTENTION');
  }
  await a.publishEvent('meridian.mnp.events', input.portInId, { type: 'PORT_IN_COMPLETED', serviceId: input.serviceId, from: input.temporaryMsisdn, to: input.donorMsisdn });
  return (state = 'COMPLETED');
}
