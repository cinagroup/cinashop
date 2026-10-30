import {and,eq,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {drizzle} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createContainerFromDb,type DbClient} from '@/lib/di';
import {legacyCategory,storeProductSpecs,storeProduct,storeProductRelation,storeProductCategory,
  storeProductUnit,systemAdmin,systemRole,systemSupplier,systemLog} from '@/models/schema';
import {md5} from '@/utils/jwt';
import {AdminParameterAuthorService} from '@/services/admin/AdminParameterAuthorService';
import {parameterActionHash} from '@/services/admin/AdminParameterAuthorInput';
import {ProductMetadataService,platformMetadataOwner} from '@/services/product/ProductMetadataService';
import {ProductAssociationService} from '@/services/product/ProductAssociationService';
import {SupplierProductManagementService} from '@/services/supplier/SupplierProductManagementService';
import {runRuntimeBusinessCommissioning} from '@/migrations/runRuntimeBusinessCommissioning';
import {auditRuntimeBusinessPrivileges} from '@/migrations/auditRuntimeBusinessPrivileges';
import {runAdminRuleUpgrade} from '@/migrations/runAdminRuleUpgrade';
import {inspectAdminRuleOperation} from '@/migrations/adminRuleOperation';
import {runAdminParameterUpgrade} from '@/migrations/runAdminParameterUpgrade';
import {assertAdminParameterOperationReady,inspectAdminParameterOperation} from '@/migrations/adminParameterOperation';
import {refundRuntimeFixture} from './helpers/refundRuntimeFixture';
import type {SequenceRunnerPeer} from './helpers/checkoutPricingMigrationDatabase';
import type {ParameterAction,ParameterOperation} from '../../view/common/parameterAuthor';

const signal=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
const outcome=<T>(task:Promise<T>)=>task.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
async function waitFor(exec:SequenceRunnerPeer['exec'],statement:string){
  for(let i=0;i<120;i++){const [row]=await exec(statement);if(row?.waiting===true)return;await new Promise(done=>setTimeout(done,10));}
  throw Error('Expected actual parameter writer blocker was not observed');
}
async function paused<T>(ready:ReturnType<typeof signal>,task:ReturnType<typeof outcome<T>>){
  await Promise.race([ready.promise,task.then(result=>{if(!result.ok)throw result.error;throw Error('Actual writer returned without pausing');})]);
}
function interrupted(db:DbClient,trace:{reached:boolean}):DbClient{
  const dialect=new PgDialect();
  return new Proxy(db,{get(target,key){const method:unknown=Reflect.get(target,key);if(typeof method!=='function')return method;if(key!=='transaction')return method.bind(target);
    return(callback:(tx:Pick<DbClient,'execute'>)=>Promise<unknown>,options:unknown)=>target.transaction(async tx=>{
      const port=new Proxy(tx,{get(current,property){const member:unknown=Reflect.get(current,property);if(typeof member!=='function')return member;if(property!=='execute')return member.bind(current);
        return async(query:Parameters<typeof tx.execute>[0])=>{const statement=dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql;
          const result=await tx.execute(query);if(statement.startsWith('GRANT SELECT, INSERT ON TABLE public.admin_parameter_operation TO ')){trace.reached=true;throw Error('Owned parameter interruption after actual grant');}return result;};
      }});return callback(port);
    },options as Parameters<typeof target.transaction>[1]);
  }});
}
/** A second real LOGIN with the already commissioned Admin credentials. No
 * maintenance SET ROLE, additional grants, or enlarged App catalog DML port. */
async function withAdminConnection<T>(connectionString:string,role:string,run:(peer:SequenceRunnerPeer)=>Promise<T>){
  const client=postgres(connectionString,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,max_lifetime:0,
    connection:{options:'-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=2000'}});
  try{
    const [identity]=await client`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version`;
    expect(identity).toMatchObject({role,session:role});expect(Math.floor(Number(identity.version)/10000)).toBe(16);
    return await run({db:drizzle(client) as unknown as DbClient,pid:Number(identity.pid),exec:async text=>Array.from(await client.unsafe(text))});
  }finally{await client.end({timeout:5});}
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Parameter author actual current PG16 LOGINs, legacy writers and product-copy locks',()=>{
  afterEach(()=>vi.restoreAllMocks());
  it('commissions atomically and preserves complete parameter history while real product/template writers serialize both directions',async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Native parameter author forbids external I/O'));
    const whole=await refundRuntimeFixture();
    try{
      if(!whole.withRuntimeRole||!whole.withPeer)throw Error('Independent App/Admin LOGIN and maintenance observer peers required');
      await whole.withRuntimeRole(async app=>whole.withRuntimeRole!(async admin=>{
        const [identity]=await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
        const target={database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role};
        // This owned unique index is the ordinary Supplier writer's declared
        // onConflict identity, as in supplier-product-parameters-native. It is
        // not a production migration or a runtime privilege repair.
        await whole.exec('CREATE UNIQUE INDEX owned_parameter_native_description ON public.store_product_description(product_id,type)');
        await runRuntimeBusinessCommissioning(whole.db,{...target,pricingOwner:whole.pricingOwner});
        await runAdminRuleUpgrade(whole.db,target);
        const audit=async()=>({app:await auditRuntimeBusinessPrivileges(app.db,'app',target),admin:await auditRuntimeBusinessPrivileges(admin.db,'admin',target)});
        expect(await inspectAdminRuleOperation(whole.db,target)).toBe(true);
        expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
        await expect(admin.db.transaction(tx=>assertAdminParameterOperationReady(tx))).rejects.toMatchObject({code:503});
        const trace={reached:false};await expect(runAdminParameterUpgrade(interrupted(whole.db,trace),target)).rejects.toThrow('Owned parameter interruption');expect(trace.reached).toBe(true);
        expect((await whole.db.execute(sql`SELECT to_regclass('public.admin_parameter_operation') IS NULL AS table_absent,
          to_regprocedure('public.admin_parameter_operation_immutable_v1()') IS NULL AS function_absent`))[0]).toEqual({table_absent:true,function_absent:true});
        expect(await inspectAdminRuleOperation(whole.db,target)).toBe(true);
        expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
        expect(await runAdminParameterUpgrade(whole.db,target)).toEqual({operation:'admin-parameter-operation-v1',applied:true});
        expect(await inspectAdminParameterOperation(whole.db,target)).toBe(true);
        await admin.db.transaction(tx=>assertAdminParameterOperationReady(tx));
        for(const query of ['SELECT * FROM public.admin_parameter_operation','INSERT INTO public.admin_parameter_operation DEFAULT VALUES'])
          await expect(app.exec(query)).rejects.toMatchObject({code:'42501'});
        for(const query of ['UPDATE public.admin_parameter_operation SET actor_id=1','DELETE FROM public.admin_parameter_operation',
          'TRUNCATE public.admin_parameter_operation','ALTER TABLE public.admin_parameter_operation ADD COLUMN forbidden integer'])
          await expect(admin.exec(query)).rejects.toMatchObject({code:'42501'});
        await withAdminConnection(admin.connectionString,admin.role,async legacy=>{
          const base=990731,consumer=base+2,doomed=base+3,orphan=base+4,pwd='owned-native-parameter-password';
          await whole.db.insert(systemRole).values({id:900,roleName:'Owned parameter author',rules:'product.manage'});
          await whole.db.insert(systemAdmin).values([{id:900,account:'owned_native_parameter',pwd,level:1,roles:'900'},
            {id:901,account:'owned_native_parameter_supplier',pwd,adminType:4,relationId:7,level:0}]);
          await whole.db.update(systemSupplier).set({adminId:901}).where(eq(systemSupplier.id,7));
          await whole.db.insert(legacyCategory).values([
            {id:base,group:3,name:'原生参数模板',pid:7,sort:-2147483648,other:'完整只读元数据',isShow:7,addTime:-1,integralMin:3,integralMax:9},
            {id:base+1,type:2,relationId:7,group:3,name:'供应商参数来源',other:'不公开的供应商原件'},
            {id:consumer,group:3,name:'原生绑定参数模板'},
            {id:doomed,group:3,name:'作者先删除的模板'},
            {id:orphan,group:3,name:'仅历史type6引用模板'},
            {id:base+5,type:1,relationId:88,group:2,ownerId:19,name:'不相关分类原件',other:'不可覆写',isShow:9},
          ]);
          await whole.db.insert(storeProductSpecs).values([
            {id:990751,tempId:base,name:'性能',value:'默认',sort:3,status:1,addTime:17},
            {id:990752,tempId:base,name:'历史隐藏\n参数',value:'\t旧值\u0085',sort:-9,status:7,addTime:-1},
            {id:990753,type:2,relationId:7,tempId:base+1,name:'私有',value:'供应商原始',sort:-5,status:0},
            {id:990754,tempId:consumer,name:'性能',value:'模板默认',sort:1,status:1},
            {id:990755,tempId:doomed,name:'性能',value:'将删除的默认',sort:1,status:1},
            {id:990756,tempId:orphan,name:'旧关系',value:'不因商品回收清除',status:0},
          ]);
          await whole.db.insert(storeProductUnit).values({id:990761,name:'参数原生件'});
          await whole.db.insert(storeProductCategory).values({id:990762,type:2,relationId:7,cateName:'参数原生供应商分类'});
          for(const table of ['category','store_product_specs','store_product','store_product_attr_value'])
            await whole.exec(`SELECT setval(pg_get_serial_sequence('public.${table}','id'),(SELECT max(id)+1 FROM public.${table}),false)`);
          const actor={id:900,authVersion:md5(pwd),expiresAt:Math.floor(Date.now()/1000)+3600},supplierActor={...actor,id:901},query=new URLSearchParams();
          const service=new AdminParameterAuthorService(createContainerFromDb(admin.db));
          const intent=async(operation:ParameterOperation,target_id=base,payload:Record<string,unknown>={}):Promise<ParameterAction>=>{
            const action={operation_id:crypto.randomUUID(),actor_id:900,operation,target_id,revision:(await service.catalog(query,actor)).revision,payload};
            return {...action,payload_hash:parameterActionHash(action)};
          };
          const metadata=(db:DbClient)=>new ProductMetadataService(createContainerFromDb(db));
          const products=(db:DbClient)=>new ProductAssociationService(createContainerFromDb(db));
          const supplier=(db:DbClient)=>new SupplierProductManagementService(createContainerFromDb(db),{APP_KEY:'owned-native-parameter-key'});
          const root=async(id:number)=>(await whole.db.select().from(legacyCategory).where(eq(legacyCategory.id,id)))[0];
          const children=async(id:number)=>whole.db.select().from(storeProductSpecs).where(eq(storeProductSpecs.tempId,id)).orderBy(storeProductSpecs.id);
          const privateSnapshot=async()=>({parents:await whole.db.select().from(legacyCategory).orderBy(legacyCategory.id),
            children:await whole.db.select().from(storeProductSpecs).orderBy(storeProductSpecs.id),
            logs:await whole.db.select().from(systemLog).orderBy(systemLog.id),
            receipts:await whole.exec('SELECT * FROM public.admin_parameter_operation ORDER BY operation_id')});
          const productSnapshot=async()=>({products:await whole.db.select().from(storeProduct).orderBy(storeProduct.id),
            relations:await whole.db.select().from(storeProductRelation).orderBy(storeProductRelation.id)});
          const productActor={id:900,name:'Owned parameter product writer',ip:'127.0.0.1'};
          const productBody=(id:number,name:string)=>({store_name:name,unit_name:'参数原生件',price:'19.50',stock:8,
            specs_id:id,specs:[{name:'性能',value:'商品独立填写值',sort:7,status:1}]});
          const supplierBody=(id:number,name:string)=>({product_type:0,store_name:name,store_info:'真实旧Supplier writer',unit_name:'参数原生件',
            cate_id:[990762],slider_image:['/owned-parameter/cover.png'],description:'<p>Owned parameter product</p>',spec_type:0,
            attrs:[{suk:'默认',image:'/owned-parameter/cover.png',price:'19.99',settle_price:'12.34',cost:'10.00',ot_price:'29.99',vip_price:'18.00',stock:7}],
            freight:1,specs_id:id,specs:[{id:0,temp_id:0,name:'自由重复参数',value:'自由甲',sort:-3},{id:0,temp_id:0,name:'自由重复参数',value:'自由乙',sort:-2147483648}]});
          const parentBefore=await root(base),childrenBefore=await children(base),foreignBefore=await root(base+5),supplierBefore=await root(base+1);
          const initial=await service.catalog(query,actor);expect(initial.list.find(row=>row.id===base)).toMatchObject({pid:7,sort:-2147483648,other:'完整只读元数据',is_show:7,add_time:-1,integral_min:3,integral_max:9});
          expect(initial.list.some(row=>row.id===base+1||row.id===base+5)).toBe(false);
          // Same historical parent values and preserve mode issue no rewrite of
          // the thirteen-column parent or any nine-column child, including xmin.
          const rawBefore=await whole.exec(`SELECT xmin::text AS version FROM public.category WHERE id=${base}`);
          const preserved=await service.mutate(await intent('update',base,{name:parentBefore.name,sort:String(parentBefore.sort),mode:'preserve'}),actor);
          expect(preserved.state).toBe('committed');expect(await root(base)).toEqual(parentBefore);expect(await children(base)).toEqual(childrenBefore);
          expect(await whole.exec(`SELECT xmin::text AS version FROM public.category WHERE id=${base}`)).toEqual(rawBefore);
          expect(await root(base+5)).toEqual(foreignBefore);expect(await root(base+1)).toEqual(supplierBefore);
          // A positive pricing/user/product key must never be the author fence.
          await whole.withPeer!(async blocker=>{await blocker.exec('BEGIN');try{
            await blocker.exec('SELECT pg_advisory_xact_lock(731652,1)');
            expect((await service.mutate(await intent('update',base,{name:parentBefore.name,sort:String(parentBefore.sort),mode:'preserve'}),actor)).state).toBe('committed');
          }finally{await blocker.exec('ROLLBACK');}});
          // The genuine old metadata writer holds731613,0 until its outer
          // transaction commits. The new author waits, then rejects stale CAS.
          const stale=await intent('update',base,{name:'不能覆盖旧核心',sort:1,mode:'preserve'}),ready=signal(),release=signal();
          const oldWriting=outcome(legacy.db.transaction(async tx=>{await metadata(tx as unknown as DbClient).saveSpecTemplate(platformMetadataOwner,base,
            {name:'成熟核心先写',sort:2,specs:[{name:'性能',value:'成熟核心默认',sort:0,status:1}]});ready.resolve();await release.promise;}));
          let author:ReturnType<typeof outcome>|undefined;
          try{await paused(ready,oldWriting);author=outcome(service.mutate(stale,actor));await waitFor(whole.exec,
            `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${admin.pid} AND locktype='advisory' AND classid=731613::oid AND objid=0::oid AND NOT granted) AS waiting`);
          }finally{release.resolve();const old=await oldWriting;if(!old.ok)throw old.error;}
          const authored=await author!;expect(authored.ok).toBe(false);if(!authored.ok)expect(authored.error).toMatchObject({httpStatus:409});
          expect((await root(base)).name).toBe('成熟核心先写');
          // Reverse direction: pause after the actual author mutation in the
          // existing SQL audit path, not before admission or on a fake lock.
          await whole.exec("CREATE FUNCTION owned_parameter_audit_hold() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_specs_catalog' THEN PERFORM pg_advisory_xact_lock(731748,21);END IF;RETURN NEW;END$$;CREATE TRIGGER owned_parameter_audit_hold BEFORE INSERT ON public.system_log FOR EACH ROW EXECUTE FUNCTION owned_parameter_audit_hold()");
          try{
            const change=await intent('update',base,{name:'新作者先写',sort:2,mode:'preserve'});
            await whole.withPeer!(async blocker=>{await blocker.exec('SELECT pg_advisory_lock(731748,21)');const writing=outcome(service.mutate(change,actor));let following:ReturnType<typeof outcome>|undefined;
              try{await waitFor(blocker.exec,`SELECT ${blocker.pid}=ANY(pg_blocking_pids(${admin.pid})) AS waiting`);
                following=outcome(metadata(legacy.db).saveSpecTemplate(platformMetadataOwner,base,{name:'成熟核心后写',sort:3,specs:[{name:'性能',value:'核心后写默认',sort:0,status:1}]}));
                await waitFor(blocker.exec,`SELECT ${admin.pid}=ANY(pg_blocking_pids(${legacy.pid})) AS waiting`);
              }finally{await blocker.exec('SELECT pg_advisory_unlock(731748,21)');const first=await writing,last=await following;expect(first.ok).toBe(true);expect(last?.ok).toBe(true);}
            });
            const after=await privateSnapshot();expect(await service.mutate(change,actor)).toMatchObject({operation_id:change.operation_id,state:'committed'});expect(await privateSnapshot()).toEqual(after);
            // Supplier intentionally retains its own NOWAIT parent-SHARE
            // policy and free five-field snapshots; the new author does not
            // turn it into a platform template editor or normalize its data.
            const supplierChange=await intent('update',base,{name:'Supplier写期间的作者',sort:3,mode:'preserve'});
            await whole.withPeer!(async blocker=>{await blocker.exec('SELECT pg_advisory_lock(731748,21)');const writing=outcome(service.mutate(supplierChange,actor));let other:ReturnType<typeof outcome>|undefined;
              try{await waitFor(blocker.exec,`SELECT ${blocker.pid}=ANY(pg_blocking_pids(${admin.pid})) AS waiting`);const before=await productSnapshot();
                other=outcome(supplier(app.db).saveProduct(7,0,supplierBody(base,'不越过作者父行锁的Supplier'),supplierActor));
                const result=await other;expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toMatchObject({httpStatus:409});expect(await productSnapshot()).toEqual(before);
              }finally{await blocker.exec('SELECT pg_advisory_unlock(731748,21)');const result=await writing;expect(result.ok).toBe(true);await other;}
            });
          }finally{await whole.exec('DROP TRIGGER owned_parameter_audit_hold ON public.system_log;DROP FUNCTION owned_parameter_audit_hold()');}
          // Supplier first: its real complete save (including the selected
          // platform parent SHARE) keeps the author from replacing that parent.
          const supplierIntent=await intent('update',base,{name:'不能越过Supplier已读父行',sort:3,mode:'preserve'}),supplierReady=signal(),supplierRelease=signal();
          let supplierProductId=0;
          const supplierWriting=outcome(app.db.transaction(async tx=>{const result=await supplier(tx as unknown as DbClient).saveProduct(7,0,supplierBody(base,'Supplier原生自由参数'),supplierActor);
            supplierProductId=result.id;supplierReady.resolve();await supplierRelease.promise;}));
          try{await paused(supplierReady,supplierWriting);await expect(service.mutate(supplierIntent,actor)).rejects.toMatchObject({httpStatus:409});}
          finally{supplierRelease.resolve();const result=await supplierWriting;if(!result.ok)throw result.error;}
          const supplierProduct=(await whole.db.select().from(storeProduct).where(eq(storeProduct.id,supplierProductId)))[0];
          expect(supplierProduct.specsId).toBe(base);expect(JSON.parse(supplierProduct.specs!)).toEqual(supplierBody(base,'').specs);
          const supplierRelations=await whole.db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId,supplierProductId),eq(storeProductRelation.type,6)));
          expect(supplierRelations).toHaveLength(1);expect(supplierRelations[0]).toMatchObject({relationId:base,relationPid:0,status:1});
          // Genuine ProductAssociation save holds parent FOR SHARE first. The
          // author refuses NOWAIT, and after commit the live binding still
          // forbids physical deletion instead of clearing product snapshots.
          const removal=await intent('delete',consumer),readerReady=signal(),readerRelease=signal();let productId=0;
          const reading=outcome(app.db.transaction(async tx=>{const saved=await products(tx as unknown as DbClient).save(0,productBody(consumer,'实际商品先读取参数父行'),productActor);
            expect(saved.associations_verified).toBe(true);productId=saved.id;readerReady.resolve();await readerRelease.promise;}));
          try{await paused(readerReady,reading);expect((await whole.exec(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${app.pid} AND relation='public.category'::regclass AND mode='RowShareLock' AND granted) AS held`))[0]?.held).toBe(true);
            await expect(service.mutate(removal,actor)).rejects.toMatchObject({httpStatus:409});
          }finally{readerRelease.resolve();const result=await reading;if(!result.ok)throw result.error;}
          const copied=await productSnapshot();await expect(service.mutate(await intent('delete',consumer),actor)).rejects.toThrow('使用');expect(await productSnapshot()).toEqual(copied);
          const originalCopy=copied.products.find(row=>row.id===productId)!;
          expect(originalCopy).toMatchObject({specsId:consumer,specs:JSON.stringify(productBody(consumer,'').specs)});
          expect(copied.relations.filter(row=>row.productId===productId&&row.type===6)).toHaveLength(1);
          // Replace changes every template child but never the product's copied
          // JSON/type6 identities. Historical names remain savable afterwards.
          const replacement=await intent('update',consumer,{name:'明确替换父模板',sort:0,mode:'replace',specs:[{name:'新参数',value:'新默认',sort:0,status:1},{name:'新参数',value:'允许模板重复',sort:1,status:0}]});
          await service.mutate(replacement,actor);expect(await productSnapshot()).toEqual(copied);
          expect((await children(consumer)).map(row=>({name:row.name,value:row.value,sort:row.sort,status:row.status}))).toEqual([
            {name:'新参数',value:'新默认',sort:0,status:1},{name:'新参数',value:'允许模板重复',sort:1,status:0}]);
          const beforeRelations=copied.relations.filter(row=>row.productId===productId);
          expect((await products(app.db).save(productId,{store_name:'历史参数商品普通保存',specs_id:consumer,specs:productBody(consumer,'').specs},productActor)).associations_verified).toBe(true);
          const afterOrdinary=await productSnapshot();expect(afterOrdinary.products.find(row=>row.id===productId)).toMatchObject({specsId:originalCopy.specsId,specs:originalCopy.specs,price:originalCopy.price,stock:originalCopy.stock});
          // Ordinary product saves may rebuild relation row IDs; the exact
          // relation membership and copied snapshot must stay unchanged.
          expect(afterOrdinary.relations.filter(row=>row.productId===productId).map(({id:_,addTime:__,...row})=>row)).toEqual(beforeRelations.map(({id:_,addTime:__,...row})=>row));
          // Type6 history is protective even when no live product points at the
          // template. It is not silently discarded by the physical delete API.
          await whole.db.insert(storeProductRelation).values({productId:71,type:6,relationId:orphan,status:0});const beforeOrphan=await privateSnapshot();
          await expect(service.mutate(await intent('delete',orphan),actor)).rejects.toThrow('使用');expect(await privateSnapshot()).toEqual(beforeOrphan);
          // Author deletion first: a brand-new actual product save must wait on
          // the real parent lock, then reject the disappeared ID with no half
          // product/relation or audit being left by that failed consumer.
          await whole.exec("CREATE FUNCTION owned_parameter_delete_hold() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_specs_catalog' AND NEW.method='DELETE' THEN PERFORM pg_advisory_xact_lock(731748,22);END IF;RETURN NEW;END$$;CREATE TRIGGER owned_parameter_delete_hold BEFORE INSERT ON public.system_log FOR EACH ROW EXECUTE FUNCTION owned_parameter_delete_hold()");
          try{const action=await intent('delete',doomed),beforeProducts=await productSnapshot();
            await whole.withPeer!(async blocker=>{await blocker.exec('SELECT pg_advisory_lock(731748,22)');const deleting=outcome(service.mutate(action,actor));let binding:ReturnType<typeof outcome>|undefined;
              try{await waitFor(blocker.exec,`SELECT ${blocker.pid}=ANY(pg_blocking_pids(${admin.pid})) AS waiting`);
                binding=outcome(products(app.db).save(0,productBody(doomed,'不能绑定已删参数父行'),productActor));await waitFor(blocker.exec,`SELECT ${admin.pid}=ANY(pg_blocking_pids(${app.pid})) AS waiting`);
                expect(await productSnapshot()).toEqual(beforeProducts);
              }finally{await blocker.exec('SELECT pg_advisory_unlock(731748,22)');const deleted=await deleting,late=await binding;expect(deleted.ok).toBe(true);expect(late?.ok).toBe(false);if(late&&!late.ok)expect(String(late.error)).toContain('不存在');}
            });
            expect(await productSnapshot()).toEqual(beforeProducts);expect(await root(doomed)).toBeUndefined();expect(await children(doomed)).toEqual([]);
            const terminal=await service.receipt(action.operation_id,query,actor);expect(terminal).toMatchObject({state:'committed',operation:'delete',result:{id:doomed,updated:1}});
            const settled=await privateSnapshot();expect(await service.mutate(action,actor)).toEqual(terminal);expect(await privateSnapshot()).toEqual(settled);
          }finally{await whole.exec('DROP TRIGGER owned_parameter_delete_hold ON public.system_log;DROP FUNCTION owned_parameter_delete_hold()');}
          // New template can deliberately contain zero children. Replacement
          // with zero is explicit, not a dropped or filtered legacy subset.
          const made=await service.mutate(await intent('create',0,{name:'原生空参数模板',sort:0,mode:'replace',specs:[]}),actor);
          expect(made.result.created).toBe(1);expect(await children(made.result.id)).toEqual([]);
          const cleared=await service.mutate(await intent('update',made.result.id,{name:'原生空参数模板',sort:0,mode:'replace',specs:[]}),actor);expect(cleared.state).toBe('committed');
          // Full private readback protects unrelated category/foreign children
          // from an audit trigger in the same transaction. Receipt and audit
          // roll back with every parent/child change.
          await whole.exec(`CREATE FUNCTION owned_parameter_tamper() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_specs_catalog' THEN UPDATE public.category SET other='forbidden trigger rewrite' WHERE id=${base+5};END IF;RETURN NEW;END$$;CREATE TRIGGER owned_parameter_tamper AFTER INSERT ON public.system_log FOR EACH ROW EXECUTE FUNCTION owned_parameter_tamper()`);
          try{const before=await privateSnapshot();await expect(service.mutate(await intent('update',made.result.id,{name:'必须整体回滚',sort:1,mode:'replace',specs:[{name:'回滚子行',value:'不能留存',sort:0,status:1}]}),actor)).rejects.toThrow('完整写后回读');expect(await privateSnapshot()).toEqual(before);}
          finally{await whole.exec('DROP TRIGGER owned_parameter_tamper ON public.system_log;DROP FUNCTION owned_parameter_tamper()');}
          const unknown=await intent('update',made.result.id,{name:'未发出的原稿',sort:0,mode:'preserve'}),committed=made;
          await whole.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,900));
          expect(await service.receipt(committed.operation_id,query,actor)).toEqual(committed);
          const sealed=await service.resolve(unknown,actor);expect(sealed).toMatchObject({state:'not_applied',result:{id:made.result.id,created:0,updated:0,count:0,revision:unknown.revision}});
          expect(await service.resolve(unknown,actor)).toEqual(sealed);await expect(service.mutate(unknown,actor)).rejects.toThrow();
          await whole.db.update(systemAdmin).set({pwd:'rotated-native-parameter-password'}).where(eq(systemAdmin.id,900));
          await expect(service.receipt(committed.operation_id,query,actor)).rejects.toThrow();
          await whole.db.update(systemAdmin).set({pwd}).where(eq(systemAdmin.id,900));
          // Exclusive maintenance gate is also the same gate used by readonly
          // readiness; held positive key1 above deliberately did not block -1.
          await whole.withPeer!(async blocker=>{await blocker.exec('BEGIN');try{await blocker.exec('SELECT pg_advisory_xact_lock(731652,0)');
            await expect(runAdminParameterUpgrade(whole.db,target)).rejects.toThrow('busy');
            await expect(admin.db.transaction(tx=>assertAdminParameterOperationReady(tx))).rejects.toMatchObject({code:503});
          }finally{await blocker.exec('ROLLBACK');}});
          expect(await runAdminParameterUpgrade(whole.db,target)).toEqual({operation:'admin-parameter-operation-v1',applied:false});
          expect(await inspectAdminParameterOperation(whole.db,target)).toBe(true);expect(await inspectAdminRuleOperation(whole.db,target)).toBe(true);
          expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
          for(const query of ['UPDATE public.admin_parameter_operation SET actor_id=1','DELETE FROM public.admin_parameter_operation','TRUNCATE public.admin_parameter_operation'])
            await expect(whole.exec(query)).rejects.toMatchObject({code:'42501'});
        });
      }));expect(fetch).not.toHaveBeenCalled();
    }finally{await whole.close();}
  },240000);
});
