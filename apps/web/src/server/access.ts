import { DomainError, forbidden, type Row, type SessionUser } from '@meridian/core';

export { forbidden };

/** Row-level checks. Permissions say *what kind* of thing a user may do; scope says *which rows*. A miss reads as "not found" so ids cannot be probed. */
const notFound = () => new DomainError('NOT_FOUND', 'not found');

export function assertCustomer(u: SessionUser, customerId: string) {
  if (u.scope.customerId && u.scope.customerId !== customerId) throw notFound();
}
export function assertOrder(u: SessionUser, o: Row) {
  const s = u.scope;
  if (s.unrestricted) return;
  if (s.customerId && o.customerId === s.customerId) return;
  if (s.storeId && o.storeId === s.storeId) return;
  if (s.dealerId && o.dealerId === s.dealerId) return;
  throw notFound();
}
