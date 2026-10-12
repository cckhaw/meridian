import type { Queryable } from './db.js';

export const audit = (q: Queryable, actor: string, entity: string, entityId: string, action: string, detail: Record<string, unknown> = {}) =>
  q.query('INSERT INTO audit_log (actor, entity, entity_id, action, detail) VALUES ($1,$2,$3,$4,$5)', [actor, entity, entityId, action, JSON.stringify(detail)]);
