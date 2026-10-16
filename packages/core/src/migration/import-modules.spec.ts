import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db, Row } from '../db.js';
import { freshDb } from '../test-helpers.js';
import { completeUpload, createImportJob, getMigrationJob, createUpload, putChunk, rollbackJob, runMigrationSlice, startImport } from './index.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
afterEach(async () => { await db.query(`UPDATE migration_jobs SET status='CANCELLED', claimed_until=NULL WHERE status IN ('PENDING','VALIDATED')`); });

const ACTOR = 'root';
async function upload(name: string, text: string): Promise<string> {
  const buf = Buffer.from(text);
  const u = await createUpload(db, ACTOR, { fileName: name, totalBytes: buf.length }, {});
  for (let n = 0; n * u.chunkBytes < buf.length; n++) await putChunk(db, ACTOR, u.id, n, buf.subarray(n * u.chunkBytes, (n + 1) * u.chunkBytes));
  return (await completeUpload(db, ACTOR, u.id, {})).uploads[0]!.id;
}
async function drive(id: string, until: string[] = ['VALIDATED', 'COMPLETED', 'FAILED', 'CANCELLED', 'ROLLED_BACK']): Promise<Row> {
  for (let i = 0; i < 400; i++) { const r = await runMigrationSlice(db, id, { budgetMs: 50 }); if (until.includes(r.job.status)) return r.job; }
  throw new Error('job did not settle');
}
async function load(entity: string, text: string, o: Partial<Parameters<typeof createImportJob>[2]> = {}): Promise<Row> {
  const job = await createImportJob(db, ACTOR, { uploadId: await upload(`${entity}.csv`, text), entity, ...o });
  const checked = await drive(job.id);
  if (checked.status !== 'VALIDATED' || !checked.summary.validation.canStart) return checked;
  await startImport(db, ACTOR, job.id);
  return drive(job.id);
}
const codes = async (j: Row) => (await getMigrationJob(db, j.id)).items.map((i) => i.code as string);
const ok = (j: Row) => expect(j.status, JSON.stringify(j.summary)).toBe('COMPLETED');

describe('import: the newer columns and data sets', () => {
  it('loads line items under an offer, scheduled catalog structure, and offers with group-plan, suspension, charging-plan and characteristics terms', async () => {
    let j = await load('catalog_structure', 'id,level,name,parent_id,network_type,status,active_from\nm-net,NETWORK_TYPE,Mobile net,,mobile,ACTIVE,\nm-cat,CATEGORY,Plans,m-net,,ACTIVE,\nm-grp,GROUP,Later group,m-cat,,SCHEDULED,2099-01-01T00:00:00Z\n');
    ok(j);
    expect((await db.query(`SELECT status, active_from FROM catalog_nodes WHERE id='m-grp'`)).rows[0]).toMatchObject({ status: 'SCHEDULED' });
    await db.query(`UPDATE catalog_nodes SET status='ACTIVE', active_from=NULL WHERE id='m-grp'`);
    j = await load('offers',
      'group_id,offer_id,name,type,monthly_fee,validity_days,ocs_plan_code,suspension_mode,suspension_fee,group_plan,max_group_members,allowed_member_offers,shared_pool_quota_gb,characteristics\n' +
      'm-grp,fam-100,Family 100,SIM_ONLY,100.00,,PLAN-FAM,MAINTENANCE_FEE,5.00,yes,3,,200,tier=gold|priority=2|roaming=true\n');
    ok(j);
    const fam = (await db.query(`SELECT data FROM catalog_nodes WHERE id='fam-100'`)).rows[0]!.data;
    expect(fam.group).toMatchObject({ isGroupOffer: true, maxGroupMembers: 3, sharedPoolQuotaGb: 200 });
    expect(fam.ocs).toMatchObject({ planCode: 'PLAN-FAM' });
    expect(fam.suspension).toMatchObject({ mode: 'MAINTENANCE_FEE', monthlyFeeMinor: 500 });
    expect(fam.characteristics).toEqual({ tier: 'gold', priority: 2, roaming: true });
    // an update that turns the group plan off and leaves the rest alone
    j = await load('offers', 'group_id,offer_id,name,type,group_plan\nm-grp,fam-100,,SIM_ONLY,no\n');
    ok(j);
    expect((await db.query(`SELECT data FROM catalog_nodes WHERE id='fam-100'`)).rows[0]!.data.group).toBeUndefined();

    // the orphan line item is refused in the check, so with the default (stop at the first problem) nothing loads
    j = await load('line_items', 'id,parent_id,name,item_type,quantity,unit,unlimited,sku\nli-fam-data,fam-100,100 GB data,DATA,100,GB,false,\nli-fam-voice,fam-100,Unlimited calls,VOICE,,,true,\nli-orphan,nope,Orphan,DATA,1,GB,false,\n');
    expect(j.status).toBe('VALIDATED');
    expect(await codes(j)).toContain('UNKNOWN_REFERENCE');
    expect((await db.query(`SELECT 1 FROM catalog_nodes WHERE id='li-fam-data'`)).rows).toHaveLength(0);
    j = await load('line_items', 'id,parent_id,name,item_type,quantity,unit,unlimited,sku\nli-fam-data,fam-100,100 GB data,DATA,100,GB,false,\nli-fam-voice,fam-100,Unlimited calls,VOICE,,,true,\nli-orphan,nope,Orphan,DATA,1,GB,false,\n', { onError: 'SKIP', errorThresholdPercent: 50 });
    ok(j);
    expect(j).toMatchObject({ rowsOk: 2, rowsError: 1 });
    expect((await db.query(`SELECT data FROM catalog_nodes WHERE id='li-fam-voice'`)).rows[0]!.data).toMatchObject({ itemType: 'VOICE', unlimited: true });
    expect((await db.query(`SELECT data FROM catalog_nodes WHERE id='li-fam-data'`)).rows[0]!.data).toMatchObject({ itemType: 'DATA', quantity: 100, unit: 'GB' });
  });

  it('loads customers with vip and credit risk, and services with a device deal, a suspension, a number status and a parent service', async () => {
    let j = await load('customers', 'id,segment,display_name,id_document,market_code,vip,credit_risk\nV-1,CONSUMER,Vera Vip,S1111111A,SG,true,HIGH\nV-2,CONSUMER,Norm Al,S2222222B,SG,,\n');
    ok(j);
    const rows = (await db.query(`SELECT c.display_name, c.vip, c.credit_risk FROM customers c JOIN migration_refs r ON r.internal_id=c.id::text AND r.entity='customers' ORDER BY r.ref`)).rows;
    expect(rows).toMatchObject([{ vip: true, creditRisk: 'HIGH' }, { vip: false, creditRisk: 'NORMAL' }]);
    j = await load('accounts', 'id,customer_id,name,bill_cycle_day\nA-1,V-1,Main,1\n');
    ok(j);
    const deal = JSON.stringify({ termMonths: 24, subsidyMinor: 40000 }).replaceAll('"', '""');
    j = await load('services',
      'id,account_id,type,identifier,offer_id,status,suspension_kind,suspended_at,suspend_until,number_status,vip_etc_bps,sim_swapped_at,deal,parent_service_id\n' +
      `S-1,A-1,MOBILE,+6591230001,fam-100,SUSPENDED,VOLUNTARY,2026-03-01T00:00:00Z,2026-09-01,PORTED_IN,15000,2026-02-01T00:00:00Z,"${deal}",\n` +
      'S-2,A-1,MOBILE,+6591230002,fam-100,ACTIVE,,,,,,,,S-1\n');
    ok(j);
    const s1 = (await db.query(`SELECT s.suspension_kind, s.suspend_until::text AS until, s.number_status, s.vip_etc_bps, s.deal, s.sim_swapped_at FROM services s JOIN migration_refs r ON r.internal_id=s.id::text AND r.entity='services' WHERE r.ref='S-1'`)).rows[0]!;
    expect(s1).toMatchObject({ suspensionKind: 'VOLUNTARY', until: '2026-09-01', numberStatus: 'PORTED_IN', vipEtcBps: 15000 });
    expect(s1.deal).toMatchObject({ termMonths: 24, subsidyMinor: 40000 });
    const s2 = (await db.query(`SELECT p.ref AS parent FROM services s JOIN migration_refs r ON r.internal_id=s.id::text AND r.entity='services' AND r.ref='S-2' JOIN migration_refs p ON p.internal_id=s.parent_service_id::text AND p.entity='services'`)).rows[0];
    expect(s2?.parent).toBe('S-1');
    // a value-added service listed before its parent is refused
    j = await load('services', 'id,account_id,type,identifier,offer_id,status,parent_service_id\nS-4,A-1,MOBILE,+6591230004,fam-100,ACTIVE,S-9\n');
    expect(j.status).toBe('VALIDATED');
    expect(await codes(j)).toContain('UNKNOWN_REFERENCE');
  });

  it('loads warehouses and an opening stock count, and takes the warehouses out again only while they are unused', async () => {
    let j = await load('warehouses', 'id,name,address\nWH-MIG-1,Migrated DC,1 Depot Road\n,Second DC,2 Depot Road\nWH-MIG-1,Dup id,x\nWH-MAIN,Another,x\n', { onError: 'SKIP', errorThresholdPercent: 50 });
    ok(j);
    expect(j).toMatchObject({ rowsOk: 2, rowsError: 1, rowsSkipped: 1 }); // the repeated id is a problem; WH-MAIN already exists and is skipped
    const made = (await db.query(`SELECT id, name, address FROM warehouses WHERE name IN ('Migrated DC','Second DC') ORDER BY name`)).rows;
    expect(made).toHaveLength(2);
    expect(made.find((m) => m.name === 'Migrated DC')).toMatchObject({ id: 'WH-MIG-1', address: '1 Depot Road' });
    expect(made.find((m) => m.name === 'Second DC')!.id).toMatch(/^WH-\d{5}$/); // the system issued the id
    // the same file again changes nothing
    j = await load('warehouses', 'id,name\nWH-MIG-1,Migrated DC\n');
    expect(j).toMatchObject({ rowsOk: 0, rowsSkipped: 1 });

    // opening stock: each row sets the count at the place; a place that does not exist is a problem
    j = await load('inventory_stock', 'location_id,sku,on_hand\nWH-MIG-1,SKU-A,40\nWH-MIG-1,SKU-B,5\nNOWHERE,SKU-A,1\n');
    expect(j.status).toBe('VALIDATED');
    j = await load('inventory_stock', 'location_id,sku,on_hand\nWH-MIG-1,SKU-A,40\nWH-MIG-1,SKU-B,5\nNOWHERE,SKU-A,1\n', { onError: 'SKIP', errorThresholdPercent: 50 });
    ok(j);
    const stock = (await db.query(`SELECT sku, on_hand FROM inventory_stock WHERE location_id='WH-MIG-1' ORDER BY sku`)).rows;
    expect(stock).toMatchObject([{ sku: 'SKU-A', onHand: 40 }, { sku: 'SKU-B', onHand: 5 }]);
    // loading the same counts again leaves the same numbers
    j = await load('inventory_stock', 'location_id,sku,on_hand\nWH-MIG-1,SKU-A,40\n');
    ok(j);
    expect((await db.query(`SELECT on_hand FROM inventory_stock WHERE location_id='WH-MIG-1' AND sku='SKU-A'`)).rows[0]!.onHand).toBe(40);

    // a warehouse that now holds stock cannot be taken out; the job says so and the warehouse stays
    const first = (await db.query(`SELECT id FROM migration_jobs WHERE entity='warehouses' AND rows_ok = 2 ORDER BY created_at LIMIT 1`)).rows[0]!.id as string;
    await rollbackJob(db, ACTOR, first, 'test');
    const stuck = await drive(first, ['ROLLED_BACK', 'FAILED', 'COMPLETED']);
    expect(stuck.status).not.toBe('ROLLED_BACK');
    expect((await db.query(`SELECT 1 FROM warehouses WHERE id='WH-MIG-1'`)).rows).toHaveLength(1);
    // one that never held stock goes
    j = await load('warehouses', 'id,name\nWH-MIG-9,Temporary DC\n');
    ok(j);
    await rollbackJob(db, ACTOR, j.id, 'test');
    expect((await drive(j.id, ['ROLLED_BACK', 'FAILED'])).status).toBe('ROLLED_BACK');
    expect((await db.query(`SELECT 1 FROM warehouses WHERE id='WH-MIG-9'`)).rows).toHaveLength(0);
  });
});
