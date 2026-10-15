/**
 * The contract between Meridian and a charging system (OCS). Meridian says WHAT has to happen to a subscriber in vendor-neutral terms; a connector decides HOW
 * that is done in one vendor's system (one call or five, REST, SOAP, a queue). Nothing outside `ocs-vendors/` knows a vendor exists, so adding or replacing
 * a vendor never touches orders, lifecycle or billing.
 */
export const OCS_COMMANDS = ['PROVISION', 'CHANGE_PLAN', 'SET_BARRING', 'CHANGE_IDENTITY', 'TERMINATE'] as const;
export type OcsCommandName = (typeof OCS_COMMANDS)[number];
export const OCS_COMMAND_LABEL: Record<OcsCommandName, string> = {
  PROVISION: 'Create the subscriber and subscribe the plan',
  CHANGE_PLAN: 'Move the subscriber to another plan',
  SET_BARRING: 'Bar, throttle or restore the subscriber',
  CHANGE_IDENTITY: 'New SIM or new number',
  TERMINATE: 'Close the subscriber',
};

export type PlanParams = Record<string, string | number | boolean>;
export interface OcsPlan { offerId: string; offerName: string; planCode: string; params: PlanParams }
export interface OcsSubscriber {
  serviceId: string;
  /** The number (MSISDN) for a mobile service; the circuit, device or subscription id for the others. */
  identifier: string;
  serviceType: string;
  serviceKind: string | null;
  iccid: string | null;
  imsi: string | null;
  customerId: string;
  accountId: string;
  segment: string | null;
  marketCode: string | null;
  /** The account's credit limit in minor units, when one is set (postpaid control in the OCS). */
  creditLimitMinor: number | null;
}

/** One thing to do to one subscriber. Everything a connector may need is in here; it never has to ask Meridian anything. */
export interface OcsRequest {
  command: OcsCommandName;
  /** Stable per job: the same job always carries the same key, so a vendor that supports idempotency can drop a repeat. */
  idempotencyKey: string;
  at: string;
  subscriber: OcsSubscriber;
  /** The plan the subscriber is on (the new one for CHANGE_PLAN). */
  plan: OcsPlan | null;
  /** PROVISION: when the service ends by itself, if it does. */
  expiresAt?: string | null;
  /** CHANGE_PLAN */
  previousPlan?: OcsPlan | null;
  /** SET_BARRING. Emergency calls are always allowed. */
  barring?: { level: 'NONE' | 'THROTTLE' | 'SOFT' | 'HARD'; reason: string | null };
  /** CHANGE_IDENTITY: what changed. */
  identity?: { from: { identifier: string | null; iccid: string | null }; to: { identifier: string | null; iccid: string | null } };
  /** TERMINATE */
  termination?: { reason: string; ported: boolean };
}

export type OcsResult =
  | { ok: true; reference?: string; detail?: string; /** The vendor has no such operation; recorded, not an error. */ skipped?: boolean }
  | { ok: false; detail: string; /** Worth trying again later (outage, timeout, rate limit). A refusal is not. */ retryable: boolean };

export interface OcsConnector {
  vendor: string;
  /** What is missing before this connector can work (a secret not set, say), or null. */
  problem(): string | null;
  handle(req: OcsRequest): Promise<OcsResult>;
  /** Optional check of the connection for the Test button. */
  test?(): Promise<{ ok: boolean; detail: string }>;
}

/** A setting a vendor needs. The portal draws the form from these, so a vendor needs no screen of its own. */
export interface OcsField {
  key: string;
  label: string;
  kind: 'text' | 'url' | 'number' | 'select' | 'env' | 'commands';
  hint?: string;
  placeholder?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
}

export interface OcsVendor {
  id: string;
  label: string;
  summary: string;
  notes?: string[];
  /** Whether it talks to a real system. */
  real: boolean;
  fields: OcsField[];
  defaults(): Record<string, unknown>;
  /** Checks and cleans what the operator entered; throws a plain-words error. */
  validate(raw: unknown): Record<string, unknown>;
  create(config: Record<string, unknown>, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): OcsConnector;
}
