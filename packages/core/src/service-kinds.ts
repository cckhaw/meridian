import { BUILTIN_SERVICE_KINDS } from '@meridian/types';
import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { queueOutbox } from './lifecycle-state.js';

/**
 * Kinds of service. MOBILE, FIBER, IOT and SUBSCRIPTION are built into the platform. An operator can define more (a roaming pass, a voucher, a prepaid top-up): an order
 * for an offer whose type creates such a kind starts a service of it, with an identifier the platform generates, an end date when the kind expires, and instructions to the
 * systems named here when it starts and ends. Billing follows the offer's prices as for any subscription; a one-off pass is simply an offer with no monthly fee.
 */
export interface ServiceKind {
  id: string; name: string; description: string | null; isBuiltin: boolean; status: 'ACTIVE' | 'INACTIVE'; identifierPrefix: string;
  expires: boolean; validityDays: number | null; provisionSystems: string[]; provisionInstruction: string; deprovisionInstruction: string; sortOrder: number;
  /** Tell the network (the START instruction, with the systems named) when a service of this type starts. */
  announceStart: boolean;
  /** Services of this type may be provisioned into the charging system (when their offer has an OCS plan code). */
  ocsEnabled: boolean;
}
export interface ServiceKindInput { name: string; description?: string | null; identifierPrefix?: string; expires?: boolean; validityDays?: number | null; provisionSystems?: string[]; provisionInstruction?: string; deprovisionInstruction?: string; announceStart?: boolean; ocsEnabled?: boolean; status?: 'ACTIVE' | 'INACTIVE' }

export const isBuiltinKind = (id: string | null | undefined) => !id || (BUILTIN_SERVICE_KINDS as readonly string[]).includes(id);
const CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
const COLS = 'id, name, description, is_builtin, status, identifier_prefix, expires, validity_days, provision_systems, provision_instruction, deprovision_instruction, sort_order, announce_start, ocs_enabled';

export async function listServiceKinds(q: Queryable, o: { activeOnly?: boolean; withUsage?: boolean } = {}): Promise<Array<ServiceKind & { offerTypes?: number; services?: number }>> {
  const rows = (await q.query<ServiceKind & Row>(`SELECT ${COLS} FROM service_kinds ${o.activeOnly ? `WHERE status='ACTIVE'` : ''} ORDER BY sort_order, name`)).rows;
  if (!o.withUsage) return rows;
  const types = new Map((await q.query(`SELECT behaviour->>'service' AS k, count(*) AS n FROM offer_types WHERE behaviour IS NOT NULL GROUP BY 1`)).rows.map((r) => [r.k as string, Number(r.n)]));
  const svc = new Map((await q.query(`SELECT service_kind AS k, count(*) AS n FROM services WHERE service_kind IS NOT NULL GROUP BY 1`)).rows.map((r) => [r.k as string, Number(r.n)]));
  return rows.map((r) => ({ ...r, offerTypes: types.get(r.id) ?? 0, services: svc.get(r.id) ?? 0 }));
}
export async function getServiceKind(q: Queryable, id: string): Promise<ServiceKind | null> {
  return (await q.query<ServiceKind & Row>(`SELECT ${COLS} FROM service_kinds WHERE id=$1`, [id])).rows[0] ?? null;
}

function clean(i: ServiceKindInput, builtin = false) {
  const name = i.name?.trim();
  if (!name || name.length > 40) throw invalid('a service type needs a name (up to 40 characters)');
  const prefix = (i.identifierPrefix ?? 'SVC').trim().toUpperCase();
  if (!builtin && !/^[A-Z0-9-]{1,10}$/.test(prefix)) throw invalid('the identifier prefix is up to 10 letters, digits or dashes');
  const expires = !!i.expires;
  const days = expires ? i.validityDays ?? null : null;
  if (!builtin && expires && (days == null || !Number.isInteger(days) || days < 1 || days > 3650)) throw invalid('a service that expires needs a default length of 1 to 3650 days');
  const systems = [...new Set((i.provisionSystems ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (systems.length > 8 || systems.some((s) => !CODE.test(s))) throw invalid('name up to 8 systems, each in capitals, digits and underscores (for example PCRF or VOUCHER_PLATFORM)');
  const instr = (v: string | undefined, d: string, what: string) => { const t = (v ?? d).trim().toUpperCase(); if (!CODE.test(t)) throw invalid(`${what} is a code in capitals, digits and underscores`); return t; };
  const description = i.description?.trim() || null;
  if (description && description.length > 200) throw invalid('the description is up to 200 characters');
  return { name, description, prefix, expires, days, announce: i.announceStart !== false, ocs: i.ocsEnabled !== false, systems, provision: instr(i.provisionInstruction, 'PROVISION', 'the start instruction'), deprovision: instr(i.deprovisionInstruction, 'DEPROVISION', 'the end instruction') };
}

export async function createServiceKind(q: Queryable, actor: string, i: ServiceKindInput): Promise<ServiceKind> {
  const c = clean(i);
  if ((await q.query('SELECT 1 FROM service_kinds WHERE lower(name)=lower($1)', [c.name])).rows.length) throw conflict(`there is already a service type called ${c.name}`);
  const base = c.name.toUpperCase().normalize('NFKD').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  const root = /^[A-Z]/.test(base) && base.length >= 2 ? base : `KIND_${base}`.slice(0, 24);
  let id = root;
  for (let n = 2; (await q.query('SELECT 1 FROM service_kinds WHERE id=$1', [id])).rows.length; n++) id = `${root}_${n}`;
  const order = Number((await q.query('SELECT COALESCE(max(sort_order),0) + 10 AS n FROM service_kinds')).rows[0]!.n);
  await q.query(
    `INSERT INTO service_kinds (id, name, description, identifier_prefix, expires, validity_days, provision_systems, provision_instruction, deprovision_instruction, sort_order, created_by, announce_start, ocs_enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, c.name, c.description, c.prefix, c.expires, c.days, JSON.stringify(c.systems), c.provision, c.deprovision, order, actor, c.announce, c.ocs]);
  await audit(q, actor, 'service_kind', id, 'create', { name: c.name });
  return (await getServiceKind(q, id))!;
}
export async function updateServiceKind(q: Queryable, actor: string, id: string, i: Partial<ServiceKindInput>): Promise<ServiceKind> {
  const cur = await getServiceKind(q, id);
  if (!cur) throw notFound('service type', id);
  if (cur.isBuiltin) {
    // The platform issues a built-in type's identifiers, ends nothing by itself, and cannot sell without it: those stay. Everything about how it is described and integrated can change.
    if (i.identifierPrefix !== undefined && i.identifierPrefix !== cur.identifierPrefix) throw rejected(`${cur.name} identifiers are issued by the platform, so their prefix cannot change.`);
    if ((i.expires !== undefined && i.expires !== cur.expires) || (i.validityDays != null && i.validityDays !== cur.validityDays)) throw rejected(`${cur.name} services do not end by themselves.`);
    if (i.status === 'INACTIVE') throw rejected(`${cur.name} cannot be switched off.`);
  }
  const defined = Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined));
  const c = clean({ name: cur.name, description: cur.description, identifierPrefix: cur.identifierPrefix, expires: cur.expires, validityDays: cur.validityDays, provisionSystems: cur.provisionSystems, provisionInstruction: cur.provisionInstruction, deprovisionInstruction: cur.deprovisionInstruction, announceStart: cur.announceStart, ocsEnabled: cur.ocsEnabled, ...defined } as ServiceKindInput, cur.isBuiltin); // what is left out keeps its value
  if (c.name.toLowerCase() !== cur.name.toLowerCase() && (await q.query('SELECT 1 FROM service_kinds WHERE lower(name)=lower($1)', [c.name])).rows.length) throw conflict(`there is already a service type called ${c.name}`);
  const status = i.status ?? cur.status;
  if (status === 'INACTIVE' && cur.status === 'ACTIVE' && Number((await q.query(`SELECT count(*) AS n FROM offer_types WHERE status='ACTIVE' AND behaviour->>'service'=$1`, [id])).rows[0]!.n)) throw rejected('an active offer type creates this service type: switch that off first');
  await q.query(`UPDATE service_kinds SET name=$2, description=$3, identifier_prefix=$4, expires=$5, validity_days=$6, provision_systems=$7, provision_instruction=$8, deprovision_instruction=$9, status=$10, announce_start=$11, ocs_enabled=$12, updated_at=now() WHERE id=$1`,
    [id, c.name, c.description, cur.isBuiltin ? cur.identifierPrefix : c.prefix, c.expires, c.days, JSON.stringify(c.systems), c.provision, c.deprovision, status, c.announce, c.ocs]);
  await audit(q, actor, 'service_kind', id, 'update', { name: c.name, before: { systems: cur.provisionSystems, start: cur.provisionInstruction, end: cur.deprovisionInstruction, announceStart: cur.announceStart, ocs: cur.ocsEnabled }, after: { systems: c.systems, start: c.provision, end: c.deprovision, announceStart: c.announce, ocs: c.ocs } });
  return (await getServiceKind(q, id))!;
}
export async function deleteServiceKind(q: Queryable, actor: string, id: string): Promise<void> {
  const cur = await getServiceKind(q, id);
  if (!cur) throw notFound('service type', id);
  if (cur.isBuiltin) throw rejected('the built-in service types cannot be removed');
  const types = Number((await q.query(`SELECT count(*) AS n FROM offer_types WHERE behaviour->>'service'=$1`, [id])).rows[0]!.n);
  const svcs = Number((await q.query(`SELECT count(*) AS n FROM services WHERE service_kind=$1`, [id])).rows[0]!.n);
  if (types || svcs) throw rejected(`${types ? `${types} offer type${types === 1 ? ' creates' : 's create'} it` : `${svcs} service${svcs === 1 ? ' exists' : 's exist'} of it`}, so it cannot be removed. Switch it off instead.`);
  await q.query('DELETE FROM service_kinds WHERE id=$1', [id]);
  await audit(q, actor, 'service_kind', id, 'delete', {});
}

/** The instruction a service of an operator-defined kind sends when it starts: which systems to tell, and until when it is valid. */
export async function announceStart(q: Queryable, kind: ServiceKind, s: { id: string; accountId: string; identifier: string; offerId: string; expiresAt: string | Date | null }): Promise<void> {
  await queueOutbox(q, { kind: 'NETWORK', instruction: kind.provisionInstruction, serviceId: s.id, accountId: s.accountId, payload: { identifier: s.identifier, serviceKind: kind.id, offerId: s.offerId, validUntil: s.expiresAt ? new Date(s.expiresAt).toISOString() : null, systems: kind.provisionSystems } });
}
/** The network systems told by default when a service ends, for a type that names none. */
export const DEFAULT_END_SYSTEMS = ['HLR', 'HSS', 'PCRF'];
/**
 * What to tell the systems when a service of this type ends: its own instruction and systems. A built-in type that names no systems keeps the default
 * (HLR, HSS and PCRF), so nothing changes until the super user adapts it. Pass the service's kind when it has one, else its type.
 */
export async function endInstruction(q: Queryable, kindId: string | null | undefined): Promise<{ instruction: string; systems: string[] } | null> {
  if (!kindId) return null;
  const k = await getServiceKind(q, kindId);
  if (!k) return null;
  return { instruction: k.deprovisionInstruction, systems: k.provisionSystems.length ? k.provisionSystems : isBuiltinKind(kindId) ? DEFAULT_END_SYSTEMS : [] };
}
