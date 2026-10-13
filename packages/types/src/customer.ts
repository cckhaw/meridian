import type { Auditable, IsoDateTime, Uuid } from './common.js';

/** A code from the customer_segments table (CONSUMER, ENTERPRISE, IOT to start with; operators add more). */
export type CustomerSegment = string;

export interface Customer extends Auditable {
  id: Uuid;
  /** Hash-derived shard routing key, stable for the life of the customer. */
  shardId: number;
  segment: CustomerSegment;
  displayName: string;
  /** National ID / passport number — stored encrypted, never logged. */
  idDocumentRef: string;
  marketCode: string;
  parentCustomerId: Uuid | null;
  hierarchyPath: string;
}

export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export interface Account extends Auditable {
  id: Uuid;
  customerId: Uuid;
  shardId: number;
  billCycleDay: number | null; // 1..28, null = daily cycle
  status: AccountStatus;
  currency: string;
  payerAccountId: Uuid | null;
}

export type ServiceStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'PORTING_OUT' | 'TERMINATED';
export type ServiceType = 'MOBILE' | 'FIBER' | 'IOT' | 'SUBSCRIPTION';

export interface Service extends Auditable {
  id: Uuid;
  accountId: Uuid;
  customerId: Uuid;
  shardId: number;
  type: ServiceType;
  /** MSISDN / circuit id / IoT device id. */
  identifier: string;
  iccid: string | null;
  offerId: string;
  status: ServiceStatus;
  contractStart: IsoDateTime | null;
  contractTermMonths: number | null;
}

export interface GroupMembership {
  groupCustomerId: Uuid;
  memberCustomerId: Uuid;
  role: 'OWNER' | 'MEMBER' | 'DEPARTMENT';
}
