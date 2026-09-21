import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { systemAdmin, systemRole, systemMenus } from '../src/models/schema';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { installRuntimeAdminBoundaryInTransaction, inspectRuntimeAdminBoundary } from '../src/migrations/runtimeAdminBoundary';

describe('shared staff table boundary with an independent PG16 application LOGIN', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson({systemAdmin,systemRole,systemMenus}))).join('\n');
  });
  beforeEach(async () => {
    f = await sequenceRunnerDatabase(); if (!f.withRuntimeRole) throw Error('Owned native PG16 required');
    await f.exec(ddl);
    await f.exec(`INSERT INTO system_admin(id,admin_type,relation_id,account,pwd) VALUES(1,1,0,'platform','unchanged'),(2,4,7,'supplier','old');
      INSERT INTO system_role(id,type,relation_id,rules) VALUES(1,1,0,'platform.view'),(2,4,7,'supplier.view');
      INSERT INTO system_menus(id,menu_name) VALUES(1,'protected');`);
  });
  afterEach(async () => { await f?.close(); });
  const install = (role: string) => f.db.transaction(tx => installRuntimeAdminBoundaryInTransaction(tx, role, 'finance_test'));
  const withApp = async (body: (peer: Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (p: infer P) => unknown ? P : never) => Promise<void>) => {
    await f.withRuntimeRole!(async peer => {
      expect(await install(peer.role)).toMatchObject({ applied: true, ready: true });
      // Deliberately broader DML than the planned column contract: demonstrate
      // that an app SQL statement cannot rewrite platform identity/authority.
      await f.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON system_admin,system_role,system_menus TO "${peer.role}"`);
      await body(peer);
    });
  };
  it('preserves all rows, is idempotent and remains SECURITY INVOKER without callable authority', async () => {
    const before = await f.query('SELECT to_jsonb(t) FROM system_admin t ORDER BY id');
    await withApp(async peer => {
      expect(await inspectRuntimeAdminBoundary(peer.db, peer.role, 'finance_test')).toMatchObject({ready:true});
      const objects = await f.query("SELECT oid::text FROM pg_proc WHERE proname='cinashop_runtime_admin_boundary_v1'");
      expect(await install(peer.role)).toMatchObject({ applied: false, ready: true });
      expect(await f.query("SELECT oid::text FROM pg_proc WHERE proname='cinashop_runtime_admin_boundary_v1'")).toEqual(objects);
      expect((await peer.exec("SELECT prosecdef,has_function_privilege(current_user,oid,'EXECUTE') AS callable FROM pg_proc WHERE proname='cinashop_runtime_admin_boundary_v1'"))[0])
        .toMatchObject({prosecdef:false,callable:false});
    });
    expect(await f.query('SELECT to_jsonb(t) FROM system_admin t ORDER BY id')).toEqual(before);
  });
  it('allows login metadata, supplier account/role management and row locking without platform mutation', async () => {
    await withApp(async peer => {
      await peer.exec("UPDATE system_admin SET last_time=123,login_count=1,last_ip='127.0.0.1' WHERE id=1");
      await peer.exec("UPDATE system_admin SET pwd='new',status=0,roles='2' WHERE id=2");
      await peer.exec("INSERT INTO system_admin(id,admin_type,relation_id,account) VALUES(3,4,7,'supplier-child')");
      await peer.exec("UPDATE system_role SET rules='supplier.manage',role_name='local' WHERE id=2");
      await peer.exec("INSERT INTO system_role(id,type,relation_id,rules) VALUES(3,4,7,'supplier.view')");
      await peer.exec('BEGIN; SELECT id FROM system_admin FOR SHARE; SELECT id FROM system_role FOR SHARE; SELECT id FROM system_menus FOR SHARE; COMMIT');
      expect((await peer.exec('SELECT pwd,last_time,login_count FROM system_admin WHERE id=1'))[0])
        .toMatchObject({pwd:'unchanged',last_time:123,login_count:1});
    });
  });
  it.each([
    "UPDATE system_admin SET pwd='attack' WHERE id=1",
    "UPDATE system_admin SET level=0 WHERE id=1",
    "UPDATE system_admin SET roles='2' WHERE id=1",
    "UPDATE system_admin SET admin_type=4,relation_id=7 WHERE id=1",
    "UPDATE system_admin SET admin_type=1 WHERE id=2",
    "UPDATE system_admin SET relation_id=8 WHERE id=2",
    "UPDATE system_admin SET id=99 WHERE id=2",
    "INSERT INTO system_admin(id,admin_type,relation_id) VALUES(3,1,0)",
    "INSERT INTO system_admin(id,admin_type,relation_id) VALUES(3,4,0)",
    "DELETE FROM system_admin WHERE id=1",
    "UPDATE system_role SET rules='*' WHERE id=1",
    "UPDATE system_role SET type=1 WHERE id=2",
    "UPDATE system_role SET relation_id=8 WHERE id=2",
    "INSERT INTO system_role(id,type,relation_id) VALUES(3,1,0)",
    "DELETE FROM system_role WHERE id=1",
    "UPDATE system_menus SET api_url='*' WHERE id=1",
    "INSERT INTO system_menus(id) VALUES(2)",
    "DELETE FROM system_menus WHERE id=1",
    "ALTER TABLE system_admin DISABLE TRIGGER USER",
    "TRUNCATE system_admin",
    "SET session_replication_role='replica'",
  ])('refuses independent application SQL: %s', async statement => {
    await withApp(async peer => {
      const before = await f.query('SELECT to_jsonb(t) FROM system_admin t ORDER BY id');
      await expect(peer.exec(statement)).rejects.toMatchObject({code:'42501'});
      expect(await f.query('SELECT to_jsonb(t) FROM system_admin t ORDER BY id')).toEqual(before);
    });
  });
  it('does not constrain the separate maintenance identity or repair drift', async () => {
    await withApp(async peer => {
      await f.exec("UPDATE system_admin SET pwd='authorized-maintenance' WHERE id=1");
      await f.exec('ALTER TABLE system_admin DISABLE TRIGGER cinashop_runtime_admin_boundary_v1');
      expect(await inspectRuntimeAdminBoundary(peer.db,peer.role,'finance_test')).toMatchObject({ready:false});
      await expect(install(peer.role)).rejects.toThrow('drift');
    });
  });
  it('rejects a pre-existing different routine without replacement', async () => {
    await f.exec("CREATE FUNCTION public.cinashop_runtime_admin_boundary_v1() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'");
    await f.withRuntimeRole!(async peer => {
      const before = await f.db.execute(sql`SELECT oid,prosrc FROM pg_proc WHERE proname='cinashop_runtime_admin_boundary_v1'`);
      await expect(install(peer.role)).rejects.toThrow('drift');
      expect(await f.db.execute(sql`SELECT oid,prosrc FROM pg_proc WHERE proname='cinashop_runtime_admin_boundary_v1'`)).toEqual(before);
    });
  });
});
