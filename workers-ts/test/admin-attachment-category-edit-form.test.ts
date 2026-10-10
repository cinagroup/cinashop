import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemAttachmentCategory, systemMenus, systemRole } from '@/models/schema';
import { adminCategoryEditForm, adminCategoryUpdate, supplierCategoryEditForm } from '@/controllers/system/AttachmentController';
import { adminAuthMiddleware } from '@/middleware/admin-auth';
import { AdminAttachmentCategoryEditFormService } from '@/services/admin/AdminAttachmentCategoryEditFormService';
import { MAX_ADMIN_CATEGORY_FORM_ROOT_OPTIONS, type AdminAttachmentCategoryCreateFormActor } from '@/services/admin/AdminAttachmentCategoryCreateFormService';
import { ApiException, HttpApiException } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import { financeMemoryPostgres } from './helpers/financePostgres';

type Reply = { status: number; msg: string; data: any };
const env = { APP_KEY:'category-edit-local-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',
  ASSETS_BUCKET:{put:vi.fn(),delete:vi.fn(),get:vi.fn(),head:vi.fn(),list:vi.fn()},ORDER_QUEUE:{send:vi.fn()} } as unknown as Env;
const actor = (): AdminAttachmentCategoryCreateFormActor => ({id:101,authVersion:md5('fixture-password'),expiresAt:Math.floor(Date.now()/1000)+3600});

describe('Admin legacy category edit-form',()=>{
  let fixture:Awaited<ReturnType<typeof financeMemoryPostgres>>,container:Container;
  let tokens:Record<'reader'|'manager'|'unrelated'|'foreign',string>;
  function application(target=container,afterAuth?:()=>Promise<void>){
    const app=new Hono<{Bindings:Env;Variables:AppVariables}>();
    app.use('*',async(c,next)=>{c.set('container',target);await next();});
    app.onError((error,c)=>c.json({status:error instanceof ApiException?error.code:500,msg:error.message,data:null},error instanceof HttpApiException?error.httpStatus:200));
    for(const prefix of ['/adminapi','/api/admin']){
      app.get(`${prefix}/file/category/:id/edit`,adminAuthMiddleware(),async(_c,next)=>{await afterAuth?.();await next();},adminCategoryEditForm);
      app.put(`${prefix}/file/category/:id`,adminAuthMiddleware(),adminCategoryUpdate);
    }
    app.get('/supplierapi/file/category/:id/edit',async(c,next)=>{c.set('supplierId',9);await next();},supplierCategoryEditForm);
    return app;
  }
  async function get(id: string|number=14,query='',token=tokens.reader,prefix='/adminapi',app=application()){
    const response=await app.request(`${prefix}/file/category/${id}/edit${query}`,{headers:token?{'Authori-zation':`Bearer ${token}`}:{}} ,env);
    return {response,body:await response.json<Reply>()};
  }
  async function put(action:string,input:Record<string,unknown>,token=tokens.manager,prefix='/adminapi'){
    const target=new NodeURL(action,`http://local${prefix}/`);
    const response=await application().request(target.href,{method:'PUT',headers:{'Authori-zation':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(input)},env);
    return response.json<Reply>();
  }
  const snapshot=()=>fixture.db.select().from(systemAttachmentCategory).orderBy(systemAttachmentCategory.id);
  beforeAll(async()=>{
    fixture=await financeMemoryPostgres([systemAdmin,systemRole,systemMenus,systemAttachmentCategory]);
    if (!fixture.isMemory) throw Error('Category edit business tests require local memory only');
    container=createContainerFromDb(fixture.db);
    const signed=await Promise.all([101,102,103,104].map(async id=>(await createToken(id,'admin',md5('fixture-password'),env.APP_KEY)).token));
    tokens={reader:signed[0],manager:signed[1],unrelated:signed[2],foreign:signed[3]};
  },30_000);
  beforeEach(async()=>{
    await fixture.reset();
    await fixture.db.insert(systemRole).values([{id:1,roleName:'素材查看',rules:'attachment.view'},
      {id:2,roleName:'素材管理',rules:'attachment.manage'},{id:3,roleName:'商品查看',rules:'product.view'},
      {id:4,roleName:'外域素材',type:4,relationId:9,rules:'attachment.view'}]);
    await fixture.db.insert(systemAdmin).values([101,102,103,104].map((id,index)=>({id,account:`edit-reader-${id}`,pwd:'fixture-password',level:1,roles:String(index+1)})));
    await fixture.db.insert(systemAttachmentCategory).values([
      {id:12,type:1,relationId:0,fileType:1,pid:0,name:'平台图片'},
      {id:13,type:1,relationId:0,fileType:1,pid:0,name:'第二图片'},
      {id:14,type:1,relationId:0,fileType:1,pid:12,name:'子级图片'},
      {id:15,type:1,relationId:0,fileType:1,pid:14,name:'深层图片'},
      {id:20,type:1,relationId:0,fileType:2,pid:0,name:'平台视频'},
      {id:21,type:1,relationId:0,fileType:2,pid:20,name:'子级视频'},
      {id:30,type:4,relationId:9,fileType:1,pid:0,name:'供应商秘密'},
      {id:40,type:1,relationId:7,fileType:1,pid:0,name:'其他关系秘密'},
    ]);vi.clearAllMocks();
  });
  afterAll(async()=>{await fixture?.close();});

  it('returns the exact old edit DTO on both bases with the current child and complete matching root options',async()=>{
    for(const prefix of ['/adminapi','/api/admin']){
      const {body,response}=await get(14,'?file_type=1',tokens.reader,prefix);
      expect(body).toEqual({status:200,msg:'ok',data:{title:'编辑分类',method:'PUT',action:'file/category/14',rules:[
        {type:'hidden',field:'file_type',value:1},
        {type:'select',field:'pid',title:'上级分类',value:12,props:{filterable:true},options:[{value:0,label:'所有分类'},{value:12,label:'平台图片'},{value:13,label:'第二图片'}]},
        {type:'input',field:'name',title:'分类名称',value:'子级图片',props:{maxlength:20}},
      ]}});
      expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('pragma')).toBe('no-cache');
      expect(JSON.stringify(body)).not.toMatch(/供应商秘密|其他关系秘密|平台视频|深层图片|pwd|fixture-password/);
      expect(Object.keys(body.data).sort()).toEqual(['action','method','rules','title']);
    }
  });

  it.each([12,14,20,21])('uses stored file type for a root or child even without a tab query (%s)',async id=>{
    const {body}=await get(id);expect(body.status).toBe(200);
    expect(body.data.rules[0].value).toBe(id<20?1:2);
    expect(body.data.rules[1].value).toBe(id===14?12:id===21?20:0);
    expect(body.data.rules[1].options.some((row:{value:number})=>row.value===id)).toBe(false);
    if(id>=20)expect(JSON.stringify(body.data)).not.toContain('平台图片');
    if(id===20)expect(body.data.rules[1].options).toEqual([{value:0,label:'所有分类'}]);
  });

  it('preserves an existing 50-character name instead of truncating it to the legacy input limit',async()=>{
    const name='名'.repeat(50);await fixture.db.update(systemAttachmentCategory).set({name}).where(eq(systemAttachmentCategory.id,14));
    const {body}=await get();expect(body.data.rules[2]).toMatchObject({value:name,props:{maxlength:20}});
    expect((await snapshot()).find(row=>row.id===14)?.name).toBe(name);
  });

  it('rejects malformed IDs, duplicate or unknown queries before starting a transaction',async()=>{
    const transaction=vi.fn(()=>{throw Error('Invalid query reached SQL');});
    const service=new AdminAttachmentCategoryEditFormService({...container,db:{transaction} as unknown as DbClient});
    for(const id of ['','0','-1','01','1.5','1e2',' 12','2147483648','NaN'])await expect(service.editForm(id,new URLSearchParams(),actor())).rejects.toMatchObject({code:400});
    for(const query of ['file_type=','file_type=0','file_type=3','file_type=01','file_type=true','file_type=1&file_type=1','id=14','pid=12','action=http://example.test','type=4','relation_id=9','limit=1','unknown=1'])
      await expect(service.editForm('14',new URLSearchParams(query),actor())).rejects.toMatchObject({code:400});
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects explicit mismatched tab types and keeps the stored type authoritative',async()=>{
    expect((await get(14,'?file_type=2')).body.status).toBe(400);expect((await get(21,'?file_type=1')).body.status).toBe(400);
    expect((await get(21,'?file_type=2')).body.data.rules[0].value).toBe(2);
    await fixture.db.update(systemAttachmentCategory).set({fileType:3}).where(eq(systemAttachmentCategory.id,14));
    const {body,response}=await get();expect(body.status).toBe(409);expect(response.status).toBe(409);
  });

  it.each([30,40,999])('rejects foreign, cross-relation or missing targets without disclosing them (%s)',async id=>{
    const {body}=await get(id);expect(body.status).toBe(404);expect(body.data).toBeNull();expect(JSON.stringify(body)).not.toMatch(/供应商秘密|其他关系秘密/);
  });

  it.each([14,999,30,40,20])('does not silently reset a deep, orphan, foreign or cross-type stored parent (%s)',async pid=>{
    await fixture.db.update(systemAttachmentCategory).set({pid}).where(eq(systemAttachmentCategory.id,15));
    const before=await snapshot(),{body,response}=await get(15);expect(body.status).toBe(409);expect(response.status).toBe(409);expect(body.data).toBeNull();expect(await snapshot()).toEqual(before);
  });

  it('excludes self even for corrupt self-parent data and leaves writer cycle detection intact',async()=>{
    await fixture.db.update(systemAttachmentCategory).set({pid:12}).where(eq(systemAttachmentCategory.id,12));
    expect((await get(12)).body.status).toBe(409);
    await fixture.db.update(systemAttachmentCategory).set({pid:0}).where(eq(systemAttachmentCategory.id,12));
    const before=await snapshot();expect((await put('file/category/12',{pid:15,name:'循环父',file_type:1})).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it('checks actual JWT read and write capabilities for both relative PUT endpoints',async()=>{
    expect((await get(14,'','')).body.status).toBe(410000);
    for(const token of [tokens.unrelated,tokens.foreign])expect((await get(14,'',token)).body.status).toBe(400011);
    for(const prefix of ['/adminapi','/api/admin']){
      const form=(await get(14,'',tokens.reader,prefix)).body.data;
      expect(form.action).toBe('file/category/14');expect(form.action).not.toMatch(/^(?:\/|https?:|\/\/)|adminapi|api\/admin|[?#]/);
      const target=new NodeURL(form.action,`http://local${prefix}/`);expect(target.origin).toBe('http://local');expect(target.pathname).toBe(`${prefix}/file/category/14`);
      expect((await put(form.action,{pid:12,name:'只读不可写',file_type:1},tokens.reader,prefix)).status).toBe(400011);
      const name=`真正提交${prefix}`;expect((await put(form.action,{pid:12,name,file_type:1},tokens.manager,prefix)).status).toBe(200);
      expect((await snapshot()).find(row=>row.id===14)?.name).toBe(name);
    }
  });

  it('revalidates live Admin-session identity and permissions after ordinary authentication',async()=>{
    for(const change of [{status:0},{pwd:'new-password'},{adminType:4},{isDel:1}]){
      const app=application(container,async()=>{await fixture.db.update(systemAdmin).set(change).where(eq(systemAdmin.id,101));});
      try{expect((await get(14,'',tokens.reader,'/adminapi',app)).body.status).toBe('pwd' in change?410001:410002);}
      finally{await fixture.db.update(systemAdmin).set({status:1,pwd:'fixture-password',adminType:1,isDel:0}).where(eq(systemAdmin.id,101));}
    }
    const app=application(container,async()=>{await fixture.db.update(systemRole).set({rules:'product.view'}).where(eq(systemRole.id,1));});
    expect((await get(14,'',tokens.reader,'/adminapi',app)).body.status).toBe(400011);
    await expect(new AdminAttachmentCategoryEditFormService(container).editForm('14',new URLSearchParams(),{...actor(),expiresAt:1})).rejects.toMatchObject({code:410001});
  });

  it('reads target and roots inside one bounded read-only snapshot without provider or object writes',async()=>{
    const before=await snapshot();let transactions=0,targetSelections=0,rootSelections=0;const external=vi.fn(()=>{throw Error('Edit form attempted external I/O');});
    const observedDb=new Proxy(fixture.db,{get(target,key){
      if(key==='select')throw Error('Edit selected outside its snapshot');
      if(key==='transaction')return async(callback:(tx:DbClient)=>Promise<unknown>)=>target.transaction(async tx=>{
        transactions++;const observedTx=new Proxy(tx,{get(inner,method){
          if(['insert','update','delete'].includes(String(method)))throw Error('Edit attempted a write');
          const value=Reflect.get(inner,method);
          if(method==='select')return (...args:unknown[])=>{
            const projection=args[0];if(projection && typeof projection==='object' && 'id' in projection && 'name' in projection
              && projection.id===systemAttachmentCategory.id && projection.name===systemAttachmentCategory.name){if('pid' in projection)targetSelections++;else rootSelections++;}
            return value.apply(inner,args);
          };
          return typeof value==='function'?value.bind(inner):value;
        }})as unknown as DbClient;
        const result=await callback(observedTx);
        const settings=await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,
          current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
        expect(settings[0]).toEqual({isolation:'repeatable read',readonly:'on',statement:'5s',lock:'2s',idle:'5s'});return result;
      });
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    vi.stubGlobal('fetch',external);try{await new AdminAttachmentCategoryEditFormService({...container,db:observedDb}).editForm('14',new URLSearchParams(),actor());}finally{vi.unstubAllGlobals();}
    expect(transactions).toBe(1);expect(targetSelections).toBe(1);expect(rootSelections).toBe(1);expect(external).not.toHaveBeenCalled();
    for(const method of ['put','delete','get','head','list']as const)expect(env.ASSETS_BUCKET[method]).not.toHaveBeenCalled();expect(env.ORDER_QUEUE.send).not.toHaveBeenCalled();expect(await snapshot()).toEqual(before);
  });

  it.each(['target-deleted','target-fileType','target-owner','parent-deleted','parent-fileType','parent-owner']as const)('makes the existing PUT revalidate scope and type after GET (%s)',async change=>{
    const forms=await Promise.all(['/adminapi','/api/admin'].map(async prefix=>(await get(14,'',tokens.reader,prefix)).body.data));
    const id=change.startsWith('target-')?14:12;
    if(change.endsWith('deleted'))await fixture.db.delete(systemAttachmentCategory).where(eq(systemAttachmentCategory.id,id));
    else await fixture.db.update(systemAttachmentCategory).set(change.endsWith('fileType')?{fileType:2}:{type:4,relationId:9}).where(eq(systemAttachmentCategory.id,id));
    const before=await snapshot();for(const[index,prefix]of['/adminapi','/api/admin'].entries())expect((await put(forms[index].action,{pid:12,name:'旧表单不可误写',file_type:1},tokens.manager,prefix)).status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it('returns every 10000 eligible root and rejects 10001 without silently dropping the selected parent',async()=>{
    await fixture.db.delete(systemAttachmentCategory);
    await fixture.db.execute(sql`INSERT INTO ${systemAttachmentCategory}(id,type,relation_id,file_type,pid,name)
      SELECT n,1,0,1,0,'目录-'||n FROM generate_series(1000,${999+MAX_ADMIN_CATEGORY_FORM_ROOT_OPTIONS}) AS source(n)`);
    await fixture.db.insert(systemAttachmentCategory).values({id:20000,type:1,relationId:0,fileType:1,pid:10999,name:'容量子分类'});
    const form=await new AdminAttachmentCategoryEditFormService(container).editForm('20000',new URLSearchParams(),actor());
    expect(form.rules[1].options).toHaveLength(MAX_ADMIN_CATEGORY_FORM_ROOT_OPTIONS+1);expect(form.rules[1].value).toBe(10999);expect(form.rules[1].options.at(-1)).toEqual({value:10999,label:'目录-10999'});
    await fixture.db.insert(systemAttachmentCategory).values({id:11000,type:1,relationId:0,fileType:1,pid:0,name:'第10001根'});
    const {body,response}=await get(20000);expect(body.status).toBe(503);expect(response.status).toBe(503);expect(body.data).toBeNull();
    expect((await fixture.db.execute(sql`SELECT count(*)::integer AS count FROM ${systemAttachmentCategory}`))[0].count).toBe(10002);
  });

  it('preserves modern PUT 50-character validation and unchanged Supplier edit behavior',async()=>{
    expect((await put('file/category/14',{pid:12,name:'名'.repeat(50),file_type:1})).status).toBe(200);
    expect((await put('file/category/14',{pid:12,name:'名'.repeat(51),file_type:1})).status).toBe(400);
    const response=await application().request('/supplierapi/file/category/30/edit',{},env);
    expect((await response.json<Reply>()).data).toMatchObject({title:'编辑附件分类',method:'PUT',action:'/supplierapi/file/category/30',rules:[{}, {type:'number'}, {maxlength:50}]});
  });

  it('registers both exact authenticated GET/PUT pairs and propagates database failures',async()=>{
    for(const[file,prefix]of[['../src/routes/adminapi.ts',''],['../src/routes/v1/index.ts','/admin']]as const){
      const source=readFileSync(new NodeURL(file,import.meta.url),'utf8');
      expect(source).toContain(`.get("${prefix}/file/category/:id/edit", adminAuth, AttachmentController.adminCategoryEditForm)`);
      expect(source).toContain(`.put("${prefix}/file/category/:id", adminAuth, AttachmentController.adminCategoryUpdate)`);
    }
    const transaction=vi.fn(()=>{throw Error('Local edit read failure');});
    await expect(new AdminAttachmentCategoryEditFormService({...container,db:{transaction}as unknown as DbClient}).editForm('14',new URLSearchParams(),actor())).rejects.toThrow('Local edit read failure');
  });
});
