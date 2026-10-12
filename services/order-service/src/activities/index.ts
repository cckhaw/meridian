import type { Order } from '@nexus/types';

/** Activity contracts. Implementations call downstream services; all must be idempotent (keyed by orderId+step). */
export interface OrderActivities {
  setOrderState(orderId: string, state: Order['state'], reason?: string): Promise<void>;
  validateOrder(orderId: string): Promise<{ ok: boolean; reason?: string }>;
  creditCheck(orderId: string): Promise<{ approved: boolean }>;
  capturePayment(orderId: string, method: string): Promise<{ reference: string } | { pending: true }>;
  refundPayment(orderId: string): Promise<void>;
  reserveInventory(orderId: string): Promise<void>;
  releaseInventory(orderId: string): Promise<void>;
  bookInstallation(orderId: string): Promise<{ requestedSlots: string[] }>;
  shipGoods(orderId: string): Promise<{ trackingNumber: string }>;
  activateService(orderId: string): Promise<void>;
  notifyCustomer(orderId: string, template: string): Promise<void>;
  publishEvent(topic: string, key: string, payload: unknown): Promise<void>;
}

/** Local stub implementation so the worker runs end-to-end before downstream services exist. */
export const stubActivities: OrderActivities = {
  async setOrderState(orderId, state, reason) { console.log(`[order ${orderId}] -> ${state}${reason ? ` (${reason})` : ''}`); },
  async validateOrder() { return { ok: true }; },
  async creditCheck() { return { approved: true }; },
  async capturePayment(orderId, method) { return method === 'QR' ? { pending: true } : { reference: `pay_${orderId}` }; },
  async refundPayment(orderId) { console.log(`[order ${orderId}] refund`); },
  async reserveInventory() {},
  async releaseInventory() {},
  async bookInstallation() { return { requestedSlots: [] }; },
  async shipGoods(orderId) { return { trackingNumber: `TRK-${orderId}` }; },
  async activateService() {},
  async notifyCustomer() {},
  async publishEvent(topic, key) { console.log(`[kafka] ${topic} ${key}`); },
};
