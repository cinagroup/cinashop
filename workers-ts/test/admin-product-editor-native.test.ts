import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { systemAdmin, systemRole, storeProduct, storeProductAttrValue, storeProductRelation, storeProductCoupon,
  systemLog, storeOrderOutbox, userLabel, storeCouponIssue } from '@/models/schema';
import { PRODUCT_EDITOR_OPERATION_SQL, inspectProductEditorOperation, PRODUCT_EDITOR_OPERATION_CONSTRAINTS_SHA256,
  assertProductEditorOperationReady, installProductEditorOperation } from '@/migrations/adminProductEditorOperation';
import { AdminProductEditorOperationService, prepareProductEditorSave } from '@/services/admin/AdminProductEditorReceipt';
import { AdminLegacyProductSaveService } from '@/services/admin/AdminLegacyProductSaveService';
import { AdminLegacyProductReadService } from '@/services/admin/AdminLegacyProductReadService';
import { createToken, md5 } from '@/utils/jwt';
import { legacySaveFixture, legacySaveActor } from './helpers/adminLegacyProductSave';
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
    new AdminLegacyProductSaveService(createContainerFromDb(db)).save(p.intent.requestedId, p.product, legacySaveActor(), { editorOperation:p.intent });
  const http = async (path: string, method = 'GET', body?: unknown, actor = 1) => {
    const response = await app.request(`https://editor.local/adminapi/product/editor/${path}`, {
      method, headers: { 'Authori-zation': `Bearer ${tokens[actor]}`, 'Content-Type':'application/json' },
      ...(body === undefined ? {} : { body:JSON.stringify(body) }),
    }, env);
    return { http:response.status, body:await response.json<{status:number;data:unknown;msg:string}>() };
  };
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
