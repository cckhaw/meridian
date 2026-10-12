import type { Auditable, Money, Uuid, IsoDateTime } from './common.js';

export type OrderChannel = 'SELF_SERVE' | 'RETAIL_ASSISTED' | 'QUICK_SALE' | 'TELESALES' | 'DEALER' | 'CALL_CENTER';

export type OrderState =
  | 'DRAFT' | 'SUBMITTED' | 'VALIDATED' | 'PAYMENT_PENDING' | 'PAID'
  | 'FULFILMENT' | 'AWAITING_INSTALLATION' | 'SHIPPED' | 'DELIVERED'
  | 'ACTIVATED' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

export type PaymentMethod = 'CREDIT_CARD' | 'CASH' | 'QR' | 'INSTALLMENT' | 'ETC_CHARGE';

export interface Attribution {
  storeId?: string;
  salespersonId?: string;
  dealerId?: string;
  /** Commission is computed from this on COMPLETED. */
  commissionEligible: boolean;
}

export interface OrderLine {
  id: Uuid;
  offerId: string;
  quantity: number;
  unitPrice: Money;
  /** For ports and number changes. */
  msisdn?: string;
  serialNumber?: string;
}

export interface Order extends Auditable {
  id: Uuid;
  customerId: Uuid;
  shardId: number;
  channel: OrderChannel;
  state: OrderState;
  lines: OrderLine[];
  total: Money;
  payment?: { method: PaymentMethod; installmentMonths?: number };
  attribution: Attribution;
  workflowId?: string;
  pointOfNoReturnAt?: IsoDateTime;
}

/* ---------------- Visual rule-builder graph ---------------- */

export type WorkflowNodeType =
  | 'START' | 'VALIDATE_ORDER' | 'CREDIT_CHECK' | 'CAPTURE_PAYMENT' | 'RESERVE_INVENTORY'
  | 'SCHEDULE_INSTALLATION' | 'SHIP_GOODS' | 'ACTIVATE_SERVICE' | 'NOTIFY' | 'WAIT_SIGNAL'
  | 'CONDITION' | 'POINT_OF_NO_RETURN' | 'END';

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  /** Canvas position, persisted by the visual designer. */
  position: { x: number; y: number };
  config: Record<string, string | number | boolean>;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  /** For CONDITION nodes: "true" | "false". */
  branch?: 'true' | 'false';
}

export interface OrderWorkflowDefinition {
  id: string;
  name: string;
  version: number;
  appliesTo: { channels: OrderChannel[]; offerKinds: string[] };
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface OrderSignals {
  paymentConfirmed: { reference: string };
  installationScheduled: { slot: IsoDateTime };
  cancelRequested: { reason: string };
}
