import { readFileSync, readdirSync } from 'node:fs';
import { assertRegisteredDatabaseCohort } from './helpers/registeredCatalogCohort';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { MigrationService } from '../src/services/MigrationService';
import { runRechargeQuotaGroupSeed } from '../src/migrations/runRechargeQuotaGroupSeed';
import { RECHARGE_QUOTA_GROUP_SEED_SQL } from '../src/migrations/rechargeQuotaGroupSeed';
import { readCatalog } from '../scripts/data-migration/postgres-catalog-audit';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';

type Fixture = Awaited<ReturnType<typeof checkoutPricingMigrationDatabase>>;
const seedFile = '0166_recharge_quota_group_seed.sql';
const previousFile = '0165_assisted_order_list_index.sql';
const seedPath = '/migration/0166/recharge-quota-group';
const seedType = 'recharge_quota_seed';
const fields = [
  { name: '售价', title: 'price', type: 'input', param: '' },
  { name: '赠送', title: 'give_money', type: 'input', param: '' },
];
const externalFiles = () => readdirSync('migrations').filter(name => /^\d+.*\.sql$/u.test(name) && name <= seedFile).sort();

async function applyExternal(f: Fixture, files: string[]) {
  for (const name of files) await f.db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
    await tx.execute(sql.raw(readFileSync(`migrations/${name}`, 'utf8')));
  });
}

async function catalog(f: Fixture) {
  return readCatalog(async query => (await f.query(query)).rows.map(row => {
    if (typeof row.key !== 'string' || typeof row.name !== 'string') throw Error('Invalid catalog row identity');
    return { ...row, key: row.key, name: row.name };
  }));
}

async function identities(f: Fixture) {
  return (await f.query(`SELECT c.oid,c.relname,c.relkind,c.relowner,c.relacl,c.reloptions,
    c.relpersistence,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace ORDER BY c.relname`)).rows;
}

/** Inspect every public table, not just DDL or a preselected business subset.
 * PostgreSQL serializes decimal values, so JS never rounds a captured balance. */
async function allRows(f: Fixture): Promise<Record<string, string[]>> {
  const tables = (await f.query(`SELECT c.relname FROM pg_class c
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') ORDER BY c.relname`)).rows;
  const result: Record<string, string[]> = {};
  for (const { relname } of tables) {
    if (typeof relname !== 'string' || !relname) throw Error('Invalid snapshot table');
    const identifier = `"${relname.replaceAll('"', '""')}"`;
    const rows = (await f.query(`SELECT to_jsonb(t)::text AS row_json FROM ONLY public.${identifier} t ORDER BY to_jsonb(t)::text`)).rows;
    result[relname] = rows.map(row => {
      if (typeof row.row_json !== 'string') throw Error('Invalid snapshot row');
      return row.row_json;
    });
  }
  return result;
}

async function assertEmptyRechargeSeed(f: Fixture, expectedOtherGroups = 0, expectedOtherLogs = 0) {
  const groups = (await f.query("SELECT * FROM public.system_group WHERE config_name='user_recharge_quota'")).rows;
  expect(groups).toHaveLength(1);
  const group = groups[0];
  expect(group).toMatchObject({ cate_id: 0, name: '充值金额设置', info: '设置充值金额额度选择', config_name: 'user_recharge_quota' });
  expect(group.id).toBeTypeOf('number'); expect(Number(group.id)).toBeGreaterThan(0);
  expect(JSON.parse(String(group.fields))).toEqual(fields);
  const logs = (await f.query(`SELECT * FROM public.system_log WHERE type='${seedType}' OR path='${seedPath}'`)).rows;
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ admin_id: 0, type: seedType, path: seedPath, method: 'MIGRATE',
    action: `initialize;group_id=${group.id};version=1` });
  expect((await f.query(`SELECT count(*)::integer AS count FROM public.system_group_data WHERE gid=${Number(group.id)}`)).rows[0].count).toBe(0);
  expect((await f.query('SELECT count(*)::integer AS count FROM public.system_group')).rows[0].count).toBe(1 + expectedOtherGroups);
  expect((await f.query('SELECT count(*)::integer AS count FROM public.system_log')).rows[0].count).toBe(1 + expectedOtherLogs);
  return { groupId: Number(group.id), logId: Number(logs[0].id) };
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('recharge seed in complete owned PostgreSQL 16 installations', () => {
  it('upgrades the complete previous external catalog with only 0166, preserving every prior row and object identity', async () => {
    const f = await checkoutPricingMigrationDatabase();
    try {
      const files = externalFiles();
      expect(files).toHaveLength(168); expect(files.at(-1)).toBe(seedFile); expect(files.at(-2)).toBe(previousFile);
      await applyExternal(f, files.slice(0, -1));
      await f.exec(`INSERT INTO public.system_group(cate_id,name,info,config_name,fields)
        VALUES(3,'Existing metadata','Keep exact labels','seed_upgrade_existing','{"opaque":"keep"}');
        INSERT INTO public.system_group_data(gid,value,sort,status)
          SELECT id,'{"opaque":"existing business option"}',9,0 FROM public.system_group WHERE config_name='seed_upgrade_existing';
        INSERT INTO public."user"(uid,account,now_money,brokerage_price) VALUES(10,'seed-upgrade-buyer',127.89,12.34);
        INSERT INTO public.user_recharge(uid,order_id,price,give_price,paid)
          VALUES(10,'seed-upgrade-existing-recharge',56.78,1.01,0);
        INSERT INTO public.store_order(uid,order_id,total_price,pay_price)
          VALUES(10,'seed-upgrade-existing-order',55.00,55.00);
        INSERT INTO public.system_config(menu_name,value,info)
          VALUES('seed_upgrade_existing_setting','keep-existing-value','existing setting');
        INSERT INTO public.system_log(admin_id,type,path,method,action)
          VALUES(0,'seed_upgrade_existing','/fixture/keep','GET','keep-existing-audit');`);
      expect((await f.query("SELECT id FROM public.system_group WHERE config_name='user_recharge_quota'")).rows).toEqual([]);
      const beforeCatalog = await catalog(f), beforeIdentity = await identities(f), beforeRows = await allRows(f);
      expect(beforeRows.user).toHaveLength(1); expect(beforeRows.user_recharge).toHaveLength(1);
      expect(beforeRows.store_order).toHaveLength(1); expect(beforeRows.system_group_data).toHaveLength(1);
      const service = new MigrationService(createContainerFromDb(f.db));
      expect(service.rechargeQuotaGroupSeedSqlForVerification()).toBe(RECHARGE_QUOTA_GROUP_SEED_SQL);
      expect(await service.runAll()).toEqual({ executed: [], errors: ['Presale outbox already registered; use standalone forward upgrades, not runAll'] });
      await runRechargeQuotaGroupSeed(f.db);
      const added = await assertEmptyRechargeSeed(f, 1, 1);
      expect(await catalog(f)).toEqual(beforeCatalog); expect(await identities(f)).toEqual(beforeIdentity);
      const afterRows = await allRows(f);
      const withoutAdded = { ...afterRows,
        system_group: afterRows.system_group.filter(row => JSON.parse(row).id !== added.groupId),
        system_log: afterRows.system_log.filter(row => JSON.parse(row).id !== added.logId),
      };
      expect(withoutAdded).toEqual(beforeRows);
      await runRechargeQuotaGroupSeed(f.db);
      expect(await allRows(f)).toEqual(afterRows); expect(await catalog(f)).toEqual(beforeCatalog);
      expect(await identities(f)).toEqual(beforeIdentity);
    } finally { await f.close(); }
  }, 120_000);

  it('builds from the 168 external files through 0166 with exactly one canonical empty group and one seed audit', async () => {
    const f = await checkoutPricingMigrationDatabase();
    try {
      const files = externalFiles(); expect(files).toHaveLength(168); expect(files.at(-1)).toBe(seedFile);
      expect((await f.query("SELECT to_regclass('public.system_group') AS relation")).rows[0].relation).toBeNull();
      await applyExternal(f, files);
      await assertEmptyRechargeSeed(f);
      for (const name of ['system_group_data', 'user', 'user_recharge', 'user_bill', 'store_order']) {
        expect((await f.query(`SELECT count(*)::integer AS count FROM public."${name}"`)).rows[0].count).toBe(0);
      }
      const before = await allRows(f); await runRechargeQuotaGroupSeed(f.db); expect(await allRows(f)).toEqual(before);
    } finally { await f.close(); }
  }, 120_000);

  it('builds from all 180 embedded steps with exactly one canonical empty group and one seed audit', async () => {
    const f = await checkoutPricingMigrationDatabase();
    try {
      expect((await f.query("SELECT to_regclass('public.system_group') AS relation")).rows[0].relation).toBeNull();
      const service = new MigrationService(createContainerFromDb(f.db));
      const result = await service.runAll();
      expect(result.errors).toEqual([]);
      expect(result.executed).toEqual(Array.from({ length: 180 }, (_, index) => String(index).padStart(4, '0')));
      await assertRegisteredDatabaseCohort(f.db,'embedded');
      await assertEmptyRechargeSeed(f);
      for (const name of ['system_group_data', 'user', 'user_recharge', 'user_bill', 'store_order']) {
        expect((await f.query(`SELECT count(*)::integer AS count FROM public."${name}"`)).rows[0].count).toBe(0);
      }
      const before = await allRows(f); await runRechargeQuotaGroupSeed(f.db); expect(await allRows(f)).toEqual(before);
    } finally { await f.close(); }
  }, 120_000);
});
