import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DbClient } from '../src/lib/di';
import { systemAdmin, systemMenus, systemRole } from '../src/models/schema';
import { adminAuthorityOperation } from '../src/models/schema/adminAuthorityOperation';
import { ADMIN_LEGACY_ROLE_OPERATION_EXPECTED_CONSTRAINTS, assertAdminAuthorityOperationReady,
  assertAdminLegacyAdminOperationReady, assertAdminLegacyRoleOperationReady,
  installAdminAuthorityOperation, inspectAdminAuthorityOperation } from '../src/migrations/adminAuthorityOperation';
import { ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL, installAdminLegacyRoleOperationUpgrade,
  installAdminLegacyRoleOperationUpgradeInTransaction, runAdminLegacyRoleOperationUpgrade } from '../src/migrations/runAdminLegacyRoleOperationUpgrade';
import { installAdminLegacyAdminOperationUpgrade, runAdminLegacyAdminOperationUpgrade } from '../src/migrations/runAdminLegacyAdminOperationUpgrade';
import { runAdminAuthorityOperationUpgrade } from '../src/migrations/runAdminAuthorityOperationUpgrade';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type ReceiptResult = (typeof adminAuthorityOperation.$inferInsert)['result'];
const deletedRole = () => ({ id:22,type:0,relation_id:0,role_name:'实际删除前角色',rules:'product.view,17',level:2,status:1 });
const deletedResult = () => ({ id:22,deleted:true,deleted_role:deletedRole() });
const receipt = (operation: string, state: 'committed' | 'not_applied' = 'committed', result: object | null = {id:22,created:false}) => ({
  operationId:randomUUID(),actorId:11,adminType:1,relationId:0,operation,
  requestHash:state==='committed'?'a'.repeat(64):'',revision:state==='committed'?'b'.repeat(64):'',
  // Runtime-negative fixtures deliberately bypass only the TS DTO. Real PG16
  // must enforce the persisted CHECK; no helper fabricates acceptance results.
  state,result:result as ReceiptResult,createdAt:1_791_500_000,
});
const originalKinds=['admin-save','role-save','role-delete','legacy-admin-save','legacy-admin-status','legacy-admin-delete'];
const allKinds=[...originalKinds,'legacy-role-status','legacy-role-delete'];
const resultFor = (operation:string) => operation==='legacy-role-delete'?deletedResult()
  : operation.endsWith('delete')?{id:22,deleted:true}:{id:22,created:false};
const originalRows = () => originalKinds.flatMap(operation => [receipt(operation,'committed',resultFor(operation)),receipt(operation,'not_applied',null)]);
async function expectCheckViolation(query:PromiseLike<unknown>):Promise<void> {
  const code=await Promise.resolve(query).then(() => null,(error:unknown) => {
    let cause=error;
    for(let depth=0;depth<6 && cause && typeof cause==='object';depth++) {
      if('code' in cause)return String(cause.code);
      cause='cause' in cause?cause.cause:undefined;
    }
    return 'missing PostgreSQL error code';
  });
  expect(code).toBe('23514');
}

/** Real catalog census separates ACLs from table shape. Thus allowing one
 * reviewed ACL difference cannot hide ownership/RLS/other table drift. */
async function catalog(db:Pick<DbClient,'execute'>) {
  return Array.from(await db.execute(sql`SELECT 'table' AS kind,c.oid::text AS id,c.relname AS name,
      concat_ws(':',c.relowner,c.relkind,c.relpersistence,c.reloptions,c.relrowsecurity,c.relforcerowsecurity) AS definition
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'table-acl',c.oid::text,c.relname,coalesce(c.relacl::text,'')
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'column',a.attrelid::text||'.'||a.attnum,c.relname||'.'||a.attname,
      concat_ws(':',a.atttypid,a.atttypmod,a.attnotnull,a.attacl,a.attidentity,a.attgenerated)
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'constraint',k.oid::text,c.relname||'.'||k.conname,pg_get_constraintdef(k.oid,false)
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE k.connamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,proname,pg_get_functiondef(oid)||':'||coalesce(proacl::text,'')
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f'
    UNION ALL SELECT 'trigger',t.oid::text,c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid)||':'||t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
    UNION ALL SELECT 'sequence',s.seqrelid::text,c.relname,
      concat_ws(':',s.seqtypid,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle)
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'default-acl',oid::text,defaclobjtype::text,defaclacl::text FROM pg_default_acl
    ORDER BY kind,id`));
}
const changedChecks = new Set(['admin_authority_operation.aao_operation_ck','admin_authority_operation.aao_state_ck']);
function unchangedCatalog(items:Awaited<ReturnType<typeof catalog>>,allowAdminRoleDelete=false) {
  return items.filter(row => !(row.kind==='constraint' && changedChecks.has(String(row.name)))
    && !(allowAdminRoleDelete && row.kind==='table-acl' && row.name==='system_role'));
}
async function exactV3(db:Pick<DbClient,'execute'>) {
  const [row]=await db.execute(sql`SELECT jsonb_object_agg(conname,pg_get_constraintdef(oid,false)) AS definitions
    FROM pg_constraint WHERE conrelid='public.admin_authority_operation'::regclass AND contype IN ('p','c')`);
  expect(row.definitions).toEqual(ADMIN_LEGACY_ROLE_OPERATION_EXPECTED_CONSTRAINTS);
  expect(await inspectAdminAuthorityOperation(db,undefined,'legacy-role-v3')).toBe(true);
}
async function receiptRows(db:DbClient) {
  return db.select().from(adminAuthorityOperation).orderBy(adminAuthorityOperation.operationId);
}
async function wholeRows(db:Pick<DbClient,'execute'>) {
  const tables=Array.from(await db.execute(sql`SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`));
  expect(tables).toHaveLength(283);
  const queries=tables.map(row => {
    const name=String(row.relname);expect(name).toMatch(/^[a-z_][a-z_0-9]*$/);
    return `SELECT '${name}' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${name}" t`;
  });
  return Array.from(await db.execute(sql.raw(queries.join(' UNION ALL ')+' ORDER BY name')));
}
async function aclEntries(db:Pick<DbClient,'execute'>) {
  return Array.from(await db.execute(sql`SELECT c.relname AS name,a.grantor::text AS grantor,a.grantee::text AS grantee,
    a.privilege_type AS privilege,a.is_grantable AS delegate
    FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f')
    ORDER BY c.relname,a.grantee,a.privilege_type,a.grantor,a.is_grantable`));
}

/** A local exception at the real post-DDL/pre-GRANT boundary. The production
 * installer has no fault switch, fake SQL result, skipped DDL or retry path. */
function interruptBeforeGrant(db:DbClient,observe:{ reached:boolean }):DbClient {
  const dialect=new PgDialect();
  return new Proxy(db,{get(target,key,receiver) {
    if(key!=='transaction')return Reflect.get(target,key,receiver);
    return (callback:(tx:Pick<DbClient,'execute'>)=>Promise<unknown>,options:unknown) => target.transaction(async tx => {
      let installed=false;
      const proxy=new Proxy(tx,{get(current,property,context) {
        if(property!=='execute')return Reflect.get(current,property,context);
        return async(query:Parameters<typeof tx.execute>[0]) => {
          const text=dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql;
          if(text.startsWith('GRANT DELETE ON TABLE public.system_role TO ')) {
            expect(installed).toBe(true);
            await exactV3(tx);observe.reached=true;
            throw Error('Owned interruption after both CHECKs before Admin DELETE grant');
          }
          const result=await tx.execute(query);
          if(text===ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL)installed=true;
          return result;
        };
      }});
      return callback(proxy);
    },options as Parameters<typeof target.transaction>[1]);
  }});
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('legacy role v3 receipt extension on actual PG16',() => {
  let fixture:Fixture,ddl:string;
  beforeAll(async() => {
    const kit=await import('drizzle-kit/api');
    ddl=(await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson({systemAdmin,systemRole,systemMenus}))).join('\n');
  });
  beforeEach(async() => {
    fixture=await sequenceRunnerDatabase();
    if(fixture.format!=='pg16')throw Error('Actual PG16 owner maintenance required');
    await fixture.exec(ddl);
    await fixture.db.transaction(tx => installAdminAuthorityOperation(tx));
    await fixture.db.transaction(tx => installAdminLegacyAdminOperationUpgrade(tx));
  },60_000);
  afterEach(async() => {await fixture?.close();},30_000);

  it('retains the original six kinds and rows, changes only two CHECKs, pins actual PG16 definitions, and repeats unchanged',async() => {
    await fixture.db.insert(adminAuthorityOperation).values(originalRows());
    const before=await catalog(fixture.db),beforeRows=await receiptRows(fixture.db),beforeAcl=await aclEntries(fixture.db);
    await fixture.db.transaction(async tx => {
      expect(await inspectAdminAuthorityOperation(tx,undefined,'legacy-admin-v2')).toBe(true);
      await assertAdminAuthorityOperationReady(tx);await assertAdminLegacyAdminOperationReady(tx);
      await expect(assertAdminLegacyRoleOperationReady(tx)).rejects.toMatchObject({code:503});
      expect(await installAdminLegacyRoleOperationUpgrade(tx)).toEqual({operation:'admin-legacy-role-operation-v3',applied:true});
      expect(await inspectAdminAuthorityOperation(tx,undefined,'legacy-admin-v2')).toBe(false);
      await exactV3(tx);
      await assertAdminAuthorityOperationReady(tx);await assertAdminLegacyAdminOperationReady(tx);await assertAdminLegacyRoleOperationReady(tx);
    });
    const installed=await catalog(fixture.db);
    expect(unchangedCatalog(installed)).toEqual(unchangedCatalog(before));expect(installed).toHaveLength(before.length);
    expect(await receiptRows(fixture.db)).toEqual(beforeRows);expect(await aclEntries(fixture.db)).toEqual(beforeAcl);
    expect(await fixture.db.transaction(tx => installAdminLegacyRoleOperationUpgrade(tx))).toEqual({operation:'admin-legacy-role-operation-v3',applied:false});
    expect(await catalog(fixture.db)).toEqual(installed);expect(await receiptRows(fixture.db)).toEqual(beforeRows);
  });

  it('enforces exactly eight kinds, full seven-column deleted snapshots, old shapes and immutable evidence',async() => {
    await fixture.db.transaction(tx => installAdminLegacyRoleOperationUpgrade(tx));
    const good=allKinds.flatMap(operation => [receipt(operation,'committed',resultFor(operation)),receipt(operation,'not_applied',null)]);
    // Existing original save kinds may still report a real create. Only the two
    // status-only operations are required to return created=false.
    for(const operation of ['admin-save','role-save','legacy-admin-save'])good.push(receipt(operation,'committed',{id:22,created:true}));
    good.push(receipt('legacy-role-delete','committed',{id:22,deleted:true,deleted_role:{...deletedRole(),type:1,level:10,status:0}}));
    await fixture.db.insert(adminAuthorityOperation).values(good);
    const bad:Array<[string,object|null]>=[
      ['unknown',{id:22,created:false}],['legacy-role-save',{id:22,created:false}],
      ['legacy-role-status',{id:22,created:true}],['legacy-role-status',{id:22,deleted:true}],
      ['legacy-role-status',{id:22,created:false,status:1}],['legacy-role-status',{id:22}],
      ['legacy-role-delete',{id:22,deleted:true}],['legacy-role-delete',{...deletedResult(),created:false}],
      ['legacy-role-delete',{...deletedResult(),deleted:false}],['legacy-role-delete',{...deletedResult(),id:0}],
      ['legacy-role-delete',{...deletedResult(),id:2147483648}],['legacy-role-delete',{...deletedResult(),id:'22'}],
      ['legacy-role-delete',{...deletedResult(),deleted_role:null}],['legacy-role-delete',{...deletedResult(),deleted_role:[]}],
      ['legacy-role-delete',{...deletedResult(),deleted_role:{...deletedRole(),extra:'not allowed'}}],
      ['legacy-admin-status',{id:22,created:true}],['legacy-admin-delete',deletedResult()],
      ['role-delete',deletedResult()],['admin-save',{id:22,created:false,deleted_role:deletedRole()}],
    ];
    for(const patch of [{id:23},{id:'22'},{type:2},{relation_id:1},{level:0},{level:11},{level:'2'},
      {status:-1},{status:2},{role_name:null},{role_name:'a'.repeat(33)},{rules:null},{rules:[]},{rules:'a'.repeat(16385)}]) {
      bad.push(['legacy-role-delete',{...deletedResult(),deleted_role:{...deletedRole(),...patch}}]);
    }
    for(const key of Object.keys(deletedRole()))bad.push(['legacy-role-delete',{...deletedResult(),
      deleted_role:Object.fromEntries(Object.entries(deletedRole()).filter(([field]) => field!==key))}]);
    for(const [operation,result] of bad)await expectCheckViolation(fixture.db.insert(adminAuthorityOperation).values(receipt(operation,'committed',result)));
    await expectCheckViolation(fixture.db.insert(adminAuthorityOperation).values({...receipt('legacy-role-delete','not_applied',null),adminType:2}));
    await expectCheckViolation(fixture.db.insert(adminAuthorityOperation).values({...receipt('legacy-role-delete','not_applied',null),relationId:1}));
    expect(await receiptRows(fixture.db)).toHaveLength(good.length);
    const id=good[0].operationId;
    await expect(fixture.exec(`UPDATE public.admin_authority_operation SET revision=revision WHERE operation_id='${id}'`)).rejects.toMatchObject({code:'42501'});
    await expect(fixture.exec(`DELETE FROM public.admin_authority_operation WHERE operation_id='${id}'`)).rejects.toMatchObject({code:'42501'});
    await expect(fixture.exec('TRUNCATE public.admin_authority_operation')).rejects.toMatchObject({code:'42501'});
    expect(await receiptRows(fixture.db)).toHaveLength(good.length);
  });

  it('rejects altered CHECK or menu-lock catalogs without repairing schema or rows',async() => {
    await fixture.db.insert(adminAuthorityOperation).values(originalRows());
    const before=await catalog(fixture.db),beforeRows=await receiptRows(fixture.db);
    for(const statement of [
      "ALTER TABLE public.admin_authority_operation DROP CONSTRAINT aao_operation_ck; ALTER TABLE public.admin_authority_operation ADD CONSTRAINT aao_operation_ck CHECK (operation<>'')",
      'ALTER FUNCTION public.admin_authority_menu_lock_v1() SET search_path=public',
    ]) {
      const rollback=Error('Roll back owned catalog drift fixture');
      await expect(fixture.db.transaction(async tx => {
        await tx.execute(sql.raw(statement));const drifted=await catalog(tx);
        await expect(installAdminLegacyRoleOperationUpgrade(tx)).rejects.toThrow('catalog drift');
        expect(await catalog(tx)).toEqual(drifted);
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await catalog(fixture.db)).toEqual(before);expect(await receiptRows(fixture.db)).toEqual(beforeRows);
    }
  });

  it('rejects third-party receipt ACLs and an ordinary independently authenticated LOGIN as maintenance',async() => {
    if(!fixture.withRuntimeRole)throw Error('Independent LOGIN fixture required');
    await fixture.withRuntimeRole(async peer => {
      await fixture.exec(`GRANT SELECT ON public.admin_authority_operation TO "${peer.role}"`);
      const before=await catalog(fixture.db);
      await expect(fixture.db.transaction(tx => installAdminLegacyRoleOperationUpgrade(tx))).rejects.toThrow('catalog drift');
      await expect(peer.db.transaction(tx => installAdminLegacyRoleOperationUpgrade(tx))).rejects.toThrow('owner maintenance');
      expect(await catalog(fixture.db)).toEqual(before);
    });
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('legacy role v3 of complete commissioned runtime profiles',() => {
  it('atomically changes two CHECKs plus only Admin role DELETE, preserves all 283 table rows and other ACLs, and refuses grant repair',async() => {
    const whole=await refundRuntimeFixture();
    try {
      if(!whole.withRuntimeRole)throw Error('Actual independently authenticated App/Admin LOGINs required');
      await whole.withRuntimeRole(async app => whole.withRuntimeRole!(async admin => {
        const [identity]=await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
        const target={database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role};
        await runRuntimeBusinessCommissioning(whole.db,{...target,pricingOwner:whole.pricingOwner});
        await runAdminAuthorityOperationUpgrade(whole.db,target);
        await runAdminLegacyAdminOperationUpgrade(whole.db,target);
        await whole.db.insert(adminAuthorityOperation).values(originalRows());
        const before=await catalog(whole.db),beforeRows=await wholeRows(whole.db),beforeAcl=await aclEntries(whole.db);
        const [beforeDelete]=await whole.db.execute(sql`SELECT has_table_privilege(${app.role},'public.system_role','DELETE') AS app,
          has_table_privilege(${admin.role},'public.system_role','DELETE') AS admin`);
        expect(beforeDelete).toEqual({app:false,admin:false});
        // Premature DELETE under exact v2 is drift, not an upgrade prerequisite
        // that the wrapper is allowed to silently adopt or repair.
        const rollbackPremature=Error('Roll back owned premature DELETE grant fixture');
        await expect(whole.db.transaction(async tx => {
          await tx.execute(sql.raw(`GRANT DELETE ON TABLE public.system_role TO "${admin.role}"`));
          const drifted=await catalog(tx);
          await expect(installAdminLegacyRoleOperationUpgradeInTransaction(tx,target)).rejects.toThrow('exact existing runtime profiles');
          expect(await catalog(tx)).toEqual(drifted);expect(await wholeRows(tx)).toEqual(beforeRows);
          throw rollbackPremature;
        })).rejects.toBe(rollbackPremature);
        expect(await catalog(whole.db)).toEqual(before);expect(await wholeRows(whole.db)).toEqual(beforeRows);
        const observe={reached:false};
        await expect(runAdminLegacyRoleOperationUpgrade(interruptBeforeGrant(whole.db,observe),target)).rejects.toThrow('Owned interruption after both CHECKs');
        expect(observe.reached).toBe(true);
        expect(await catalog(whole.db)).toEqual(before);expect(await wholeRows(whole.db)).toEqual(beforeRows);
        expect(await aclEntries(whole.db)).toEqual(beforeAcl);
        expect(await inspectAdminAuthorityOperation(whole.db,target,'legacy-admin-v2')).toBe(true);
        expect(await runAdminLegacyRoleOperationUpgrade(whole.db,target)).toEqual({operation:'admin-legacy-role-operation-v3',applied:true});
        await exactV3(whole.db);
        const installed=await catalog(whole.db),installedAcl=await aclEntries(whole.db);
        expect(unchangedCatalog(installed,true)).toEqual(unchangedCatalog(before,true));expect(installed).toHaveLength(before.length);
        expect(await wholeRows(whole.db)).toEqual(beforeRows);
        const added=installedAcl.filter(row => !beforeAcl.some(previous => JSON.stringify(previous)===JSON.stringify(row)));
        const removed=beforeAcl.filter(row => !installedAcl.some(next => JSON.stringify(next)===JSON.stringify(row)));
        const [roleOids]=await whole.db.execute(sql`SELECT (SELECT oid::text FROM pg_roles WHERE rolname=${target.maintenance}) AS maintenance,
          (SELECT oid::text FROM pg_roles WHERE rolname=${admin.role}) AS admin`);
        expect(removed).toEqual([]);
        expect(added).toEqual([{name:'system_role',grantor:roleOids.maintenance,grantee:roleOids.admin,privilege:'DELETE',delegate:false}]);
        for(const [kind,peer] of [['app',app],['admin',admin]] as const) {
          const report=await auditRuntimeBusinessPrivileges(peer.db,kind,target);
          expect(report,JSON.stringify(report)).toMatchObject({ready:true,failures:[],tableCount:283,readOnly:true});
        }
        await admin.db.transaction(tx => assertAdminLegacyRoleOperationReady(tx));
        await expect(app.exec('SELECT * FROM public.admin_authority_operation')).rejects.toMatchObject({code:'42501'});
        await expect(app.exec('DELETE FROM public.system_role WHERE false')).rejects.toMatchObject({code:'42501'});
        await admin.exec('DELETE FROM public.system_role WHERE false');
        await expect(admin.exec('UPDATE public.admin_authority_operation SET state=state')).rejects.toMatchObject({code:'42501'});
        await expect(admin.exec('TRUNCATE public.admin_authority_operation')).rejects.toMatchObject({code:'42501'});
        expect(await runAdminLegacyRoleOperationUpgrade(whole.db,target)).toEqual({operation:'admin-legacy-role-operation-v3',applied:false});
        expect(await catalog(whole.db)).toEqual(installed);expect(await wholeRows(whole.db)).toEqual(beforeRows);expect(await aclEntries(whole.db)).toEqual(installedAcl);
        // Already-v3 missing DELETE must fail before the applied:false path;
        // no new GRANT is allowed to disguise drift as an idempotent repeat.
        const rollbackMissing=Error('Roll back owned missing DELETE grant fixture');
        await expect(whole.db.transaction(async tx => {
          await tx.execute(sql.raw(`REVOKE DELETE ON TABLE public.system_role FROM "${admin.role}"`));
          const drifted=await catalog(tx);
          await expect(installAdminLegacyRoleOperationUpgradeInTransaction(tx,target)).rejects.toThrow('exact existing runtime profiles');
          expect(await catalog(tx)).toEqual(drifted);expect(await wholeRows(tx)).toEqual(beforeRows);
          const [missing]=await tx.execute(sql`SELECT has_table_privilege(${admin.role},'public.system_role','DELETE') AS allowed`);
          expect(missing.allowed).toBe(false);throw rollbackMissing;
        })).rejects.toBe(rollbackMissing);
        expect(await catalog(whole.db)).toEqual(installed);expect(await wholeRows(whole.db)).toEqual(beforeRows);expect(await aclEntries(whole.db)).toEqual(installedAcl);
      }));
    }finally {await whole.close();}
  },180_000);
});
