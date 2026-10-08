import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemAttachmentCategory, systemMenus, systemRole } from '@/models/schema';
import { adminCategoryCreateForm, adminCategorySave, supplierCategoryCreateForm, adminCategoryEditForm } from '@/controllers/system/AttachmentController';
import { adminAuthMiddleware } from '@/middleware/admin-auth';
import { AdminAttachmentCategoryCreateFormService, MAX_ADMIN_CATEGORY_FORM_ROOT_OPTIONS,
  type AdminAttachmentCategoryCreateFormActor } from '@/services/admin/AdminAttachmentCategoryCreateFormService';
import { ApiException } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

type Reply = { status: number; msg: string; data: any };
const env = { APP_KEY: 'category-form-local-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
  ASSETS_BUCKET: { put:vi.fn(),delete:vi.fn(),get:vi.fn(),head:vi.fn(),list:vi.fn() }, ORDER_QUEUE:{ send:vi.fn() } } as unknown as Env;
const actor = (): AdminAttachmentCategoryCreateFormActor => ({ id:101,authVersion:md5('fixture-password'),expiresAt:Math.floor(Date.now()/1000)+3600 });

describe('Admin legacy category create-form', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>, container:Container;
  let tokens:Record<'reader'|'manager'|'unrelated'|'foreign',string>;
  function application(target = container, afterAuth?: () => Promise<void>) {
    const app = new Hono<{ Bindings:Env;Variables:AppVariables }>();
    app.use('*',async(c,next)=>{c.set('container',target);await next();});
    app.onError((error,c)=>c.json({status:error instanceof ApiException?error.code:500,msg:error.message,data:null}));
    for(const prefix of ['/adminapi','/api/admin']) {
      const recheck = async (_c:any,next:()=>Promise<void>) => { await afterAuth?.(); await next(); };
      app.get(`${prefix}/file/category/create`,adminAuthMiddleware(),recheck,adminCategoryCreateForm);
      app.get(`${prefix}/file/category/create/:parentId`,adminAuthMiddleware(),recheck,adminCategoryCreateForm);
    }
    for(const prefix of ['/adminapi','/api/admin']) app.post(`${prefix}/file/category`,adminAuthMiddleware(),adminCategorySave);
    app.get('/adminapi/file/category/:id/edit',adminAuthMiddleware(),adminCategoryEditForm);
    app.get('/supplierapi/file/category/create/:parentId',async(c,next)=>{c.set('supplierId',9);await next();},supplierCategoryCreateForm);
    return app;
  }
  async function get(query='',token=tokens.reader,prefix='/adminapi',app=application(),suffix='') {
    const response = await app.request(`${prefix}/file/category/create${suffix}${query}`,{headers:token?{'Authori-zation':`Bearer ${token}`}:{}} ,env);
    return {response,body:await response.json<Reply>()};
  }
  async function post(action:string,body:Record<string,unknown>,token=tokens.manager,prefix='/adminapi') {
    const target=new NodeURL(action,`http://local${prefix}/`);
    const response = await application().request(target.href,{method:'POST',headers:{'Authori-zation':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)},env);
    return response.json<Reply>();
  }
  beforeAll(async()=>{
    if(process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Category form business tests require local memory only');
    fixture=await financePostgres([systemAdmin,systemRole,systemMenus,systemAttachmentCategory]);
    container=createContainerFromDb(fixture.db);
    const signed=await Promise.all([101,102,103,104].map(async id=>(await createToken(id,'admin',md5('fixture-password'),env.APP_KEY)).token));
    tokens={reader:signed[0],manager:signed[1],unrelated:signed[2],foreign:signed[3]};
  },30_000);
  beforeEach(async()=>{
    await fixture.reset();
    await fixture.db.insert(systemRole).values([
      {id:1,roleName:'素材查看',rules:'attachment.view'},
      {id:2,roleName:'素材管理',rules:'attachment.manage'},
      {id:3,roleName:'商品查看',rules:'product.view'},
      {id:4,roleName:'供应商素材',type:4,relationId:9,rules:'attachment.view'},
    ]);
    await fixture.db.insert(systemAdmin).values([101,102,103,104].map((id,index)=>({id,account:`form-reader-${id}`,pwd:'fixture-password',level:1,roles:String(index+1)})));
    await fixture.db.insert(systemAttachmentCategory).values([
      {id:12,type:1,relationId:0,fileType:1,pid:0,name:'平台图片'},
      {id:13,type:1,relationId:0,fileType:1,pid:0,name:'第二图片'},
      {id:14,type:1,relationId:0,fileType:1,pid:12,name:'子级图片'},
      {id:20,type:1,relationId:0,fileType:2,pid:0,name:'平台视频'},
      {id:30,type:4,relationId:9,fileType:1,pid:0,name:'供应商秘密'},
      {id:40,type:1,relationId:7,fileType:1,pid:0,name:'其他关系秘密'},
    ]);
    await fixture.db.execute(sql`SELECT setval(pg_get_serial_sequence('system_attachment_category','id'),40,true)`);
    vi.clearAllMocks();
  });
  afterAll(async()=>{await fixture?.close();});

  it('serves the actual old form DTO on both exact paths and only offers the platform image roots',async()=>{
    for(const prefix of ['/adminapi','/api/admin']) {
      const {body,response}=await get('?id=12&file_type=1',tokens.reader,prefix);
      expect(body).toEqual({status:200,msg:'ok',data:{title:'添加分类',method:'POST',action:'file/category',rules:[
        {type:'hidden',field:'file_type',value:1},
        {type:'select',field:'pid',title:'上级分类',value:12,props:{filterable:true},options:[
          {value:0,label:'所有分类'},{value:12,label:'平台图片'},{value:13,label:'第二图片'}]},
        {type:'input',field:'name',title:'分类名称',value:'',props:{maxlength:20}},
      ]}});
      expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('pragma')).toBe('no-cache');
      expect(JSON.stringify(body)).not.toMatch(/供应商秘密|其他关系秘密|子级图片|平台视频|pwd|fixture-password/);
      expect(Object.keys(body.data).sort()).toEqual(['action','method','rules','title']);
    }
  });

  it.each(['','?id=','?id=0'])('treats a missing, blank or zero selected parent as root (%s)',async(query)=>{
    const {body}=await get(query);expect(body.status).toBe(200);
    expect(body.data.rules[0].value).toBe(1);expect(body.data.rules[1].value).toBe(0);
  });

  it('uses the video tab independently and excludes every image root',async()=>{
    const {body}=await get('?id=20&file_type=2');expect(body.status).toBe(200);
    expect(body.data.rules[0].value).toBe(2);expect(body.data.rules[1]).toMatchObject({value:20,options:[{value:0,label:'所有分类'},{value:20,label:'平台视频'}]});
  });

  it('retains the Admin parameter route but rejects query/path disagreement and duplicated parameters',async()=>{
    expect((await get('?file_type=1',tokens.reader,'/adminapi',application(),'/12')).body.data.rules[1].value).toBe(12);
    expect((await get('?id=12&file_type=1',tokens.reader,'/adminapi',application(),'/12')).body.status).toBe(200);
    for(const query of ['?id=13','?id=','?id=12&id=12']) expect((await get(query,tokens.reader,'/adminapi',application(),'/12')).body.status).toBe(400);
    expect((await get('?id=',tokens.reader,'/adminapi',application(),'/0')).body.data.rules[1].value).toBe(0);
    expect((await get('',tokens.reader,'/adminapi',application(),'/01')).body.status).toBe(400);
  });

  it('rejects malformed query before any SQL transaction instead of coercing it to a root/image selection',async()=>{
    const transaction=vi.fn(()=>{throw Error('Invalid query reached SQL');});
    const service=new AdminAttachmentCategoryCreateFormService({...container,db:{transaction} as unknown as DbClient});
    for(const query of ['id=-1','id=01','id=1.5','id=1e2','id=%2012','id=2147483648','id=NaN','id=12&id=12',
      'file_type=','file_type=0','file_type=3','file_type=01','file_type=true','file_type=1&file_type=1',
      'action=https://example.test','type=4','relation_id=9','limit=1','pid=12','unknown=1']) {
      await expect(service.createForm(new URLSearchParams(query),actor())).rejects.toMatchObject({code:400});
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([14,20,30,40,999])('rejects a child, mismatched file type, foreign realm or absent selected parent %s',async(id)=>{
    expect((await get(`?id=${id}&file_type=1`)).body.status).toBe(404);
  });

  it('uses one read-only snapshot, one complete root query, deadlines, and no object, queue or external I/O',async()=>{
    const before=await fixture.db.select().from(systemAttachmentCategory).orderBy(systemAttachmentCategory.id);
    let transactions=0,rootSelections=0;const external=vi.fn(()=>{throw Error('Form attempted external I/O');});
    const observedDb=new Proxy(fixture.db,{get(target,key){
      if(key==='select') throw Error('Form selected outside its snapshot');
      if(key==='transaction') return async(callback:(tx:DbClient)=>Promise<unknown>)=>{
        transactions++;return target.transaction(async tx=>{
          const observedTx=new Proxy(tx,{get(inner,method){
            if(['insert','update','delete'].includes(String(method))) throw Error('Form attempted a write');
            const value=Reflect.get(inner,method);
            if(method==='select') return (...args:unknown[])=>{
              const projection=args[0];
              if(projection && typeof projection==='object' && 'id' in projection && 'name' in projection
                && projection.id===systemAttachmentCategory.id && projection.name===systemAttachmentCategory.name) rootSelections++;
              return value.apply(inner,args);
            };
            return typeof value==='function'?value.bind(inner):value;
          }}) as unknown as DbClient;
          const result=await callback(observedTx);
          const settings=await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,
            current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
          expect(settings[0]).toEqual({isolation:'repeatable read',readonly:'on',statement:'5s',lock:'2s',idle:'5s'});return result;
        });
      }
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    vi.stubGlobal('fetch',external);
    try { await new AdminAttachmentCategoryCreateFormService({...container,db:observedDb}).createForm(new URLSearchParams('id=12'),actor()); }
    finally {vi.unstubAllGlobals();}
    expect(transactions).toBe(1);expect(rootSelections).toBe(1);expect(external).not.toHaveBeenCalled();
    for(const method of ['put','delete','get','head','list'] as const) expect(env.ASSETS_BUCKET[method]).not.toHaveBeenCalled();
    expect(env.ORDER_QUEUE.send).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(systemAttachmentCategory).orderBy(systemAttachmentCategory.id)).toEqual(before);
    expect((await fixture.db.execute(sql`SELECT current_setting('statement_timeout') AS timeout`))[0].timeout).toBe('0');
  });

  it('requires actual JWT permissions and allows view only to read, never to submit the generated action',async()=>{
    expect((await get('','')).body.status).toBe(410000);
    for(const token of [tokens.unrelated,tokens.foreign]) expect((await get('',token)).body.status).toBe(400011);
    for(const prefix of ['/adminapi','/api/admin']) {
      const form=(await get('',tokens.reader,prefix)).body.data;
      expect((await post(form.action,{pid:0,name:'只读不可写',file_type:1},tokens.reader,prefix)).status).toBe(400011);
      const result=await post(form.action,{pid:12,name:`实际可提交${prefix==='/adminapi'?'一':'二'}`,file_type:1},tokens.manager,prefix);
      expect(result.status).toBe(200);expect(result.data).toMatchObject({pid:12,file_type:1});
    }
  });

  it('revalidates the Admin-session identity and capability rather than ordinary-auth cached data',async()=>{
    for(const change of [{status:0},{pwd:'new-password'},{adminType:4},{isDel:1}]) {
      const app=application(container,async()=>{await fixture.db.update(systemAdmin).set(change).where(eq(systemAdmin.id,101));});
      try {expect((await get('',tokens.reader,'/adminapi',app)).body.status).toBe('pwd' in change?410001:410002);}
      finally {await fixture.db.update(systemAdmin).set({status:1,pwd:'fixture-password',adminType:1,isDel:0}).where(eq(systemAdmin.id,101));}
    }
    const app=application(container,async()=>{await fixture.db.update(systemRole).set({rules:'product.view'}).where(eq(systemRole.id,1));});
    expect((await get('',tokens.reader,'/adminapi',app)).body.status).toBe(400011);
    await expect(new AdminAttachmentCategoryCreateFormService(container).createForm(new URLSearchParams(),{...actor(),expiresAt:1})).rejects.toMatchObject({code:410001});
  });

  it.each(['deleted','fileType','realm'] as const)('makes POST revalidate a parent changed after GET (%s)',async(change)=>{
    const prefixes=['/adminapi','/api/admin'];
    const forms=await Promise.all(prefixes.map(async prefix=>(await get('?id=13',tokens.reader,prefix)).body.data));
    for(const form of forms) expect(form.rules[1].value).toBe(13);
    if(change==='deleted') await fixture.db.delete(systemAttachmentCategory).where(eq(systemAttachmentCategory.id,13));
    else await fixture.db.update(systemAttachmentCategory).set(change==='fileType'?{fileType:2}:{relationId:7}).where(eq(systemAttachmentCategory.id,13));
    const before=await fixture.db.select().from(systemAttachmentCategory).orderBy(systemAttachmentCategory.id);
    for(const [index,prefix] of prefixes.entries()) expect((await post(forms[index].action,{pid:13,file_type:1,name:'失效父分类'},tokens.manager,prefix)).status).toBe(404);
    expect(await fixture.db.select().from(systemAttachmentCategory).orderBy(systemAttachmentCategory.id)).toEqual(before);
  });

  it('returns a complete 10000-option catalog and rejects a real 10001-row catalog without silent truncation',async()=>{
    await fixture.db.delete(systemAttachmentCategory);
    await fixture.db.execute(sql`INSERT INTO ${systemAttachmentCategory}(id,type,relation_id,file_type,pid,name)
      SELECT n,1,0,1,0,'目录-'||n FROM generate_series(1000,${999+MAX_ADMIN_CATEGORY_FORM_ROOT_OPTIONS}) AS source(n)`);
    const service=new AdminAttachmentCategoryCreateFormService(container);
    const form=await service.createForm(new URLSearchParams('id=10999'),actor());
    expect(form.rules[1].options).toHaveLength(MAX_ADMIN_CATEGORY_FORM_ROOT_OPTIONS+1);
    expect(form.rules[1].options?.at(-1)).toEqual({value:10999,label:'目录-10999'});
    await fixture.db.insert(systemAttachmentCategory).values({id:11000,type:1,relationId:0,fileType:1,pid:0,name:'第10001个根'});
    const {body}=await get();expect(body.status).toBe(503);expect(body.data).toBeNull();
    expect((await fixture.db.execute(sql`SELECT count(*)::integer AS count FROM ${systemAttachmentCategory}`))[0].count).toBe(10001);
  });

  it('keeps modern POST names up to 50 and leaves Supplier/edit form behavior separate',async()=>{
    const name='名'.repeat(50);expect((await post('/adminapi/file/category',{pid:0,name,file_type:1})).status).toBe(200);
    expect((await post('/adminapi/file/category',{pid:0,name:'名'.repeat(51),file_type:1})).status).toBe(400);
    const edit=await application().request('/adminapi/file/category/12/edit',{headers:{'Authori-zation':`Bearer ${tokens.reader}`}},env);
    expect((await edit.json<Reply>()).data).toMatchObject({title:'编辑附件分类',method:'PUT',action:'/adminapi/file/category/12',rules:[{}, {type:'number'}, {maxlength:50}]});
    const supplier=await application().request('/supplierapi/file/category/create/30',{},env);
    expect((await supplier.json<Reply>()).data).toMatchObject({title:'添加附件分类',action:'/supplierapi/file/category',rules:[{}, {type:'number',value:30}, {maxlength:50}]});
  });

  it('registers the exact authenticated pair and propagates database failures instead of fabricating a form',async()=>{
    for(const [file,prefix] of [['../src/routes/adminapi.ts',''],['../src/routes/v1/index.ts','/admin']] as const) {
      expect(readFileSync(new NodeURL(file,import.meta.url),'utf8')).toContain(`.get("${prefix}/file/category/create", adminAuth, AttachmentController.adminCategoryCreateForm)`);
      expect(readFileSync(new NodeURL(file,import.meta.url),'utf8')).toContain(`.post("${prefix}/file/category", adminAuth, AttachmentController.adminCategorySave)`);
    }
    const transaction=vi.fn(()=>{throw Error('Local form read failure');});
    await expect(new AdminAttachmentCategoryCreateFormService({...container,db:{transaction} as unknown as DbClient})
      .createForm(new URLSearchParams(),actor())).rejects.toThrow('Local form read failure');
  });

  it('resolves the prefix-free form action under both API bases to an authenticated working POST endpoint',async()=>{
    for(const prefix of ['/adminapi','/api/admin']) {
      const {body}=await get('',tokens.reader,prefix);
      expect(body.data.action).toBe('file/category');
      expect(body.data.action).not.toMatch(/^(?:\/|https?:|\/\/)|adminapi|api\/admin|[?#]/);
      const target=new NodeURL(body.data.action,`http://local${prefix}/`);
      expect(target.origin).toBe('http://local');expect(target.pathname).toBe(`${prefix}/file/category`);
      expect((await post(body.data.action,{pid:0,file_type:1,name:`地址验证${prefix}`},tokens.reader,prefix)).status).toBe(400011);
      expect((await post(body.data.action,{pid:0,file_type:1,name:`地址验证${prefix}`},tokens.manager,prefix)).status).toBe(200);
    }
  });
});
