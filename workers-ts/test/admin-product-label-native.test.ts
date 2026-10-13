import {afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {createContainerFromDb} from '@/lib/di';
import {legacyCategory,storeProductLabel,storeProductRelation,storeProduct,systemLog} from '@/models/schema';
import {AdminProductLabelService} from '@/services/admin/AdminProductLabelService';
import {labelActor,labelBody,labelSchema,seedProductLabels} from './helpers/adminProductLabels';
import {sequenceRunnerDatabase,type SequenceRunnerPeer} from './helpers/kefuSequenceRunnerDatabase';
type Fixture=Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Login=SequenceRunnerPeer&{role:string};
function code(error:unknown):string{for(let i=0;i<6&&error&&typeof error==='object';i++){if('code'in error)return String(error.code);error='cause'in error?error.cause:null;}return '';}
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('complete product-label writes on independent PG16 LOGINs',()=>{
  let f:Fixture,ddl:string;
  beforeAll(async()=>{const kit=await import('drizzle-kit/api');ddl=(await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson(labelSchema))).join('\n');});
  beforeEach(async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Native label fixture forbids external I/O'));f=await sequenceRunnerDatabase();
    if(f.format!=='pg16'||!f.withRuntimeRole||!f.withPeer)throw Error('Independent PG16 LOGIN peers required');
    await f.exec(ddl);await seedProductLabels(f.db);
    await f.exec("SELECT setval(pg_get_serial_sequence('category','id'),100,false); SELECT setval(pg_get_serial_sequence('store_product_label','id'),1000,false)");
  },60000);
  afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}},30000);
  const service=(peer:SequenceRunnerPeer)=>new AdminProductLabelService(createContainerFromDb(peer.db),'label-native-key');
  async function login<T>(write:boolean,run:(peer:Login)=>Promise<T>){return f.withRuntimeRole!(async peer=>{
    if(!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role))throw Error('Unsafe owned LOGIN');
    await f.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${peer.role}"`);
    if(write)await f.exec(`GRANT INSERT,UPDATE,DELETE ON public.category,public.store_product_label,public.system_log TO "${peer.role}";
      GRANT UPDATE ON public.system_admin,public.system_role TO "${peer.role}";
      GRANT UPDATE(id) ON public.system_menus TO "${peer.role}";
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${peer.role}"`);
    const [identity]=await peer.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version");
    expect(identity).toMatchObject({role:peer.role,session:peer.role,pid:peer.pid});expect(Math.floor(Number(identity.version)/10000)).toBe(16);
    return run(peer);
  });}
  it('completes group and label lifecycle with real menu row-lock capability but no semantic menu DML',async()=>{
    await login(true,async peer=>{
      const [acl]=await peer.exec("SELECT has_column_privilege(current_user,'public.system_menus','id','UPDATE') AS lock_id,has_column_privilege(current_user,'public.system_menus','api_url','UPDATE') AS rewrite_api");
      expect(acl).toEqual({lock_id:true,rewrite_api:false});
      await expect(peer.exec("UPDATE public.system_menus SET api_url='forged' WHERE id=901")).rejects.toMatchObject({code:'42501'});
      const group=await service(peer).saveCategory(0,{name:'原生分组',sort:8},labelActor(105));
      const label=await service(peer).save(0,labelBody({label_cate:group.id}),labelActor(105));
      await service(peer).save(label.id,labelBody({label_cate:group.id,label_name:'原生改名'}),labelActor(105));
      await service(peer).setFlag(label.id,0,'status',labelActor(105));await service(peer).setFlag(label.id,0,'isShow',labelActor(105));
      await expect(service(peer).deleteCategory(group.id,labelActor())).rejects.toThrow('有标签');
      await service(peer).deleteLabel(label.id,labelActor(105));await service(peer).deleteCategory(group.id,labelActor(105));
      expect(await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,label.id))).toEqual([]);
      expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row=>row.method)).toEqual(['POST','POST','POST','PUT','PUT','DELETE','DELETE']);
    });
  },60000);
  it('supports SELECT-only reads and rejects writes without authority table-lock privilege with zero business effects',async()=>{
    await login(false,async peer=>{
      expect((await service(peer).list(new URLSearchParams(),labelActor())).count).toBe(4);
      const before=await f.db.select().from(storeProductLabel).orderBy(storeProductLabel.id);
      const error=await service(peer).save(0,labelBody(),labelActor()).then(()=>null,error=>error);
      expect(code(error)).toBe('42501');expect(await f.db.select().from(storeProductLabel).orderBy(storeProductLabel.id)).toEqual(before);
      expect(await f.db.select().from(systemLog)).toEqual([]);
    });
  },60000);
  it('serializes concurrent same-name creation and retains one complete row and audit',async()=>{
    await login(true,peer=>f.withPeer!(async writer=>{
      expect(peer.pid).not.toBe(writer.pid);
      const results=await Promise.allSettled([service(peer).save(0,labelBody(),labelActor()),service(writer).save(0,labelBody(),labelActor())]);
      expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
      expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.labelName,'新品')))).toHaveLength(1);
      expect(await f.db.select().from(systemLog)).toHaveLength(1);
      await expect(service(peer).save(0,labelBody(),labelActor())).rejects.toThrow('已经存在');
    }));
  },60000);
  it('honors the existing product FOR SHARE protocol before deleting a referenced label',async()=>{
    await login(true,peer=>f.withPeer!(async writer=>{
      await writer.db.transaction(async tx=>{
        await tx.select().from(storeProductLabel).where(eq(storeProductLabel.id,10)).for('share');
        const error=await service(peer).deleteLabel(10,labelActor()).then(()=>null,error=>error);
        expect(code(error)).toBe('55P03');
        await tx.insert(storeProductRelation).values({productId:99,relationId:10,type:3});
      });
      await expect(service(peer).deleteLabel(10,labelActor())).rejects.toThrow('引用');
      expect(await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,10))).toHaveLength(1);
      expect(await f.db.select().from(systemLog)).toEqual([]);
    }));
  },60000);
  it('does not delete a group underneath a held category reference or partially commit a protected batch',async()=>{
    await login(true,peer=>f.withPeer!(async writer=>{
      await writer.db.transaction(async tx=>{
        await tx.select().from(legacyCategory).where(eq(legacyCategory.id,3)).for('share');
        const error=await service(peer).deleteCategory(3,labelActor()).then(()=>null,error=>error);
        expect(code(error)).toBe('55P03');
        await tx.insert(storeProductLabel).values({id:99,labelCate:3,labelName:'并发新标签'});
      });
      await expect(service(peer).deleteCategory(3,labelActor())).rejects.toThrow('有标签');
      await writer.db.insert(storeProductRelation).values({productId:88,relationId:10,type:3});
      await expect(service(peer).batchDelete({ids:[10,11]},labelActor())).rejects.toThrow('引用');
      expect(await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,11))).toHaveLength(1);
      expect(await f.db.select().from(systemLog)).toEqual([]);
      await writer.db.delete(storeProductRelation);
      await writer.db.insert(storeProduct).values({id:88,storeLabelId:'0, ,99999999999999,11,',isDel:0});
      await expect(service(peer).deleteLabel(11,labelActor())).rejects.toThrow('引用');
      await service(peer).deleteLabel(10,labelActor());
      expect(await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,10))).toEqual([]);
      expect(await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,11))).toHaveLength(1);
    }));
  },60000);
});
