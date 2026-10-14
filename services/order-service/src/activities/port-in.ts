/**
 * What the port-in workflow needs from the outside. All calls are idempotent and safe to retry. Real implementations:
 *   submitToClearinghouse -> the national clearinghouse (MNP) API: file the port-in request, return its reference
 *   recordDecision        -> POST /mnp/port-in/:id/decision { approved, reference, reason }
 *   swapMsisdnOnNetwork   -> HLR/HSS: replace the subscriber's temporary MSISDN with the ported-in one (same IMSI), or activate the ported number
 *   completePortIn        -> POST /mnp/port-in/:id/complete   (the service takes the number; the temporary one goes to rest; group, discounts and shared quota are untouched)
 *   expirePortIn          -> POST /mnp/port-in/:id/cancel
 */
export interface PortInDetails { portInId: string; serviceId: string; donorOperator: string; /** The routing code the clearinghouse uses to route the request to the donor. */ donorRoutingCode: string; donorMsisdn: string; temporaryMsisdn: string | null }
export interface PortDecision { approved: boolean; reference?: string; reason?: string; /** When the donor releases the number (ISO). Default: at once. */ effectiveAt?: string }
export interface PortInActivities {
  submitToClearinghouse(d: PortInDetails): Promise<{ reference: string }>;
  recordDecision(portInId: string, d: PortDecision): Promise<void>;
  swapMsisdnOnNetwork(d: { serviceId: string; from: string | null; to: string }): Promise<void>;
  completePortIn(portInId: string): Promise<void>;
  expirePortIn(portInId: string, reason: string): Promise<void>;
  publishEvent(topic: string, key: string, payload: unknown): Promise<void>;
}
export const stubPortInActivities: PortInActivities = {
  async submitToClearinghouse(d) { console.log(`[mnp] submit port-in ${d.donorMsisdn} from ${d.donorOperator} (route ${d.donorRoutingCode})`); return { reference: `NCH-${d.portInId.slice(0, 8)}` }; },
  async recordDecision(id, d) { console.log(`[mnp] ${id} ${d.approved ? 'approved' : 'refused'}`); },
  async swapMsisdnOnNetwork(d) { console.log(`[hlr] swap ${d.from ?? '(none)'} -> ${d.to} for ${d.serviceId}`); },
  async completePortIn(id) { console.log(`[mnp] ${id} complete`); },
  async expirePortIn(id, reason) { console.log(`[mnp] ${id} expired: ${reason}`); },
  async publishEvent(topic, key) { console.log(`[kafka] ${topic} ${key}`); },
};
