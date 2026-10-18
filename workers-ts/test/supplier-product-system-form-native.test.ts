import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { storeProduct, systemForm, systemRole, systemAdmin, storeOrder, systemFormData, storeOrderCartInfo } from '@/models/schema';
import { SupplierProductManagementService } from '@/services/supplier/SupplierProductManagementService';
import { supplierProductSystemFormsFixture, supplierProductSystemFormsActor, supplierSystemFormCheckoutFixture, supplierSystemFormTemplate } from './helpers/supplierProductSystemForms';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const wiring = vi.hoisted(() => ({ container: null as Container | null }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => wiring.container }));
const app = createApp();
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier ordinary product system form complete author and customer checkout on owned PG16 App JWT', () => {
  let f: Awaited<ReturnType<typeof supplierProductSystemFormsFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned system form scenario forbids outbound I/O'));
    f = await supplierProductSystemFormsFixture(); wiring.container = f.container; }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { await f?.close(); wiring.container = null; vi.restoreAllMocks(); } }, 30000);
  async function request(method: string, path: string, body?: unknown, actor: keyof typeof f.tokens | 'anonymous' = 'manager') {
    const response = await app.request('/supplierapi' + path, { method, headers: {
      ...(actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + f.tokens[actor] }), 'X-Supplier-Id': '8',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store');
    return response.json<{ status: number; msg: string; data: any }>();
  }
  const root = async (id = 80) => (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0];
  async function unchanged(work: () => Promise<unknown>) { const before = await f.snapshot(), sequences = await f.sequences(); const value = await work();
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences); return value; }
  async function hidden(before: Awaited<ReturnType<typeof root>>, snapshot: Awaited<ReturnType<typeof f.snapshot>>) {
    const after = await root(), current = await f.snapshot();
    for (const key of ['autoOnTime','autoOffTime','brandId','brandCom','ensureId','specsId','specs','labelId','commandWord','customForm','addTime','sales','spu'] as const) expect(after[key], key).toEqual(before[key]);
    expect(current.store_product_relation.filter((item: { row: { product_id: number; type: number } }) => item.row.product_id === 80 && item.row.type !== 1))
      .toEqual(snapshot.store_product_relation.filter((item: { row: { product_id: number; type: number } }) => item.row.product_id === 80 && item.row.type !== 1));
    for (const name of Object.keys(snapshot)) if (!['store_product','store_product_attr','store_product_attr_result','store_product_relation'].includes(name)) expect(current[name], name).toEqual(snapshot[name]);
  }
  it('reads only binding eligibility through a sixteen-table SELECT-only viewer and never emits old answer/configuration bytes', async () => f.withReader(async runtime => {
    wiring.container = runtime.container;
    await f.db.insert(systemFormData).values({ uid: 999, systemFormId: '71', relationId: 900, value: 'PRIVATE-CUSTOMER-ANSWER' });
    await unchanged(async () => {
      const read = await request('GET', '/product/product/80', undefined, 'viewer'); expect(read.status).toBe(200);
      expect(read.data.system_form_id).toBe(71); expect(read.data.system_form_selection).toEqual({ system_form_id: 71, available: true });
      expect(Object.keys(read.data.system_form_selection).sort()).toEqual(['available','system_form_id']);
      expect(read.data).not.toHaveProperty('custom_form'); expect(JSON.stringify(read.data)).not.toContain('原字节必须保留'); expect(JSON.stringify(read.data)).not.toContain('PRIVATE-CUSTOMER-ANSWER');
      const catalog = await request('GET', '/form/all_system_form', undefined, 'viewer'); expect(catalog.status).toBe(200);
      expect(catalog.data.map((row: { id: number }) => row.id)).toContain(401); expect(catalog.data.map((row: { id: number }) => row.id)).not.toContain(402);
    });
    const [rights] = await runtime.db.execute(sql`SELECT count(*) FILTER(WHERE has_table_privilege(current_user,c.oid,'SELECT'))::int AS selected,
      bool_and(NOT(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))) AS pure
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
    expect(rights).toEqual({ selected: 16, pure: true });
    const [sequences] = await runtime.db.execute(sql`SELECT bool_and(NOT has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE')) AS pure FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S'`); expect(sequences).toEqual({ pure: true });
  }));
  it.each([401, '401', 0, '0'])('saves exact form intent %j and rereads it without writing definitions or legacy custom_form', async id => f.withWriter(async runtime => {
    wiring.container = runtime.container; const before = await root(), snapshot = await f.snapshot();
    const saved = await request('POST', '/product/product/80', f.body({ system_form_id: id, custom_form: [{ value: '不得写入的客户答案' }], is_show: 1, is_verify: 1 }));
    expect(saved.status, saved.msg).toBe(200); expect(await root()).toMatchObject({ systemFormId: Number(id), isShow: 0, isVerify: 0 });
    const read = await request('GET', '/product/product/80'); expect(read.data).toMatchObject({ system_form_id: Number(id), system_form_selection: { system_form_id: Number(id), available: true } });
    await hidden(before, snapshot);
    const [rights] = await runtime.db.execute(sql`SELECT has_column_privilege(current_user,'system_form','id','UPDATE') AS lock_only,
      has_column_privilege(current_user,'system_form','value','UPDATE') AS can_edit,has_table_privilege(current_user,'system_form','INSERT,DELETE') AS can_create,has_table_privilege(current_user,'system_form_data','SELECT,INSERT,UPDATE,DELETE') AS can_read_or_edit_answers`);
    expect(rights).toEqual({ lock_only: true, can_edit: false, can_create: false, can_read_or_edit_answers: false });
  }));
  it('creates an ordinary bound product and keeps the form definition unchanged', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const forms = await f.db.select().from(systemForm).orderBy(asc(systemForm.id));
    const created = await request('POST', '/product/product', f.body({ system_form_id: 401 })); expect(created.status, created.msg).toBe(200);
    expect(await root(created.data.id)).toMatchObject({ type: 2, relationId: 7, systemFormId: 401, customForm: null, isShow: 0, isVerify: 0 });
    expect(await f.db.select().from(systemForm).orderBy(asc(systemForm.id))).toEqual(forms);
  }));
  it.each([402, 403, 404, 405, 406, 999])('rejects unavailable or malformed actual template %j before writing', async id => f.withWriter(async runtime => {
    wiring.container = runtime.container; await unchanged(async () => expect((await request('POST', '/product/product/80', f.body({ system_form_id: id }))).status).toBe(400));
  }));
  it.each([null, '', true, '0401', '2147483648'])('rejects malformed HTTP form intent %j without touching rows or sequences', async id => f.withWriter(async runtime => {
    wiring.container = runtime.container; await unchanged(async () => expect((await request('POST','/product/product/80',f.body({system_form_id:id}))).status).toBe(400));
  }));
  it('keeps negative missing disabled deleted and malformed history readable, allows omission and explicit repair', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    for (const id of [-1, 999, 402, 403, 404, 405, 406]) {
      await f.db.update(storeProduct).set({ systemFormId: id }).where(eq(storeProduct.id, 80));
      await unchanged(async () => { const read = await request('GET', '/product/product/80'); expect(read.status).toBe(200);
        expect(read.data.system_form_id).toBe(Math.max(0,id)); expect(read.data.system_form_selection).toEqual({ system_form_id: id, available: false }); });
      const raw = (await root()).customForm;
      expect((await request('POST', '/product/product/80', f.body())).status).toBe(200); expect(await root()).toMatchObject({ systemFormId: id, customForm: raw });
      expect((await request('POST', '/product/product/80', f.body({ system_form_id: 0 }))).status).toBe(200); expect(await root()).toMatchObject({ systemFormId: 0, customForm: raw });
    }
  }));
  it('does not mask a real SQL SELECT denial as unavailable metadata', async () => f.withReader(async runtime => {
    await f.exec(`REVOKE SELECT ON public.system_form FROM "${runtime.role}"`); wiring.container = runtime.container;
    await unchanged(async () => { const read = await request('GET', '/product/product/80', undefined, 'viewer'); expect(read.status).not.toBe(200); expect(read.data).toBeNull(); });
  }));
  it('omits system_form_id from the actual UPDATE target and preserves all old custom_form bytes', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    await f.exec("CREATE FUNCTION owned_form_must_be_omitted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'system_form_id mentioned in UPDATE'; END $$; CREATE TRIGGER owned_form_must_be_omitted BEFORE UPDATE OF system_form_id ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_form_must_be_omitted()");
    const before = await root(); expect((await request('POST', '/product/product/80', f.body())).status).toBe(200);
    expect(await root()).toMatchObject({ systemFormId: before.systemFormId, customForm: before.customForm });
  }));
  it('preserves an Admin form binding committed while an omitted-field save waits on the real product row', async () => f.withWriter(async runtime => f.withPeer!(async owner => {
    const held = signal(), release = signal();
    const holding = withTx(createContainerFromDb(owner.db), async tx => { await tx.update(storeProduct).set({ systemFormId: 401, customForm: 'new-admin-raw' }).where(eq(storeProduct.id, 80)); held.resolve(); await release.promise; });
    let saving: Promise<unknown> | undefined;
    try { await held.promise; saving = outcome(new SupplierProductManagementService(runtime.container, f.env).saveProduct(7, 80, f.body()));
      await waitForFinanceBlock(f.db, runtime.pid, owner.pid); release.resolve(); await holding; expect(await saving).toMatchObject({ ok: true });
      expect(await root()).toMatchObject({ systemFormId: 401, customForm: 'new-admin-raw' });
    } finally { release.resolve(); await holding; await saving; }
  })));
  it('requires current JWT manage and ownership instead of the caller selected tenant', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => {
      for (const actor of ['viewer','denied'] as const) expect((await request('POST', '/product/product/80', f.body({ system_form_id: 401, supplier_id: 8 }), actor)).status).toBe(400011);
      expect((await request('POST', '/product/product/80', f.body({ system_form_id: 401 }), 'anonymous')).status).toBe(410000);
      expect((await request('POST', '/product/product/90', f.body({ system_form_id: 401 }))).status).toBe(404);
      expect((await request('POST', '/product/product/80', f.body({ system_form_id: 401 }), 'other')).status).toBe(404);
    });
    await f.db.update(systemRole).set({ rules: 'supplier.product.view' }).where(eq(systemRole.id,21));
    await unchanged(async () => expect((await request('POST', '/product/product/80', f.body({ system_form_id: 401 }))).status).toBe(400011));
  }));
  it('rechecks the original password claim and expired actor inside the actual binding transaction', async () => f.withWriter(async runtime => {
    const service = new SupplierProductManagementService(runtime.container, f.env);
    await unchanged(async () => { await expect(service.saveProduct(7,80,f.body({system_form_id:401}),{...supplierProductSystemFormsActor(),expiresAt:1})).rejects.toThrow(); });
    await f.db.update(systemAdmin).set({ pwd: 'changed-after-token' }).where(eq(systemAdmin.id,21));
    await unchanged(async () => { await expect(service.saveProduct(7,80,f.body({system_form_id:401}),supplierProductSystemFormsActor())).rejects.toThrow(); });
  }));
  it('fails quickly against an independently locked actual template and leaves the full save rolled back', async () => f.withWriter(async runtime => f.withPeer!(async owner => {
    await owner.exec('BEGIN; SELECT id FROM public.system_form WHERE id=401 FOR UPDATE');
    try { wiring.container = runtime.container; const before = await f.snapshot();
      expect((await request('POST','/product/product/80',f.body({system_form_id:401}))).status).toBe(409); expect(await f.snapshot()).toEqual(before);
    } finally { await owner.exec('ROLLBACK'); }
  })));
  it.each(['skip','rewrite'] as const)('rejects an actual %s trigger rather than publishing a false binding receipt', async mode => f.withWriter(async runtime => {
    await f.exec(mode === 'skip'
      ? "CREATE FUNCTION owned_form_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.system_form_id=401 THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_form_write_guard BEFORE UPDATE OF system_form_id ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_form_write_guard()"
      : "CREATE FUNCTION owned_form_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_trigger_depth()=1 AND NEW.system_form_id=401 THEN UPDATE public.store_product SET system_form_id=71 WHERE id=NEW.id; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_form_write_guard AFTER UPDATE OF system_form_id ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_form_write_guard()");
    wiring.container = runtime.container; const before = await f.snapshot();
    expect((await request('POST','/product/product/80',f.body({system_form_id:401}))).status).toBe(409); expect(await f.snapshot()).toEqual(before);
  }));
  it('combines form, free parameters, assurances, brand, labels and schedule while preserving legacy answers', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const raw = (await root()).customForm;
    const saved = await request('POST','/product/product/80',f.body({system_form_id:401,specs_id:301,specs:[{name:'自由材质',value:'棉',sort:-2}],
      ensure_id:[201,202],brand_id:[101,102,103],store_label_id:[31],auto_on_time:123,auto_off_time:456}));
    expect(saved.status,saved.msg).toBe(200); expect(await root()).toMatchObject({systemFormId:401,customForm:raw,specsId:301,ensureId:'201,202',brandId:103,brandCom:'101,102,103',autoOnTime:123,autoOffTime:456});
  }));
  it.each(['ensure','brand'] as const)('rechecks the form changed by an executable later %s author before completing a combination save', async mode => f.withWriter(async runtime => {
    await f.exec(`GRANT UPDATE(status) ON public.system_form TO "${runtime.role}"`);
    const column=mode==='ensure'?'ensure_id':'brand_id', selected=mode==='ensure'?"NEW.ensure_id='201'":'NEW.brand_id=103';
    await f.exec(`CREATE FUNCTION owned_form_later_author() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE changed integer; BEGIN IF NEW.id=80 AND ${selected} THEN UPDATE public.system_form SET status=0 WHERE id=401; GET DIAGNOSTICS changed=ROW_COUNT; IF changed<>1 THEN RAISE EXCEPTION 'owned form trigger did not execute'; END IF; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_form_later_author AFTER UPDATE OF ${column} ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_form_later_author()`);
    wiring.container=runtime.container;
    const author=mode==='ensure'?{ensure_id:[201]}:{brand_id:[101,102,103]};
    // Positive control: the same real writer can execute the adverse trigger
    // when no form binding is being authored; then restore only its fixture row.
    const control=await request('POST','/product/product/80',f.body(author));expect(control.status,control.msg).toBe(200);
    expect((await f.db.select().from(systemForm).where(eq(systemForm.id,401)))[0].status).toBe(0);
    await f.db.update(systemForm).set({status:1}).where(eq(systemForm.id,401));const before=await f.snapshot();
    expect((await request('POST','/product/product/80',f.body({system_form_id:401,...author}))).status).toBe(409);
    expect(await f.snapshot()).toEqual(before);
  }));
  it.each(['disabled','deleted','definition','name','product','relation'] as const)('settles an executable deferred %s mutation then rejects and rolls back every row', async mode => f.withWriter(async runtime => {
    await f.exec(`GRANT UPDATE(status,is_del,value,name) ON public.system_form TO "${runtime.role}"`);
    const mutation=mode==='disabled'?"UPDATE public.system_form SET status=0 WHERE id=401":mode==='deleted'?"UPDATE public.system_form SET is_del=1 WHERE id=401"
      :mode==='definition'?"UPDATE public.system_form SET value='[{\"id\":\"late\",\"name\":\"texts\",\"titleConfig\":{\"value\":\"changed\"}}]' WHERE id=401"
      :mode==='name'?"UPDATE public.system_form SET name='late changed' WHERE id=401":mode==='product'?"UPDATE public.store_product SET custom_form='late injected answer' WHERE id=80"
      :"INSERT INTO public.store_product_relation(product_id,type,relation_id,status) VALUES(80,4,999,1)";
    await f.exec(`CREATE FUNCTION owned_form_deferred() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=80 AND NEW.system_form_id=401 AND pg_trigger_depth()=1 THEN ${mutation}; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER owned_form_deferred AFTER UPDATE ON public.store_product DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION owned_form_deferred()`);
    wiring.container=runtime.container;const before=await f.snapshot();
    expect((await request('POST','/product/product/80',f.body({system_form_id:401}))).status).toBe(409);expect(await f.snapshot()).toEqual(before);
  }));
  it('retains an originally disabled assurance beside a new active item after the last form author without permitting removed items to rebind', async () => f.withWriter(async runtime => {
    await f.exec('UPDATE public.store_product_ensure SET status=0 WHERE id=41');wiring.container=runtime.container;
    const saved=await request('POST','/product/product/80',f.body({system_form_id:401,ensure_id:[41,201]}));expect(saved.status,saved.msg).toBe(200);
    expect(await root()).toMatchObject({systemFormId:401,ensureId:'41,201'});
    const read=await request('GET','/product/product/80');expect(read.data).toMatchObject({system_form_id:401,ensure_id:[41,201],ensure_selection:{consistent:true,available:false,retained_ids:[41]}});
    const removed=await request('POST','/product/product/80',f.body({system_form_id:401,ensure_id:[201]}));expect(removed.status,removed.msg).toBe(200);
    await unchanged(async()=>{expect((await request('POST','/product/product/80',f.body({system_form_id:401,ensure_id:[41,201]}))).status).toBe(400);});
  }));
  it.each([{mode:'ensure-disabled'},{mode:'ensure-moved'},{mode:'brand-hidden'},{mode:'brand-moved'}] as const)(
    'rejects a last form author changing admitted $mode qualification after a proven executable positive control', async ({mode}) => f.withWriter(async runtime => {
    // Only this adverse owned fixture gives the actual trigger these columns.
    // The minimum runtime role and production grants remain unchanged.
    await f.exec(`GRANT UPDATE(status,relation_id) ON public.store_product_ensure TO "${runtime.role}";
      GRANT UPDATE(is_show,store_id) ON public.store_brand TO "${runtime.role}"`);
    const mutation=mode==='ensure-disabled'?"UPDATE public.store_product_ensure SET status=0 WHERE id=201"
      :mode==='ensure-moved'?"UPDATE public.store_product_ensure SET relation_id=8 WHERE id=201"
      :mode==='brand-hidden'?"UPDATE public.store_brand SET is_show=0 WHERE id=103"
      :"UPDATE public.store_brand SET store_id=8 WHERE id=103";
    await f.exec(`CREATE FUNCTION owned_form_last_author_catalog() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE changed integer; BEGIN IF NEW.id=80 AND NEW.system_form_id=401 THEN ${mutation}; GET DIAGNOSTICS changed=ROW_COUNT; IF changed<>1 THEN RAISE EXCEPTION 'owned last form catalog mutation did not execute'; END IF; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_form_last_author_catalog AFTER UPDATE OF system_form_id ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_form_last_author_catalog()`);
    wiring.container=runtime.container;
    // The target catalog is not selected by this first request. Its successful
    // real save proves the trigger can execute under this exact runtime role.
    const control=await request('POST','/product/product/80',f.body({system_form_id:401}));expect(control.status,control.msg).toBe(200);
    if(mode.startsWith('ensure')){
      const [changed]=await f.exec('SELECT status,relation_id FROM public.store_product_ensure WHERE id=201');
      expect(changed).toMatchObject(mode==='ensure-disabled'?{status:0,relation_id:0}:{status:1,relation_id:8});
      await f.exec('UPDATE public.store_product_ensure SET status=1,relation_id=0 WHERE id=201');
    }else{
      const [changed]=await f.exec('SELECT is_show,store_id FROM public.store_brand WHERE id=103');
      expect(changed).toMatchObject(mode==='brand-hidden'?{is_show:0,store_id:0}:{is_show:1,store_id:8});
      await f.exec('UPDATE public.store_brand SET is_show=1,store_id=0 WHERE id=103');
    }
    const before=await f.snapshot(),author=mode.startsWith('ensure')?{ensure_id:[201]}:{brand_id:[101,102,103]};
    const saved=await request('POST','/product/product/80',f.body({system_form_id:401,...author}));
    expect(saved.status,saved.msg).toBe(409);expect(await f.snapshot()).toEqual(before);
  }));
  it('connects Supplier authoring to real Customer JWT confirmation creation required answers immutable snapshot and explicit close', async () => {
    const checkout=await supplierSystemFormCheckoutFixture(f);
    try {
      await f.withWriter(async runtime=>{wiring.container=runtime.container;const saved=await request('POST','/product/product/80',f.body({system_form_id:401}));expect(saved.status,saved.msg).toBe(200);});
      // Simulate the distinct Admin review step; Supplier saves never self-approve.
      await f.db.update(storeProduct).set({isShow:1,isVerify:1}).where(eq(storeProduct.id,80));
      wiring.container=f.container;
      const customer=async(path:string,body:unknown)=>{
        const response=await app.request('/api'+path,{method:'POST',headers:{Authorization:'Bearer '+checkout.token,'Content-Type':'application/json'},body:JSON.stringify(body)},f.env);
        return response.json<{status:number;msg:string;data:any}>();
      };
      const cart=await checkout.createCart(), input={cartIds:[cart],addressId:11,shippingType:1,useIntegral:false};
      const confirm=await customer('/order/confirm',input);expect(confirm.status,confirm.msg).toBe(200);
      const before={...await checkout.snapshot(),answers:await f.db.select().from(systemFormData),lines:await f.db.select().from(storeOrderCartInfo)};
      const bad=await customer('/order/create/'+confirm.data.orderKey,{...input,quoteToken:confirm.data.quoteToken,customForm:[]});
      expect(bad.status).toBe(400);expect(bad.data).toMatchObject({errorCode:'ORDER_FORM_REJECTED',orderKey:confirm.data.orderKey});
      expect({...await checkout.snapshot(),answers:await f.db.select().from(systemFormData),lines:await f.db.select().from(storeOrderCartInfo)}).toEqual(before);
      const answers=[{...supplierSystemFormTemplate()[0],titleConfig:{value:'伪造标题'},value:'真实客户补充信息'}];
      const good=await customer('/order/create/'+confirm.data.orderKey,{...input,quoteToken:confirm.data.quoteToken,customForm:answers});expect(good.status,good.msg).toBe(200);
      const [order]=await f.db.select().from(storeOrder).where(eq(storeOrder.orderId,good.data.orderId));
      expect(order).toMatchObject({uid:11,paid:0,totalNum:1,customForm:expect.any(String)});
      expect(JSON.parse(order.customForm!)[0]).toMatchObject({id:'message',titleConfig:{value:'收件补充信息'},value:'真实客户补充信息'});
      expect(await f.db.select().from(systemFormData)).toHaveLength(1);expect(await f.db.select().from(storeOrderCartInfo)).toHaveLength(1);
      await f.withWriter(async runtime=>{wiring.container=runtime.container;const saved=await request('POST','/product/product/80',f.body({system_form_id:0}));expect(saved.status,saved.msg).toBe(200);});
      expect((await root()).customForm).toBe('[{"legacy":"原字节必须保留"}]');
      await f.db.update(storeProduct).set({isShow:1,isVerify:1}).where(eq(storeProduct.id,80));wiring.container=f.container;
      const next=await checkout.createCart(), secondInput={...input,cartIds:[next]}, secondConfirm=await customer('/order/confirm',secondInput);expect(secondConfirm.status,secondConfirm.msg).toBe(200);
      const second=await customer('/order/create/'+secondConfirm.data.orderKey,{...secondInput,quoteToken:secondConfirm.data.quoteToken,customForm:[]});expect(second.status,second.msg).toBe(200);
      const orders=await f.db.select().from(storeOrder).orderBy(asc(storeOrder.id));expect(orders).toHaveLength(2);expect(orders[0].customForm).toBe(order.customForm);expect(orders[1].customForm).toBe('[]');
      expect(await f.db.select().from(systemFormData)).toHaveLength(1);expect(checkout.sequence()).toBe(3);
    } finally { await checkout.close(); }
  },60000);
});
