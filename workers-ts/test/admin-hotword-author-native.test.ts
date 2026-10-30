import {eq,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {drizzle} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createContainerFromDb,type DbClient} from '@/lib/di';
import {storeProductWords,systemAttachment,systemAdmin,systemRole,systemLog} from '@/models/schema';
import {md5} from '@/utils/jwt';
import {AdminHotwordAuthorService} from '@/services/admin/AdminHotwordAuthorService';
import {ProductWordsService} from '@/services/product/ProductWordsService';
import {PublicHotwordService} from '@/services/product/PublicHotwordService';
import {publicHotwordAuthorImages,renderHotwordAuthorImages} from '@/services/product/HotwordAuthorAssetPolicy';
import {runRuntimeBusinessCommissioning} from '@/migrations/runRuntimeBusinessCommissioning';
import {auditRuntimeBusinessPrivileges} from '@/migrations/auditRuntimeBusinessPrivileges';
import {runAdminParameterUpgrade} from '@/migrations/runAdminParameterUpgrade';
import {inspectAdminParameterOperation} from '@/migrations/adminParameterOperation';
import {runAdminHotwordUpgrade} from '@/migrations/runAdminHotwordUpgrade';
import {assertAdminHotwordOperationReady,inspectAdminHotwordOperation} from '@/migrations/adminHotwordOperation';
import {refundRuntimeFixture} from './helpers/refundRuntimeFixture';
import type {SequenceRunnerPeer} from './helpers/checkoutPricingMigrationDatabase';
import {hotwordPayloadHash,type HotwordAction,type HotwordOperation,type HotwordRow} from '../../view/common/hotwordAuthor';

const signal=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
const outcome=<T>(task:Promise<T>)=>task.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
async function waitFor(exec:SequenceRunnerPeer['exec'],statement:string){
  for(let i=0;i<120;i++){const [row]=await exec(statement);if(row?.waiting===true)return;await new Promise(done=>setTimeout(done,10));}
  throw Error('Expected actual hotword writer blocker was not observed');
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
          const result=await tx.execute(query);if(statement.startsWith('GRANT SELECT, INSERT ON TABLE public.admin_hotword_operation TO ')){trace.reached=true;throw Error('Owned hotword interruption after actual grant');}return result;};
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

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Hotword author real current PG16 LOGINs, old catalog writer and exact icon authority',()=>{
 afterEach(()=>vi.restoreAllMocks());
 it('commissions atomically and serializes genuine legacy save show delete and attachment metadata both directions',async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Owned hotword native forbids outbound I/O'));
  const whole=await refundRuntimeFixture();
  try{
   if(!whole.withRuntimeRole||!whole.withPeer)throw Error('Independent current App/Admin LOGIN and observer peers required');
   await whole.withRuntimeRole(async app=>whole.withRuntimeRole!(async admin=>{
    const [identity]=await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
    const target={database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role};
    await runRuntimeBusinessCommissioning(whole.db,{...target,pricingOwner:whole.pricingOwner});
    await runAdminParameterUpgrade(whole.db,target);
    const audit=async()=>({app:await auditRuntimeBusinessPrivileges(app.db,'app',target),admin:await auditRuntimeBusinessPrivileges(admin.db,'admin',target)});
    expect(await inspectAdminParameterOperation(whole.db,target)).toBe(true);
    expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    await expect(admin.db.transaction(tx=>assertAdminHotwordOperationReady(tx))).rejects.toMatchObject({code:503});
    const trace={reached:false};await expect(runAdminHotwordUpgrade(interrupted(whole.db,trace),target)).rejects.toThrow('Owned hotword interruption');expect(trace.reached).toBe(true);
    expect((await whole.db.execute(sql`SELECT to_regclass('public.admin_hotword_operation') IS NULL AS table_absent,
      to_regprocedure('public.admin_hotword_operation_immutable_v1()') IS NULL AS function_absent`))[0]).toEqual({table_absent:true,function_absent:true});
    expect(await inspectAdminParameterOperation(whole.db,target)).toBe(true);expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    expect(await runAdminHotwordUpgrade(whole.db,target)).toEqual({operation:'admin-hotword-operation-v1',applied:true});
    expect(await inspectAdminHotwordOperation(whole.db,target)).toBe(true);await admin.db.transaction(tx=>assertAdminHotwordOperationReady(tx));
    for(const query of ['SELECT * FROM public.admin_hotword_operation','INSERT INTO public.admin_hotword_operation DEFAULT VALUES',
      "INSERT INTO public.store_product_words(name) VALUES('forbidden app writer')","UPDATE public.store_product_words SET name='forbidden app writer'"])
      await expect(app.exec(query)).rejects.toMatchObject({code:'42501'});
    for(const query of ['UPDATE public.admin_hotword_operation SET actor_id=1','DELETE FROM public.admin_hotword_operation',
      'TRUNCATE public.admin_hotword_operation','ALTER TABLE public.admin_hotword_operation ADD COLUMN forbidden integer'])
      await expect(admin.exec(query)).rejects.toMatchObject({code:'42501'});
    // Catalog drift checks run only within intentionally rolled-back owner
    // transactions; no reviewed runtime grant is enlarged or left behind.
    await expect(whole.db.transaction(async tx=>{await tx.execute(sql.raw('ALTER TABLE public.admin_hotword_operation ADD COLUMN forbidden integer'));
      expect(await inspectAdminHotwordOperation(tx,target)).toBe(false);throw Error('Owned hotword schema rollback');})).rejects.toThrow('Owned hotword schema rollback');
    await expect(whole.db.transaction(async tx=>{await tx.execute(sql.raw(`GRANT SELECT ON public.admin_hotword_operation TO "${app.role}"`));
      expect(await inspectAdminHotwordOperation(tx,target)).toBe(false);throw Error('Owned hotword ACL rollback');})).rejects.toThrow('Owned hotword ACL rollback');
    expect(await inspectAdminHotwordOperation(whole.db,target)).toBe(true);
    await withAdminConnection(admin.connectionString,admin.role,async legacy=>{
     const base=990841,asset1=900041,asset2=900042,pwd='owned-native-hotword-password',query=new URLSearchParams(),env={APP_KEY:'owned-native-hotword-key'};
     await whole.db.insert(systemRole).values({id:900,roleName:'Owned hotword author',rules:'product.manage'});
     await whole.db.insert(systemAdmin).values({id:900,account:'owned_native_hotword',pwd,level:1,roles:'900'});
     await whole.db.insert(storeProductWords).values([
      {id:base,name:'原生热词',color:'#666',bgColor:'#f5f5f5',borderColor:'',icon:'/static/original.png',sort:0,isSearch:0,isShow:1,isHot:0,addTime:17},
      {id:base+1,name:'😀'.repeat(128),color:'red',bgColor:'legacy-bg',borderColor:'legacy-border',icon:'http://legacy.example/icon.png',sort:-32768,isSearch:7,isShow:-3,isHot:9,addTime:-1},
      {id:base+2,type:2,relationId:7,name:'供应商私有热词',color:'opaque raw',sort:-9,isSearch:9,isShow:1,isHot:7},
      {id:base+3,name:'已软删的热词',icon:'javascript:old',isDel:1,isShow:7,isHot:7},
      ...[10,11,12,20,21,22].map(n=>({id:base+n,name:'普通热词'+n,color:'#abc',bgColor:'',borderColor:'',icon:'/static/original.png',sort:0,isSearch:0,isShow:1,isHot:0})),
     ]);
     await whole.db.insert(systemAttachment).values([asset1,asset2].map(id=>({attId:id,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,
      name:`attachments/admin/1/2026/10/${id}.png`,attDir:`/api/assets/${id}`,sattDir:`/api/assets/${id}`,attType:'image/png',realName:'原生图标'+id})));
     await whole.exec("SELECT setval(pg_get_serial_sequence('public.store_product_words','id'),(SELECT max(id)+1 FROM public.store_product_words),false)");
     const actor={id:900,authVersion:md5(pwd),expiresAt:Math.floor(Date.now()/1000)+3600},legacyActor={id:900,name:'Owned legacy hotword writer',ip:'127.0.0.1'};
     const service=new AdminHotwordAuthorService(createContainerFromDb(admin.db),env);
     const intent=async(operation:HotwordOperation,target_id:number,payload:Record<string,unknown>={}):Promise<HotwordAction>=>{
      const a={operation_id:crypto.randomUUID(),actor_id:actor.id,operation,target_id,revision:(await service.catalog(query,actor)).revision,payload};return {...a,payload_hash:await hotwordPayloadHash(a)};
     };
     const raw=(row:HotwordRow)=>({name:row.name,color:row.color,bg_color:row.bg_color,border_color:row.border_color,icon:row.icon,sort:String(row.sort),is_search:String(row.is_search),is_show:String(row.is_show)});
     const values=async(id:number,changes:Record<string,unknown>={})=>{const row=(await service.catalog(query,actor)).list.find(row=>row.id===id);if(!row)throw Error('Owned expected hotword missing');return {...raw(row),...changes};};
     const word=async(id:number)=>(await whole.db.select().from(storeProductWords).where(eq(storeProductWords.id,id)))[0];
     const privateSnapshot=async()=>({words:await whole.exec('SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.store_product_words t ORDER BY id'),
      attachments:await whole.exec('SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.system_attachment t ORDER BY att_id'),
      logs:await whole.db.select().from(systemLog).orderBy(systemLog.id),receipts:await whole.exec('SELECT * FROM public.admin_hotword_operation ORDER BY operation_id')});
     const wholeWords=async()=>whole.exec('SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.store_product_words t ORDER BY id');
     const foreign=await word(base+2),deleted=await word(base+3),history=await word(base+1),catalog=await service.catalog(query,actor);
     expect(catalog.list.some(row=>row.id===base+2||row.id===base+3)).toBe(false);
     expect(catalog.list.find(row=>row.id===base+1)).toMatchObject({name:'😀'.repeat(128),color:'red',icon:'http://legacy.example/icon.png',sort:-32768,is_search:7,is_show:-3,preview:{color:'',bg_color:'',border_color:'',icon:''}});
     const historicBefore=await whole.exec(`SELECT xmin::text AS version FROM public.store_product_words WHERE id=${base+1}`);
     const same=await service.mutate(await intent('update',base+1,await values(base+1)),actor);expect(same.state).toBe('committed');expect(await word(base+1)).toEqual(history);
     expect(await whole.exec(`SELECT xmin::text AS version FROM public.store_product_words WHERE id=${base+1}`)).toEqual(historicBefore);
     expect(await word(base+2)).toEqual(foreign);expect(await word(base+3)).toEqual(deleted);
     // Positive pricing/user IDs do not substitute for author key-1.
     await whole.withPeer!(async blocker=>{await blocker.exec('BEGIN');try{await blocker.exec('SELECT pg_advisory_xact_lock(731653,1)');
      expect((await service.mutate(await intent('update',base+1,await values(base+1)),actor)).state).toBe('committed');}finally{await blocker.exec('ROLLBACK');}});
     const oldService=(db:DbClient)=>new ProductWordsService(createContainerFromDb(db));
     const legacyWrite=(db:DbClient,operation:'save'|'show'|'delete',id:number)=>operation==='save'
      ?oldService(db).save(id,{name:'旧核心写'+(id-base),color:'#123456',bg_color:'',border_color:'',icon:'/static/legacy.png',sort:3,is_search:1,is_show:1},legacyActor)
      :operation==='show'?oldService(db).setShow(id,0,legacyActor):oldService(db).delete(id,legacyActor);
     // Actual old service acquires731614,0 and performs its mutation inside an
     // independently authenticated Admin outer transaction before pausing.
     for(const [index,operation] of (['save','show','delete'] as const).entries()){
      const id=base+10+index,a=await intent('update',id,await values(id,{name:'不覆盖旧核心'})),ready=signal(),release=signal();
      const oldWriting=outcome(legacy.db.transaction(async tx=>{await legacyWrite(tx as unknown as DbClient,operation,id);ready.resolve();await release.promise;}));
      let writing:ReturnType<typeof outcome>|undefined;
      try{await paused(ready,oldWriting);writing=outcome(service.mutate(a,actor));await waitFor(whole.exec,
       `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${admin.pid} AND locktype='advisory' AND classid=731614::oid AND objid=0::oid AND NOT granted) AS waiting`);
      }finally{release.resolve();const first=await oldWriting;if(!first.ok)throw first.error;}
      const result=await writing!;expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toMatchObject({httpStatus:409});
      expect((await word(id)).isDel).toBe(operation==='delete'?1:0);if(operation==='save')expect((await word(id)).name).toBe('旧核心写10');if(operation==='show')expect((await word(id)).isShow).toBe(0);
     }
     // Reverse ordering pauses after a genuine new writer's audit INSERT.
     // The old service must wait on that same legacy fence, not a fake lock.
     await whole.exec("CREATE FUNCTION owned_hotword_audit_hold() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_words' THEN PERFORM pg_advisory_xact_lock(731754,31);END IF;RETURN NEW;END$$;CREATE TRIGGER owned_hotword_audit_hold BEFORE INSERT ON public.system_log FOR EACH ROW EXECUTE FUNCTION owned_hotword_audit_hold()");
     try{for(const [index,operation]of(['save','show','delete']as const).entries()){
      const id=base+20+index,a=await intent('update',id,await values(id,{name:'新作者先写'+index}));
      await whole.withPeer!(async blocker=>{await blocker.exec('SELECT pg_advisory_lock(731754,31)');const writing=outcome(service.mutate(a,actor));let following:ReturnType<typeof outcome>|undefined;
       try{await waitFor(blocker.exec,`SELECT ${blocker.pid}=ANY(pg_blocking_pids(${admin.pid})) AS waiting`);following=outcome<unknown>(legacyWrite(legacy.db,operation,id));
        await waitFor(blocker.exec,`SELECT ${admin.pid}=ANY(pg_blocking_pids(${legacy.pid})) AS waiting`);
       }finally{await blocker.exec('SELECT pg_advisory_unlock(731754,31)');const first=await writing,last=await following;expect(first.ok).toBe(true);expect(last?.ok).toBe(true);}
      });
      const before=await privateSnapshot();expect((await service.mutate(a,actor)).state).toBe('committed');expect(await privateSnapshot()).toEqual(before);
     }}finally{await whole.exec('DROP TRIGGER owned_hotword_audit_hold ON public.system_log;DROP FUNCTION owned_hotword_audit_hold()');}
     // A genuine attachment mutation owns the row before canonical admission;
     // author FOR SHARE NOWAIT rejects without words, audit or receipt writes.
     const locked=await intent('update',base,await values(base,{icon:`/api/assets/${asset1}`}));
     await whole.withPeer!(async peer=>{await peer.exec('BEGIN');try{await peer.exec(`UPDATE public.system_attachment SET real_name='uncommitted metadata writer' WHERE att_id=${asset1}`);
      const before=await privateSnapshot();await expect(service.mutate(locked,actor)).rejects.toMatchObject({httpStatus:409});expect(await privateSnapshot()).toEqual(before);
     }finally{await peer.exec('ROLLBACK');}});
     // Reverse order: exact metadata read locks survive the author transaction
     // and prevent an independently authenticated Admin from changing a MIME
     // until the command and its audit/receipt have committed.
     await whole.exec("CREATE FUNCTION owned_hotword_media_hold() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_words' THEN PERFORM pg_advisory_xact_lock(731754,32);END IF;RETURN NEW;END$$;CREATE TRIGGER owned_hotword_media_hold BEFORE INSERT ON public.system_log FOR EACH ROW EXECUTE FUNCTION owned_hotword_media_hold()");
     try{
      const change=await intent('update',base,await values(base,{icon:`/api/assets/${asset1}`}));
      await whole.withPeer!(async blocker=>{await blocker.exec('SELECT pg_advisory_lock(731754,32)');const writing=outcome(service.mutate(change,actor));let metadata:ReturnType<typeof outcome>|undefined;
       try{await waitFor(blocker.exec,`SELECT ${blocker.pid}=ANY(pg_blocking_pids(${admin.pid})) AS waiting`);
        metadata=outcome(legacy.db.update(systemAttachment).set({attType:'text/html'}).where(eq(systemAttachment.attId,asset1)));
        await waitFor(blocker.exec,`SELECT ${admin.pid}=ANY(pg_blocking_pids(${legacy.pid})) AS waiting`);
       }finally{await blocker.exec('SELECT pg_advisory_unlock(731754,32)');const first=await writing,next=await metadata;expect(first.ok).toBe(true);expect(next?.ok).toBe(true);}
      });
      expect((await word(base)).icon).toBe(`/api/assets/${asset1}`);
      expect(await publicHotwordAuthorImages(admin.db,[`/api/assets/${asset1}`])).toEqual(['']);
      const publicWords=new PublicHotwordService(createContainerFromDb(app.db),env);
      const unsafeBefore=await privateSnapshot(),withoutIcon=await publicWords.publicKeywords();
      expect(withoutIcon.find(row=>row.id===base)?.icon).toBe(`/api/assets/${asset1}`);expect(withoutIcon.find(row=>row.id===base)?.icon).not.toMatch(/signature=/u);expect(withoutIcon.some(row=>row.id===base+2||row.id===base+3)).toBe(false);expect(await privateSnapshot()).toEqual(unsafeBefore);
      await whole.db.update(systemAttachment).set({attType:'image/png'}).where(eq(systemAttachment.attId,asset1));
      const refs=await publicHotwordAuthorImages(admin.db,[`/api/assets/${asset1}`,'/static/legacy.png','https://cdn.example.test/i.png','http://legacy.example/i.png']);
      expect(refs).toEqual([`/api/assets/${asset1}`,'/static/legacy.png','https://cdn.example.test/i.png','']);
      const publishedBefore=await privateSnapshot(),published=await publicWords.publicKeywords();expect(published.length).toBeLessThanOrEqual(20);const publicRow=published.find(row=>row.id===base);expect(publicRow?.name).toBe((await word(base)).name);expect(publicRow?.keyword).toBe(publicRow?.name);expect(publicRow?.icon).toMatch(new RegExp(`^/api/assets/${asset1}\\?expires=\\d{10}&signature=[A-Za-z0-9_-]{43}$`));expect(Object.keys(publicRow!).sort()).toEqual(['id','name','keyword','color','bg_color','border_color','icon'].sort());expect((await word(base)).isSearch).toBe(0);expect((await word(base)).isHot).toBe(0);expect(await privateSnapshot()).toEqual(publishedBefore);
      const rendered=await renderHotwordAuthorImages(env.APP_KEY,refs);expect(rendered[0]).toMatch(new RegExp(`^/api/assets/${asset1}\\?expires=\\d{10}&signature=[A-Za-z0-9_-]{43}$`));expect(rendered.slice(1)).toEqual(refs.slice(1));
     }finally{await whole.exec('DROP TRIGGER owned_hotword_media_hold ON public.system_log;DROP FUNCTION owned_hotword_media_hold()');}
     // An executable same-transaction audit trigger changes newly admitted
     // attachment metadata. The service must recheck it and roll everything
     // back; a source-only word readback is insufficient publication evidence.
     await whole.exec(`CREATE FUNCTION owned_hotword_media_tamper() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_words' THEN UPDATE public.system_attachment SET att_type='text/html' WHERE att_id=${asset2};END IF;RETURN NEW;END$$;CREATE TRIGGER owned_hotword_media_tamper AFTER INSERT ON public.system_log FOR EACH ROW EXECUTE FUNCTION owned_hotword_media_tamper()`);
     try{const a=await intent('update',base,await values(base,{icon:`/api/assets/${asset2}`})),before=await privateSnapshot();await expect(service.mutate(a,actor)).rejects.toThrow();expect(await privateSnapshot()).toEqual(before);
      expect(await whole.exec(`SELECT count(*)::integer AS count FROM public.admin_hotword_operation WHERE operation_id='${a.operation_id}'`)).toEqual([{count:0}]);
     }finally{await whole.exec('DROP TRIGGER owned_hotword_media_tamper ON public.system_log;DROP FUNCTION owned_hotword_media_tamper()');}
     // Private CAS covers hidden/foreign rows, not just the public catalog.
     await whole.exec(`CREATE FUNCTION owned_hotword_foreign_tamper() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='product_words' THEN UPDATE public.store_product_words SET is_hot=11 WHERE id=${base+2};END IF;RETURN NEW;END$$;CREATE TRIGGER owned_hotword_foreign_tamper AFTER INSERT ON public.system_log FOR EACH ROW EXECUTE FUNCTION owned_hotword_foreign_tamper()`);
     try{const a=await intent('show',base,{is_show:0}),before=await privateSnapshot();await expect(service.mutate(a,actor)).rejects.toThrow();expect(await privateSnapshot()).toEqual(before);}
     finally{await whole.exec('DROP TRIGGER owned_hotword_foreign_tamper ON public.system_log;DROP FUNCTION owned_hotword_foreign_tamper()');}
     const created=await service.mutate(await intent('create',0,{name:' 原生新词 ',color:'#abc',bg_color:'',border_color:'',icon:'',sort:'999',is_search:'0',is_show:'1'}),actor);
     expect(created).toMatchObject({operation:'create',state:'committed',result:{created:1,updated:0}});expect((await word(created.result.id)).name).toBe('原生新词');
     const deleteAction=await intent('delete',created.result.id),prior=await word(created.result.id),committed=await service.mutate(deleteAction,actor);
     expect(await word(created.result.id)).toEqual({...prior,isDel:1,isShow:0,isHot:0});expect((await service.catalog(query,actor)).list.some(row=>row.id===created.result.id)).toBe(false);
     const unchanged=await wholeWords(),unknown=await intent('update',base,await values(base,{name:'不曾发出的原稿'}));
     await whole.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,900));expect(await service.receipt(committed.operation_id,query,actor)).toEqual(committed);
     const sealed=await service.resolve(unknown,actor);expect(sealed).toMatchObject({state:'not_applied',result:{id:base,created:0,updated:0,count:0,revision:unknown.revision}});expect(await wholeWords()).toEqual(unchanged);
     await whole.db.update(systemRole).set({rules:'product.manage'}).where(eq(systemRole.id,900));await expect(service.mutate(unknown,actor)).rejects.toMatchObject({httpStatus:409});
     await whole.db.update(systemAdmin).set({pwd:'owned-rotated-hotword-password'}).where(eq(systemAdmin.id,900));await expect(service.receipt(committed.operation_id,query,actor)).rejects.toThrow();await whole.db.update(systemAdmin).set({pwd}).where(eq(systemAdmin.id,900));
     await whole.withPeer!(async blocker=>{await blocker.exec('BEGIN');try{await blocker.exec('SELECT pg_advisory_xact_lock(731653,0)');await expect(runAdminHotwordUpgrade(whole.db,target)).rejects.toThrow('busy');await expect(admin.db.transaction(tx=>assertAdminHotwordOperationReady(tx))).rejects.toMatchObject({code:503});}finally{await blocker.exec('ROLLBACK');}});
     expect(await runAdminHotwordUpgrade(whole.db,target)).toEqual({operation:'admin-hotword-operation-v1',applied:false});expect(await inspectAdminHotwordOperation(whole.db,target)).toBe(true);expect(await inspectAdminParameterOperation(whole.db,target)).toBe(true);
     expect(await audit()).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
     for(const statement of ['UPDATE public.admin_hotword_operation SET actor_id=1','DELETE FROM public.admin_hotword_operation','TRUNCATE public.admin_hotword_operation'])await expect(whole.exec(statement)).rejects.toMatchObject({code:'42501'});
    });
   }));expect(fetch).not.toHaveBeenCalled();
  }finally{await whole.close();}
 },240000);
});
