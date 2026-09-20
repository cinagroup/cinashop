import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { acquireCheckoutPricingLock, auditCheckoutPricingLockRuntime, inspectCheckoutPricingLock, installCheckoutPricingLock } from '../src/migrations/checkoutPricingLock';
import { protectCheckoutPricingSources, readCheckoutPricingSources } from '../src/services/order/CheckoutPricingSources';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

type Runtime = SequenceRunnerPeer & {role:string;connectionString:string};
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 reviewed checkout pricing capability',()=>{
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl:string;
  beforeAll(async()=>{const kit=await import('drizzle-kit/api'),schema=await import('../src/models/schema');
    ddl=(await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson(schema))).join('\n');},120000);
  beforeEach(async()=>{f=await sequenceRunnerDatabase();expect(f.format).toBe('pg16');await f.exec(ddl);
    await f.exec("INSERT INTO system_config(menu_name,value) VALUES('whole_free_shipping','0'); INSERT INTO member_right(right_type,number,status) VALUES('express',50,1)");},120000);
  afterEach(async()=>{await f?.close();},120000);
  const withRoles=async(callback:(owner:Pick<Runtime,'role'>,runtime:Runtime)=>Promise<void>,install=true)=>{
    const role=f.withRuntimeRole;if(!role)throw Error('Real LOGIN required');
    const owner={role:'cinashop_runtime_'+randomUUID().replaceAll('-','')};
    await f.exec(`CREATE ROLE "${owner.role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    try {
      await role(async runtime=>{
        await f.exec(`GRANT SELECT ON public.member_right,public.system_config TO "${runtime.role}"`);
        if(install){await installCheckoutPricingLock(f.db,owner.role);
          await f.exec(`GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO "${runtime.role}"`);}
        await callback(owner,runtime);
      });
    } finally {
      if(!/^cinashop_runtime_[a-f0-9]{32}$/.test(owner.role))throw Error('Unsafe owned pricing role cleanup');
      await f.exec(`DROP OWNED BY "${owner.role}"; DROP ROLE "${owner.role}"`);
      expect((await f.query(`SELECT oid FROM pg_roles WHERE rolname='${owner.role}'`)).rows).toEqual([]);
    }
  };
  const snapshot=()=>f.query("SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM system_config t) AS config,(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM member_right t) AS rights");
  const code=(error:unknown):unknown=>error&&typeof error==='object'?('code' in error?error.code:'cause' in error?code(error.cause):undefined):undefined;
  const rejectedSql=async(r:Runtime,statement:string)=>{
    const result=await outcome(withTx(createContainerFromDb(r.db),tx=>tx.execute(sql.raw(statement))));
    expect(result.ok).toBe(false);if(!result.ok)expect(code(result.error)).toBe('42501');
  };

  it('reproduces the existing direct-LOCK 42501, then permits the real readonly LOGIN through the exact capability',async()=>{
    await withRoles(async(owner,r)=>{
      const before=await snapshot();
      const old=await outcome(withTx(createContainerFromDb(r.db),tx=>tx.execute(sql`LOCK TABLE public.member_right, public.system_config IN SHARE MODE NOWAIT`)));
      expect(old.ok).toBe(false);if(!old.ok)expect(code(old.error)).toBe('42501');
      await installCheckoutPricingLock(f.db,owner.role);
      await f.exec(`GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO "${r.role}"`);
      expect(await auditCheckoutPricingLockRuntime(r.db)).toEqual({ready:true,catalogReady:true,callerSafe:true,requiredPrivileges:true,noUnreviewedDefinerRoutine:true});
      await withTx(createContainerFromDb(r.db),async tx=>{await protectCheckoutPricingSources(tx);expect((await readCheckoutPricingSources(tx)).values.whole_free_shipping).toBe('0');});
      expect(await snapshot()).toEqual(before);
    },false);
  });
  it('reinstalls without changing the function OID, ACL, owner or business data',async()=>{
    await withRoles(async(owner,r)=>{const state=await inspectCheckoutPricingLock(f.db),before=await snapshot();
      expect(await installCheckoutPricingLock(f.db,owner.role)).toEqual(state);
      expect((await auditCheckoutPricingLockRuntime(r.db)).ready).toBe(true);expect(await snapshot()).toEqual(before);});
  });
  it('never gives the runtime DML, table lock, DDL, role switching or owner authority',async()=>{
    await withRoles(async(owner,r)=>{
      for(const table of ['member_right','system_config'])for(const statement of [
        `INSERT INTO ${table} DEFAULT VALUES`,`UPDATE ${table} SET id=id`,`DELETE FROM ${table}`,
        `TRUNCATE ${table}`,`LOCK TABLE ${table} IN SHARE MODE`,`ALTER TABLE ${table} ADD COLUMN forbidden int`,
      ])await rejectedSql(r,statement);
      await rejectedSql(r,`SET ROLE "${owner.role}"`);
      await rejectedSql(r,'ALTER FUNCTION public.checkout_lock_pricing_v1() IMMUTABLE');
      expect((await auditCheckoutPricingLockRuntime(r.db)).ready).toBe(true);
    });
  });
  it('rejects an ungranted independent LOGIN and rejects acquisition outside a business transaction',async()=>{
    await withRoles(async(_owner,r)=>{
      const role=f.withRuntimeRole;if(!role)throw Error('LOGIN required');
      await role(async other=>{await rejectedSql(other,'SELECT public.checkout_lock_pricing_v1()');
        expect((await auditCheckoutPricingLockRuntime(other.db)).ready).toBe(false);});
      await expect(acquireCheckoutPricingLock(r.db)).rejects.toThrow('business transaction');
    });
  });
  it.each(['repeatable read','serializable'] as const)('rejects %s snapshots instead of blessing stale pricing',async isolation=>{
    await withRoles(async(_owner,r)=>{const result=await outcome(r.db.transaction(async tx=>{
      await tx.execute(sql`SELECT public.checkout_lock_pricing_v1()`);
    },{isolationLevel:isolation}));expect(result.ok).toBe(false);if(!result.ok)expect(code(result.error)).toBe('25000');});
  });
  it('cannot redirect the capability using pg_temp or shadow tables',async()=>{
    await withRoles(async(_owner,r)=>{await r.exec('CREATE TEMP TABLE member_right(id int); CREATE TEMP TABLE system_config(id int); SET search_path=pg_temp,public');
      await withTx(createContainerFromDb(r.db),async tx=>{await acquireCheckoutPricingLock(tx);
        const rows=await tx.execute(sql`SELECT n.nspname,c.relname FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=pg_backend_pid() AND l.mode='ShareLock' ORDER BY c.relname`);
        expect(Array.from(rows)).toEqual([{nspname:'public',relname:'member_right'},{nspname:'public',relname:'system_config'}]);
      });});
  });
  it.each(['member_right','system_config'].flatMap(table=>['commit','rollback'].map(ending=>({table,ending}))))('holds actual $table peer writers until $ending without writing configuration',async({table,ending})=>{
    await withRoles(async(_owner,r)=>{const peer=f.withPeer;if(!peer)throw Error('Real peers required');
      await peer(async writer=>{await peer(async observer=>{
        let writing:ReturnType<typeof outcome>|undefined;
        try {
          const locking=outcome(withTx(createContainerFromDb(r.db),async tx=>{await acquireCheckoutPricingLock(tx);
            writing=outcome(writer.exec(table==='system_config'?"UPDATE system_config SET value='1' WHERE menu_name='whole_free_shipping'":'UPDATE member_right SET number=25'));
            await waitForFinanceBlock(observer.db,writer.pid,r.pid);
            expect((await readCheckoutPricingSources(tx)).values.whole_free_shipping).toBe('0');
            if(ending==='rollback')throw Error('controlled rollback');
          }));
          const result=await locking;expect(result.ok).toBe(ending==='commit');
          expect(writing).toBeDefined();expect((await writing)?.ok).toBe(true);
        } finally {await writing;}
      });});});
  });
  it.each(['member_right','system_config'])('fails NOWAIT when %s already has a writer',async table=>{
    await withRoles(async(_owner,r)=>{const peer=f.withPeer;if(!peer)throw Error('Real peer required');
      await peer(async writer=>{await writer.exec(`BEGIN; UPDATE ${table} SET id=id`);
        try {const result=await outcome(withTx(createContainerFromDb(r.db),tx=>acquireCheckoutPricingLock(tx)));
          expect(result.ok).toBe(false);if(!result.ok)expect(code(result.error)).toBe('55P03');
        } finally {await writer.exec('ROLLBACK');}
      });});
  });
  it.each([
    ['body',"CREATE OR REPLACE FUNCTION public.checkout_lock_pricing_v1() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN NULL; END'"],
    ['invoker','ALTER FUNCTION public.checkout_lock_pricing_v1() SECURITY INVOKER'],
    ['path',"ALTER FUNCTION public.checkout_lock_pricing_v1() SET search_path=public,pg_temp"],
    ['parallel','ALTER FUNCTION public.checkout_lock_pricing_v1() PARALLEL SAFE'],
    ['public execute','GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO PUBLIC'],
    ['overload',"CREATE FUNCTION public.checkout_lock_pricing_v1(int) RETURNS void LANGUAGE plpgsql AS 'BEGIN NULL; END'"],
    ['rls','ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY'],
  ])('refuses %s drift without repairing it or taking the capability',async(_kind,statement)=>{
    await withRoles(async(owner,r)=>{const before=await snapshot();await f.exec(statement);
      expect((await auditCheckoutPricingLockRuntime(r.db)).ready).toBe(false);
      await expect(withTx(createContainerFromDb(r.db),tx=>acquireCheckoutPricingLock(tx))).rejects.toThrow('requires review');
      await expect(installCheckoutPricingLock(f.db,owner.role)).rejects.toThrow('requires review');
      expect(await snapshot()).toEqual(before);
    });
  });
  it.each(['LOGIN','CREATEDB','CREATEROLE','BYPASSRLS'])('rejects owner attribute expansion %s',async attribute=>{
    await withRoles(async(owner,r)=>{await f.exec(`ALTER ROLE "${owner.role}" ${attribute}`);
      expect((await auditCheckoutPricingLockRuntime(r.db)).ready).toBe(false);
      await expect(withTx(createContainerFromDb(r.db),tx=>acquireCheckoutPricingLock(tx))).rejects.toThrow('requires review');
    });
  });
  it('rejects configuration column privileges and a mixed inherited role path',async()=>{
    await withRoles(async(owner,r)=>{
      await f.exec(`GRANT UPDATE(value) ON system_config TO "${r.role}"`);
      expect((await auditCheckoutPricingLockRuntime(r.db)).callerSafe).toBe(false);
      await f.exec(`REVOKE UPDATE(value) ON system_config FROM "${r.role}"`);
      const role=f.withRuntimeRole;if(!role)throw Error('LOGIN required');
      await role(async bridge=>{await f.exec(`GRANT "${owner.role}" TO "${bridge.role}" WITH INHERIT FALSE, SET FALSE;
        GRANT "${bridge.role}" TO "${r.role}" WITH INHERIT FALSE, SET FALSE`);
        expect((await auditCheckoutPricingLockRuntime(r.db)).callerSafe).toBe(false);});
    });
  });
  it('does not whitelist an unrelated callable SECURITY DEFINER routine',async()=>{
    await withRoles(async(_owner,r)=>{
      await f.exec("CREATE FUNCTION public.unreviewed_pricing_helper() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN NULL; END'");
      const result=await auditCheckoutPricingLockRuntime(r.db);
      expect(result.catalogReady).toBe(true);expect(result.noUnreviewedDefinerRoutine).toBe(false);expect(result.ready).toBe(false);
    });
  });
  it('will not install while a business transaction holds the shared maintenance gate',async()=>{
    await withRoles(async(owner,r)=>{const before=await inspectCheckoutPricingLock(f.db);
      await withTx(createContainerFromDb(r.db),async tx=>{
        await acquireCheckoutPricingLock(tx);
        await expect(installCheckoutPricingLock(f.db,owner.role)).rejects.toThrow('busy');
        expect((await readCheckoutPricingSources(tx)).values.whole_free_shipping).toBe('0');
      });
      expect(await installCheckoutPricingLock(f.db,owner.role)).toEqual(before);
    });
  });
  it('rolls a competing first installation back without leaving function or owner grants',async()=>{
    await withRoles(async(owner,r)=>{const peer=f.withPeer;if(!peer)throw Error('Real peer required');
      await expect(withTx(createContainerFromDb(r.db),tx=>acquireCheckoutPricingLock(tx))).rejects.toThrow('missing');
      await peer(async writer=>{await writer.exec('BEGIN; UPDATE system_config SET value=value');
        try {const result=await outcome(installCheckoutPricingLock(f.db,owner.role));
          expect(result.ok).toBe(false);if(!result.ok)expect(code(result.error)).toBe('55P03');
        } finally {await writer.exec('ROLLBACK');}
      });
      expect((await inspectCheckoutPricingLock(f.db)).absent).toBe(true);
      const [rights]=await f.db.execute(sql`SELECT has_table_privilege(${owner.role},'public.system_config','UPDATE') AS writable,
        has_schema_privilege(${owner.role},'public','CREATE') AS creatable`);
      expect(rights).toMatchObject({writable:false,creatable:false});
      await installCheckoutPricingLock(f.db,owner.role);
    },false);
  });
  it.each(['unrelated-write','grant-option'] as const)('refuses capability owner %s expansion',async mode=>{
    await withRoles(async(owner,r)=>{await f.exec(mode==='unrelated-write'
      ?`GRANT UPDATE ON store_product TO "${owner.role}"`:`GRANT UPDATE ON system_config TO "${owner.role}" WITH GRANT OPTION`);
      expect((await auditCheckoutPricingLockRuntime(r.db)).catalogReady).toBe(false);
      await expect(withTx(createContainerFromDb(r.db),tx=>acquireCheckoutPricingLock(tx))).rejects.toThrow('requires review');
    });
  });
  it('rejects runtime EXECUTE delegation and a maintenance connection masked with SET ROLE',async()=>{
    await withRoles(async(_owner,r)=>{
      await f.exec(`GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO "${r.role}" WITH GRANT OPTION`);
      expect((await auditCheckoutPricingLockRuntime(r.db)).catalogReady).toBe(false);
      await f.exec(`REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() FROM "${r.role}"`);
      expect((await auditCheckoutPricingLockRuntime(r.db)).ready).toBe(true);
      await f.exec(`SET ROLE "${r.role}"`);
      try {expect((await auditCheckoutPricingLockRuntime(f.db)).callerSafe).toBe(false);}
      finally {await f.exec('RESET ROLE');}
    });
  });
  it('rejects a LOGIN owner and unsafe identifiers before creating anything',async()=>{
    await withRoles(async(owner,r)=>{
      await expect(installCheckoutPricingLock(f.db,r.role)).rejects.toThrow('NOLOGIN');
      for(const name of ['public;select 1','pg_temp','a'.repeat(64)])
        await expect(installCheckoutPricingLock(f.db,owner.role,name)).rejects.toThrow('identifier');
      expect((await inspectCheckoutPricingLock(f.db)).absent).toBe(true);
    },false);
  });
  it('does not treat NOLOGIN as revocation of an existing owner session',async()=>{
    const role=f.withRuntimeRole;if(!role)throw Error('Real LOGIN required');
    await role(async oldLogin=>{await f.exec(`ALTER ROLE "${oldLogin.role}" NOLOGIN`);
      await expect(installCheckoutPricingLock(f.db,oldLogin.role)).rejects.toThrow('NOLOGIN');
      expect((await inspectCheckoutPricingLock(f.db)).absent).toBe(true);
      const [rights]=await f.db.execute(sql`SELECT has_table_privilege(${oldLogin.role},'public.system_config','UPDATE') AS writable`);
      expect(rights?.writable).toBe(false);
    });
  });
  it('refuses an otherwise exact capability transferred to an owner with a surviving session',async()=>{
    await withRoles(async(_owner,r)=>{const role=f.withRuntimeRole;if(!role)throw Error('Real LOGIN required');
      await role(async oldLogin=>{await f.exec(`ALTER ROLE "${oldLogin.role}" NOLOGIN;
        GRANT UPDATE ON member_right,system_config TO "${oldLogin.role}";
        ALTER FUNCTION public.checkout_lock_pricing_v1() OWNER TO "${oldLogin.role}"`);
        const state=await inspectCheckoutPricingLock(f.db);
        expect(state.definitionSafe).toBe(true);expect(state.ownerSafe).toBe(false);
        expect((await auditCheckoutPricingLockRuntime(r.db)).ready).toBe(false);
        await expect(withTx(createContainerFromDb(r.db),tx=>acquireCheckoutPricingLock(tx))).rejects.toThrow('requires review');
      });
    });
  });
  it('rolls back when an independent non-superuser maintainer lacks installation authority',async()=>{
    await withRoles(async(owner)=>{const role=f.withRuntimeRole;if(!role)throw Error('Real LOGIN required');
      await role(async maintenance=>{
        const result=await outcome(installCheckoutPricingLock(maintenance.db,owner.role));
        expect(result.ok).toBe(false);if(!result.ok)expect(code(result.error)).toBe('42501');
        expect((await inspectCheckoutPricingLock(f.db)).absent).toBe(true);
        const [rights]=await f.db.execute(sql`SELECT has_table_privilege(${owner.role},'public.system_config','UPDATE') AS writable,
          has_schema_privilege(${owner.role},'public','CREATE') AS creatable`);
        expect(rights).toMatchObject({writable:false,creatable:false});
      });
    },false);
  });
  it('installs and reinstalls through a real restricted maintenance LOGIN with explicit object and owner-role authority',async()=>{
    await withRoles(async(owner,r)=>{const role=f.withRuntimeRole;if(!role)throw Error('Real LOGIN required');
      const before=await snapshot();
      const [initial]=await f.db.execute(sql`SELECT
        (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public') AS schema_owner,
        (SELECT bool_and(pg_get_userbyid(relowner)='finance_test') FROM pg_class
          WHERE oid IN ('public.member_right'::regclass,'public.system_config'::regclass)) AS table_owners`);
      expect(initial).toMatchObject({schema_owner:'pg_database_owner',table_owners:true});
      await role(async maintenance=>{
        await f.exec(`ALTER SCHEMA public OWNER TO "${maintenance.role}";
          ALTER TABLE public.member_right OWNER TO "${maintenance.role}";
          ALTER TABLE public.system_config OWNER TO "${maintenance.role}";
          GRANT "${owner.role}" TO "${maintenance.role}" WITH INHERIT FALSE, SET TRUE`);
        try {
          const [identity]=await maintenance.db.execute(sql`SELECT rolname=current_user AND current_user=session_user AS actual_login,
            rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS elevated
            FROM pg_roles WHERE rolname=current_user`);
          expect(identity).toMatchObject({actual_login:true,elevated:false});
          const installed=await installCheckoutPricingLock(maintenance.db,owner.role);
          expect(await installCheckoutPricingLock(maintenance.db,owner.role)).toEqual(installed);
          await f.exec(`GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO "${r.role}"`);
          expect((await auditCheckoutPricingLockRuntime(r.db)).ready).toBe(true);
          // The maintenance identity itself must never be certified as runtime.
          expect((await auditCheckoutPricingLockRuntime(maintenance.db)).ready).toBe(false);
        } finally {
          await f.exec('ALTER TABLE public.member_right OWNER TO finance_test; ALTER TABLE public.system_config OWNER TO finance_test; ALTER SCHEMA public OWNER TO pg_database_owner');
        }
      });
      expect((await auditCheckoutPricingLockRuntime(r.db)).ready).toBe(true);
      await withTx(createContainerFromDb(r.db),tx=>acquireCheckoutPricingLock(tx));
      expect(await snapshot()).toEqual(before);
    },false);
  });
});
