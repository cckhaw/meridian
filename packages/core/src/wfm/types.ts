/**
 * The contract between Meridian and a workforce-management (field-service) system: Salesforce Field Service, TOA / Oracle Field Service Cloud, a partner's own
 * dispatch tool. Meridian says WHAT it needs in vendor-neutral terms (which times can a technician with these skills come, hold this slot, create this
 * job, cancel it); a connector decides HOW that is done in one vendor's system. Nothing outside `wfm/` knows a vendor exists.
 */
export interface WfmAddress { line1?: string; line2?: string; postcode?: string; city?: string; state?: string; country?: string }

export interface WfmSlotQuery {
  postalNode: string | null;
  address: WfmAddress;
  /** What the technician must hold, e.g. FIBER_SPLICING. */
  skills: string[];
  /** What the visit needs reserved, e.g. ONT_UNIT. */
  equipment: string[];
  from: string; to: string;
  durationMinutes: number;
  /** How many of our own visits are already booked in each slot (by the slot's start time, as an ISO string), for a connector that has no capacity of its own. */
  booked: Record<string, number>;
}
export interface WfmSlot { id: string; start: string; end: string; capacityLeft: number | null }

export interface WfmBooking {
  caseId: string; caseNumber: string;
  /** Stable for one booking: a repeat of the same request carries the same key, so a vendor that supports idempotency can drop it. */
  idempotencyKey: string;
  slot: { id: string; start: string; end: string };
  skills: string[]; equipment: string[];
  address: WfmAddress;
  customer: { name: string; phone: string | null };
  problem: string;
  notes: string;
  priority: 'NORMAL' | 'HIGH' | 'URGENT';
}

export interface WfmTechnician { ref?: string; name?: string; phone?: string }
export type WfmResult<T extends object = object> = ({ ok: true } & T) | { ok: false; detail: string; /** Worth trying again later (outage, timeout, rate limit). A refusal is not. */ retryable: boolean };

export interface WfmConnector {
  vendor: string;
  /** What is missing before this connector can work, or null. */
  problem(): string | null;
  availability(q: WfmSlotQuery): Promise<WfmResult<{ slots: WfmSlot[] }>>;
  /** Holds a slot, and the skills and equipment the visit needs, for a short time while the agent is on the call. */
  reserve(b: WfmBooking): Promise<WfmResult<{ reservationRef: string; expiresAt: string }>>;
  /** Turns a held slot into a job (work order). `REQUESTED` means the WFM accepted the request and will say when a technician is assigned (by callback). */
  confirm(b: WfmBooking & { reservationRef: string }): Promise<WfmResult<{ jobRef: string; status: 'SCHEDULED' | 'REQUESTED'; technician?: WfmTechnician }>>;
  /** Releases a hold or cancels a job. */
  cancel(r: { jobRef?: string | null; reservationRef?: string | null; reason: string }): Promise<WfmResult>;
  test?(): Promise<{ ok: boolean; detail: string }>;
}

export interface WfmField { key: string; label: string; kind: 'text' | 'url' | 'number' | 'select' | 'env'; hint?: string; placeholder?: string; required?: boolean; options?: Array<{ value: string; label: string }>; min?: number; max?: number }
export interface WfmVendor {
  id: string; label: string; summary: string; notes?: string[]; real: boolean; fields: WfmField[];
  defaults(): Record<string, unknown>;
  validate(raw: unknown): Record<string, unknown>;
  create(config: Record<string, unknown>, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): WfmConnector;
}
