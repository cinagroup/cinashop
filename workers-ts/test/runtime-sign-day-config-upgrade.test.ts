import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { AdminSignDayConfigService } from '../src/services/admin/AdminSignDayConfigService';
import { auditRuntimeBusinessPrivileges, inspectRuntimeBusinessProfileInTransaction } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { inspectSignDayConfigRuntimeCatalog } from '../src/migrations/signDayConfigRuntimeCatalog';
import { SIGN_DAY_GROUP_LOCK_BOUNDARY, installRuntimeSignDayGroupLockBoundaryInTransaction,
  inspectRuntimeSignDayGroupLockBoundary } from '../src/migrations/runtimeSignDayGroupLockBoundary';
import { installSignDayConfigRuntimeUpgradeInTransaction, runSignDayConfigRuntimeUpgrade } from '../src/migrations/runSignDayConfigRuntimeUpgrade';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { runPromotionGiftRuntimeUpgrade } from '../src/migrations/runPromotionGiftRuntimeUpgrade';
import { runCouponTemplateRuntimeUpgrade } from '../src/migrations/runCouponTemplateRuntimeUpgrade';
import { runSeckillParentRuntimeUpgrade } from '../src/migrations/runSeckillParentRuntimeUpgrade';
import { runSeckillScheduleRuntimeUpgrade } from '../src/migrations/runSeckillScheduleRuntimeUpgrade';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { removeAgentLevelFixtureGrants, removeSignDayFixtureGrants } from './helpers/runtimeHistoricalProfile';
import type { SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

type Peer = SequenceRunnerPeer & { role: string };
type Target = { database: string; maintenance: string; app: string; admin: string };
const native = process.env.TEST_FINANCE_POSTGRES_URL ? describe : describe.skip;
// This suite proves the fixed sign-day forward, not the subsequent distributor
// forward. Keep its installed profile and expected delta frozen.
const auditFrozenSignDayProfile = (...[db,kind,target]:Parameters<typeof auditRuntimeBusinessPrivileges>) =>
  db.transaction(tx => inspectRuntimeBusinessProfileInTransaction(tx,kind,target,'pre-agent-levels'));
async function sqlState(work: Promise<unknown>, code: string) {
  let error: unknown = await work.then(() => null, value => value);
  expect(error).not.toBeNull();
  for (let n = 0; n < 8 && error && typeof error === 'object'; n++) {
    if ('code' in error) { expect(error.code).toBe(code); return; }
    error = 'cause' in error ? error.cause : undefined;
  }
  throw Error('Expected PostgreSQL refusal ' + code);
}

native('sign-day explicit PG16 forward from the complete frozen gift-era profile', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => { f = await refundRuntimeFixture(); }, 60_000);
  afterEach(async () => { await f?.close(); }, 30_000);
  async function roles(run: (app: Peer, admin: Peer, target: Target) => Promise<void>, previous = true, commissioned = true) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [row] = await f.exec('SELECT current_database() AS database');
      const target = { database: String(row.database), maintenance: 'finance_test', app: app.role, admin: admin.role };
      if (commissioned) {
        await runRuntimeBusinessCommissioning(f.db, { ...target, pricingOwner: f.pricingOwner });
        await removeAgentLevelFixtureGrants(f.exec, target);
        if (previous) await removeSignDayFixtureGrants(f.exec, target);
      }
      await run(app, admin, target);
    }));
  }
  const profile = (peer: Peer, kind: 'app' | 'admin', target: Target) => peer.db.transaction(
    tx => inspectRuntimeBusinessProfileInTransaction(tx, kind, target, 'pre-sign-day'));
  const catalog = () => f.exec(`SELECT 'relation' AS kind,c.oid::text AS key,c.relname AS name,c.relowner::text AS owner,c.relacl::text AS acl,
      c.relkind::text||':'||c.relpersistence::text||':'||c.relrowsecurity::text||':'||c.relforcerowsecurity::text AS definition
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'column',c.oid::text||'.'||a.attnum::text,c.relname||'.'||a.attname,NULL,a.attacl::text,
      format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,proname,proowner::text,proacl::text,pg_get_functiondef(oid)
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind IN('f','p')
    UNION ALL SELECT 'constraint',c.oid::text,c.conname,NULL,NULL,pg_get_constraintdef(c.oid)
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relnamespace='public'::regnamespace
    UNION ALL SELECT 'index',i.indexrelid::text,c.relname,NULL,NULL,pg_get_indexdef(i.indexrelid)
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'sequence',s.seqrelid::text,c.relname,NULL,NULL,
      concat_ws(':',s.seqtypid,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle)
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'trigger',g.oid::text,g.tgname,NULL,NULL,pg_get_triggerdef(g.oid)||':'||g.tgenabled::text
    FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT g.tgisinternal
    ORDER BY kind,key`);
  async function rows() {
    const tables = await f.exec("SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname");
    expect(tables).toHaveLength(282);
    return f.exec(tables.map(({ name }) => {
      expect(name).toMatch(/^[a-z_][a-z_0-9]*$/);
      return `SELECT '${name}' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${name}" t`;
    }).join(' UNION ALL ') + ' ORDER BY name');
  }
  async function oldForwardsNoop(target: Target, stage: 'pre-sign-day' | 'pre-agent-levels') {
    for (const forward of [runSeckillScheduleRuntimeUpgrade, runSeckillParentRuntimeUpgrade,
      runCouponTemplateRuntimeUpgrade, runPromotionGiftRuntimeUpgrade]) {
      const before = await catalog();
      expect(await forward(f.db, target)).toMatchObject({ applied: false, profileStage: stage });
      expect(await catalog()).toEqual(before);
    }
  }

  it('adds only the fixed guard and eight Admin ACL changes; preserves every existing object, row and prior forward', async () => {
    await roles(async (app, admin, target) => {
      expect(app.pid).not.toBe(admin.pid);
      expect(await inspectSignDayConfigRuntimeCatalog(f.db, target.maintenance,target)).toMatchObject({ ready: true });
      expect(await inspectRuntimeSignDayGroupLockBoundary(f.db,target)).toMatchObject({absent:true,ready:false});
      expect(await profile(app, 'app', target)).toMatchObject({ ready: true, failures: [] });
      expect(await profile(admin, 'admin', target)).toMatchObject({ ready: true, failures: [] });
      expect(await auditFrozenSignDayProfile(admin.db, 'admin', target)).toMatchObject({ ready: false });
      await oldForwardsNoop(target, 'pre-sign-day');
      const before = await catalog(), data = await rows(), appBefore = await profile(app, 'app', target);
      expect(await runSignDayConfigRuntimeUpgrade(f.db, target)).toMatchObject({ applied: true, profileStage: 'pre-agent-levels' });
      const after = await catalog();
      expect(after).toHaveLength(before.length+2);
      const added=after.filter(row=>!before.some(old=>old.kind===row.kind && old.key===row.key));
      expect(added.map(row=>({kind:row.kind,name:row.name}))).toEqual([
        {kind:'function',name:SIGN_DAY_GROUP_LOCK_BOUNDARY},{kind:'trigger',name:SIGN_DAY_GROUP_LOCK_BOUNDARY}]);
      const changed = before.filter(old => after.some(row => row.kind === old.kind && row.key === old.key
        && JSON.stringify(row) !== JSON.stringify(old)));
      expect(changed.map(row => row.name).sort()).toEqual(['system_group', 'system_group.id', 'system_group_data',
        'system_group_data.value', 'system_group_data.sort', 'system_group_data.status',
        'system_group_id_seq', 'system_group_data_id_seq'].sort());
      expect(after.filter(row => !added.some(item=>row.kind===item.kind && row.key===item.key)
        && !changed.some(old => row.kind === old.kind && row.key === old.key)))
        .toEqual(before.filter(row => !changed.some(old => row.kind === old.kind && row.key === old.key)));
      expect(await rows()).toEqual(data);
      expect(await auditFrozenSignDayProfile(app.db, 'app', target)).toEqual(appBefore);
      expect(await auditFrozenSignDayProfile(admin.db, 'admin', target)).toMatchObject({ ready: true, failures: [] });
      expect(await inspectRuntimeSignDayGroupLockBoundary(f.db,target)).toMatchObject({absent:false,ready:true});
      expect(await runSignDayConfigRuntimeUpgrade(f.db, target)).toMatchObject({ applied: false, profileStage: 'pre-agent-levels' });
      await oldForwardsNoop(target, 'pre-agent-levels');
      expect(await catalog()).toEqual(after); expect(await rows()).toEqual(data);
    });
  }, 60_000);

  it('lets the real Admin initialize the missing fixed group and edit/status/delete with receipts; denies metadata and app writes', async () => {
    await roles(async (app, admin, target) => {
      await runSignDayConfigRuntimeUpgrade(f.db, target);
      await f.exec("DELETE FROM system_group_data WHERE gid IN(SELECT id FROM system_group WHERE config_name='sign_day_num');DELETE FROM system_group WHERE config_name='sign_day_num'");
      const svc = new AdminSignDayConfigService(createContainerFromDb(admin.db)), actor = { id: 41 };
      const empty = await svc.list(); expect(empty).toMatchObject({ group_present: false, count: 0 });
      const body = { revision: empty.revision, request_id: randomUUID(), day: ' 第一天 🌿 ', sign_num: 15, sort: 7, status: 1 };
      const created = await svc.mutate('create', undefined, body, actor);
      expect(await svc.mutate('create', undefined, body, actor)).toEqual(created);
      expect(await svc.receipt(body.request_id, actor)).toEqual(created);
      let entry = (await svc.detail(created.id)).info;
      await admin.exec(`SELECT id FROM system_group WHERE id=${entry.gid} FOR SHARE`);
      const metadata = await app.exec(`SELECT * FROM system_group WHERE id=${entry.gid}`);
      await sqlState(admin.exec(`UPDATE system_group SET id=id+1 WHERE id=${entry.gid}`), '42501');
      expect(await admin.exec(`UPDATE system_group SET id=id WHERE id=${entry.gid} RETURNING id`)).toEqual([{id:entry.gid}]);
      entry=(await svc.detail(created.id)).info;
      for (const assignment of ["name='rewrite'", "info='rewrite'", "config_name='other'", "fields='[]'", 'cate_id=9'])
        await sqlState(admin.exec(`UPDATE system_group SET ${assignment} WHERE id=${entry.gid}`), '42501');
      await sqlState(admin.exec(`DELETE FROM system_group WHERE id=${entry.gid}`), '42501');
      await sqlState(admin.db.transaction(tx=>tx.execute(sql.raw('LOCK TABLE system_group IN SHARE ROW EXCLUSIVE MODE'))), '42501');
      for (const assignment of ['id=id', 'gid=gid', 'add_time=add_time'])
        await sqlState(admin.exec(`UPDATE system_group_data SET ${assignment} WHERE id=${created.id}`), '42501');
      await svc.mutate('update', created.id, { ...body, revision: entry.revision, request_id: randomUUID(), day: '第二天', sign_num: 25, sort: 8 }, actor);
      entry = (await svc.detail(created.id)).info; expect(entry).toMatchObject({ day: '第二天', sign_num: 25, sort: 8 });
      await svc.mutate('status', created.id, { revision: entry.revision, request_id: randomUUID(), status: 0 }, actor);
      entry = (await svc.detail(created.id)).info; expect(entry.status).toBe(0);
      const removed = await svc.mutate('delete', created.id, { revision: entry.revision, request_id: randomUUID() }, actor);
      expect((await svc.list()).count).toBe(0); expect(await svc.receipt(removed.request_id, actor)).toEqual(removed);
      expect(await app.exec(`SELECT * FROM system_group WHERE id=${entry.gid}`)).toEqual(metadata);
      for (const statement of ["INSERT INTO system_group(config_name) VALUES('app_forbidden')", 'UPDATE system_group SET id=id',
        'DELETE FROM system_group', 'SELECT id FROM system_group FOR SHARE', 'INSERT INTO system_group_data(gid) VALUES(0)',
        'UPDATE system_group_data SET value=value,sort=sort,status=status', 'DELETE FROM system_group_data',
        "SELECT nextval('system_group_id_seq')", "SELECT nextval('system_group_data_id_seq')"])
        await sqlState(app.exec(statement), '42501');
      await sqlState(app.db.transaction(tx=>tx.execute(sql.raw('LOCK TABLE system_group_data IN SHARE ROW EXCLUSIVE MODE'))), '42501');
      expect(await app.exec('SELECT * FROM system_group_data')).toEqual(await admin.exec('SELECT * FROM system_group_data'));
      for (const peer of [app, admin]) {
        expect(await peer.exec("INSERT INTO system_log(type) VALUES('runtime_shared_log') RETURNING id")).toHaveLength(1);
        await sqlState(peer.exec('DELETE FROM system_log'), '42501');
        for (const sequence of ['system_group_id_seq', 'system_group_data_id_seq'])
          await sqlState(peer.exec(`SELECT setval('${sequence}',1,true)`), '42501');
      }
      expect(await admin.exec("SELECT count(*)::integer AS n FROM system_log WHERE type='sign_day_config' AND admin_id=41")).toEqual([{ n: 4 }]);
      await f.exec(`CREATE FUNCTION sign_day_late_mutation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.id=NEW.id+1;RETURN NEW;END$$;
        CREATE TRIGGER zz_sign_day_late_mutation BEFORE UPDATE ON system_group FOR EACH ROW EXECUTE FUNCTION sign_day_late_mutation()`);
      try {
        await sqlState(admin.exec(`UPDATE system_group SET id=id WHERE id=${entry.gid}`),'42501');
        expect(await app.exec(`SELECT * FROM system_group WHERE id=${entry.gid}`)).toEqual(metadata);
        expect(await inspectRuntimeSignDayGroupLockBoundary(f.db,target)).toMatchObject({ready:false});
      } finally {
        await f.exec('DROP TRIGGER zz_sign_day_late_mutation ON system_group;DROP FUNCTION sign_day_late_mutation()');
      }
      expect(await auditFrozenSignDayProfile(admin.db, 'admin', target)).toMatchObject({ ready: true });
      expect(await auditFrozenSignDayProfile(app.db, 'app', target)).toMatchObject({ ready: true });
    });
  }, 60_000);

  it('refuses partial, extra, delegated, app or schema/sequence grants without repairing drift', async () => {
    await roles(async (app, admin, target) => {
      const data = await rows();
      for (const mutation of [
        `GRANT INSERT ON system_group TO "${admin.role}"`,
        `GRANT UPDATE ON system_group TO "${admin.role}"`,
        `GRANT UPDATE(gid) ON system_group_data TO "${admin.role}"`,
        `GRANT UPDATE(id) ON system_group TO "${admin.role}" WITH GRANT OPTION`,
        `GRANT USAGE ON SEQUENCE system_group_id_seq TO "${admin.role}"`,
        `GRANT INSERT ON system_group_data TO "${app.role}"`,
        'ALTER SEQUENCE system_group_data_id_seq OWNED BY NONE',
        'ALTER SEQUENCE system_group_id_seq CACHE 2',
        "ALTER TABLE system_group_data ALTER COLUMN gid SET DEFAULT 9",
        'ALTER TABLE system_group ALTER COLUMN name TYPE varchar(51)',
        'CREATE INDEX sign_day_unreviewed_idx ON system_group_data(gid)',
        `ALTER TABLE system_group OWNER TO "${f.pricingOwner}"`,
        `CREATE FUNCTION sign_day_unreviewed_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$;
          CREATE TRIGGER sign_day_unreviewed_trigger BEFORE INSERT ON system_group_data FOR EACH ROW EXECUTE FUNCTION sign_day_unreviewed_trigger();
          ALTER TABLE system_group_data DISABLE TRIGGER sign_day_unreviewed_trigger`,
      ]) {
        const before = await catalog();
        await expect(f.db.transaction(async tx => {
          await tx.execute(sql.raw(mutation));
          await expect(installSignDayConfigRuntimeUpgradeInTransaction(tx, target)).rejects.toThrow();
          throw Error('rollback invalid sign-day fixture');
        })).rejects.toThrow('rollback invalid sign-day fixture');
        expect(await catalog()).toEqual(before); expect(await rows()).toEqual(data);
      }
      const before=await catalog();
      await expect(f.db.transaction(async tx=>{
        await installRuntimeSignDayGroupLockBoundaryInTransaction(tx,target);
        await expect(installSignDayConfigRuntimeUpgradeInTransaction(tx,target)).rejects.toThrow('exact pre-sign-day profile required');
        throw Error('rollback partial guard fixture');
      })).rejects.toThrow('rollback partial guard fixture');
      expect(await catalog()).toEqual(before);expect(await rows()).toEqual(data);
    });
  }, 60_000);

  it('rolls back every late grant failure and rejects wrong database, role, transaction and competing maintenance gate', async () => {
    await roles(async (app, _admin, target) => {
      const before = await catalog(), data = await rows();
      await expect(f.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout='1500ms'; SET LOCAL lock_timeout='500ms'; SET LOCAL idle_in_transaction_session_timeout='1500ms'`);
        expect(await installSignDayConfigRuntimeUpgradeInTransaction(tx, target)).toMatchObject({ applied: true });
        const [settings] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,
          current_setting('idle_in_transaction_session_timeout') AS idle`);
        expect(settings).toEqual({ statement: '1500ms', lock: '500ms', idle: '1500ms' });
        throw Error('late sign-day forward failure');
      })).rejects.toThrow('late sign-day forward failure');
      await expect(runSignDayConfigRuntimeUpgrade(f.db, { ...target, database: 'wrong_database' })).rejects.toThrow('database requires review');
      await expect(runSignDayConfigRuntimeUpgrade(app.db, target)).rejects.toThrow('requires review');
      await expect(installSignDayConfigRuntimeUpgradeInTransaction(f.db, target)).rejects.toThrow('existing transaction');
      await expect(f.db.transaction(tx => installSignDayConfigRuntimeUpgradeInTransaction(tx, target),
        { isolationLevel: 'repeatable read' })).rejects.toThrow('requires review');
      await expect(f.db.transaction(tx => installSignDayConfigRuntimeUpgradeInTransaction(tx, target),
        { accessMode: 'read only' })).rejects.toThrow('requires review');
      await f.withPeer!(async peer => {
        await peer.exec('BEGIN;SELECT pg_advisory_xact_lock(731626,6)');
        try { await expect(runSignDayConfigRuntimeUpgrade(f.db, target)).rejects.toThrow('busy'); }
        finally { await peer.exec('ROLLBACK'); }
      });
      expect(await catalog()).toEqual(before); expect(await rows()).toEqual(data);
    });
  }, 60_000);

  it('refuses a committed DDL winner after waiting for the fixed table locks, leaving prior ACLs and all rows intact', async () => {
    await roles(async (app, admin, target) => {
      const before = await catalog(), data = await rows(), [identity] = await f.exec('SELECT pg_backend_pid() AS pid');
      await f.withPeer!(holder => f.withPeer!(async observer => {
        await holder.exec('BEGIN;ALTER TABLE system_group_data ALTER COLUMN gid SET DEFAULT 9');
        const pending = runSignDayConfigRuntimeUpgrade(f.db, target).then(
          () => ({ ok: true, error: undefined }), error => ({ ok: false, error }));
        try {
          let blocked = false;
          const deadline = Date.now() + 800;
          while (Date.now() < deadline) {
            const [row] = await observer.exec(`SELECT ${holder.pid}=ANY(pg_blocking_pids(${Number(identity.pid)})) AS blocked`);
            if (row.blocked === true) { blocked = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          await holder.exec('COMMIT');
          const result = await pending; expect(result.ok).toBe(false);
          expect(String(result.error)).toContain('exact catalog required');
        } finally { await holder.exec('ROLLBACK'); await pending; }
      }));
      const after = await catalog();
      expect(after.map(({ kind, key, acl, owner }) => ({ kind, key, acl, owner })))
        .toEqual(before.map(({ kind, key, acl, owner }) => ({ kind, key, acl, owner })));
      expect(await rows()).toEqual(data);
      expect(await inspectSignDayConfigRuntimeCatalog(f.db, target.maintenance,target)).toMatchObject({ ready: false });
      await sqlState(admin.exec('INSERT INTO system_group_data(gid) VALUES(0)'), '42501');
      await sqlState(app.exec('INSERT INTO system_group_data(gid) VALUES(0)'), '42501');
    });
  }, 60_000);

  it('refuses unreviewed existing group structure during initial commissioning without granting either fresh LOGIN', async () => {
    await roles(async (app, admin, target) => {
      await f.exec('ALTER TABLE system_group ALTER COLUMN name TYPE varchar(51)');
      const before = await catalog(), data = await rows();
      await expect(runRuntimeBusinessCommissioning(f.db, { ...target, pricingOwner: f.pricingOwner })).rejects.toThrow('exact catalog required');
      expect(await catalog()).toEqual(before); expect(await rows()).toEqual(data);
      for (const peer of [app, admin]) {
        await sqlState(peer.exec('SELECT * FROM system_group'), '42501');
        await sqlState(peer.exec('SELECT * FROM system_group_data'), '42501');
        await sqlState(peer.exec('SELECT * FROM system_log'), '42501');
      }
    }, false, false);
  }, 60_000);

  it('refuses drifted guard body, owner, ACL or disabled/missing triggers without replacing or granting anything',async()=>{
    await roles(async (_app,admin,target)=>{
      const data=await rows();
      for(const mutation of [
        `CREATE OR REPLACE FUNCTION public.${SIGN_DAY_GROUP_LOCK_BOUNDARY}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
          SET search_path=pg_catalog,pg_temp AS $$BEGIN RETURN NEW;END$$`,
        `ALTER FUNCTION public.${SIGN_DAY_GROUP_LOCK_BOUNDARY}() OWNER TO "${f.pricingOwner}"`,
        `GRANT EXECUTE ON FUNCTION public.${SIGN_DAY_GROUP_LOCK_BOUNDARY}() TO "${admin.role}"`,
        `GRANT EXECUTE ON FUNCTION public.${SIGN_DAY_GROUP_LOCK_BOUNDARY}() TO PUBLIC`,
        `ALTER FUNCTION public.${SIGN_DAY_GROUP_LOCK_BOUNDARY}() RESET search_path`,
        `ALTER FUNCTION public.${SIGN_DAY_GROUP_LOCK_BOUNDARY}() SECURITY DEFINER`,
        `ALTER TABLE system_group DISABLE TRIGGER ${SIGN_DAY_GROUP_LOCK_BOUNDARY}`,
        `DROP TRIGGER ${SIGN_DAY_GROUP_LOCK_BOUNDARY} ON system_group`,
      ]) {
        const before=await catalog();
        await expect(f.db.transaction(async tx=>{
          await tx.execute(sql.raw(mutation));
          await expect(installSignDayConfigRuntimeUpgradeInTransaction(tx,target)).rejects.toThrow('exact catalog required');
          throw Error('rollback drifted guard fixture');
        })).rejects.toThrow('rollback drifted guard fixture');
        expect(await catalog()).toEqual(before);expect(await rows()).toEqual(data);
      }
    },false);
  },60_000);
});
