import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { eq,sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createContainerFromDb,createDbFromConnectionString } from '../src/lib/di';
import type { AppVariables,Env } from '../src/env';
import { systemDise,systemLog } from '../src/models/schema';
import { adminDiseSave,adminDiseDel } from '../src/controllers/api/v1/AdminCrudController';
import { ProductCategoryStyleRejected,ProductCategoryStyleStaleVersion,categoryStyleInput } from '../src/services/admin/AdminProductCategoryStyleInput';
import { PRODUCT_CATEGORY_STYLE_LOCK_NAMESPACE } from '../src/services/admin/AdminProductCategoryStyleService';
import { themeHash } from '../src/services/content/ThemeReadService';
import { PRODUCT_CATEGORY_STYLES } from '../../view/common/productCategoryStyle';
import { outcome,waitForFinanceBlock } from './helpers/financePeers';
import { categoryActor,observeCategoryDb,productCategoryStyleFixture } from './helpers/productCategoryStyleFixture';
type Fixture=Awaited<ReturnType<typeof productCategoryStyleFixture>>;
type Peer=Parameters<Parameters<Fixture['withRuntimeRole']>[0]>[0];
const input=(revision:string,level=2,index=1)=>({operationId:crypto.randomUUID(),revision,level,index});
function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native complete category settings with non-owner current ACL intersection',()=>{
  let f:Fixture;
  beforeEach(async()=>{f=await productCategoryStyleFixture();},30000);
  afterEach(async()=>{await f?.close();},30000);
  const profiles=(run:(admin:Peer,app:Peer)=>Promise<void>)=>f.withRuntimeRole(app=>f.withRuntimeRole(async admin=>{
    await f.installSlice(app,admin);for(const peer of[app,admin])expect((await peer.exec('SELECT current_user,session_user'))[0]).toEqual({current_user:peer.role,session_user:peer.role});
    expect(app.pid).not.toBe(admin.pid);await run(admin,app);
  }));
  it('reads regardless of row switches, denies App writes and both LOGINs DDL',async()=>{await profiles(async(admin,app)=>{
    const before=await f.settingsSnapshot();expect(await f.serviceFor(app.db).read()).toMatchObject({value:{level:2,index:1},configured:true,editable:true,issues:[]});
    for(const peer of[app,admin])await expect(peer.exec('CREATE TABLE forbidden_category(id int)')).rejects.toMatchObject({code:'42501'});
    for(const query of["UPDATE system_dise SET value='{}' WHERE id=88","INSERT INTO system_dise(name) VALUES('bad')",'DELETE FROM system_dise WHERE id=88'])await expect(app.exec(query)).rejects.toMatchObject({code:'42501'});
    expect(await f.settingsSnapshot()).toEqual(before);
  });});
  it('saves every complete layout and preserves opaque JSON plus all unrelated row fields',async()=>{await profiles(async admin=>{
    const service=f.serviceFor(admin.db),before=await f.settingsSnapshot(),initial=before.rows.find(row=>row.id===88)!;
    const stable=({value:_value,version:_version,updateTime:_time,...rest}:typeof initial)=>rest;
    for(const{level,index}of PRODUCT_CATEGORY_STYLES){const body=input((await service.read()).revision,level,index),receipt=await service.save(body,categoryActor);
      expect(receipt).toEqual({operation:'update',id:88,operationId:body.operationId,payloadHash:await themeHash(categoryStyleInput(body).canonical)});
      const row=(await f.settingsSnapshot()).rows.find(item=>item.id===88)!;expect(stable(row)).toEqual(stable(initial));
      expect(JSON.parse(row.value!)).toEqual({...JSON.parse(initial.value!),level,index});expect(row.version).not.toBe(initial.version);
      expect((await service.read()).value).toEqual({level,index});
    }
    const after=await f.settingsSnapshot();expect(after.logs).toHaveLength(10);expect(after.configs).toEqual(before.configs);
  });});
  it('GET never initializes; explicit first save and receipt are atomic',async()=>{await f.db.delete(systemDise).where(eq(systemDise.id,88));await profiles(async admin=>{
    const service=f.serviceFor(admin.db),before=await f.settingsSnapshot(),missing=await service.read();
    expect(missing).toMatchObject({value:{level:2,index:1},configured:false,editable:true,issues:['category_style_missing']});expect(await f.settingsSnapshot()).toEqual(before);
    const body=input(missing.revision,3,3),receipt=await service.save(body,categoryActor),after=await f.settingsSnapshot();
    expect(after.rows).toHaveLength(before.rows.length+1);expect(after.rows.find(row=>row.id===receipt.id)).toMatchObject({templateName:'category',type:3,status:0,isShow:0,isDel:0,value:'{"level":3,"index":3}'});
    expect(await service.receipt(body.operationId,categoryActor)).toEqual(receipt);expect(after.logs).toHaveLength(1);
  });});
  it('rejects aliases, wrong types, deleted identities, duplicates and damaged or lossy objects before DML',async()=>{await profiles(async admin=>{
    const service=f.serviceFor(admin.db);
    for(const patch of[{templateName:'\tCATEGORY\n'},{templateName:'\u00a0category\u00a0'},{type:1},{isDel:1},
      {value:'{"level":2,"index":1,"opaque":9007199254740993}'},{value:'{"level":2,"index":1,"opaque":1.234567890123456789}'},{value:'{"level":2,"index":1,"index":2}'},{value:'broken'}]){
      await f.db.update(systemDise).set({templateName:'category',type:3,isDel:0,value:'{"level":2,"index":1}',...patch}).where(eq(systemDise.id,88));
      const page=await service.read(),before=await f.settingsSnapshot();expect(page.editable).toBe(false);expect(page.configured).toBe(false);
      await expect(service.save(input(page.revision),categoryActor)).rejects.toBeInstanceOf(ProductCategoryStyleRejected);expect(await f.settingsSnapshot()).toEqual(before);
    }
    await f.db.update(systemDise).set({templateName:'category',type:3,isDel:0,value:'{"level":2,"index":1}'}).where(eq(systemDise.id,88));
    await f.db.insert(systemDise).values({templateName:'\u00a0CATEGORY\u00a0',type:3,value:'{"level":3,"index":0}'});
    const page=await service.read(),before=await f.settingsSnapshot();expect(page.issues).toEqual(['category_style_duplicate']);await expect(service.save(input(page.revision),categoryActor)).rejects.toBeInstanceOf(ProductCategoryStyleRejected);expect(await f.settingsSnapshot()).toEqual(before);
  });});
  it('includes hidden metadata xmin in CAS and replays success before CAS while keeping actor/hash conflicts unknown',async()=>{await profiles(async admin=>{
    const service=f.serviceFor(admin.db),body=input((await service.read()).revision);
    await f.db.update(systemDise).set({content:'peer metadata only'}).where(eq(systemDise.id,88));let before=await f.settingsSnapshot();
    await expect(service.save(body,categoryActor)).rejects.toBeInstanceOf(ProductCategoryStyleStaleVersion);expect(await f.settingsSnapshot()).toEqual(before);
    const fresh=input((await service.read()).revision),receipt=await service.save(fresh,categoryActor);before=await f.settingsSnapshot();expect(await service.save(fresh,categoryActor)).toEqual(receipt);
    for(const[data,actor]of[[{...fresh,index:2},categoryActor],[fresh,{id:8}]]as const){const result=await outcome(service.save(data,actor));expect(result.ok).toBe(false);if(!result.ok){expect(result.error).not.toBeInstanceOf(ProductCategoryStyleRejected);expect(result.error).not.toBeInstanceOf(ProductCategoryStyleStaleVersion);}}
    expect(await f.settingsSnapshot()).toEqual(before);
    await f.db.update(systemLog).set({action:'broken'}).where(eq(systemLog.path,`/config/product-category-style/receipt/${fresh.operationId}`));before=await f.settingsSnapshot();
    const corrupt=await outcome(service.save(fresh,categoryActor));expect(corrupt.ok).toBe(false);if(!corrupt.ok)expect(corrupt.error).not.toBeInstanceOf(ProductCategoryStyleRejected);expect(await f.settingsSnapshot()).toEqual(before);
  });});
  it('rolls back all first-init writes after a genuine late journal INSERT error without proof',async()=>{await f.db.delete(systemDise).where(eq(systemDise.id,88));
    await f.exec("CREATE FUNCTION public.fail_category_journal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'owned journal error'; END$$");
    await f.exec('CREATE TRIGGER fail_category_journal BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION public.fail_category_journal()');
    await profiles(async admin=>{const service=f.serviceFor(admin.db),before=await f.settingsSnapshot(),result=await outcome(service.save(input((await service.read()).revision),categoryActor));
      expect(result.ok).toBe(false);if(!result.ok){expect(result.error).not.toBeInstanceOf(ProductCategoryStyleRejected);expect(result.error).not.toBeInstanceOf(ProductCategoryStyleStaleVersion);}expect(await f.settingsSnapshot()).toEqual(before);
    });
  });
  it('serializes identical UUIDs on independent genuine LOGIN sessions into one receipt',async()=>{await profiles(async admin=>{
    const second=createDbFromConnectionString(admin.connectionString,1),entered=gate(),release=gate(),body=input((await f.serviceFor(admin.db).read()).revision);
    try{await f.withPeer(async holder=>{const held=holder.db.transaction(async tx=>{await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_CATEGORY_STYLE_LOCK_NAMESPACE},0)`);entered.resolve();await release.promise;});await entered.promise;
      const[identity]=await second.execute(sql`SELECT pg_backend_pid() AS pid,current_user AS role`);expect(identity.role).toBe(admin.role);
      const one=outcome(f.serviceFor(admin.db).save(body,categoryActor)),two=outcome(f.serviceFor(second).save(body,categoryActor));
      try{await waitForFinanceBlock(f.db,admin.pid,holder.pid);await waitForFinanceBlock(f.db,Number(identity.pid),holder.pid);}finally{release.resolve();await held;}
      const[a,b]=await Promise.all([one,two]);expect(a.ok).toBe(true);expect(b).toEqual(a);expect((await f.settingsSnapshot()).logs).toHaveLength(1);
    });}finally{release.resolve();await second.$client.end({timeout:5});}
  });});
  it('freshly observes an importer phantom after waiting at the real table fence under forced RC',async()=>{await profiles(async admin=>{
    await admin.exec("SET default_transaction_isolation='repeatable read'");const service=f.serviceFor(admin.db),body=input((await service.read()).revision),entered=gate(),release=gate();
    await f.withPeer(async writer=>{const held=writer.db.transaction(async tx=>{await tx.insert(systemDise).values({templateName:'category',type:3,value:'{"level":3,"index":0}'});entered.resolve();await release.promise;});await entered.promise;
      const saving=outcome(service.save(body,categoryActor));try{await waitForFinanceBlock(f.db,admin.pid,writer.pid);expect((await f.exec(`SELECT mode FROM pg_locks WHERE pid=${admin.pid} AND relation='system_dise'::regclass AND NOT granted`))[0].mode).toBe('ShareRowExclusiveLock');}finally{release.resolve();await held;}
      const result=await saving;expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toBeInstanceOf(ProductCategoryStyleStaleVersion);expect((await service.read()).issues).toEqual(['category_style_duplicate']);expect((await f.settingsSnapshot()).logs).toHaveLength(0);
    });
  });});
  it('keeps generic save/delete at table-before-row, preserving usable ordinary DIY while avoiding lock inversion',async()=>{await profiles(async(admin,app)=>{
    await f.withRuntimeRole(async other=>{await f.installSlice(app,other);const generic=new Hono<{Bindings:Env;Variables:AppVariables}>();
      generic.use('*',async(c,next)=>{c.set('container',createContainerFromDb(other.db));await next();});generic.onError((error,c)=>c.json({status:400,msg:error.message},400));generic.post('/save',adminDiseSave);generic.delete('/del/:id',adminDiseDel);
      for(const method of['save','delete']){const entered=gate(),release=gate();let gated=false;
        const observed=observeCategoryDb(admin.db,async(_tx,command)=>{if(!gated&&/LOCK TABLE.*system_dise.*SHARE ROW EXCLUSIVE/i.test(command)){gated=true;entered.resolve();await release.promise;}});
        const saving=outcome(f.serviceFor(observed).save(input((await f.serviceFor(admin.db).read()).revision),categoryActor));await entered.promise;
        const changing=generic.request(method==='save'?'/save':'/del/2',{method:method==='save'?'POST':'DELETE',...(method==='save'?{headers:{'Content-Type':'application/json'},body:JSON.stringify({id:2,name:'ordinary changed',value:'[]',status:0})}:{})});
        try{await waitForFinanceBlock(f.db,other.pid,admin.pid);expect((await f.exec(`SELECT mode FROM pg_locks WHERE pid=${other.pid} AND relation='system_dise'::regclass AND NOT granted`))[0].mode).toBe('ShareRowExclusiveLock');}finally{release.resolve();}
        expect((await saving).ok).toBe(true);expect((await changing).status).toBe(200);if(method==='save')expect((await f.db.select().from(systemDise).where(eq(systemDise.id,2)))[0]).toMatchObject({name:'ordinary changed',status:0,isDel:0});
      }
      expect((await f.db.select().from(systemDise).where(eq(systemDise.id,2)))[0]).toMatchObject({name:'ordinary changed',isDel:1});expect((await f.settingsSnapshot()).logs).toHaveLength(2);
    });
  });});
});
