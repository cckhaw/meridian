export type DunningAction = 'REMIND' | 'SOFT_BAR' | 'HARD_BAR' | 'FINAL_NOTICE' | 'TERMINATE';
export interface DunningStepInput { action: DunningAction; /** Days after the due date (D). */ day: number }

/**
 * What the dunning workflow needs from the CRM. Each call is idempotent (the CRM records every applied step once per dunning run), so Temporal
 * can retry freely. Real implementations call the back-office API:
 *   applyDunningStep      -> POST /accounts/:id/dunning  { asOf, only }   (the CRM applies one ladder step, its bars and notices, and queues the PCRF/HLR/SMS instructions)
 *   isStillOverdue        -> GET  /accounts/:id/dunning                    (is anything past due?)
 *   restoreAfterPayment   -> done by the payment itself in the CRM; here it only confirms and notifies
 */
export interface DunningActivities {
  isStillOverdue(accountId: string): Promise<boolean>;
  applyDunningStep(accountId: string, action: DunningAction, asOf: string): Promise<Record<string, unknown>>;
  confirmRestored(accountId: string): Promise<void>;
  publishEvent(topic: string, key: string, payload: unknown): Promise<void>;
}

export const stubDunningActivities: DunningActivities = {
  async isStillOverdue() { return true; },
  async applyDunningStep(accountId, action, asOf) { console.log(`[dunning ${accountId}] ${action} (${asOf})`); return { applied: action }; },
  async confirmRestored(accountId) { console.log(`[dunning ${accountId}] restored after payment`); },
  async publishEvent(topic, key) { console.log(`[kafka] ${topic} ${key}`); },
};
