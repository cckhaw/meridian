import { assertOrgScope, DomainError, forbidden, type Row, type SessionUser } from '@meridian/core';

export { forbidden };

/** Row-level checks. Permissions say *what kind* of thing a user may do; scope says *which rows*. A miss reads as "not found" so ids cannot be probed. */
const notFound = () => new DomainError('NOT_FOUND', 'not found');

export function assertCustomer(u: SessionUser, customerId: string) {
  if (u.scope.customerId && u.scope.customerId !== customerId) throw notFound();
}
export function assertOrder(u: SessionUser, o: Row) {
  assertOrgScope(u, o); // the shared organisation-scope check: customer, store or dealer
}
