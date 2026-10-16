import { audit, conflict, decryptText, encryptText, invalid, notFound, type Queryable, type Row } from '@meridian/core';

export const PROVIDER_TYPES = ['OWNED_INFRASTRUCTURE', 'WHOLESALE_PARTNER'] as const;
export const ADAPTER_KINDS = ['NONE', 'REST', 'SOAP'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export interface ProviderInput {
  code: string; name: string; type: ProviderType; agreementId?: string | null; costPerPortMinor?: number; currency?: string; installLeadDays?: number; slaResponseHours?: number;
  speedTiersMbps?: number[]; adapterKind?: (typeof ADAPTER_KINDS)[number]; adapterUrl?: string | null; adapterConfig?: Record<string, unknown>; adapterEnabled?: boolean; enabled?: boolean;
  /** Write-only. undefined keeps what is stored, an empty string clears it. */ adapterSecret?: string;
}

/** What goes to a browser or to an API caller: never the adapter secret, and the commercial terms only for staff. */
export const providerView = (r: Row, staff = true) => ({
  id: r.id, code: r.code, name: r.name, type: r.type, installLeadDays: r.installLeadDays, slaResponseHours: r.slaResponseHours, speedTiersMbps: r.speedTiersMbps, enabled: r.enabled,
  ...(staff ? { agreementId: r.agreementId, costPerPortMinor: r.costPerPortMinor, currency: r.currency?.trim(), adapterKind: r.adapterKind, adapterUrl: r.adapterUrl, adapterConfig: r.adapterConfig, adapterEnabled: r.adapterEnabled, hasAdapterSecret: !!r.adapterSecretEnc, updatedAt: r.updatedAt } : {}),
});

function check(i: ProviderInput) {
  if (!/^[A-Z0-9_]{2,30}$/.test(i.code ?? '')) throw invalid('The code is 2 to 30 capital letters, digits or underscores, for example TIME_DOTCOM.');
  if (!i.name?.trim() || i.name.length > 100) throw invalid('Give the provider a name of up to 100 characters.');
  if (!PROVIDER_TYPES.includes(i.type)) throw invalid(`The type is one of ${PROVIDER_TYPES.join(', ')}.`);
  if (i.speedTiersMbps && (!i.speedTiersMbps.length || i.speedTiersMbps.some((s) => !Number.isInteger(s) || s < 1 || s > 100_000))) throw invalid('Speed tiers are whole numbers of Mbps, for example 100, 500, 1000.');
  if (i.adapterKind && !ADAPTER_KINDS.includes(i.adapterKind)) throw invalid(`The adapter is one of ${ADAPTER_KINDS.join(', ')}.`);
  if (i.adapterUrl) { let u: URL; try { u = new URL(i.adapterUrl); } catch { throw invalid('The partner address is not a valid address.'); } if (u.protocol !== 'https:' && !(u.protocol === 'http:' && process.env.NODE_ENV !== 'production')) throw invalid('The partner address must use https://.'); }
  if ((i.adapterKind === 'REST' || i.adapterKind === 'SOAP') && i.adapterEnabled && !i.adapterUrl) throw invalid('Enter the partner address before switching the adapter on.');
  if (i.installLeadDays !== undefined && (!Number.isInteger(i.installLeadDays) || i.installLeadDays < 0 || i.installLeadDays > 365)) throw invalid('Installation lead time is 0 to 365 days.');
  if (i.costPerPortMinor !== undefined && (!Number.isInteger(i.costPerPortMinor) || i.costPerPortMinor < 0)) throw invalid('The cost per port is an amount of zero or more.');
}

export async function saveProvider(q: Queryable, actor: string, i: ProviderInput, id?: string): Promise<Row> {
  check(i);
  const enc = i.adapterSecret === undefined ? undefined : i.adapterSecret === '' ? null : encryptText(i.adapterSecret);
  try {
    if (id) {
      const r = (await q.query(
        `UPDATE fiber_providers SET code=$2, name=$3, type=$4, agreement_id=$5, cost_per_port_minor=$6, currency=$7, install_lead_days=$8, sla_response_hours=$9, speed_tiers_mbps=$10, adapter_kind=$11, adapter_url=$12, adapter_config=$13, adapter_enabled=$14, enabled=$15,
           adapter_secret_enc = CASE WHEN $16::boolean THEN $17 ELSE adapter_secret_enc END, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, i.code, i.name.trim(), i.type, i.agreementId ?? null, i.costPerPortMinor ?? 0, (i.currency ?? 'SGD').toUpperCase(), i.installLeadDays ?? 7, i.slaResponseHours ?? 48, i.speedTiersMbps ?? [100, 500, 1000], i.adapterKind ?? 'NONE', i.adapterUrl ?? null, JSON.stringify(i.adapterConfig ?? {}), i.adapterEnabled ?? false, i.enabled ?? true, enc !== undefined, enc ?? null])).rows[0];
      if (!r) throw notFound('provider', id);
      await audit(q, actor, 'fiber_provider', id, 'UPDATE', { code: i.code, adapter: i.adapterKind, adapterEnabled: i.adapterEnabled, secret: i.adapterSecret === undefined ? 'kept' : i.adapterSecret === '' ? 'cleared' : 'replaced' });
      return r;
    }
    const r = (await q.query(
      `INSERT INTO fiber_providers (code, name, type, agreement_id, cost_per_port_minor, currency, install_lead_days, sla_response_hours, speed_tiers_mbps, adapter_kind, adapter_url, adapter_config, adapter_enabled, enabled, adapter_secret_enc, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [i.code, i.name.trim(), i.type, i.agreementId ?? null, i.costPerPortMinor ?? 0, (i.currency ?? 'SGD').toUpperCase(), i.installLeadDays ?? 7, i.slaResponseHours ?? 48, i.speedTiersMbps ?? [100, 500, 1000], i.adapterKind ?? 'NONE', i.adapterUrl ?? null, JSON.stringify(i.adapterConfig ?? {}), i.adapterEnabled ?? false, i.enabled ?? true, enc ?? null, actor])).rows[0]!;
    await audit(q, actor, 'fiber_provider', r.id, 'CREATE', { code: i.code, type: i.type });
    return r;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict('A provider with that code already exists.');
    throw e;
  }
}
export async function deleteProvider(q: Queryable, actor: string, id: string): Promise<void> {
  const used = Number((await q.query(`SELECT (SELECT count(*) FROM fiber_dps WHERE provider_id=$1) + (SELECT count(*) FROM fiber_coverage_polygons WHERE provider_id=$1) AS n`, [id])).rows[0]!.n);
  if (used) throw conflict('This provider still has distribution points or coverage areas. Switch it off instead, or remove them first.');
  const r = await q.query('DELETE FROM fiber_providers WHERE id=$1', [id]);
  if (!r.rowCount) throw notFound('provider', id);
  await audit(q, actor, 'fiber_provider', id, 'DELETE');
}
export const listProviders = async (q: Queryable): Promise<Row[]> => (await q.query('SELECT * FROM fiber_providers ORDER BY type, name')).rows;
export async function getProvider(q: Queryable, id: string): Promise<Row> {
  const r = (await q.query('SELECT * FROM fiber_providers WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('provider', id);
  return r;
}
export const providerSecret = (r: Row): string | null => (r.adapterSecretEnc ? decryptText(r.adapterSecretEnc) : null);
