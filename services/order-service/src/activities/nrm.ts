/**
 * What the number-resource workflows need from the CRM. Both calls are idempotent and safe to retry. Real implementations call the back-office API:
 *   recycleExpired   -> POST /numbering/recycle  { asOf }   (IMSIs QUARANTINED -> RECYCLED -> POOL_UNASSIGNED; numbers QUARANTINE_COOLING -> AVAILABLE)
 * and report how many of each were restored.
 */
export interface RecycleResult { imsis: number; msisdns: number; expiredHolds: number }
export interface NrmActivities {
  recycleExpired(asOf: string): Promise<RecycleResult>;
  publishEvent(topic: string, key: string, payload: unknown): Promise<void>;
}
export const stubNrmActivities: NrmActivities = {
  async recycleExpired(asOf) { console.log(`[nrm] recycle (${asOf})`); return { imsis: 0, msisdns: 0, expiredHolds: 0 }; },
  async publishEvent(topic, key) { console.log(`[kafka] ${topic} ${key}`); },
};
