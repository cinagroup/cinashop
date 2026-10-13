import {afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {createContainerFromDb,withTx} from '@/lib/di';
import {storeBrand,storeProduct,storeProductRelation,systemLog} from '@/models/schema';
import {AdminProductBrandService} from '@/services/admin/AdminProductBrandService';
import {lockProductWrite} from '@/services/product/ProductAssociationService';
import {brandActor,brandBody,brandSchema,seedProductBrands} from './helpers/adminProductBrands';
import {sequenceRunnerDatabase,type SequenceRunnerPeer} from './helpers/kefuSequenceRunnerDatabase';
type Fixture=Awaited<ReturnType<typeof sequenceRunnerDatabase>>;type Login=SequenceRunnerPeer&{role:string};
function code(error:unknown):string{for(let i=0;i<6&&error&&typeof error==='object';i++){if('code'in error)return String(error.code);error='cause'in error?error.cause:null;}return '';}
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('complete brand hierarchy on independent PG16 LOGINs',()=>{
  let f:Fixture,ddl:string;beforeAll(async()=>{const kit=await import('drizzle-kit/api');ddl=(await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson(brandSchema))).join('\n');});
  beforeEach(async()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Native external I/O forbidden'));f=await sequenceRunnerDatabase();if(f.format!=='pg16'||!f.withRuntimeRole||!f.withPeer)throw Error('Independent PG16 LOGIN peers required');await f.exec(ddl);await seedProductBrands(f.db);await f.exec("SELECT setval(pg_get_serial_sequence('store_brand','id'),100,false)");},60000);
  afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}},30000);
  const service=(peer:SequenceRunnerPeer)=>new AdminProductBrandService(createContainerFromDb(peer.db));
  async function login<T>(write:boolean,run:(peer:Login)=>Promise<T>){return f.withRuntimeRole!(async peer=>{
    if(!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role))throw Error('Unsafe owned LOGIN');await f.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${peer.role}"`);
    if(write)await f.exec(`GRANT INSERT,UPDATE,DELETE ON public.store_brand,public.store_product_relation,public.system_log TO "${peer.role}"; GRANT UPDATE ON public.store_product,public.system_admin,public.system_role TO "${peer.role}"; GRANT UPDATE(id) ON public.system_menus TO "${peer.role}"; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${peer.role}"`);
    const [identity]=await peer.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version");expect(identity).toMatchObject({role:peer.role,session:peer.role,pid:peer.pid});expect(Math.floor(Number(identity.version)/10000)).toBe(16);return run(peer);
  });}
  async function product(){await f.db.insert(storeProduct).values({id:80,brandId:3,brandCom:'1,2,3',price:'29.50'});await f.db.insert(storeProductRelation).values([1,2,3].map((relationId,index)=>({id:801+index,productId:80,type:2,relationId,status:index===0?0:1,addTime:index+1})));}
  it('completes three-level lifecycle under numeric authority with menu row-lock but no semantic menu DML',async()=>{
    await login(true,async peer=>{const [acl]=await peer.exec("SELECT has_column_privilege(current_user,'public.system_menus','id','UPDATE') AS lock_id,has_column_privilege(current_user,'public.system_menus','api_url','UPDATE') AS rewrite_api");expect(acl).toEqual({lock_id:true,rewrite_api:false});await expect(peer.exec("UPDATE public.system_menus SET api_url='forged' WHERE id=1341")).rejects.toMatchObject({code:'42501'});
      const root=await service(peer).save(0,brandBody(),brandActor(105)),child=await service(peer).save(0,brandBody({fid:[root.id]}),brandActor(105)),leaf=await service(peer).save(0,brandBody({fid:[root.id,child.id]}),brandActor(105));
      await service(peer).save(leaf.id,brandBody({fid:[root.id,child.id],brand_name:'原生编辑'}),brandActor(105));await service(peer).setShow(leaf.id,0,brandActor(105));await service(peer).remove(leaf.id,brandActor(105));await service(peer).remove(child.id,brandActor(105));await service(peer).remove(root.id,brandActor(105));
      expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row=>row.method)).toEqual(['POST','POST','POST','PUT','PUT','DELETE','DELETE','DELETE']);});
  },60000);
  it('reads with SELECT-only and rejects writes without table-barrier capability with zero effects',async()=>{
    await login(false,async peer=>{expect((await service(peer).list(new URLSearchParams(),brandActor())).count).toBe(4);const before=await f.db.select().from(storeBrand).orderBy(storeBrand.id);const error=await service(peer).save(0,brandBody(),brandActor()).then(()=>null,error=>error);expect(code(error)).toBe('42501');expect(await f.db.select().from(storeBrand).orderBy(storeBrand.id)).toEqual(before);expect(await f.db.select().from(systemLog)).toEqual([]);});
  },60000);
  it('serializes competing same-parent creations into one row and one complete audit',async()=>{
    await login(true,peer=>f.withPeer!(async writer=>{const results=await Promise.allSettled([service(peer).save(0,brandBody(),brandActor()),service(writer).save(0,brandBody(),brandActor())]);expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(await f.db.select().from(storeBrand).where(eq(storeBrand.brandName,'新品牌'))).toHaveLength(1);expect(await f.db.select().from(systemLog)).toHaveLength(1);}));
  },60000);
  it('returns an immediate conflict while a product writer holds the shared product fence and succeeds after its commit',async()=>{
    await product();await login(true,peer=>f.withPeer!(async writer=>{
      await withTx(createContainerFromDb(writer.db),async tx=>{await lockProductWrite(tx,80);await expect(service(peer).save(2,brandBody({fid:[4]}),brandActor())).rejects.toMatchObject({code:409});await tx.select().from(storeBrand).where(eq(storeBrand.id,3)).for('share');await tx.update(storeProduct).set({price:'30.00'}).where(eq(storeProduct.id,80));});
      expect(await f.db.select().from(systemLog)).toEqual([]);await service(peer).save(2,brandBody({fid:[4]}),brandActor());expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id,80)))[0]).toMatchObject({brandId:3,brandCom:'4,2,3',price:'30.00'});expect((await f.db.select().from(storeBrand).where(eq(storeBrand.id,3)))[0].fid).toBe('4,2');
    }));
  },60000);
  it('holds a product writer until the brand move commits, then exposes only the new ancestry',async()=>{
    await product();await f.exec("CREATE FUNCTION hold_brand_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731736,0); RETURN NEW; END $$; CREATE TRIGGER hold_brand_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION hold_brand_audit_fixture()");
    await login(true,peer=>f.withPeer!(async blocker=>f.withPeer!(async writer=>{
      const [observer]=await blocker.exec('SELECT pg_backend_pid() AS pid');expect(observer.pid).toBe(blocker.pid);expect(new Set([peer.pid,writer.pid,blocker.pid]).size).toBe(3);
      await blocker.exec('SELECT pg_advisory_lock(731736,0)');const operation=service(peer).save(2,brandBody({fid:[4]}),brandActor()).then(()=>null,error=>error);
      let writerOperation:Promise<unknown>|undefined,moveError:unknown,writerError:unknown,readAncestry=false;
      try{let waiting=false;for(let attempt=0;attempt<100;attempt++){const [lock]=await blocker.exec(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${peer.pid} AND locktype='advisory' AND classid=731736::oid AND objid=0::oid AND NOT granted) AS waiting`);if(lock?.waiting===true){waiting=true;break;}await new Promise(done=>setTimeout(done,10));}expect(waiting).toBe(true);
        // The real product writer waits on the shared product fence first. Start
        // it without awaiting completion while the audit commit barrier is held.
        writerOperation=withTx(createContainerFromDb(writer.db),async tx=>{await lockProductWrite(tx,80);const [brand]=await tx.select().from(storeBrand).where(eq(storeBrand.id,3)).for('share');readAncestry=true;expect(brand.fid).toBe('4,2');await tx.update(storeProduct).set({price:'31.00'}).where(eq(storeProduct.id,80));}).then(()=>null,error=>error);
        let productWaiting=false;for(let attempt=0;attempt<100;attempt++){const [lock]=await blocker.exec(`SELECT ${peer.pid}=ANY(pg_blocking_pids(${writer.pid})) AND EXISTS(SELECT 1 FROM pg_locks WHERE pid=${writer.pid} AND locktype='advisory' AND classid=731617::oid AND objid=80::oid AND NOT granted) AS waiting`);if(lock?.waiting===true){productWaiting=true;break;}await new Promise(done=>setTimeout(done,10));}expect(productWaiting).toBe(true);expect(readAncestry).toBe(false);
        // The observer has its own backend and no queued writer transaction.
        await expect(blocker.exec('SELECT id FROM public.store_brand WHERE id=3 FOR SHARE NOWAIT')).rejects.toMatchObject({code:'55P03'});
      }finally{await blocker.exec('SELECT pg_advisory_unlock(731736,0)');[moveError,writerError]=await Promise.all([operation,writerOperation??Promise.resolve(null)]);}
      if(moveError)throw moveError;if(writerError)throw writerError;expect(readAncestry).toBe(true);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id,80)))[0]).toMatchObject({brandId:3,brandCom:'4,2,3',price:'31.00'});expect((await f.db.select().from(storeProductRelation).orderBy(storeProductRelation.id)).filter(row=>row.productId===80).map(row=>row.relationId).sort()).toEqual([2,3,4]);
    })));
  },60000);
});
