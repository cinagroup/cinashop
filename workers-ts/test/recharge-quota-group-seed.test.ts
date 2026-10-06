import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { systemGroup, systemGroupData, systemLog, user, userRecharge } from '../src/models/schema';
import { RECHARGE_QUOTA_GROUP_SEED_SQL } from '../src/migrations/rechargeQuotaGroupSeed';
import { runRechargeQuotaGroupSeed } from '../src/migrations/runRechargeQuotaGroupSeed';
import { MigrationService } from '../src/services/MigrationService';
import { createContainerFromDb } from '../src/lib/di';
import { UserFinanceService } from '../src/services/user/UserFinanceService';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const fields = [{ name: '售价', title: 'price', type: 'input', param: '' }, { name: '赠送', title: 'give_money', type: 'input', param: '' }];

it('registers byte-identical external 0166 and embedded 0172 without a runtime HTTP initializer', () => {
  expect(readFileSync('migrations/0166_recharge_quota_group_seed.sql', 'utf8').trim()).toBe(RECHARGE_QUOTA_GROUP_SEED_SQL.trim());
  const service = new MigrationService({} as never);
  expect(service.rechargeQuotaGroupSeedSqlForVerification()).toBe(RECHARGE_QUOTA_GROUP_SEED_SQL);
  for (const file of ['src/routes/adminapi.ts', 'src/routes/v1/index.ts']) expect(readFileSync(file, 'utf8')).not.toContain('runRechargeQuotaGroupSeed');
  expect(RECHARGE_QUOTA_GROUP_SEED_SQL).not.toMatch(/\b(setval|GRANT|UPDATE|DELETE)\b/);
});

describe('fixed empty recharge group seed on SQL', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeEach(async () => {
    f = await financePostgres([systemGroup, systemGroupData, systemLog, user, userRecharge], { namespace: 'public' });
    await f.exec('CREATE UNIQUE INDEX system_group_config_name_uq ON public.system_group(config_name)');
    await f.db.insert(systemGroup).values({ id: 62, name: 'Other group', configName: 'other_data', fields: 'retain raw text' });
    await f.db.insert(systemGroupData).values({ id: 2, gid: 62, value: 'other group payload', status: 1 });
    await f.db.insert(user).values({ uid: 10, nowMoney: '15.00' });
    await f.db.insert(userRecharge).values({ uid: 10, orderId: 'czseedexisting', price: '50.00', givePrice: '5.00', paid: 0 });
  }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);
  const batch = async (query: string) => {
    if (native) return f.db.$client.begin(async tx => { await tx.unsafe(query); });
    try { await f.exec(`BEGIN; ${query} COMMIT;`); }
    catch (error) { await f.exec('ROLLBACK'); throw error; }
  };
  const apply = () => native ? runRechargeQuotaGroupSeed(f.db) : batch(RECHARGE_QUOTA_GROUP_SEED_SQL);
  const snapshot = async () => ({ groups: await f.db.select().from(systemGroup).orderBy(systemGroup.id),
    data: await f.db.select().from(systemGroupData), logs: await f.db.select().from(systemLog), users: await f.db.select().from(user), orders: await f.db.select().from(userRecharge) });
  const sequences = () => f.exec('SELECT last_value,is_called FROM public.system_group_id_seq UNION ALL SELECT last_value,is_called FROM public.system_log_id_seq');

  it('creates only one canonical empty metadata group plus a system audit and repeats without even consuming a sequence value', async () => {
    const before = await snapshot(); await apply(); const after = await snapshot();
    const created = after.groups.find(row => row.configName === 'user_recharge_quota')!;
    expect(created).toMatchObject({ id: 1, cateId: 0, name: '充值金额设置', info: '设置充值金额额度选择' });
    expect(JSON.parse(created.fields!)).toEqual(fields);
    expect(after.groups.filter(row => row.id !== created.id)).toEqual(before.groups);
    expect(after.data).toEqual(before.data); expect(after.users).toEqual(before.users); expect(after.orders).toEqual(before.orders);
    expect(after.logs).toHaveLength(1);
    expect(after.logs[0]).toMatchObject({ adminId: 0, adminName: '', type: 'recharge_quota_seed', path: '/migration/0166/recharge-quota-group',
      method: 'MIGRATE', action: 'initialize;group_id=1;version=1' });
    const counter = await sequences(); await apply(); expect(await snapshot()).toEqual(after); expect(await sequences()).toEqual(counter);
  });

  it.each([null, '', '  ', '[]', '{bad JSON', '[{"title":"different","type":"upload"}]'])('preserves an existing unique group and arbitrary historical fields: %s', async value => {
    await f.db.insert(systemGroup).values({ id: 77, cateId: 9, configName: 'user_recharge_quota', name: 'Custom name', info: 'Custom info', fields: value });
    const before = await snapshot(), counter = await sequences(); await apply(); await apply();
    expect(await snapshot()).toEqual(before); expect(await sequences()).toEqual(counter);
  });

  it('rejects duplicate natural keys without choosing or replacing either group', async () => {
    await f.exec('DROP INDEX system_group_config_name_uq');
    await f.db.insert(systemGroup).values([{ id: 77, configName: 'user_recharge_quota' }, { id: 78, configName: 'user_recharge_quota' }]);
    const before = await snapshot(); await expect(apply()).rejects.toThrow(/Duplicate recharge quota/); expect(await snapshot()).toEqual(before);
  });

  it('requires natural-key uniqueness before creating metadata', async () => {
    await f.exec('DROP INDEX system_group_config_name_uq');
    const before = await snapshot(); await expect(apply()).rejects.toThrow(/unique index/); expect(await snapshot()).toEqual(before);
  });

  it('does not repair sequence collisions or overwrite the existing row', async () => {
    await f.db.insert(systemGroup).values({ id: 1, configName: 'occupied_serial_id' });
    const before = await snapshot(); await expect(apply()).rejects.toThrow(/duplicate key/); expect(await snapshot()).toEqual(before);
    // Native nextval may advance even though the business transaction rolls back.
  });

  it.each([['visible', 1, '{"price":"100","give_money":"50"}'], ['hidden', 0, '{"price":"100"}'], ['invalid', 1, 'not-json']] as const)
    ('does not adopt %s orphan rows matching the next serial group ID', async (_label, status, value) => {
      await f.db.insert(systemGroupData).values({ id: 3, gid: 1, value, status });
      const before = await snapshot();
      await expect(apply()).rejects.toThrow(/adopt orphan/);
      expect(await snapshot()).toEqual(before);
      expect((await new UserFinanceService(createContainerFromDb(f.db)).rechargeIndex()).recharge_quota).toEqual([]);
    });

  it.each(['system_group', 'system_log'] as const)('refuses missing id primary keys on %s before consuming IDs', async table => {
    const [key] = await f.db.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid=${table}::regclass AND contype='p'`);
    await f.exec(`ALTER TABLE public.${table} DROP CONSTRAINT "${String(key.conname)}"`);
    const before = await snapshot(), counter = await sequences();
    await expect(apply()).rejects.toThrow(/serial default/); expect(await snapshot()).toEqual(before); expect(await sequences()).toEqual(counter);
  });

  it.each(['system_group', 'system_log'] as const)('rejects extra default functions on %s without invoking their effects', async table => {
    await f.exec(`CREATE TABLE seed_probe(n integer);
      CREATE FUNCTION seed_probe_default() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INSERT INTO seed_probe VALUES(1); RETURN 1; END $$;
      ALTER TABLE public.${table} ADD COLUMN probe integer DEFAULT seed_probe_default()`);
    await f.exec('TRUNCATE seed_probe'); // ALTER may evaluate the default for already existing fixture rows.
    const before = await snapshot(); await expect(apply()).rejects.toThrow(/side effects/);
    expect(await snapshot()).toEqual(before); expect((await f.db.execute(sql`SELECT count(*)::integer AS n FROM seed_probe`))[0].n).toBe(0);
  });

  it('rolls metadata back if the mandatory audit insert fails', async () => {
    await f.exec("ALTER TABLE public.system_log ADD CONSTRAINT reject_seed_audit CHECK(type <> 'recharge_quota_seed')");
    const before = await snapshot(); await expect(apply()).rejects.toThrow(/reject_seed_audit/); expect(await snapshot()).toEqual(before);
  });

  it.each(['trigger', 'rule', 'default', 'rls'] as const)('rejects unreviewed insertion side effects: %s', async mode => {
    if (mode === 'trigger') await f.exec("CREATE FUNCTION seed_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER seed_unreviewed BEFORE INSERT ON public.system_group FOR EACH ROW EXECUTE FUNCTION seed_side_effect()");
    if (mode === 'rule') await f.exec("CREATE RULE seed_unreviewed AS ON INSERT TO public.system_group DO ALSO NOTIFY quota_seed_review");
    if (mode === 'default') await f.exec('ALTER TABLE public.system_group ALTER COLUMN id SET DEFAULT 99');
    if (mode === 'rls') await f.exec('ALTER TABLE public.system_group ENABLE ROW LEVEL SECURITY');
    const before = await snapshot(); await expect(apply()).rejects.toThrow(/requires|require/); expect(await snapshot()).toEqual(before);
  });

  it('rolls a successful seed back with its enclosing transaction and retains stricter caller deadlines', async () => {
    const before = await snapshot();
    await expect(batch(`${RECHARGE_QUOTA_GROUP_SEED_SQL} DO $$ BEGIN RAISE EXCEPTION 'later failure'; END $$;`)).rejects.toThrow('later failure');
    expect(await snapshot()).toEqual(before);
    await batch(`SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='100ms'; ${RECHARGE_QUOTA_GROUP_SEED_SQL}
      DO $$ BEGIN IF current_setting('statement_timeout')<>'2s' OR current_setting('lock_timeout')<>'100ms'
      THEN RAISE EXCEPTION 'stricter deadlines changed'; END IF; END $$;`);
  });

  it.runIf(native)('serializes independent concurrent seeds with exactly one group and one audit', async () => {
    await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731642,1)');
      try {
        const first = outcome(runRechargeQuotaGroupSeed(firstPeer.db)); await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
        const second = outcome(runRechargeQuotaGroupSeed(secondPeer.db)); await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
        await blocker.exec('COMMIT'); expect((await first).ok).toBe(true); expect((await second).ok).toBe(true);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const after = await snapshot(); expect(after.groups.filter(row => row.configName === 'user_recharge_quota')).toHaveLength(1); expect(after.logs).toHaveLength(1);
  });

  it.runIf(native)('holds audit DDL and orphan-data writers until the seed transaction commits', async () => {
    await withFinancePeers(f.db, async ([installer, ddlPeer, dataPeer]) => {
      let release!: () => void, installed!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { installed = resolve; });
      const seed = outcome(installer.db.$client.begin(async tx => { await tx.unsafe(RECHARGE_QUOTA_GROUP_SEED_SQL); installed(); await gate; }));
      try {
        await Promise.race([ready, seed.then(result => { if (!result.ok) throw result.error; })]);
        const ddl = outcome(ddlPeer.exec('ALTER TABLE public.system_log ADD COLUMN harmless_extra text'));
        await waitForFinanceBlock(f.db, ddlPeer.pid, installer.pid);
        const data = outcome(dataPeer.exec("INSERT INTO public.system_group_data(gid,value,status) VALUES(999,'orphan fixture',0)"));
        await waitForFinanceBlock(f.db, dataPeer.pid, installer.pid);
        release(); expect((await seed).ok).toBe(true); expect((await ddl).ok).toBe(true); expect((await data).ok).toBe(true);
      } finally { release(); await seed; }
    });
    expect((await snapshot()).logs).toHaveLength(1);
  });

  it.runIf(native)('rechecks group-data RLS after waiting for concurrent DDL before testing orphan ownership', async () => {
    await f.db.insert(systemGroupData).values({ id: 3, gid: 1, value: '{"price":"100"}', status: 1 });
    const before = await snapshot();
    await withFinancePeers(f.db, async ([ddlPeer, installer]) => {
      await ddlPeer.exec('BEGIN; ALTER TABLE public.system_group_data ENABLE ROW LEVEL SECURITY; ALTER TABLE public.system_group_data FORCE ROW LEVEL SECURITY');
      try {
        const seed = outcome(runRechargeQuotaGroupSeed(installer.db));
        await waitForFinanceBlock(f.db, installer.pid, ddlPeer.pid);
        await ddlPeer.exec('COMMIT');
        const result = await seed; expect(result.ok).toBe(false);
        if (!result.ok) expect(String(result.error)).toContain('owned group data table');
      } finally {
        await ddlPeer.exec('ROLLBACK; ALTER TABLE public.system_group_data DISABLE ROW LEVEL SECURITY; ALTER TABLE public.system_group_data NO FORCE ROW LEVEL SECURITY');
      }
    });
    expect(await snapshot()).toEqual(before);
  });
});
