import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireAdminAuthorityMenuLock } from '@/migrations/adminAuthorityOperation';
import { acquireAdminAuthorityWriteBarrier } from '@/services/admin/AdminAuthorityWriteService';
import { ADMIN_PLATFORM_MENU_WRITE_FUNCTION, ADMIN_PLATFORM_MENU_WRITE_SIGNATURE,
  inspectAdminPlatformMenuOperation, inspectAdminPlatformMenuWriteCapability,
  assertAdminPlatformMenuWriteReady, installAdminPlatformMenuWriteCapabilityInTransaction } from '@/migrations/adminPlatformMenuWriteCapability';
import { createAdminPlatformMenuFixture } from './helpers/adminPlatformMenuFixture';
import { runtimeAdminBoundaryBody } from '@/migrations/runtimeAdminBoundary';

function state(error: unknown): string {
  for (let n=0; n<8 && error && typeof error==='object'; n++) {
    if ('code' in error && typeof error.code==='string') return error.code;
    error='cause' in error ? error.cause : undefined;
  }
  return '';
}
describe('Platform type-1 exact controlled SQL and immutable operation evidence', () => {
  let f: Awaited<ReturnType<typeof createAdminPlatformMenuFixture>>;
  beforeAll(async()=>{ f=await createAdminPlatformMenuFixture(); },30000);
  afterAll(async()=>{ await f?.close(); },30000);
  beforeEach(async()=>{
    await f.reset();
    await f.exec(`INSERT INTO public.system_admin(id,account,admin_type,relation_id,level,status,is_del) VALUES(1,'owned',1,0,0,1,0);
      INSERT INTO public.system_menus(id,pid,type,auth_type,menu_name,menu_path,unique_auth,path)
      VALUES(10,0,1,1,'Root','/admin/system','owned-root',''),(30,0,1,1,'Free','/system/free','owned-free',''),(40,0,4,1,'Supplier','/supplier','supplier-root','');
      INSERT INTO public.system_menus(id,pid,type,auth_type,menu_name,api_url,methods,path,access,module,controller,action,params,header,is_header)
      VALUES(20,10,1,2,'Old API','order/list','GET','10',0,'legacy-module','old-controller','old-action','{"keep":"metadata"}','old-header',1);
      INSERT INTO public.system_role(id,type,relation_id,role_name,rules,status) VALUES(1,1,0,'inactive','20',0),(2,4,7,'cross-scope',' 00020 ',0);
      SELECT setval('public.system_menus_id_seq',1000,true);`);
  });
  const rows = async()=>Array.from(await f.db.execute(sql`SELECT * FROM public.system_menus ORDER BY id`),r=>({...r}));
  const receipts = async()=>Array.from(await f.db.execute(sql`SELECT * FROM public.admin_platform_menu_operation ORDER BY request_id`),r=>({...r}));
  const revision = async(id:number)=>String((await f.db.execute(sql`SELECT xmin::text AS value FROM public.system_menus WHERE id=${id}`))[0]?.value);
  const payload = async(id:number)=>({...((await f.db.execute(sql`SELECT pid,auth_type,menu_name,menu_path,unique_auth,api_url,methods,icon,sort,is_show,is_show_path FROM public.system_menus WHERE id=${id}`))[0])});
  const fresh = (overrides:Record<string,unknown>={})=>({pid:10,auth_type:2,menu_name:'New API',menu_path:'',unique_auth:'',api_url:'order/info/:id',methods:'GET',icon:'',sort:0,is_show:1,is_show_path:0,...overrides});
  const write = (operation:string,id:number,xmin:string|null,body:unknown)=>f.asAdmin(()=>f.db.transaction(async tx=>{
    await acquireAdminAuthorityWriteBarrier(tx as unknown as DbClient); await acquireAdminAuthorityMenuLock(tx);
    return tx.execute(sql`SELECT public.cinashop_admin_platform_menu_write_v1(${operation},${id},${xmin},${JSON.stringify(body)}::jsonb) AS id`);
  }));
  async function denied(work:Promise<unknown>,code:string) {
    const error=await work.then(()=>null,failure=>failure); expect(error).not.toBeNull(); expect(state(error)).toBe(code);
  }

  it('recognizes actual function ownership, strong receipt schema and zero app access without writes',async()=>{
    const before={rows:await rows(),receipts:await receipts()};
    expect(await inspectAdminPlatformMenuWriteCapability(f.db,f.names.admin)).toMatchObject({ready:true,absent:false,definitionSafe:true,ownerSafe:true,aclSafe:true,tablesSafe:true});
    expect(await inspectAdminPlatformMenuOperation(f.db,f.names)).toBe(true);
    await f.asAdmin(()=>assertAdminPlatformMenuWriteReady(f.db));
    await denied(f.asApp(()=>f.exec('SELECT * FROM public.admin_platform_menu_operation')),'42501');
    expect({rows:await rows(),receipts:await receipts()}).toEqual(before);
  });
  it('requires the staff/role and menu locks even for the configured Admin session',async()=>{
    const before=await rows();
    await denied(f.asAdmin(()=>f.db.execute(sql`SELECT public.cinashop_admin_platform_menu_write_v1('create',0,NULL,${JSON.stringify(fresh())}::jsonb)`)),'42501');
    await denied(f.asAdmin(()=>f.db.transaction(async tx=>{
      await acquireAdminAuthorityWriteBarrier(tx as unknown as DbClient);
      return tx.execute(sql`SELECT public.cinashop_admin_platform_menu_write_v1('create',0,NULL,${JSON.stringify(fresh())}::jsonb)`);
    })),'42501');
    expect(await rows()).toEqual(before);
  });
  it('creates one type-1 API rule with PHP defaults and complete derived parent path',async()=>{
    const result=await write('create',0,null,fresh({is_show:0})); expect(result[0]?.id).toBe(1001);
    const [row]=await f.db.execute(sql`SELECT * FROM public.system_menus WHERE id=1001`);
    expect(row).toMatchObject({type:1,auth_type:2,pid:10,path:'10',access:1,module:'admin',is_show:1,api_url:'order/info/:id',methods:'GET'});
    expect(row).toMatchObject({controller:'',action:'',params:'[]',header:'',is_header:0,is_del:0});
  });
  it('keeps all inactive historical metadata and unchanged old path on a cosmetic edit',async()=>{
    const before=(await rows()).find(r=>r.id===20)!;
    await write('update',20,await revision(20),{...await payload(20),menu_name:'Renamed',icon:'md-star',sort:3});
    expect((await rows()).find(r=>r.id===20)).toEqual({...before,menu_name:'Renamed',icon:'md-star',sort:3});
  });
  it.each(['auth_type','api_url','methods','menu_path','unique_auth'] as const)('rejects referenced permission change to %s including inactive and cross-scope references',async field=>{
    const changed={auth_type:1,api_url:'order/save',methods:'POST',menu_path:'/admin/other',unique_auth:'system.manage'};
    const before=await rows(); await denied(write('update',20,await revision(20),{...await payload(20),...(field==='auth_type'?{menu_path:'/admin/meaning-change'}:{}),[field]:changed[field]}),'23503'); expect(await rows()).toEqual(before);
  });
  it('also counts an unassigned leading-zero reference when the ordinary platform reference is removed',async()=>{
    await f.exec('DELETE FROM public.system_role WHERE id=1'); const before=await rows();
    await denied(write('delete',20,await revision(20),{}),'23503'); expect(await rows()).toEqual(before);
  });
  it('rejects a newly allocated ID already present in any dangling role CSV without silently skipping it',async()=>{
    await f.exec("INSERT INTO public.system_role(id,type,relation_id,rules,status) VALUES(3,3,7,' 0001001 ',0)");
    const before=await rows(), prior=await receipts(); await denied(write('create',0,null,fresh()),'23503');
    expect(await rows()).toEqual(before); expect(await receipts()).toEqual(prior);
    const [sequence]=await f.db.execute(sql`SELECT last_value FROM public.system_menus_id_seq`); expect(Number(sequence.last_value)).toBe(1001);
    const [missing]=await f.db.execute(sql`SELECT count(*)::integer AS count FROM public.system_menus WHERE id=1001`); expect(missing.count).toBe(0);
  });
  it('rewrites the entire descendant path set on explicit reparenting and preserves its other fields',async()=>{
    const before=(await rows()).find(r=>r.id===20)!;
    await write('update',10,await revision(10),{...await payload(10),pid:30});
    expect((await rows()).find(r=>r.id===10)?.path).toBe('30');
    expect((await rows()).find(r=>r.id===20)).toEqual({...before,path:'30/10'});
  });
  it('rejects parent cycles, API parents and cross-scope parents atomically',async()=>{
    await f.exec('UPDATE public.system_menus SET pid=10 WHERE id=30'); const before=await rows();
    await denied(write('update',10,await revision(10),{...await payload(10),pid:30}),'23514');
    await denied(write('create',0,null,fresh({pid:20})),'23503'); await denied(write('create',0,null,fresh({pid:40})),'23503');
    expect(await rows()).toEqual(before);
  });
  it('refuses deletion with children, all role references, or a foreign type',async()=>{
    const before=await rows();
    await denied(write('delete',10,await revision(10),{}),'23503'); await denied(write('delete',20,await revision(20),{}),'23503');
    await denied(write('delete',40,await revision(40),{}),'P0002'); expect(await rows()).toEqual(before);
  });
  it('retains a permanent soft tombstone and rejects every explicit revival path',async()=>{
    const body=await payload(30); await write('delete',30,await revision(30),{});
    expect((await rows()).find(r=>r.id===30)?.is_del).toBe(1);
    await denied(write('update',30,await revision(30),body),'P0002'); await denied(write('create',30,null,body),'23514');
    expect((await rows()).find(r=>r.id===30)?.is_del).toBe(1);
  });
  it('allows navigation show only and keeps a stale row version from overwriting a later state',async()=>{
    const old=await revision(30); await write('show',30,old,{is_show:0});
    expect((await rows()).find(r=>r.id===30)?.is_show).toBe(0);
    await denied(write('show',30,old,{is_show:1}),'40001'); await denied(write('show',20,await revision(20),{is_show:0}),'23514');
  });
  it.each([
    ['extra hidden access',fresh({access:0})],['null number',fresh({pid:null})],['fraction',fresh({sort:0.5})],
    ['method missing',fresh({methods:''})],['multiple methods',fresh({methods:'GET|POST'})],['external API',fresh({api_url:'https://evil.invalid/a'})],
    ['external page',fresh({auth_type:1,menu_path:'//evil.invalid'})],['parent traversal',fresh({auth_type:1,menu_path:'/system/../other'})],
  ])('rejects %s payload without writing any menu',async(_label,body)=>{
    const before=await rows(); await denied(write('create',0,null,body),'23514'); expect(await rows()).toEqual(before);
  });
  it('preserves an unchanged legacy malformed API tuple for a narrow name correction',async()=>{
    await f.exec("UPDATE public.system_menus SET methods='GET|POST',api_url='old unknown path' WHERE id=20");
    const old=(await rows()).find(r=>r.id===20)!; await write('update',20,await revision(20),{...await payload(20),menu_name:'Kept old tuple'});
    expect((await rows()).find(r=>r.id===20)).toEqual({...old,menu_name:'Kept old tuple'});
  });
  it('enforces exact immutable receipt values and actual UPDATE/DELETE/TRUNCATE triggers',async()=>{
    const id=randomUUID(); await f.asAdmin(()=>f.db.execute(sql`INSERT INTO public.admin_platform_menu_operation VALUES(${id},1,'delete',30,${'a'.repeat(64)},${'b'.repeat(64)},1)`));
    const before=await receipts();
    for(const statement of ['UPDATE public.admin_platform_menu_operation SET actor_id=2','DELETE FROM public.admin_platform_menu_operation','TRUNCATE public.admin_platform_menu_operation']) {
      await denied(f.exec(statement),'42501'); expect(await receipts()).toEqual(before);
    }
    await denied(f.asAdmin(()=>f.db.execute(sql`INSERT INTO public.admin_platform_menu_operation VALUES(${randomUUID()},0,'other',0,'bad','bad',0)`)),'23514');
    expect(await receipts()).toEqual(before);
  });
  it('detects receipt trigger/constraint/ACL drift without repairing it',async()=>{
    await f.exec('ALTER TABLE public.admin_platform_menu_operation DISABLE TRIGGER apmo_immutable_rows');
    try { expect(await inspectAdminPlatformMenuOperation(f.db,f.names)).toBe(false); await expect(f.asAdmin(()=>assertAdminPlatformMenuWriteReady(f.db))).rejects.toMatchObject({code:503}); }
    finally { await f.exec('ALTER TABLE public.admin_platform_menu_operation ENABLE TRIGGER apmo_immutable_rows'); }
    await f.exec('ALTER TABLE public.admin_platform_menu_operation DROP CONSTRAINT apmo_actor_ck; ALTER TABLE public.admin_platform_menu_operation ADD CONSTRAINT apmo_actor_ck CHECK(actor_id>=0)');
    try { expect(await inspectAdminPlatformMenuOperation(f.db,f.names)).toBe(false); }
    finally { await f.exec('ALTER TABLE public.admin_platform_menu_operation DROP CONSTRAINT apmo_actor_ck; ALTER TABLE public.admin_platform_menu_operation ADD CONSTRAINT apmo_actor_ck CHECK(actor_id>0)'); }
    await f.exec('GRANT SELECT ON public.admin_platform_menu_operation TO PUBLIC');
    try { expect(await inspectAdminPlatformMenuOperation(f.db,f.names)).toBe(false); }
    finally { await f.exec('REVOKE SELECT ON public.admin_platform_menu_operation FROM PUBLIC'); }
    expect(await inspectAdminPlatformMenuOperation(f.db,f.names)).toBe(true);
  });
  it('rejects an unreviewed menu trigger but retains existing role-lock infrastructure',async()=>{
    await f.exec(`CREATE FUNCTION public.cinashop_runtime_admin_boundary_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $boundary$${runtimeAdminBoundaryBody(f.names.app)}$boundary$; REVOKE ALL ON FUNCTION public.cinashop_runtime_admin_boundary_v1() FROM PUBLIC`);
    for (const table of ['system_admin','system_role','system_menus']) await f.exec(`CREATE TRIGGER cinashop_runtime_admin_boundary_v1 BEFORE INSERT OR UPDATE OR DELETE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.cinashop_runtime_admin_boundary_v1()`);
    try {
      expect((await inspectAdminPlatformMenuWriteCapability(f.db,f.names.admin)).ready).toBe(true);
      await f.exec("CREATE FUNCTION public.menu_rewrite_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER menu_rewrite BEFORE UPDATE ON public.system_menus FOR EACH ROW EXECUTE FUNCTION public.menu_rewrite_fixture()");
      try { expect((await inspectAdminPlatformMenuWriteCapability(f.db,f.names.admin)).ready).toBe(false); await expect(f.asAdmin(()=>assertAdminPlatformMenuWriteReady(f.db))).rejects.toMatchObject({code:503}); }
      finally { await f.exec('DROP TRIGGER menu_rewrite ON public.system_menus; DROP FUNCTION public.menu_rewrite_fixture()'); }
      await f.exec('ALTER TABLE public.system_menus DISABLE TRIGGER cinashop_runtime_admin_boundary_v1');
      try { expect((await inspectAdminPlatformMenuWriteCapability(f.db,f.names.admin)).ready).toBe(false); }
      finally { await f.exec('ALTER TABLE public.system_menus ENABLE TRIGGER cinashop_runtime_admin_boundary_v1'); }
      expect((await inspectAdminPlatformMenuWriteCapability(f.db,f.names.admin)).ready).toBe(true);
    } finally {
      for (const table of ['system_admin','system_role','system_menus']) await f.exec(`DROP TRIGGER cinashop_runtime_admin_boundary_v1 ON public.${table}`);
      await f.exec('DROP FUNCTION public.cinashop_runtime_admin_boundary_v1()');
    }
    expect((await inspectAdminPlatformMenuWriteCapability(f.db,f.names.admin)).ready).toBe(true);
  });
  it('detects function-body and EXECUTE ACL drift while leaving the original type-4 namespace absent',async()=>{
    const before=await rows(); await f.exec(`GRANT EXECUTE ON FUNCTION ${ADMIN_PLATFORM_MENU_WRITE_SIGNATURE} TO PUBLIC`);
    try { expect((await inspectAdminPlatformMenuWriteCapability(f.db,f.names.admin)).ready).toBe(false); }
    finally { await f.exec(`REVOKE EXECUTE ON FUNCTION ${ADMIN_PLATFORM_MENU_WRITE_SIGNATURE} FROM PUBLIC`); }
    await f.exec(`ALTER FUNCTION ${ADMIN_PLATFORM_MENU_WRITE_SIGNATURE} RENAME TO platform_menu_saved_fixture`);
    try {
      await f.exec(`CREATE FUNCTION public.${ADMIN_PLATFORM_MENU_WRITE_FUNCTION}(text,integer,text,jsonb) RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$`);
      expect((await inspectAdminPlatformMenuWriteCapability(f.db,f.names.admin)).ready).toBe(false);
    } finally {
      await f.exec(`DROP FUNCTION ${ADMIN_PLATFORM_MENU_WRITE_SIGNATURE}; ALTER FUNCTION public.platform_menu_saved_fixture(text,integer,text,jsonb) RENAME TO ${ADMIN_PLATFORM_MENU_WRITE_FUNCTION}`);
    }
    expect((await inspectAdminPlatformMenuWriteCapability(f.db,f.names.admin)).ready).toBe(true); expect(await rows()).toEqual(before);
    const [row]=await f.db.execute(sql`SELECT to_regprocedure('public.cinashop_admin_supplier_menu_write_v1(text,integer,text,jsonb)') IS NULL AS absent`); expect(row.absent).toBe(true);
  });
  it('rejects maintenance on the wrong database/version and never attempts automatic DDL repair',async()=>{
    const before=await rows();
    await expect(f.db.transaction(tx=>installAdminPlatformMenuWriteCapabilityInTransaction(tx,{...f.names,database:'not_owned_fixture'}))).rejects.toThrow('PG16 owner/database');
    expect(await rows()).toEqual(before); expect(await inspectAdminPlatformMenuOperation(f.db,f.names)).toBe(true);
  });
});
