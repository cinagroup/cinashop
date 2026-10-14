import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '@/lib/di';
import { systemLog, user, userGroup } from '@/models/schema';
import { AdminUserGroupService } from '@/services/admin/AdminUserGroupService';
import { UserSegmentationService } from '@/services/user/UserSegmentationService';
import { groupActor, groupSchema, seedUserGroups } from './helpers/adminUserGroups';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Login = SequenceRunnerPeer & { role: string };
function code(error: unknown): string {
  for (let depth = 0; depth < 6 && error && typeof error === 'object'; depth++) {
    if ('code' in error) return String(error.code);
    error = 'cause' in error ? error.cause : undefined;
  }
  return '';
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('user-group lifecycle on independent PG16 LOGINs', () => {
  let f: Fixture, ddl: string;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(groupSchema))).join('\n');
  });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native user-group fixture forbids external I/O'));
    f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Independent PG16 LOGIN peers required');
    await f.exec(ddl);
    await seedUserGroups(f.db);
    await f.exec("SELECT setval(pg_get_serial_sequence('user_group','id'),100,false)");
  }, 60000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);

  const service = (peer: SequenceRunnerPeer) => new AdminUserGroupService(createContainerFromDb(peer.db));
  async function login<T>(write: boolean, run: (peer: Login) => Promise<T>) {
    return f.withRuntimeRole!(async peer => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe owned LOGIN');
      await f.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${peer.role}"`);
      if (write) await f.exec(`GRANT INSERT,UPDATE,DELETE ON public.user_group,public.system_log TO "${peer.role}";
        GRANT UPDATE ON public.system_admin,public.system_role TO "${peer.role}";
        GRANT UPDATE(id) ON public.system_menus TO "${peer.role}";
        GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${peer.role}"`);
      const [identity] = await peer.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version");
      expect(identity).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid });
      expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      return run(peer);
    });
  }
  async function snapshot() {
    return { groups: await f.db.select().from(userGroup).orderBy(userGroup.id),
      users: await f.db.select().from(user).orderBy(user.uid),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) };
  }
  async function waitFor(observer: SequenceRunnerPeer, statement: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [row] = await observer.exec(statement);
      if (row?.waiting === true) return;
      await new Promise(done => setTimeout(done, 10));
    }
    throw Error('Expected independent PostgreSQL lock wait was not observed');
  }

  it('reads with SELECT-only authority and denies writes without authority barrier privileges', async () => {
    await login(false, async peer => {
      expect((await service(peer).list(new URLSearchParams(), groupActor(105))).count).toBe(3);
      expect(await service(peer).form(20, new URLSearchParams(), groupActor(105)))
        .toMatchObject({ title: '修改分组' });
      expect(await service(peer).list(new URLSearchParams('group_name=会员'), groupActor(105), false))
        .toEqual({ list: [{ id: 20, group_name: '会员' }], count: 1, page: 1, limit: 20 });
      const [acl] = await peer.exec("SELECT has_table_privilege(current_user,'public.user_group','SELECT') AS reads,has_table_privilege(current_user,'public.user_group','UPDATE') AS writes,has_table_privilege(current_user,'public.system_admin','UPDATE') AS authority_writes");
      expect(acl).toEqual({ reads: true, writes: false, authority_writes: false });
      const before = await snapshot();
      const error = await service(peer).save({ group_name: '只读数据库拒绝' }, groupActor())
        .then(() => null, error => error);
      expect(code(error)).toBe('42501');
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);

  it('writes with bounded catalog ACL and numeric authority without user DML or semantic menu UPDATE', async () => {
    await login(true, async peer => {
      const [acl] = await peer.exec("SELECT has_column_privilege(current_user,'public.system_menus','id','UPDATE') AS menu_lock,has_column_privilege(current_user,'public.system_menus','api_url','UPDATE') AS menu_rewrite,has_table_privilege(current_user,'public.user','UPDATE') AS user_write");
      expect(acl).toEqual({ menu_lock: true, menu_rewrite: false, user_write: false });
      await expect(peer.exec("UPDATE public.system_menus SET api_url='forged' WHERE id=265"))
        .rejects.toMatchObject({ code: '42501' });
      await expect(peer.exec('UPDATE public."user" SET group_id=20 WHERE uid=1'))
        .rejects.toMatchObject({ code: '42501' });
      const users = await f.db.select().from(user).orderBy(user.uid);
      const created = await service(peer).save({ group_name: '原生分组' }, groupActor(104));
      await service(peer).save({ id: created.id, group_name: '原生编辑' }, groupActor(104));
      expect(await service(peer).remove(created.id, new URLSearchParams(), groupActor(104))).toBe('删除成功!');
      expect(await f.db.select().from(user).orderBy(user.uid)).toEqual(users);
      expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row => JSON.parse(row.action)))
        .toEqual([{ operation: 'create', id: created.id }, { operation: 'update', id: created.id },
          { operation: 'delete', id: created.id }]);
    });
  }, 60000);

  it('serializes concurrent same-name creation into one catalog row and one atomic audit', async () => {
    await login(true, peer => f.withPeer!(async writer => {
      expect(peer.pid).not.toBe(writer.pid);
      const results = await Promise.allSettled([
        service(peer).save({ group_name: '并发唯一分组' }, groupActor()),
        service(writer).save({ group_name: '并发唯一分组' }, groupActor()),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(await f.db.select().from(userGroup).where(eq(userGroup.groupName, '并发唯一分组'))).toHaveLength(1);
      expect(await f.db.select().from(systemLog)).toHaveLength(1);
      await expect(service(peer).save({ group_name: '并发唯一分组' }, groupActor())).rejects.toThrow('已经存在');
    }));
  }, 60000);

  it('keeps deletion outside an uncommitted assignGroup reference and refuses it after assignment commits', async () => {
    await login(true, peer => f.withPeer!(async writer => {
      expect(peer.pid).not.toBe(writer.pid);
      await withTx(createContainerFromDb(writer.db), async tx => {
        await new UserSegmentationService(createContainerFromDb(tx)).assignGroup([1], 20);
        // The exact production assignment service retains KEY SHARE until the
        // outer transaction commits, even across its nested savepoint.
        const error = await service(peer).remove(20, new URLSearchParams(), groupActor())
          .then(() => null, error => error);
        expect(code(error)).toBe('409');
        expect(await tx.select().from(userGroup).where(eq(userGroup.id, 20))).toHaveLength(1);
      });
      await expect(service(peer).remove(20, new URLSearchParams(), groupActor())).rejects.toThrow('仍有用户');
      expect((await f.db.select().from(user).where(eq(user.uid, 1)))[0]).toMatchObject({
        groupId: 20, nowMoney: '18.50', integral: 70 });
      expect(await f.db.select().from(userGroup).where(eq(userGroup.id, 20))).toHaveLength(1);
      expect(await f.db.select().from(systemLog)).toEqual([]);
    }));
  }, 60000);

  it('holds assignGroup until deletion and its audit commit, then rejects the disappeared target without orphan users', async () => {
    await f.exec("CREATE FUNCTION hold_user_group_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731739,0); RETURN NEW; END $$; CREATE TRIGGER hold_user_group_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION hold_user_group_audit_fixture()");
    await login(true, peer => f.withPeer!(async blocker => f.withPeer!(async writer => {
      expect(new Set([peer.pid, writer.pid, blocker.pid]).size).toBe(3);
      await blocker.exec('SELECT pg_advisory_lock(731739,0)');
      const deletion = service(peer).remove(20, new URLSearchParams(), groupActor()).then(() => null, error => error);
      let assignment: Promise<unknown> | undefined, assignmentFinished = false;
      let deletionError: unknown, assignmentError: unknown;
      try {
        await waitFor(blocker, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${peer.pid} AND locktype='advisory' AND classid=731739::oid AND objid=0::oid AND NOT granted) AS waiting`);
        assignment = new UserSegmentationService(createContainerFromDb(writer.db)).assignGroup([1], 20)
          .then(() => { assignmentFinished = true; return null; }, error => { assignmentFinished = true; return error; });
        await waitFor(blocker, `SELECT ${peer.pid}=ANY(pg_blocking_pids(${writer.pid})) AS waiting`);
        expect(assignmentFinished).toBe(false);
        expect((await blocker.exec('SELECT group_id,now_money,integral FROM public."user" WHERE uid=1'))[0])
          .toEqual({ group_id: 10, now_money: '18.50', integral: 70 });
      } finally {
        await blocker.exec('SELECT pg_advisory_unlock(731739,0)');
        [deletionError, assignmentError] = await Promise.all([deletion, assignment ?? Promise.resolve(null)]);
      }
      if (deletionError) throw deletionError;
      expect(assignmentError).toBeInstanceOf(Error);
      expect((assignmentError as Error).message).toContain('用户分组不存在');
      expect(await f.db.select().from(userGroup).where(eq(userGroup.id, 20))).toEqual([]);
      expect((await f.db.select().from(user).where(eq(user.uid, 1)))[0]).toMatchObject({
        groupId: 10, nowMoney: '18.50', integral: 70 });
      expect((await f.db.select().from(systemLog)).map(row => JSON.parse(row.action)))
        .toEqual([{ operation: 'delete', id: 20 }]);
    })));
  }, 60000);

  it('rolls back native creation and deletion completely when the audit trigger refuses commit', async () => {
    await f.exec("CREATE FUNCTION reject_user_group_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'user-group audit refused'; END $$; CREATE TRIGGER reject_user_group_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION reject_user_group_audit_fixture()");
    const before = await snapshot();
    await login(true, async peer => {
      await expect(service(peer).save({ group_name: '审计拒绝创建' }, groupActor())).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      await expect(service(peer).remove(20, new URLSearchParams(), groupActor())).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);
});
