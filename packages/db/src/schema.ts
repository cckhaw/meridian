import { bigint, boolean, char, index, integer, pgEnum, pgTable, primaryKey, smallint, text, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';

export const accountStatus = pgEnum('account_status', ['ACTIVE', 'SUSPENDED', 'CLOSED']);
export const serviceType = pgEnum('service_type', ['MOBILE', 'FIBER', 'IOT', 'SUBSCRIPTION']);
export const serviceStatus = pgEnum('service_status', ['PENDING', 'ACTIVE', 'SUSPENDED', 'PORTING_OUT', 'TERMINATED']);
export const membershipRole = pgEnum('membership_role', ['OWNER', 'MEMBER', 'DEPARTMENT']);
export const orderChannel = pgEnum('order_channel', ['SELF_SERVE', 'RETAIL_ASSISTED', 'QUICK_SALE', 'TELESALES', 'DEALER', 'CALL_CENTER']);
export const orderState = pgEnum('order_state', [
  'DRAFT', 'SUBMITTED', 'VALIDATED', 'PAYMENT_PENDING', 'PAID', 'FULFILMENT', 'AWAITING_INSTALLATION',
  'SHIPPED', 'DELIVERED', 'ACTIVATED', 'COMPLETED', 'CANCELLED', 'FAILED',
]);
export const paymentMethod = pgEnum('payment_method', ['CREDIT_CARD', 'CASH', 'QR', 'INSTALLMENT', 'ETC_CHARGE']);
export const paymentStatus = pgEnum('payment_status', ['PENDING', 'AUTHORISED', 'CAPTURED', 'FAILED', 'REFUNDED']);

const audit = {
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// NOTE: partitioning and the ltree column are declared in migrations/*.sql (drizzle cannot express them);
// the definitions below are the query-side mirror.
export const customers = pgTable('customers', {
  id: uuid('id').notNull().defaultRandom(),
  shardId: smallint('shard_id').notNull(),
  segment: text('segment').notNull(), // a code from customer_segments
  displayName: text('display_name').notNull(),
  idDocumentRef: text('id_document_ref').notNull(),
  marketCode: char('market_code', { length: 2 }).notNull(),
  parentCustomerId: uuid('parent_customer_id'),
  hierarchyPath: text('hierarchy_path').notNull(),
  ...audit,
}, (t) => [primaryKey({ columns: [t.shardId, t.id] })]);

export const accounts = pgTable('accounts', {
  id: uuid('id').notNull().defaultRandom(),
  shardId: smallint('shard_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  billCycleDay: smallint('bill_cycle_day'),
  status: accountStatus('status').notNull().default('ACTIVE'),
  currency: char('currency', { length: 3 }).notNull(),
  payerAccountId: uuid('payer_account_id'),
  ...audit,
}, (t) => [primaryKey({ columns: [t.shardId, t.id] }), index('accounts_customer_idx').on(t.shardId, t.customerId)]);

export const services = pgTable('services', {
  id: uuid('id').notNull().defaultRandom(),
  shardId: smallint('shard_id').notNull(),
  accountId: uuid('account_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  type: serviceType('type').notNull(),
  identifier: text('identifier').notNull(),
  iccid: text('iccid'),
  offerId: text('offer_id').notNull(),
  status: serviceStatus('status').notNull().default('PENDING'),
  contractStart: timestamp('contract_start', { withTimezone: true }),
  contractTermMonths: smallint('contract_term_months'),
  ...audit,
}, (t) => [primaryKey({ columns: [t.shardId, t.identifier, t.id] }), uniqueIndex('services_identifier_uq').on(t.shardId, t.type, t.identifier)]);

export const legacyGroupMemberships = pgTable('legacy_group_memberships', {
  groupCustomerId: uuid('group_customer_id').notNull(),
  memberCustomerId: uuid('member_customer_id').notNull(),
  shardId: smallint('shard_id').notNull(),
  role: membershipRole('role').notNull(),
}, (t) => [primaryKey({ columns: [t.shardId, t.groupCustomerId, t.memberCustomerId] })]);

export const orders = pgTable('orders', {
  id: uuid('id').notNull().defaultRandom(),
  shardId: smallint('shard_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  channel: orderChannel('channel').notNull(),
  state: orderState('state').notNull().default('DRAFT'),
  totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  storeId: text('store_id'),
  salespersonId: text('salesperson_id'),
  dealerId: text('dealer_id'),
  commissionEligible: boolean('commission_eligible').notNull().default(false),
  workflowId: text('workflow_id'),
  pointOfNoReturnAt: timestamp('point_of_no_return_at', { withTimezone: true }),
  ...audit,
}, (t) => [primaryKey({ columns: [t.shardId, t.id] }), index('orders_customer_idx').on(t.shardId, t.customerId, t.createdAt)]);

export const orderLines = pgTable('order_lines', {
  id: uuid('id').notNull().defaultRandom(),
  shardId: smallint('shard_id').notNull(),
  orderId: uuid('order_id').notNull(),
  offerId: text('offer_id').notNull(),
  quantity: integer('quantity').notNull(),
  unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull(),
  msisdn: text('msisdn'),
  serialNumber: text('serial_number'),
}, (t) => [primaryKey({ columns: [t.shardId, t.orderId, t.id] })]);

export const orderStateHistory = pgTable('order_state_history', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
  shardId: smallint('shard_id').notNull(),
  orderId: uuid('order_id').notNull(),
  fromState: orderState('from_state'),
  toState: orderState('to_state').notNull(),
  actor: text('actor').notNull(),
  reason: text('reason'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.shardId, t.id] })]);

export const payments = pgTable('payments', {
  id: uuid('id').notNull().defaultRandom(),
  shardId: smallint('shard_id').notNull(),
  orderId: uuid('order_id').notNull(),
  method: paymentMethod('method').notNull(),
  status: paymentStatus('status').notNull().default('PENDING'),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  installmentMonths: smallint('installment_months'),
  gatewayRef: text('gateway_ref'),
  idempotencyKey: text('idempotency_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.shardId, t.id] }), uniqueIndex('payments_idem_uq').on(t.shardId, t.idempotencyKey)]);

export const installationAppointments = pgTable('installation_appointments', {
  id: uuid('id').notNull().defaultRandom(),
  shardId: smallint('shard_id').notNull(),
  orderId: uuid('order_id').notNull(),
  slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
  slotEnd: timestamp('slot_end', { withTimezone: true }).notNull(),
  technicianId: text('technician_id'),
  status: text('status').notNull().default('BOOKED'),
}, (t) => [primaryKey({ columns: [t.shardId, t.id] })]);

export const inventoryStock = pgTable('inventory_stock', {
  locationId: text('location_id').notNull(),
  sku: text('sku').notNull(),
  onHand: integer('on_hand').notNull(),
  reserved: integer('reserved').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.locationId, t.sku] })]);
