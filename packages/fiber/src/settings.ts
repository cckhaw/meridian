import { audit, type Queryable } from '@meridian/core';

/**
 * Whether the module is on, and how it behaves. Held in Meridian's own settings table (key `modules` for the switch, so the CRM can read it too; key `fiberCoverage`
 * for the rest), with `FEATURE_FIBER_COVERAGE_MODULE_ENABLED` as the starting value until an administrator sets it.
 */
export interface FiberSettings {
  /** How long a port stays locked while a customer checks out. */
  lockMinutes: number;
  /** How long a partner's answer for a place is reused. */
  cacheHours: number;
  /** How long to wait for a partner before answering without them. */
  partnerTimeoutMs: number;
  /** A distribution point is "low" when this few ports (or this share) remain free. */
  lowPortsAbsolute: number;
  lowPortsPercent: number;
  /** Switches for individual partner adapters, by provider code. A partner not listed follows its own setting. */
  adapters: Record<string, boolean>;
}
export const DEFAULT_FIBER_SETTINGS: FiberSettings = { lockMinutes: 30, cacheHours: 24, partnerTimeoutMs: 2500, lowPortsAbsolute: 2, lowPortsPercent: 15, adapters: {} };

const envFlag = (): boolean => /^(1|true|on|yes)$/i.test((process.env.FEATURE_FIBER_COVERAGE_MODULE_ENABLED ?? '').trim());

export async function moduleEnabled(q: Queryable): Promise<boolean> {
  const r = (await q.query(`SELECT value FROM settings WHERE key='modules'`)).rows[0];
  const v = (r?.value as { fiberCoverage?: { enabled?: boolean } } | undefined)?.fiberCoverage?.enabled;
  return typeof v === 'boolean' ? v : envFlag();
}
export async function setModuleEnabled(q: Queryable, actor: string, enabled: boolean): Promise<boolean> {
  const cur = (await q.query(`SELECT value FROM settings WHERE key='modules'`)).rows[0]?.value ?? {};
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('modules', $1, $2) ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=now()`, [JSON.stringify({ ...cur, fiberCoverage: { enabled } }), actor]);
  await audit(q, actor, 'settings', 'modules', enabled ? 'FIBER_MODULE_ON' : 'FIBER_MODULE_OFF', { enabled });
  return enabled;
}

export async function getFiberSettings(q: Queryable): Promise<FiberSettings> {
  const r = (await q.query(`SELECT value FROM settings WHERE key='fiberCoverage'`)).rows[0];
  return { ...DEFAULT_FIBER_SETTINGS, ...(r?.value ?? {}), adapters: { ...(r?.value?.adapters ?? {}) } };
}
export async function setFiberSettings(q: Queryable, actor: string, p: Partial<FiberSettings>): Promise<FiberSettings> {
  const next = { ...(await getFiberSettings(q)), ...p };
  const int = (n: number, lo: number, hi: number, what: string) => { if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${what} must be a whole number from ${lo} to ${hi}.`); };
  int(next.lockMinutes, 1, 240, 'The checkout lock'); int(next.cacheHours, 0, 168, 'The cache time'); int(next.partnerTimeoutMs, 200, 30000, 'The partner timeout'); int(next.lowPortsAbsolute, 0, 64, 'The low-port count'); int(next.lowPortsPercent, 0, 100, 'The low-port share');
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('fiberCoverage', $1, $2) ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=now()`, [JSON.stringify(next), actor]);
  await audit(q, actor, 'settings', 'fiberCoverage', 'UPDATE', next as unknown as Record<string, unknown>);
  return next;
}
