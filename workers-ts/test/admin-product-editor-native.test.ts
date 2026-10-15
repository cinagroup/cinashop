import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { systemAdmin, systemRole, storeProduct, storeProductAttrValue, storeProductRelation, storeProductCoupon,
  systemLog, storeOrderOutbox, userLabel, storeCouponIssue, systemStore, systemSupplier, storeProductVirtual,
  storeProductDescription } from '@/models/schema';
import { PRODUCT_EDITOR_OPERATION_SQL, inspectProductEditorOperation, PRODUCT_EDITOR_OPERATION_CONSTRAINTS_SHA256,
  assertProductEditorOperationReady, installProductEditorOperation } from '@/migrations/adminProductEditorOperation';
import { AdminProductEditorOperationService, prepareProductEditorCopySave, prepareProductEditorSave } from '@/services/admin/AdminProductEditorReceipt';
import { AdminLegacyProductSaveService } from '@/services/admin/AdminLegacyProductSaveService';
import { AdminLegacyProductReadService } from '@/services/admin/AdminLegacyProductReadService';
import { createToken, md5 } from '@/utils/jwt';
import { legacySaveFixture, legacySaveActor, legacySaveSku } from './helpers/adminLegacyProductSave';
import { editorProduct } from './helpers/adminProductEditor';
import { pauseModerationExecute } from './helpers/adminProductModeration';
import { outcome, withFinancePeers } from './helpers/financePeers';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
const appKey = 'editor-native-local-test-key';
const env = { APP_KEY: appKey, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
  ORDER_QUEUE: { sendBatch: async () => {} } } as unknown as Env;
const signal = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 full editor immutable operations', () => {
  let f: Awaited<ReturnType<typeof legacySaveFixture>>;
  const app = createApp(), tokens: Record<number,string> = {};
  beforeAll(async () => {
    f = await legacySaveFixture(); await f.db.transaction(tx => installProductEditorOperation(tx));
    wiring.application.mockImplementation(() => f.container);
    wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Editor must not contact any provider'));
    for (const id of [1,2]) tokens[id] = (await createToken(id,'admin',md5('legacy-save-password'),appKey)).token;
  }, 30000);
  beforeEach(async () => { await f.seed(); });
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });
  const operations = (db: DbClient = f.db) => new AdminProductEditorOperationService(createContainerFromDb(db));
  const prepared = (product = editorProduct(), target = 0, operationId = crypto.randomUUID()) =>
    prepareProductEditorSave({ operation_id: operationId, product }, target, legacySaveActor(), appKey);
  const save = (p: ReturnType<typeof prepared>, db: DbClient = f.db) =>
    new AdminLegacyProductSaveService(createContainerFromDb(db),undefined,appKey).save(p.intent.requestedId, p.product, legacySaveActor(), { editorOperation:p.intent });
  const http = async (path: string, method = 'GET', body?: unknown, actor = 1) => {
    const response = await app.request(`https://editor.local/adminapi/product/editor/${path}`, {
      method, headers: { 'Authori-zation': `Bearer ${tokens[actor]}`, 'Content-Type':'application/json' },
      ...(body === undefined ? {} : { body:JSON.stringify(body) }),
    }, env);
    return { http:response.status, body:await response.json<{status:number;data:unknown;msg:string}>() };
  };
  const copySeed = async (sourceId: number) => {
    const response = await http('copy/'+sourceId); expect(response.body.status, response.body.msg).toBe(200);
    return response.body.data as {productInfo:Record<string,unknown>;editor:{copy:{source_id:number;token:string;destination:{type:number;relation_id:number}};retired_attrs:unknown[]}};
  };
  const copyBody = (product: Record<string,unknown>, token: string, operationId = crypto.randomUUID()) =>
    ({operation_id:operationId,copy_token:token,product:{...product,attrs:(product.attrs as object[]).map(row=>({disk_info:'',virtual_list:[],...row}))}});
  it('pins actual PostgreSQL16 catalog definitions independently of the TypeScript source', async () => {
    expect(readFileSync(resolve(import.meta.dirname,'../src/migrations/maintenance/0184_admin_product_editor_operation.sql'),'utf8')
      .split('\n').slice(1).join('\n')).toBe(PRODUCT_EDITOR_OPERATION_SQL);
    const state = await f.db.transaction(tx => inspectProductEditorOperation(tx));
    console.log('PRODUCT_EDITOR_NATIVE_CATALOG', JSON.stringify(state));
    expect(state?.constraints_hash).toBe(PRODUCT_EDITOR_OPERATION_CONSTRAINTS_SHA256);
    expect((await f.db.execute(sql`SELECT count(*)::integer AS count FROM public.admin_product_editor_operation_v1`))[0]?.count).toBe(0);
    expect(await f.db.transaction(tx => installProductEditorOperation(tx))).toEqual({applied:false});
  });
  it('recovers a discarded successful HTTP create response after grant revocation without another product or outbox write', async () => {
    const p = prepared();
    const response = await http('save/0','POST',{operation_id:p.intent.operationId,product:p.product});
    expect(response.http).toBe(200); expect(response.body.status).toBe(200);
    const [product] = await f.db.select().from(storeProduct);
    expect(product.id).toBeGreaterThan(0);
    // The caller discarded the response; recovery uses only the durable UUID.
    await f.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,1));
    const before = await f.snapshot();
    expect((await http('operations/'+p.intent.operationId)).body.data).toEqual({
      operation_id:p.intent.operationId,actor_id:1,requested_id:0,state:'committed',result:{id:product.id,created:true},
    });
    expect((await http('operations/'+p.intent.operationId+'/resolve','POST',{requested_id:0})).body.data)
      .toMatchObject({state:'committed',result:{id:product.id,created:true}});
    expect((await http('save/0','POST',{operation_id:p.intent.operationId,product:p.product})).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
    expect(await f.db.select().from(systemLog)).toHaveLength(1); expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(1);
    await f.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,1));
    expect((await http('operations/'+p.intent.operationId)).body.status).not.toBe(200);
  });
  it('replays exactly once, rejects changed bodies and preserves prior identities, empty replacements and description/form snapshots', async () => {
    await f.db.insert(userLabel).values({id:5,name:'完整标签'});
    await f.db.insert(storeCouponIssue).values({id:2,title:'赠券'});
    const p = prepared(editorProduct({label_id:[5],coupon_ids:[2],custom_form:{ field:{name:'texts',titleConfig:{value:'快照'}} }}));
    const saved = await save(p), before = await f.snapshot();
    expect((await save(p)).receipt).toEqual(saved.receipt);
    expect(await f.snapshot()).toEqual(before);
    await expect(save(prepared(editorProduct({store_name:'changed'}),0,p.intent.operationId))).rejects.toMatchObject({httpStatus:409});
    expect(await f.snapshot()).toEqual(before);
    const read = await new AdminLegacyProductReadService(f.container,appKey).detail(saved.id,new URLSearchParams(),legacySaveActor(),{editorContract:true});
    expect(read.productInfo.label_id).toEqual([{id:5,label_name:'完整标签'}]);
    expect(read.editor.stored_custom_form).toEqual({field:{name:'texts',titleConfig:{value:'快照'}}});
    const [sku] = await f.db.select().from(storeProductAttrValue);
    const clear = prepared(editorProduct({attrs:[{...(p.product.attrs as unknown[])[0] as object,unique:sku.unique}],store_name:'清空标签和赠券'}),saved.id);
    await save(clear);
    expect((await f.db.select().from(storeProductAttrValue))[0]).toMatchObject({id:sku.id,unique:sku.unique});
    expect((await f.db.select().from(storeProduct))[0]).toMatchObject({labelId:''});
    expect(await f.db.select().from(storeProductRelation)).toHaveLength(1);
    expect(await f.db.select().from(storeProductCoupon)).toEqual([]);
    expect((await new AdminLegacyProductReadService(f.container,appKey).detail(saved.id,new URLSearchParams(),legacySaveActor(),{editorContract:true})).productInfo.label_id).toEqual([]);
  });
  it('rolls back all product/audit/outbox and receipt writes when a late coupon check fails', async () => {
    const p = prepared(editorProduct({coupon_ids:[999]})), before = await f.snapshot();
    await expect(save(p)).rejects.toThrow('优惠券不存在');
    expect(await f.snapshot()).toEqual(before);
    expect(await operations().receipt(p.intent.operationId,legacySaveActor())).toMatchObject({state:'unknown',requested_id:null,result:null});
    expect(await operations().resolve(p.intent.operationId,0,legacySaveActor())).toMatchObject({state:'not_applied',requested_id:0,result:null});
    await expect(save(p)).rejects.toMatchObject({httpStatus:409});
    expect(await f.snapshot()).toEqual(before);
  });
  it('binds receipts to the original live account and refuses schema/ACL drift before business writes', async () => {
    const p = prepared(), saved = await save(p);
    await f.db.insert(systemAdmin).values({id:2,account:'other-editor',pwd:'legacy-save-password',roles:'1',level:1});
    expect((await http('operations/'+p.intent.operationId,'GET',undefined,2)).body.status).not.toBe(200);
    await expect(operations().receipt(p.intent.operationId,{...legacySaveActor(),expiresAt:1})).rejects.toThrow();
    const before = await f.snapshot();
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql.raw('ALTER TABLE public.admin_product_editor_operation_v1 DISABLE TRIGGER apeo_immutable_rows'));
      await assertProductEditorOperationReady(tx);
    })).rejects.toThrow('未就绪');
    expect(await f.snapshot()).toEqual(before);
    expect(saved.receipt?.result).toMatchObject({id:saved.id,created:true});
    for (const statement of [
      'UPDATE public.admin_product_editor_operation_v1 SET actor_id=actor_id',
      'DELETE FROM public.admin_product_editor_operation_v1',
      'TRUNCATE public.admin_product_editor_operation_v1',
    ]) await expect(f.exec(statement)).rejects.toMatchObject({code:'42501'});
  });
  it('uses independent SQL sessions to refuse recovery during a live writer and fences late saves after durable resolution', async () => {
    await withFinancePeers(f.db,async ([writer,recovery]) => {
      expect(writer.pid).not.toBe(recovery.pid);
      const p = prepared(), ready = signal(), release = signal();
      const hooked = pauseModerationExecute(writer.db,/LOCK TABLE ONLY public.system_admin[\s\S]*SHARE ROW EXCLUSIVE MODE NOWAIT/i,
        async () => { ready.resolve(); await release.promise; });
      const pending = outcome(save(p,hooked));
      try {
        await Promise.race([ready.promise,pending.then(result => { if (!result.ok) throw result.error; throw Error('Writer did not reach live staff barrier'); })]);
        await expect(operations(recovery.db).resolve(p.intent.operationId,0,legacySaveActor())).rejects.toMatchObject({httpStatus:409});
      } finally { release.resolve(); await pending; }
      const result = await pending; if (!result.ok) throw result.error;
      expect(await operations(recovery.db).receipt(p.intent.operationId,legacySaveActor())).toMatchObject({state:'committed',result:{id:result.value.id,created:true}});
      const late = prepared(), before = await f.snapshot();
      expect(await operations(recovery.db).resolve(late.intent.operationId,0,legacySaveActor())).toMatchObject({state:'not_applied'});
      await expect(save(late,writer.db)).rejects.toMatchObject({httpStatus:409});
      expect(await f.snapshot()).toEqual(before);
    });
  },30000);
  it('rejects malformed and oversized recovery envelopes, missing fields and unregistered write variants through the actual App', async () => {
    const before = await f.snapshot(), operation = crypto.randomUUID();
    for (const body of [{requested_id:0,extra:1},{requested_id:'0'},{requested_id:2147483648},{requested_id:0,padding:'x'.repeat(5000)}])
      expect((await http('operations/'+operation+'/resolve','POST',body)).body.status).not.toBe(200);
    expect((await http('save/0','POST',{operation_id:operation,product:{store_name:'missing'}})).body.status).not.toBe(200);
    expect((await http('save/00','POST',{operation_id:operation,product:editorProduct()})).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
  });
  it('copies a recycled source through the actual App with new identities and durable recovery, binding the source and save kind', async () => {
    const original = editorProduct({ficti:29}), source = await save(prepared(original));
    const [sourceSku] = await f.db.select().from(storeProductAttrValue);
    await f.db.update(storeProduct).set({isDel:1,sales:91,codePath:'old-code',soureLink:'https://old-import.local'}).where(eq(storeProduct.id,source.id));
    const seed = await copySeed(source.id), before = await f.snapshot();
    expect(await f.snapshot()).toEqual(before);
    expect(seed.productInfo).toMatchObject({id:0,type:0,relation_id:0,supplier_id:0,is_del:0,sales:0,code_path:'',soure_link:'',spu:''});
    expect(seed.productInfo.attr).not.toHaveProperty('unique'); expect(JSON.stringify(seed)).not.toContain(sourceSku.unique);
    const body = copyBody(original,seed.editor.copy.token);
    const response = await http('copy/'+source.id,'POST',body); expect(response.body.status,response.body.msg).toBe(200);
    const receipt = response.body.data as {result:{id:number;created:boolean}};
    expect(receipt.result.created).toBe(true); expect(receipt.result.id).not.toBe(source.id);
    const [created] = await f.db.select().from(storeProduct).where(eq(storeProduct.id,receipt.result.id));
    const [createdSku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId,created.id));
    expect(created).toMatchObject({type:0,relationId:0,isDel:0,sales:0,ficti:29,soureLink:'',codePath:'',stock:7});
    expect(created.spu).not.toBe((await f.db.select().from(storeProduct).where(eq(storeProduct.id,source.id)))[0].spu);
    expect(createdSku.unique).not.toBe(sourceSku.unique); expect(createdSku).toMatchObject({sales:0,stock:7,sumStock:7});
    expect((await f.db.select().from(systemLog)).map(row=>JSON.parse(row.action)).find(row=>row.productId===created.id))
      .toMatchObject({copied:true,source_id:source.id});
    const after = await f.snapshot();
    expect((await http('copy/'+source.id,'POST',body)).body.data).toEqual(response.body.data);
    expect((await http('copy/'+created.id,'POST',body)).body.status).not.toBe(200);
    expect((await http('save/0','POST',{operation_id:body.operation_id,product:body.product})).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(after);
    await f.db.delete(storeProduct).where(eq(storeProduct.id,source.id));
    const deleted = await f.snapshot();
    expect((await http('copy/'+source.id,'POST',body)).body.data).toEqual(response.body.data);
    expect((await http('operations/'+body.operation_id)).body.data).toEqual(response.body.data);
    expect(await f.snapshot()).toEqual(deleted);
    await f.db.update(systemRole).set({rules:'product.view'}).where(eq(systemRole.id,1));
    expect((await http('copy/'+created.id)).body.status).not.toBe(200);
    expect((await http('copy/'+created.id,'POST',copyBody(original,seed.editor.copy.token))).body.status).not.toBe(200);
    expect((await http('operations/'+body.operation_id)).body.data).toEqual(response.body.data);
  });
  it('never returns or duplicates fixed delivery content, cards or card inventory', async () => {
    const product = editorProduct({product_type:1,attrs:[legacySaveSku({disk_info:'SYNTHETIC-FIXED-DELIVERY',virtual_list:[]})]});
    const source = await save(prepared(product)), [sku] = await f.db.select().from(storeProductAttrValue);
    await f.db.insert(storeProductVirtual).values({productId:source.id,attrUnique:sku.unique,cardNo:'SYNTHETIC-CARD-NUMBER',cardPwd:'SYNTHETIC-CARD-PASSWORD'});
    const before = await f.snapshot(), seed = await copySeed(source.id);
    for (const secret of ['SYNTHETIC-FIXED-DELIVERY','SYNTHETIC-CARD-NUMBER','SYNTHETIC-CARD-PASSWORD',sku.unique]) expect(JSON.stringify(seed)).not.toContain(secret);
    expect(seed.productInfo.attr).toMatchObject({stock:0,disk_info:'',virtual_list:[],virtual_available:0,virtual_total:0,sales:0});
    expect(seed.editor.retired_attrs).toEqual([]); expect(await f.snapshot()).toEqual(before);
    const clone = copyBody({...product,attrs:[legacySaveSku({stock:0,disk_info:'',virtual_list:[]})]},seed.editor.copy.token);
    const result = await http('copy/'+source.id,'POST',clone); expect(result.body.status,result.body.msg).toBe(200);
    const createdId = (result.body.data as {result:{id:number}}).result.id;
    expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId,createdId)))[0]).toMatchObject({stock:0,diskInfo:'',sales:0,sumStock:0});
    expect(await f.db.select().from(storeProductVirtual)).toHaveLength(1);
  });
  it('derives destination ownership from actual store/supplier sources and rejects client owner or fulfillment changes', async () => {
    await f.db.insert(systemStore).values({id:71,name:'源门店'});
    await f.db.insert(systemSupplier).values({id:72,adminId:72,supplierName:'源供应商'});
    for (const owner of [{type:1,relationId:71},{type:2,relationId:72}]) {
      const original = editorProduct(), source = await save(prepared(original));
      await f.db.update(storeProduct).set(owner).where(eq(storeProduct.id,source.id));
      const seed = await copySeed(source.id);
      expect(seed.editor.copy.destination).toEqual({type:owner.type,relation_id:owner.relationId});
      const product = {...original,supplier_id:owner.type===2?owner.relationId:0};
      for (const changed of [{...product,supplier_id:99},{...product,product_type:3}]) {
        const before = await f.snapshot();
        expect((await http('copy/'+source.id,'POST',copyBody(changed,seed.editor.copy.token))).body.status).not.toBe(200);
        expect(await f.snapshot()).toEqual(before);
      }
      const result = await http('copy/'+source.id,'POST',copyBody(product,seed.editor.copy.token));
      expect(result.body.status,result.body.msg).toBe(200);
      const createdId = (result.body.data as {result:{id:number}}).result.id;
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id,createdId)))[0]).toMatchObject(owner);
    }
  });
  it('refuses stale source snapshots and inaccessible source media without any product or receipt writes', async () => {
    const product = editorProduct(), source = await save(prepared(product)), seed = await copySeed(source.id);
    await f.db.update(storeProduct).set({storeName:'source changed'}).where(eq(storeProduct.id,source.id));
    const before = await f.snapshot(), body = copyBody(product,seed.editor.copy.token);
    expect((await http('copy/'+source.id,'POST',body)).body.status).toBe(409);
    expect(await f.snapshot()).toEqual(before);
    expect(await operations().receipt(body.operation_id,legacySaveActor())).toMatchObject({state:'unknown'});
    const refreshed = await copySeed(source.id), late = copyBody({...product,coupon_ids:[999]},refreshed.editor.copy.token);
    expect((await http('copy/'+source.id,'POST',late)).body.msg).toContain('优惠券不存在');
    expect(await f.snapshot()).toEqual(before);
    expect(await operations().receipt(late.operation_id,legacySaveActor())).toMatchObject({state:'unknown'});
    for (const kind of ['slider','sku','description']) {
      await f.db.update(storeProduct).set({sliderImage:JSON.stringify(kind==='slider'?['/api/assets/987']:['/uploads/main.png'])}).where(eq(storeProduct.id,source.id));
      await f.db.update(storeProductAttrValue).set({image:kind==='sku'?'/api/assets/987':'/uploads/sku.png'}).where(eq(storeProductAttrValue.productId,source.id));
      await f.db.update(storeProductDescription).set({description:kind==='description'?'<img src="/api/assets/987">':'<p>safe</p>'}).where(eq(storeProductDescription.productId,source.id));
      const state = await f.snapshot(), response = await http('copy/'+source.id);
      expect(response.body.status,response.body.msg).toBe(409); expect(response.body.msg).toContain('私有图片');
      expect(await f.snapshot()).toEqual(state);
    }
  });
  it('holds a real source-table fence during copy and rejects an already active direct SQL source writer', async () => {
    const product = editorProduct(), source = await save(prepared(product)), seed = await copySeed(source.id);
    const p = prepareProductEditorCopySave(copyBody(product,seed.editor.copy.token),source.id,legacySaveActor(),appKey);
    await withFinancePeers(f.db,async ([writer,peer]) => {
      await writer.exec('BEGIN');
      try {
        await writer.exec(`UPDATE public.store_product SET store_name='uncommitted source' WHERE id=${source.id}`);
        await expect(save(p,peer.db)).rejects.toMatchObject({httpStatus:409});
      } finally { await writer.exec('ROLLBACK'); }
      const ready = signal(), release = signal();
      const hooked = pauseModerationExecute(peer.db,/LOCK TABLE ONLY (?:(?:"public"|public)\.)?"store_product",[\s\S]*SHARE ROW EXCLUSIVE MODE NOWAIT/i,
        async()=>{ready.resolve();await release.promise;});
      const pending = outcome(save(p,hooked));
      try {
        await Promise.race([ready.promise,pending.then(result=>{if(!result.ok)throw result.error;throw Error('Copy did not reach real source-table fence');})]);
        await writer.exec("SET lock_timeout='200ms'");
        await expect(writer.exec(`UPDATE public.store_product SET store_name='late source' WHERE id=${source.id}`)).rejects.toMatchObject({code:'55P03'});
      } finally {release.resolve();await pending;}
      const result=await pending;if(!result.ok)throw result.error;
      expect(result.value.receipt).toMatchObject({state:'committed'});
    });
  },30000);
  it('recovers and fences under an independent restricted LOGIN with only SELECT/INSERT on receipt evidence', async () => {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
    const [origin] = await f.db.execute(sql`SELECT current_database() AS database,current_schema() AS schema`);
    if (!ownsFinanceFixtureTarget(String(origin.database),String(origin.schema),base.href)) throw Error('Unowned editor runtime fixture');
    const role = 'editor_runtime_'+crypto.randomUUID().replaceAll('-',''), password = crypto.randomUUID().replaceAll('-','');
    await f.exec(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    let client: ReturnType<typeof postgres> | undefined;
    try {
      await f.exec(`GRANT USAGE ON SCHEMA public TO "${role}";
        GRANT SELECT,UPDATE ON public.system_admin,public.system_role TO "${role}";
        GRANT SELECT,INSERT ON public.admin_product_editor_operation_v1 TO "${role}"`);
      const url = new URL(base); url.pathname='/'+origin.database; url.username=role; url.password=password;
      client = postgres(url.href,{max:1,prepare:false,connect_timeout:5});
      const [identity] = await client`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
        FROM pg_roles WHERE rolname=current_user`;
      expect(identity).toEqual({login:true,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false});
      const restricted = drizzle(client) as unknown as DbClient, operation = crypto.randomUUID();
      expect(await operations(restricted).receipt(operation,legacySaveActor())).toMatchObject({state:'unknown'});
      expect(await operations(restricted).resolve(operation,0,legacySaveActor())).toMatchObject({state:'not_applied'});
      for (const statement of ['DELETE FROM public.admin_product_editor_operation_v1','TRUNCATE public.admin_product_editor_operation_v1'])
        await expect(client.unsafe(statement)).rejects.toMatchObject({code:'42501'});
    } finally {
      await client?.end({timeout:5});
      await f.exec(`REVOKE ALL ON public.admin_product_editor_operation_v1,public.system_admin,public.system_role FROM "${role}";
        REVOKE ALL ON SCHEMA public FROM "${role}"; DROP ROLE "${role}"`);
    }
  });
});
