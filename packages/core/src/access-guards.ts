import { DomainError, forbidden } from './errors.js';
import { resolvePermission, permissionKey } from './permission-catalog.js';
import type { Permission, Scope } from './rbac.js';

/**
 * The checks every entry point makes, in one place. The API route table, the northbound gateway and background jobs all use these rather than
 * looking at roles. Permissions say *what kind* of thing someone may do (`requirePermissions`); the organisation scope says *which rows*
 * (`assertOrgScope`: a store user sees their own store, a dealer their own dealer code, a customer their own account).
 */
export interface Actor { permissions: ReadonlySet<Permission>; scope: Scope }
const named = (n: string) => { const p = resolvePermission(n); if (!p) throw new Error(`unknown permission ${n}`); return p; };

/** The actor must hold every one named (a permission id, a `domain:resource:action` key, or an alias). */
export function requirePermissions(actor: Pick<Actor, 'permissions'>, ...needs: string[]): void {
  const missing = needs.map(named).filter((p) => !actor.permissions.has(p));
  if (missing.length) throw forbidden(`Your role does not allow this (${permissionKey(missing[0]!)}).`);
}
/** The actor must hold at least one of those named. */
export function requireAnyPermission(actor: Pick<Actor, 'permissions'>, ...needs: string[]): void {
  const ps = needs.map(named);
  if (!ps.some((p) => actor.permissions.has(p))) throw forbidden(`Your role does not allow this (${permissionKey(ps[0]!)}).`);
}

export interface OrgRef { storeId?: string | null; dealerId?: string | null; customerId?: string | null }
/** Whether a row (an order, a commission line, a stock movement…) belongs to the actor's organisation scope. */
export function inOrgScope(actor: Pick<Actor, 'scope'>, row: OrgRef): boolean {
  const s = actor.scope;
  if (s.unrestricted) return true;
  return !!((s.customerId && row.customerId === s.customerId) || (s.storeId && row.storeId === s.storeId) || (s.dealerId && row.dealerId === s.dealerId));
}
/** Refuses a row outside the actor's scope. It reads as "not found", so an outsider cannot probe which ids exist. */
export function assertOrgScope(actor: Pick<Actor, 'scope'>, row: OrgRef): void {
  if (!inOrgScope(actor, row)) throw new DomainError('NOT_FOUND', 'not found');
}
