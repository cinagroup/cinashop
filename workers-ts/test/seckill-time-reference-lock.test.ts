import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { acquireSeckillTimeReferenceLock, inspectSeckillTimeReferenceLock, installSeckillTimeReferenceLock } from '../src/migrations/seckillTimeReferenceLock';
import { seckillTimeReferenceLockCatalogReady } from '../src/migrations/seckillTimeReferenceLockCatalog';
import { SECKILL_TIME_REFERENCE_LOCK_INSTALLATION_SQL } from '../src/migrations/seckillTimeReferenceLockInstallation';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

type Runtime = SequenceRunnerPeer & { role: string; connectionString: string };
const code = (error: unknown): unknown => error && typeof error === 'object'
  ? 'code' in error ? error.code : 'cause' in error ? code(error.cause) : undefined : undefined;

it('keeps external 0167 equal to the reviewed fixed installer', () => {
  expect(readFileSync('migrations/0167_seckill_time_reference_lock.sql', 'utf8')).toBe(SECKILL_TIME_REFERENCE_LOCK_INSTALLATION_SQL);
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 fixed seckill time reference capability', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async () => {
    f = await sequenceRunnerDatabase(); expect(f.format).toBe('pg16');
    await f.exec(`CREATE TABLE public.store_activity(id serial PRIMARY KEY,value text);
      CREATE TABLE public.store_seckill(id serial PRIMARY KEY,value text);
      CREATE TABLE public.store_seckill_time(id serial PRIMARY KEY,value text);
      CREATE TABLE public.unrelated_data(id serial PRIMARY KEY,value text);
      INSERT INTO store_activity(value) VALUES('parent'); INSERT INTO store_seckill(value) VALUES('child');
      INSERT INTO store_seckill_time(value) VALUES('slot');`);
  }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);
  const snapshot = () => f.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_activity t) AS parents,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_seckill t) AS children,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_seckill_time t) AS slots`);
  const withRoles = async (run: (owner: string, admin: Runtime) => Promise<void>, install = true) => {
    const role = f.withRuntimeRole; if (!role) throw Error('Real LOGIN required');
    const owner = 'cinashop_runtime_' + randomUUID().replaceAll('-', '');
    await f.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    try {
      await role(async admin => {
        await f.exec(`GRANT SELECT ON store_activity,store_seckill TO "${admin.role}";
          GRANT SELECT,INSERT,UPDATE,DELETE ON store_seckill_time TO "${admin.role}";
          GRANT USAGE ON SEQUENCE store_seckill_time_id_seq TO "${admin.role}"`);
        if (install) {
          await installSeckillTimeReferenceLock(f.db, owner);
          await f.exec(`GRANT EXECUTE ON FUNCTION public.admin_lock_seckill_time_references_v1() TO "${admin.role}"`);
        }
        await run(owner, admin);
      });
    } finally {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(owner)) throw Error('Unsafe owned role cleanup');
      await f.exec(`DROP OWNED BY "${owner}"; DROP ROLE "${owner}"`);
      expect((await f.query(`SELECT oid FROM pg_roles WHERE rolname='${owner}'`)).rows).toEqual([]);
    }
  };
  const rejectedSql = async (runtime: Runtime, statement: string, expected = '42501') => {
    const result = await outcome(withTx(createContainerFromDb(runtime.db), tx => tx.execute(sql.raw(statement))));
    expect(result.ok).toBe(false); if (!result.ok) expect(code(result.error)).toBe(expected);
  };
  it('reproduces direct EXCLUSIVE 42501, then locks only fixed parent and child for a real admin LOGIN', async () => {
    await withRoles(async (owner, admin) => {
      const before = await snapshot();
      await rejectedSql(admin, 'LOCK TABLE public.store_activity,public.store_seckill IN EXCLUSIVE MODE');
      await installSeckillTimeReferenceLock(f.db, owner);
      await f.exec(`GRANT EXECUTE ON FUNCTION public.admin_lock_seckill_time_references_v1() TO "${admin.role}"`);
      await withTx(createContainerFromDb(admin.db), async tx => {
        await acquireSeckillTimeReferenceLock(tx);
        expect(Array.from(await tx.execute(sql`SELECT n.nspname,c.relname FROM pg_locks l
          JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE l.pid=pg_backend_pid() AND l.mode='ExclusiveLock' ORDER BY c.relname`)))
          .toEqual([{ nspname: 'public', relname: 'store_activity' }, { nspname: 'public', relname: 'store_seckill' }]);
      });
      expect(await snapshot()).toEqual(before);
    }, false);
  });
  it('grants slot UPDATE and DELETE without granting parent DML, table locking, DDL, SET ROLE or delegation', async () => {
    await withRoles(async (owner, admin) => {
      await admin.exec("UPDATE store_seckill_time SET value='changed'; DELETE FROM store_seckill_time; INSERT INTO store_seckill_time(value) VALUES('new slot')");
      for (const table of ['store_activity', 'store_seckill']) for (const statement of [
        `INSERT INTO ${table} DEFAULT VALUES`, `UPDATE ${table} SET id=id`, `DELETE FROM ${table}`,
        `TRUNCATE ${table}`, `LOCK TABLE ${table} IN EXCLUSIVE MODE`, `ALTER TABLE ${table} ADD COLUMN forbidden int`,
      ]) await rejectedSql(admin, statement);
      await rejectedSql(admin, `SET ROLE "${owner}"`);
      await rejectedSql(admin, 'ALTER FUNCTION public.admin_lock_seckill_time_references_v1() IMMUTABLE');
      const [delegation] = await admin.db.execute(sql`SELECT has_function_privilege(current_user,
        'public.admin_lock_seckill_time_references_v1()','EXECUTE WITH GRANT OPTION') AS can_delegate`);
      expect(delegation.can_delegate).toBe(false);
      await rejectedSql(admin, "SELECT public.admin_lock_seckill_time_references_v1('store_order')", '42883');
      expect(seckillTimeReferenceLockCatalogReady(await inspectSeckillTimeReferenceLock(admin.db))).toBe(true);
    });
  });
  it('denies app and PUBLIC execution and root acquisition', async () => {
    await withRoles(async (_owner, admin) => {
      const role = f.withRuntimeRole; if (!role) throw Error('Real LOGIN required');
      await role(async app => {
        await f.exec(`GRANT SELECT ON store_activity,store_seckill,store_seckill_time TO "${app.role}"`);
        await rejectedSql(app, 'SELECT public.admin_lock_seckill_time_references_v1()');
        await rejectedSql(app, 'UPDATE store_seckill_time SET value=value');
        await rejectedSql(app, 'DELETE FROM store_seckill_time');
      });
      const [acl] = await f.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_proc p,
        LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.proname='admin_lock_seckill_time_references_v1' AND a.grantee=0) AS public_grant`);
      expect(acl.public_grant).toBe(false);
      await expect(acquireSeckillTimeReferenceLock(admin.db)).rejects.toThrow('existing transaction');
    });
  });
  it('reinstalls with stable function identity, owner, ACL and business rows', async () => {
    await withRoles(async (owner) => {
      const before = await snapshot(), state = await inspectSeckillTimeReferenceLock(f.db);
      const acl = await f.query("SELECT oid,proowner,proacl FROM pg_proc WHERE proname='admin_lock_seckill_time_references_v1'");
      expect(await installSeckillTimeReferenceLock(f.db, owner)).toEqual(state);
      expect(await f.query("SELECT oid,proowner,proacl FROM pg_proc WHERE proname='admin_lock_seckill_time_references_v1'")).toEqual(acl);
      expect(await snapshot()).toEqual(before);
    });
  });
  it.each(['repeatable read', 'serializable'] as const)('rejects %s and preserves stricter transaction deadlines', async isolation => {
    await withRoles(async (_owner, admin) => {
      const result = await outcome(admin.db.transaction(tx => tx.execute(sql`SELECT public.admin_lock_seckill_time_references_v1()`), { isolationLevel: isolation }));
      expect(result.ok).toBe(false); if (!result.ok) expect(code(result.error)).toBe('25000');
      await withTx(createContainerFromDb(admin.db), async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout='1500ms'; SET LOCAL lock_timeout='750ms'; SET LOCAL idle_in_transaction_session_timeout='4000ms'`);
        await acquireSeckillTimeReferenceLock(tx);
        const [settings] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,
          current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
        expect(settings).toEqual({ statement: '1500ms', lock: '750ms', idle: '4s' });
      });
    });
  });
  it('ignores pg_temp shadows and keeps only the two permanent tables locked', async () => {
    await withRoles(async (_owner, admin) => {
      await admin.exec('CREATE TEMP TABLE store_activity(id int); CREATE TEMP TABLE store_seckill(id int); SET search_path=pg_temp,public');
      await withTx(createContainerFromDb(admin.db), async tx => {
        await acquireSeckillTimeReferenceLock(tx);
        expect(Array.from(await tx.execute(sql`SELECT n.nspname,c.relname FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=pg_backend_pid() AND l.mode='ExclusiveLock' ORDER BY c.relname`)))
          .toEqual([{ nspname: 'public', relname: 'store_activity' }, { nspname: 'public', relname: 'store_seckill' }]);
      });
    });
  });
  it.each(['store_activity', 'store_seckill'].flatMap(table => ['commit', 'rollback'].map(ending => ({ table, ending }))))
    ('holds the real $table writer until $ending while allowing public reads', async ({ table, ending }) => {
      await withRoles(async (_owner, admin) => {
        const peer = f.withPeer; if (!peer) throw Error('Real peers required');
        await peer(async writer => { await peer(async observer => {
          let writing: ReturnType<typeof outcome> | undefined;
          try {
            const locking = outcome(withTx(createContainerFromDb(admin.db), async tx => {
              await acquireSeckillTimeReferenceLock(tx);
              writing = outcome(writer.exec(`UPDATE public.${table} SET value='writer' WHERE id=1`));
              await waitForFinanceBlock(observer.db, writer.pid, admin.pid);
              expect((await observer.exec(`SELECT value FROM public.${table} WHERE id=1`))[0].value).toBe(table === 'store_activity' ? 'parent' : 'child');
              if (ending === 'rollback') throw Error('controlled rollback');
            }));
            expect((await locking).ok).toBe(ending === 'commit');
            expect(writing).toBeDefined(); expect((await writing)?.ok).toBe(true);
          } finally { await writing; }
        }); });
      });
    });
  it('waits in parent-before-child order and rolls back an earlier parent lock on the bounded child timeout', async () => {
    await withRoles(async (_owner, admin) => {
      const peer = f.withPeer; if (!peer) throw Error('Real peers required');
      await peer(async holder => { await peer(async observer => {
        await holder.exec('BEGIN; LOCK TABLE store_seckill IN ROW SHARE MODE');
        try {
          const locking = outcome(withTx(createContainerFromDb(admin.db), async tx => {
            await tx.execute(sql`SET LOCAL lock_timeout='1500ms'`); await acquireSeckillTimeReferenceLock(tx);
          }));
          await waitForFinanceBlock(observer.db, admin.pid, holder.pid);
          const held = await observer.exec(`SELECT c.relname,l.granted FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
            WHERE l.pid=${admin.pid} AND l.mode='ExclusiveLock' ORDER BY c.relname`);
          expect(held.map(row => ({ relname: row.relname, granted: row.granted })))
            .toEqual([{ relname: 'store_activity', granted: true }, { relname: 'store_seckill', granted: false }]);
          const result = await locking; expect(result.ok).toBe(false); if (!result.ok) expect(code(result.error)).toBe('55P03');
          expect(await observer.exec(`SELECT 1 FROM pg_locks WHERE pid=${admin.pid} AND mode='ExclusiveLock'`)).toEqual([]);
        } finally { await holder.exec('ROLLBACK'); }
      }); });
    });
  });
  it.each([
    ['body', "CREATE OR REPLACE FUNCTION public.admin_lock_seckill_time_references_v1() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN NULL; END'"],
    ['invoker', 'ALTER FUNCTION public.admin_lock_seckill_time_references_v1() SECURITY INVOKER'],
    ['path', 'ALTER FUNCTION public.admin_lock_seckill_time_references_v1() SET search_path=public,pg_temp'],
    ['public execute', 'GRANT EXECUTE ON FUNCTION public.admin_lock_seckill_time_references_v1() TO PUBLIC'],
    ['overload', "CREATE FUNCTION public.admin_lock_seckill_time_references_v1(int) RETURNS void LANGUAGE plpgsql AS 'BEGIN NULL; END'"],
    ['rls', 'ALTER TABLE public.store_activity ENABLE ROW LEVEL SECURITY'],
  ])('refuses %s drift without silently repairing it', async (_kind, statement) => {
    await withRoles(async (owner, admin) => {
      const before = await snapshot(); await f.exec(statement);
      expect(seckillTimeReferenceLockCatalogReady(await inspectSeckillTimeReferenceLock(f.db))).toBe(false);
      await expect(withTx(createContainerFromDb(admin.db), tx => acquireSeckillTimeReferenceLock(tx))).rejects.toThrow('requires review');
      await expect(installSeckillTimeReferenceLock(f.db, owner)).rejects.toThrow('requires review');
      expect(await snapshot()).toEqual(before);
    });
  });
  it.each(['LOGIN', 'CREATEDB', 'CREATEROLE', 'BYPASSRLS'])('refuses owner %s expansion', async attribute => {
    await withRoles(async (owner, admin) => {
      await f.exec(`ALTER ROLE "${owner}" ${attribute}`);
      expect(seckillTimeReferenceLockCatalogReady(await inspectSeckillTimeReferenceLock(f.db))).toBe(false);
      await expect(withTx(createContainerFromDb(admin.db), tx => acquireSeckillTimeReferenceLock(tx))).rejects.toThrow('requires review');
    });
  });
  it.each(['incoming membership', 'outgoing membership', 'unrelated DML', 'column insert', 'column references', 'column grant option', 'grant option', 'execute delegation'])
    ('refuses owner or ACL authority expansion: %s', async mode => {
      await withRoles(async (owner, admin) => {
        await f.exec(mode === 'incoming membership' ? `GRANT "${owner}" TO "${admin.role}" WITH INHERIT FALSE,SET FALSE`
          : mode === 'outgoing membership' ? `GRANT "${admin.role}" TO "${owner}" WITH INHERIT FALSE,SET FALSE`
          : mode === 'unrelated DML' ? `GRANT UPDATE(value) ON unrelated_data TO "${owner}"`
          : mode === 'column insert' ? `GRANT INSERT(value) ON unrelated_data TO "${owner}"`
          : mode === 'column references' ? `GRANT REFERENCES(id) ON unrelated_data TO "${owner}"`
          : mode === 'column grant option' ? `GRANT UPDATE(value) ON store_activity TO "${owner}" WITH GRANT OPTION`
          : mode === 'grant option' ? `GRANT UPDATE ON store_activity TO "${owner}" WITH GRANT OPTION`
          : `GRANT EXECUTE ON FUNCTION public.admin_lock_seckill_time_references_v1() TO "${admin.role}" WITH GRANT OPTION`);
        expect(seckillTimeReferenceLockCatalogReady(await inspectSeckillTimeReferenceLock(f.db))).toBe(false);
        await expect(withTx(createContainerFromDb(admin.db), tx => acquireSeckillTimeReferenceLock(tx))).rejects.toThrow('requires review');
        await expect(installSeckillTimeReferenceLock(f.db, owner)).rejects.toThrow(/review|NOLOGIN/);
      });
    });
  it('refuses maintenance races and leaves no function or new owner grants after failed first installation', async () => {
    await withRoles(async (owner, admin) => {
      const peer = f.withPeer; if (!peer) throw Error('Real peers required');
      await peer(async writer => {
        await writer.exec('BEGIN; UPDATE store_activity SET value=value');
        try {
          const result = await outcome(installSeckillTimeReferenceLock(f.db, owner));
          expect(result.ok).toBe(false); if (!result.ok) expect(code(result.error)).toBe('55P03');
        } finally { await writer.exec('ROLLBACK'); }
      });
      expect((await inspectSeckillTimeReferenceLock(f.db)).absent).toBe(true);
      const [rights] = await f.db.execute(sql`SELECT has_table_privilege(${owner},'public.store_activity','UPDATE') AS writable,
        has_schema_privilege(${owner},'public','CREATE') AS creatable`);
      expect(rights).toEqual({ writable: false, creatable: false });
      await installSeckillTimeReferenceLock(f.db, owner);
      await f.exec(`GRANT EXECUTE ON FUNCTION public.admin_lock_seckill_time_references_v1() TO "${admin.role}"`);
      await withTx(createContainerFromDb(admin.db), async tx => {
        await acquireSeckillTimeReferenceLock(tx);
        await expect(installSeckillTimeReferenceLock(f.db, owner)).rejects.toThrow('busy');
      });
    }, false);
  });
  it('rejects missing or unsafe owner/schema settings and a LOGIN owner before installing', async () => {
    await withRoles(async (owner, admin) => {
      await expect(installSeckillTimeReferenceLock(f.db, undefined)).rejects.toThrow('explicit safe NOLOGIN');
      await expect(installSeckillTimeReferenceLock(f.db, admin.role)).rejects.toThrow('NOLOGIN');
      for (const schema of ['public;select 1', 'pg_temp', 'a'.repeat(64)])
        await expect(installSeckillTimeReferenceLock(f.db, owner, schema)).rejects.toThrow('identifier');
      expect((await inspectSeckillTimeReferenceLock(f.db)).absent).toBe(true);
    }, false);
  });
});
