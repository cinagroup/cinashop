import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { randomUUID, createHash } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import bcrypt from 'bcryptjs';
import type { Env, AppVariables } from '@/env';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { adminAuthorityOperation } from '@/models/schema/adminAuthorityOperation';
import { ADMIN_AUTHORITY_OPERATION_SQL, assertAdminAuthorityOperationReady } from '@/migrations/adminAuthorityOperation';
import { AdminAuthorityOperationService, type AdminAuthorityPreview } from '@/services/admin/AdminAuthorityOperationService';
import { AdminAuthorityWriteService, type AdminAuthorityActor, type AdminAuthorityOperationKind } from '@/services/admin/AdminAuthorityWriteService';
import { adminAuthorityPreview, adminAuthorityCommit, adminAuthorityReceipt, adminAuthorityResolve } from '@/controllers/api/v1/AdminAuthorityOperationController';
import { ApiException, HttpApiException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { financeMemoryPostgres } from './helpers/financePostgres';

const password = 'owned-memory-authority-operation-password';
const appKey = 'owned-memory-authority-operation-hmac-key';
type Intent = { operation_id:string; operation:AdminAuthorityOperationKind; payload:Record<string,unknown> };
const intent = (operation:AdminAuthorityOperationKind,payload:Record<string,unknown>):Intent => ({ operation_id:randomUUID(),operation,payload });
const confirmation = (input:Intent,preview:AdminAuthorityPreview) => ({ ...input,revision:preview.revision,expires_at:preview.expires_at,confirmed:true });
const dialect = new PgDialect();

/** Observe original statements/results. A lost response is injected only after
 * the real database transaction resolves; no SQL or result is substituted. */
function observedDatabase(db:DbClient,options:{ statements?:string[]; afterCommit?:() => void }):DbClient {
  const observedQueries = new WeakMap<object,object>();
  const observeSelect = (query:object):object => {
    const existing = observedQueries.get(query); if (existing) return existing;
    const proxy = new Proxy(query,{ get(target,key) {
      const method:unknown = Reflect.get(target,key);
      if (typeof method !== 'function') return method;
      return (...args:unknown[]) => {
        if (key === 'then') {
          const compile:unknown = Reflect.get(target,'toSQL');
          if (typeof compile !== 'function') throw Error('Real SELECT SQL required for decision-order observation');
          const compiled:unknown = Reflect.apply(compile,target,[]);
          if (!compiled || typeof compiled !== 'object' || !('sql' in compiled) || typeof compiled.sql !== 'string') {
            throw Error('Unexpected real SELECT SQL');
          }
          options.statements?.push(compiled.sql);
          // Await the original thenable, preserving the actual query/result.
          return Reflect.apply(method,target,args);
        }
        const result:unknown = Reflect.apply(method,target,args);
        return result && typeof result === 'object' ? observeSelect(result) : result;
      };
    } });
    observedQueries.set(query,proxy); return proxy;
  };
  return new Proxy(db,{ get(database,property) {
    const method:unknown = Reflect.get(database,property);
    if (typeof method !== 'function') return method;
    if (property !== 'transaction') return method.bind(database);
    return (callback:(tx:DbClient) => Promise<unknown>,...args:unknown[]) => {
      const completed:Promise<unknown> = Reflect.apply(method,database,[(tx:DbClient) => callback(new Proxy(tx,{ get(transaction,key) {
        const operation:unknown = Reflect.get(transaction,key);
        if (typeof operation !== 'function') return operation;
        if (key === 'select' && options.statements) return (...params:unknown[]) => observeSelect(Reflect.apply(operation,transaction,params));
        if (key !== 'execute') return operation.bind(transaction);
        return async (query:SQL,...params:unknown[]) => {
          const result:unknown = await Reflect.apply(operation,transaction,[query,...params]);
          options.statements?.push(dialect.sqlToQuery(query).sql); return result;
        };
      } })),...args]);
      return completed.then(result => { options.afterCommit?.(); return result; });
    };
  } });
}

describe('authority confirmation and immutable operation receipts in owned local memory',() => {
  let fixture:Awaited<ReturnType<typeof financeMemoryPostgres>>,container:Container,service:AdminAuthorityOperationService,expiresAt:number;
  const actor = (id=102):AdminAuthorityActor => ({ id,authVersion:md5(password),expiresAt });
  const snapshot = async () => ({ admins:await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id),
    roles:await fixture.db.select().from(systemRole).orderBy(systemRole.id),
    menus:await fixture.db.select().from(systemMenus).orderBy(systemMenus.id),
    receipts:await fixture.db.select().from(adminAuthorityOperation).orderBy(adminAuthorityOperation.operationId) });
  beforeAll(async () => {
    fixture = await financeMemoryPostgres([systemAdmin,systemRole,systemMenus],{ namespace:'public' });
    if (!fixture.isMemory) throw Error('Authority operation business tests require owned local memory only');
    // PGlite's PG18 is not the PG16 owner-maintenance installer gate. Execute
    // the exact reviewed receipt DDL, including all CHECKs and immutable
    // triggers, then exercise the real runtime catalog/privilege assertion.
    // Never synthesize the receipt table with the helper's column-only DDL.
    await fixture.exec(ADMIN_AUTHORITY_OPERATION_SQL);
    await fixture.db.transaction(tx => assertAdminAuthorityOperationReady(tx));
    container = createContainerFromDb(fixture.db); service = new AdminAuthorityOperationService(container,appKey);
  },30_000);
  beforeEach(async () => {
    expiresAt = Math.floor(Date.now()/1000)+3600;
    await fixture.db.delete(systemAdmin); await fixture.db.delete(systemRole); await fixture.db.delete(systemMenus);
    await fixture.db.insert(systemMenus).values([
      { id:2,menuName:'商品读取',authType:2,apiUrl:'product/list',methods:'GET' },
      { id:3,menuName:'用户读取',authType:2,apiUrl:'user/list',methods:'GET' },
    ]);
    await fixture.db.insert(systemRole).values([
      { id:900,roleName:'管理者',rules:'system.manage,product.manage',level:1 },
      { id:901,roleName:'只读',rules:'system.view',level:1 },
      { id:50,roleName:'被引用角色',rules:'product.view',level:2 },
      { id:51,roleName:'范围之外',rules:'user.manage',level:2 },
      { id:52,roleName:'数字旧角色',rules:'2',level:2 },
      { id:53,type:4,roleName:'其他管理域角色',rules:'product.view' },
      { id:54,type:1,relationId:9,roleName:'其他关系角色',rules:'product.view' },
      { id:55,roleName:'已删除角色',rules:'product.view',status:-1 },
      { id:56,roleName:'停用角色',rules:'product.view',status:0 },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id:100,account:'super-one',pwd:password,level:0 },
      { id:101,account:'super-two',pwd:password,level:0 },
      { id:102,account:'manager',pwd:password,level:1,roles:'900' },
      { id:103,account:'reader',pwd:password,level:1,roles:'901' },
      { id:104,account:'other-manager',pwd:password,level:1,roles:'900' },
      { id:110,account:'active-staff',pwd:password,level:2,roles:'50' },
      { id:111,account:'disabled-staff',pwd:password,level:2,roles:'50',status:0 },
      { id:112,account:'foreign-staff',pwd:password,adminType:4,roles:'' },
      { id:113,account:'other-relation',pwd:password,relationId:9,roles:'' },
      { id:114,account:'deleted-staff',pwd:password,level:2,roles:'50',isDel:1 },
      { id:115,account:'outside-permission',pwd:password,level:2,roles:'51' },
    ]);
  });
  afterAll(async () => { await fixture?.close(); });

  it('previews admin and role creates without DML, sequence consumption or credential fields',async () => {
    const before = await snapshot();
    const sequences = await fixture.db.execute(sql`SELECT 'admin' AS kind,last_value,is_called FROM public.system_admin_id_seq
      UNION ALL SELECT 'role',last_value,is_called FROM public.system_role_id_seq ORDER BY kind`);
    const input = intent('admin-save',{ account:'new-preview',pwd:'new-preview-secret-password',phone:'13800123000',real_name:'预览姓名',roles:'50',level:2 });
    const value = await service.preview(input,actor());
    expect(value).toMatchObject({ operation_id:input.operation_id,actor_id:102,operation:'admin-save',requires_confirmation:true,
      summary:{ target_id:0,target_name:'预览姓名',action:'create',before:null,after:{ roles:'50',level:2,status:1 } },affected_accounts:[] });
    expect(value.request_hash).toMatch(/^[a-f0-9]{64}$/); expect(value.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(value.request_hash).not.toBe(createHash('sha256').update(String(input.payload.pwd)).digest('hex'));
    for (const secret of [input.payload.pwd,input.payload.phone,password,actor().authVersion]) expect(JSON.stringify(value)).not.toContain(secret);
    const role = await service.preview(intent('role-save',{ role_name:'预览角色',rules:'product.manage',level:0 }),actor());
    expect(role.summary).toEqual({ target_id:0,target_name:'预览角色',action:'create',before:null,
      after:{ role_name:'预览角色',rules:'product.view,product.manage',level:0,status:1 } });
    expect(await snapshot()).toEqual(before);
    expect(await fixture.db.execute(sql`SELECT 'admin' AS kind,last_value,is_called FROM public.system_admin_id_seq
      UNION ALL SELECT 'role',last_value,is_called FROM public.system_role_id_seq ORDER BY kind`)).toEqual(sequences);
  });

  it('requires explicit confirmation and preserves the shared barriers before catalogue readiness',async () => {
    const statements:string[] = [],observed = new AdminAuthorityOperationService(createContainerFromDb(observedDatabase(fixture.db,{ statements })),appKey);
    const input = intent('role-save',{ id:50,rules:'product.manage' }),before = await snapshot();
    const value = await observed.preview(input,actor());
    const adminBarrier = statements.indexOf('LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT');
    const menuBarrier = statements.indexOf('SELECT public.admin_authority_menu_lock_v1()');
    expect(adminBarrier).toBeGreaterThanOrEqual(0); expect(menuBarrier).toBeGreaterThan(adminBarrier);
    const firstLiveRead = statements.findIndex(statement => statement.startsWith('select ') && statement.includes('from "system_admin"'));
    expect(firstLiveRead).toBeGreaterThan(menuBarrier);
    expect(statements.findIndex(statement => statement.includes('c.relkind') && statement.includes('admin_authority_operation_immutable_v1'))).toBeGreaterThan(firstLiveRead);
    for (const body of [input,{ ...confirmation(input,value),confirmed:false },{ ...confirmation(input,value),confirmed:'true' }]) {
      await expect(service.commit(body,actor())).rejects.toBeInstanceOf(ApiException);
    }
    expect(await snapshot()).toEqual(before);
  });

  it.each(['rules','disable','enable','delete'] as const)('confirms the complete platform impact for referenced role %s',async change => {
    if (change === 'enable') await fixture.db.update(systemRole).set({ status:0 }).where(eq(systemRole.id,50));
    const input = intent(change === 'delete' ? 'role-delete' : 'role-save',change === 'rules' ? { id:50,rules:'product.manage' }
      : change === 'delete' ? { id:50 } : { id:50,status:change === 'enable' ? 1 : 0 });
    const before = await snapshot(),value = await service.preview(input,actor());
    expect(value.affected_accounts).toEqual(before.admins.filter(row => [110,111,114].includes(row.id)).map(row =>
      ({ id:row.id,account:row.account,real_name:row.realName,level:row.level,status:row.status,is_del:row.isDel })));
    expect(value.summary.before).toEqual({ role_name:'被引用角色',rules:'product.view',level:2,status:change === 'enable' ? 0 : 1 });
    const result = await service.commit(confirmation(input,value),actor());
    expect(result).toEqual({ operation_id:input.operation_id,actor_id:102,operation:input.operation,state:'committed',request_hash:value.request_hash,
      result:change === 'delete' ? { id:50,deleted:true } : { id:50,created:false } });
    const after = await snapshot(),target = after.roles.find(row => row.id===50)!;
    expect(target).toEqual({ ...before.roles.find(row => row.id===50)!,...(change === 'rules' ? { rules:'product.view,product.manage' }
      : { status:change === 'delete' ? -1 : change === 'enable' ? 1 : 0 }) });
    expect(after.admins).toEqual(before.admins); expect(after.receipts).toHaveLength(before.receipts.length+1);
    expect(await service.receipt(input.operation_id,input.operation,actor())).toEqual(result);
  });

  it('keeps old bare referenced writes blocked and permits only semantically unchanged metadata',async () => {
    const bare = new AdminAuthorityWriteService(container),before = await snapshot();
    await expect(bare.saveRole({ id:50,rules:'product.manage' },actor())).rejects.toThrow('确认影响范围');
    await expect(bare.deleteRole(50,actor())).rejects.toThrow('确认影响范围');
    expect(await snapshot()).toEqual(before);
    await fixture.db.update(systemRole).set({ rules:'system.manage' }).where(eq(systemRole.id,50));
    const input = intent('role-save',{ id:50,role_name:'已确认改名',rules:'system.view,system.manage' });
    const value = await service.preview(input,actor());
    expect(value.affected_accounts.map(row => row.id)).toEqual([110,111,114]);
    await service.commit(confirmation(input,value),actor());
    expect((await fixture.db.select().from(systemRole).where(eq(systemRole.id,50)))[0]).toMatchObject({ roleName:'已确认改名',rules:'system.view,system.manage' });
  });

  it('preserves legacy role level 10 in a confirmed metadata update when the draft omits level',async () => {
    await fixture.db.update(systemRole).set({ level:10 }).where(eq(systemRole.id,50));
    const input = intent('role-save',{ id:50,role_name:'保留旧等级' }),value = await service.preview(input,actor());
    expect(value.summary.before).toEqual({ role_name:'被引用角色',rules:'product.view',level:10,status:1 });
    expect(value.summary.after).toEqual({ role_name:'保留旧等级',rules:'product.view',level:10,status:1 });
    expect(value.affected_accounts.map(row => row.id)).toEqual([110,111,114]);
    await service.commit(confirmation(input,value),actor());
    expect((await fixture.db.select().from(systemRole).where(eq(systemRole.id,50)))[0]).toMatchObject({ roleName:'保留旧等级',level:10 });
  });

  it('checks every affected current and projected permission and rejects foreign-realm disclosure',async () => {
    const input = intent('role-save',{ id:50,rules:'product.manage' });
    await fixture.db.update(systemAdmin).set({ roles:'50,51' }).where(eq(systemAdmin.id,111));
    const before = await snapshot(); await expect(service.preview(input,actor())).rejects.toThrow('超出当前'); expect(await snapshot()).toEqual(before);
    await fixture.db.update(systemAdmin).set({ roles:'50' }).where(eq(systemAdmin.id,111));
    await fixture.db.update(systemAdmin).set({ roles:'50' }).where(eq(systemAdmin.id,101));
    await expect(service.preview(input,actor())).rejects.toThrow('超级管理员');
    await fixture.db.update(systemAdmin).set({ roles:'' }).where(eq(systemAdmin.id,101));
    for (const foreignId of [112,113]) {
      await fixture.db.update(systemAdmin).set({ roles:'50' }).where(eq(systemAdmin.id,foreignId));
      for (const payload of [{ id:50,rules:'' },{ id:50,role_name:'无害改名也不得泄露名单' }]) {
        await expect(service.preview(intent('role-save',payload),actor(100))).rejects.toThrow('其他管理域');
      }
      await fixture.db.update(systemAdmin).set({ roles:'' }).where(eq(systemAdmin.id,foreignId));
    }
    await expect(service.preview(intent('role-save',{ id:50,rules:'user.view' }),actor())).rejects.toThrow('超出当前');
    await expect(service.preview(intent('role-save',{ id:50,rules:'unmapped.old' }),actor(100))).rejects.toThrow('未知权限');
  });

  it.each(['added-reference','removed-reference','reference-profile','referenced-other-role','target','catalogue'] as const)(
    'binds a complete source proof and requires a fresh preview after %s',async change => {
      if (change === 'referenced-other-role') await fixture.db.update(systemAdmin).set({ roles:'50,52' }).where(eq(systemAdmin.id,111));
      const input = intent('role-save',{ id:50,rules:'product.manage' }),value = await service.preview(input,actor());
      if (change === 'added-reference') await fixture.db.update(systemAdmin).set({ roles:'50' }).where(eq(systemAdmin.id,104));
      if (change === 'removed-reference') await fixture.db.update(systemAdmin).set({ roles:'' }).where(eq(systemAdmin.id,110));
      if (change === 'reference-profile') await fixture.db.update(systemAdmin).set({ realName:'独立改名' }).where(eq(systemAdmin.id,111));
      if (change === 'referenced-other-role') {
        await fixture.db.update(systemRole).set({ roleName:'独立旧规则名' }).where(eq(systemRole.id,52));
      }
      if (change === 'target') await fixture.db.update(systemRole).set({ roleName:'独立目标名' }).where(eq(systemRole.id,50));
      if (change === 'catalogue') await fixture.db.update(systemMenus).set({ menuName:'独立目录名' }).where(eq(systemMenus.id,3));
      const afterExternal = await snapshot();
      await expect(service.commit(confirmation(input,value),actor())).rejects.toThrow('影响范围已变化');
      expect(await snapshot()).toEqual(afterExternal);
      const fresh = await service.preview(input,actor()); expect(fresh.revision).not.toBe(value.revision);
      await expect(service.commit(confirmation(input,fresh),actor())).resolves.toMatchObject({ state:'committed' });
    });

  it('rejects tampered payload, operation, revision, expiration and current session without mutation',async () => {
    const input = intent('role-save',{ id:50,rules:'product.manage' }),value = await service.preview(input,actor()),before = await snapshot();
    const valid = confirmation(input,value);
    for (const body of [{ ...valid,payload:{ id:50,rules:'' } },{ ...valid,operation_id:randomUUID() },
      { ...valid,operation:'role-delete',payload:{ id:50 } },{ ...valid,revision:'0'.repeat(64) },
      { ...valid,expires_at:1 },{ ...valid,expires_at:value.expires_at+301 },{ ...valid,payload:{ ...input.payload,unknown:'x' } }]) {
      await expect(service.commit(body,actor())).rejects.toBeInstanceOf(ApiException); expect(await snapshot()).toEqual(before);
    }
    for (const claims of [actor(104),actor(103),actor(112),{ ...actor(),expiresAt:expiresAt-1 },{ ...actor(),authVersion:md5('changed') }]) {
      await expect(service.commit(valid,claims)).rejects.toBeInstanceOf(ApiException); expect(await snapshot()).toEqual(before);
    }
  });

  it('creates genuine accounts and roles, then replays the immutable original result without duplicate writes',async () => {
    const roleInput = intent('role-save',{ role_name:'确认新角色',rules:'product.view',level:0 }),rolePreview = await service.preview(roleInput,actor());
    const roleReceipt = await service.commit(confirmation(roleInput,rolePreview),actor()),roleId = roleReceipt.result!.id;
    expect(roleReceipt.result).toEqual({ id:roleId,created:true });
    const input = intent('admin-save',{ account:'created-staff',pwd:'created-owned-secret-password',phone:'13800123000',real_name:'确认账号',roles:String(roleId),level:2 });
    const value = await service.preview(input,actor()),receipt = await service.commit(confirmation(input,value),actor()),after = await snapshot();
    const saved = after.admins.find(row => row.id===receipt.result!.id)!;
    expect(receipt.result).toEqual({ id:saved.id,created:true }); expect(await bcrypt.compare(String(input.payload.pwd),saved.pwd)).toBe(true);
    expect(saved).toMatchObject({ account:'created-staff',realName:'确认账号',roles:String(roleId),level:2,adminType:1,relationId:0,status:1 });
    expect(JSON.stringify(after.receipts)).not.toContain(input.payload.pwd);
    expect(await service.commit({ ...confirmation(input,value),expires_at:1 },actor())).toEqual(receipt); expect(await snapshot()).toEqual(after);
    await fixture.db.delete(systemAdmin).where(eq(systemAdmin.id,saved.id));
    const afterRemoval = await snapshot();
    expect(await service.commit({ ...confirmation(input,value),expires_at:1 },actor())).toEqual(receipt);
    expect(await service.resolve({ operation_id:input.operation_id,operation:input.operation },actor())).toEqual(receipt);
    await expect(service.commit({ ...confirmation(input,value),payload:{ ...input.payload,real_name:'不同请求' } },actor())).rejects.toThrow('原提交内容');
    await expect(service.receipt(input.operation_id,'role-save',actor())).rejects.toThrow('类型不一致');
    await expect(service.receipt(input.operation_id,input.operation,actor(104))).rejects.toThrow('无权读取');
    expect(await snapshot()).toEqual(afterRemoval);
  },30_000);

  it('recovers after a genuine COMMIT loses its response and still permits a revoked owner to restore evidence',async () => {
    const input = intent('role-save',{ role_name:'已提交响应丢失',rules:'product.view' }),value = await service.preview(input,actor());
    let committed = false;
    const dropped = new AdminAuthorityOperationService(createContainerFromDb(observedDatabase(fixture.db,{ afterCommit:() => {
      committed = true; throw Error('owned lost ACK after real COMMIT');
    } })),appKey);
    await expect(dropped.commit(confirmation(input,value),actor())).rejects.toThrow('owned lost ACK'); expect(committed).toBe(true);
    const persisted = await snapshot(),row = persisted.receipts.find(row => row.operationId===input.operation_id)!;
    const recovered = await service.receipt(input.operation_id,input.operation,actor());
    expect(recovered).toMatchObject({ state:'committed',request_hash:value.request_hash,result:row.result });
    expect(persisted.roles.find(role => role.id===row.result!.id)?.roleName).toBe('已提交响应丢失');
    await fixture.db.update(systemAdmin).set({ roles:'999' }).where(eq(systemAdmin.id,102));
    expect(await service.receipt(input.operation_id,input.operation,actor())).toEqual(recovered);
    expect(await service.resolve({ operation_id:input.operation_id,operation:input.operation },actor())).toEqual(recovered);
    await expect(service.commit(confirmation(input,value),actor())).rejects.toThrow('权限已变化');
    await fixture.db.update(systemAdmin).set({ pwd:'changed-owner-password' }).where(eq(systemAdmin.id,102));
    await expect(service.receipt(input.operation_id,input.operation,actor())).rejects.toThrow('凭据');
    expect(await service.receipt(input.operation_id,input.operation,{ ...actor(),authVersion:md5('changed-owner-password') })).toEqual(recovered);
  });

  it('leaves an absent lookup unknown and seals resolve not_applied against a late original commit',async () => {
    const input = intent('role-save',{ role_name:'迟到不得执行',rules:'product.view' }),value = await service.preview(input,actor()),before = await snapshot();
    const empty = { operation_id:input.operation_id,actor_id:102,operation:input.operation,request_hash:null,result:null };
    expect(await service.receipt(input.operation_id,input.operation,actor())).toEqual({ ...empty,state:'unknown' }); expect(await snapshot()).toEqual(before);
    const sealed = await service.resolve({ operation_id:input.operation_id,operation:input.operation },actor()); expect(sealed).toEqual({ ...empty,state:'not_applied' });
    const afterSeal = await snapshot(); expect(afterSeal.admins).toEqual(before.admins); expect(afterSeal.roles).toEqual(before.roles);
    expect(afterSeal.receipts.find(row => row.operationId===input.operation_id)).toMatchObject({ state:'not_applied',requestHash:'',revision:'',result:null });
    await expect(service.commit(confirmation(input,value),actor())).rejects.toThrow('封存为未执行');
    expect(await service.resolve({ operation_id:input.operation_id,operation:input.operation },actor())).toEqual(sealed);
    expect(await snapshot()).toEqual(afterSeal);
    await expect(fixture.db.update(adminAuthorityOperation).set({ state:'committed' }).where(eq(adminAuthorityOperation.operationId,input.operation_id))).rejects.toThrow();
    await expect(fixture.db.delete(adminAuthorityOperation).where(eq(adminAuthorityOperation.operationId,input.operation_id))).rejects.toThrow();
    await expect(fixture.db.execute(sql`TRUNCATE public.admin_authority_operation`)).rejects.toThrow();
    expect(await snapshot()).toEqual(afterSeal);
  });

  it.each(['returning','readback'] as const)('rolls all real business DML back when the receipt %s differs',async fault => {
    const input = intent('role-save',{ id:50,rules:'product.manage' }),value = await service.preview(input,actor()),before = await snapshot();
    await fixture.exec(`CREATE FUNCTION public.owned_operation_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      ${fault === 'returning' ? "NEW.request_hash:=repeat('0',64); RETURN NEW;" : "UPDATE public.admin_authority_operation SET request_hash=repeat('0',64) WHERE operation_id=NEW.operation_id; RETURN NEW;"}
    END $$;
    CREATE FUNCTION public.owned_operation_receipt_arm() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
      IF NEW.id=50 THEN
        ${fault === 'readback' ? "EXECUTE 'ALTER TABLE public.admin_authority_operation DISABLE TRIGGER aao_immutable_rows';" : ''}
        EXECUTE 'CREATE TRIGGER owned_operation_receipt_fault ${fault === 'returning' ? 'BEFORE' : 'AFTER'} INSERT ON public.admin_authority_operation FOR EACH ROW EXECUTE FUNCTION public.owned_operation_receipt_fault()';
      END IF; RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION public.owned_operation_receipt_arm() FROM PUBLIC;
    CREATE TRIGGER owned_operation_receipt_arm AFTER UPDATE ON public.system_role FOR EACH ROW EXECUTE FUNCTION public.owned_operation_receipt_arm();`);
    try {
      // The exact runtime catalog check really passes first. The owned
      // business-row trigger arms the deliberate fault only after the real
      // target UPDATE; the receipt INSERT/RETURNING/readback remain genuine.
      await expect(service.commit(confirmation(input,value),actor())).rejects.toThrow(fault === 'returning' ? '回执保存结果不一致' : '回执回读不一致');
      expect(await snapshot()).toEqual(before);
      await fixture.db.transaction(tx => assertAdminAuthorityOperationReady(tx));
      expect(await service.receipt(input.operation_id,input.operation,actor())).toMatchObject({ state:'unknown' });
    } finally {
      await fixture.exec('DROP TRIGGER owned_operation_receipt_arm ON public.system_role; DROP FUNCTION public.owned_operation_receipt_arm(); DROP FUNCTION public.owned_operation_receipt_fault();');
    }
  });

  it('allows an own password commit, then requires the current password version for receipt recovery',async () => {
    const input = intent('admin-save',{ id:102,pwd:'new-owned-self-operation-password' }),value = await service.preview(input,actor());
    const receipt = await service.commit(confirmation(input,value),actor()),[saved] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id,102));
    expect(await bcrypt.compare(String(input.payload.pwd),saved.pwd)).toBe(true);
    await expect(service.receipt(input.operation_id,input.operation,actor())).rejects.toThrow('凭据');
    expect(await service.receipt(input.operation_id,input.operation,{ ...actor(),authVersion:md5(saved.pwd) })).toEqual(receipt);
  },30_000);

  it('checks the normal administrator target, requested roles and own authority before generating a confirmation',async () => {
    const before = await snapshot();
    for (const payload of [{ id:112,real_name:'错误管理域' },{ id:113,real_name:'错误关系' },{ id:114,real_name:'已删除' },
      { id:115,real_name:'旧权限超出' },{ id:110,roles:'51' },{ id:110,roles:'53' },{ id:110,roles:'54' },{ id:110,roles:'55' },
      { id:110,roles:'56' },{ id:110,roles:'52' },{ id:110,level:0 },{ id:100,real_name:'不能编辑超级管理员' },
      { id:102,roles:'' },{ id:102,status:0 },{ id:102,level:2 }]) {
      await expect(service.preview(intent('admin-save',payload),actor())).rejects.toBeInstanceOf(ApiException);
      expect(await snapshot()).toEqual(before);
    }
    const input = intent('admin-save',{ id:110,real_name:'确认后正常改名',roles:'50',level:2,status:1 }),value = await service.preview(input,actor());
    expect(value.summary).toMatchObject({ target_id:110,action:'update',before:{ roles:'50',level:2,status:1 },after:{ roles:'50',level:2,status:1 } });
    await service.commit(confirmation(input,value),actor());
    expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id,110)))[0].realName).toBe('确认后正常改名');
  });

  it('fails unavailable receipt capability before any business mutation and restores the owned table unchanged',async () => {
    const before = await snapshot(),input = intent('role-save',{ id:50,rules:'product.manage' }),value = await service.preview(input,actor());
    await fixture.exec('ALTER TABLE public.admin_authority_operation RENAME TO owned_unavailable_authority_receipt');
    try {
      await expect(service.commit(confirmation(input,value),actor())).rejects.toMatchObject({ httpStatus:503 });
      expect(await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id)).toEqual(before.admins);
      expect(await fixture.db.select().from(systemRole).orderBy(systemRole.id)).toEqual(before.roles);
    } finally { await fixture.exec('ALTER TABLE public.owned_unavailable_authority_receipt RENAME TO admin_authority_operation'); }
    expect(await snapshot()).toEqual(before);
    await fixture.db.transaction(tx => assertAdminAuthorityOperationReady(tx));
  });

  it('uses exact controller envelopes, receipt query kind and no-store responses with live claims',async () => {
    const app = new Hono<{ Bindings:Env; Variables:AppVariables }>(),env = { APP_KEY:appKey } as Env;
    app.use('*',async (c,next) => { c.set('container',container); c.set('adminId',102); c.set('socketAuthVersion',actor().authVersion);
      c.set('socketTokenExp',expiresAt); c.set('adminInfo',{ id:102,account:'stale-cache',level:0,roles:'',realName:'',divisionId:0 }); await next(); });
    app.onError((error,c) => c.json({ status:error instanceof ApiException ? error.code : 500,msg:error.message,data:null },
      error instanceof HttpApiException ? error.httpStatus : 200));
    app.post('/system/authority/preview',adminAuthorityPreview); app.post('/system/authority/commit',adminAuthorityCommit);
    app.get('/system/authority/receipt/:operationId',adminAuthorityReceipt); app.post('/system/authority/resolve',adminAuthorityResolve);
    const post = (route:string,body:unknown) => app.request(`/system/authority/${route}`,{ method:'POST',headers:{ 'content-type':'application/json' },body:JSON.stringify(body) },env);
    const input = intent('role-save',{ id:50,rules:'product.manage' }),previewResponse = await post('preview',input);
    expect(previewResponse.headers.get('cache-control')).toBe('private, no-store');
    const previewBody = await previewResponse.json() as { status:number; data:AdminAuthorityPreview }; expect(previewBody.status).toBe(200);
    const committed = await (await post('commit',confirmation(input,previewBody.data))).json() as { status:number; data:unknown }; expect(committed.status).toBe(200);
    expect(await (await app.request(`/system/authority/receipt/${input.operation_id}?operation=role-save`,{},env)).json()).toMatchObject({ status:200,data:committed.data });
    for (const suffix of ['', '?operation=role-save&operation=role-save','?operation=role-save&extra=x']) {
      expect(await (await app.request(`/system/authority/receipt/${input.operation_id}${suffix}`,{},env)).json()).toMatchObject({ status:400 });
    }
    expect(await (await post('resolve',{ operation_id:input.operation_id,operation:input.operation })).json()).toMatchObject({ status:200,data:committed.data });
    await fixture.db.update(systemRole).set({ rules:'system.view' }).where(eq(systemRole.id,900));
    expect(await (await post('preview',intent('role-save',{ role_name:'旧缓存不能授权',rules:'product.view' }))).json()).toMatchObject({ status:400011 });
    expect(await (await app.request(`/system/authority/receipt/${input.operation_id}?operation=role-save`,{},env)).json()).toMatchObject({ status:200,data:committed.data });
  });
});
