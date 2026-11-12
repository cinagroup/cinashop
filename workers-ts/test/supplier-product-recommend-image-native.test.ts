import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductDescription, systemAdmin, systemAttachment, systemRole } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { SUPPLIER_COPY_FIELDS } from '@/services/supplier/SupplierProductCopySource';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { SupplierProductManagementService } from '@/services/supplier/SupplierProductManagementService';
import { supplierProductRecommendImageFixture } from './helpers/supplierProductRecommendImage';
import { supplierProductSchedulePassword } from './helpers/supplierProductSchedule';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const wiring = vi.hoisted(() => ({ container: null as Container | null, moderator: null as Container | null }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => wiring.container,
  createAdminDatabaseSession: () => {
    if (!wiring.moderator) throw Error('Missing independently commissioned owned Admin LOGIN');
    return { container: wiring.moderator, close: async () => {} };
  },
}));
const app = createApp();
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
type Envelope = { status: number; msg: string; data: any };

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier ordinary recommendation image author through real App JWT and owned PG16 publication', () => {
  let f: Awaited<ReturnType<typeof supplierProductRecommendImageFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned recommendation-image scenario forbids outbound I/O'));
    f = await supplierProductRecommendImageFixture(); wiring.container = f.container;
  }, 30000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { await f?.close(); wiring.container = null; wiring.moderator = null; vi.restoreAllMocks(); }
  }, 30000);
  async function request(method: string, path: string, body?: unknown,
    actor: keyof typeof f.tokens | 'anonymous' = 'manager', token?: string) {
    const response = await app.request('/supplierapi' + path, { method, headers: {
      ...(actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + (token ?? f.tokens[actor]) }),
      'X-Supplier-Id': '8', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store');
    return response.json<Envelope>();
  }
  async function unchanged(work: () => Promise<unknown>) {
    const before = await f.snapshot(), sequences = await f.sequences(); await work();
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
  }
  async function rollback(work: () => Promise<unknown>) {
    // A late rollback preserves every business row, not PostgreSQL sequences.
    const before = await f.snapshot(); await work(); expect(await f.snapshot()).toEqual(before);
  }
  async function preserved(before: Awaited<ReturnType<typeof f.snapshot>>, previous: Awaited<ReturnType<typeof f.product>>, id = 80) {
    const after = await f.product(id), current = await f.snapshot();
    for (const key of ['image','sliderImage','price','settlePrice','cost','otPrice','vipPrice','stock','sales','spu','addTime',
      'autoOnTime','autoOffTime','brandId','brandCom','ensureId','specsId','specs','labelId','commandWord','customForm','systemFormId'] as const) {
      expect(after[key], key).toEqual(previous[key]);
    }
    const authored = new Set(['store_product','store_product_attr','store_product_attr_result','store_product_relation']);
    for (const name of Object.keys(before)) if (!authored.has(name)) expect(current[name], name).toEqual(before[name]);
    expect(current.store_product.filter(item => item.row.id !== id)).toEqual(before.store_product.filter(item => item.row.id !== id));
    expect(current.store_product_relation.filter(item => item.row.product_id === id && item.row.type !== 1))
      .toEqual(before.store_product_relation.filter(item => item.row.product_id === id && item.row.type !== 1));
  }
  async function moderate() {
    const response = await app.request('/adminapi/product/product/set_verify/80', { method: 'POST',
      headers: { Authorization: 'Bearer ' + f.adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_verify: 1, is_show: 1, refusal: '', auto_on_time: '' }) }, f.env);
    const result = await response.json<Envelope>(); expect(result.status, result.msg).toBe(200);
  }
  async function catalogue() {
    const response = await app.request('/api/products?ids=80&page=1&limit=10', {}, f.env);
    const result = await response.json<Envelope>(); expect(result.status, result.msg).toBe(200); return result.data;
  }

  it('projects a canonical private recommendation plus real short-lived preview through a SELECT-only viewer without exposing customer answers', async () => f.withReader(async runtime => {
    await f.db.update(storeProduct).set({ recommendImage: 'https://old.invalid/api/assets/31?expires=1&signature=old' }).where(eq(storeProduct.id, 80));
    wiring.container = runtime.container;
    await unchanged(async () => {
      const result = await request('GET', '/product/product/80', undefined, 'viewer'); expect(result.status, result.msg).toBe(200);
      expect(result.data.recommend_image).toBe('/api/assets/31');
      const preview = result.data.media.previews['/api/assets/31']; expect(preview.status).toBe('ready'); expect(preview.expires_at).toBeGreaterThan(Date.now()/1000);
      const image = await app.request(preview.src, {}, f.env); expect(image.status).toBe(200); expect(image.headers.get('content-type')).toBe('image/png');
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect(JSON.stringify(result.data)).not.toContain('UNCHANGED-CUSTOMER-ANSWER'); expect(result.data).not.toHaveProperty('custom_form');
    });
    const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS independent,
      has_any_column_privilege(current_user,'store_product','UPDATE') AS product_write,
      has_table_privilege(current_user,'system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_access`);
    expect(rights).toEqual({ independent: true, product_write: false, answers_access: false });
  }));

  it.each([0,1,3])('saves and explicitly clears only recommendation metadata for ordinary fulfillment type %i', async type => {
    const id = type === 1 ? 81 : 80;
    if (type === 3) {
      await f.db.update(storeProduct).set({ productType: 3 }).where(eq(storeProduct.id, id));
      await f.db.update(storeProductAttrValue).set({ productType: 3 }).where(eq(storeProductAttrValue.productId, id));
    }
    await f.withWriter(async runtime => {
      wiring.container = runtime.container; const body = await f.body({}, id), before = await f.snapshot(), previous = await f.product(id);
      expect((await request('POST', '/product/product/' + id, { ...body, recommend_image: '/api/assets/31' })).status).toBe(200);
      expect(await f.product(id)).toMatchObject({ recommendImage: '/api/assets/31', isShow: 0, isVerify: 0 }); await preserved(before, previous, id);
      const saved = await request('GET', '/product/product/' + id); expect(saved.data.recommend_image).toBe('/api/assets/31');
      expect((await request('POST', '/product/product/' + id, { ...body, recommend_image: '' })).status).toBe(200);
      expect(await f.product(id)).toMatchObject({ recommendImage: '', image: previous.image }); await preserved(before, previous, id);
      const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS independent,
        has_column_privilege(current_user,'system_attachment','att_id','UPDATE') AS metadata_lock,
        has_column_privilege(current_user,'system_attachment','name','UPDATE') AS metadata_edit,
        has_table_privilege(current_user,'system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_access`);
      expect(rights).toEqual({ independent: true, metadata_lock: true, metadata_edit: false, answers_access: false });
    });
  });

  it('creates a normal four-SKU product with a canonical recommendation without extending mature copy fields', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const body = await f.body({ recommend_image: 'https://old.invalid/kefuapi/assets/31?expires=1&signature=old' });
    body.attrs = (body.attrs as Record<string, unknown>[]).map(row => ({ ...row, id: undefined, unique: undefined }));
    const created = await request('POST', '/product/product', body); expect(created.status, created.msg).toBe(200);
    expect(await f.product(created.data.id)).toMatchObject({ type: 2, relationId: 7, recommendImage: '/api/assets/31', isShow: 0, isVerify: 0 });
    expect(SUPPLIER_COPY_FIELDS).not.toContain('recommend_image');
  }));

  it.each([null, false, 0, {}, [], 'javascript:alert(1)', 'http://invalid.test/r.png', '//invalid.test/r.png',
    'https://name:secret@invalid.test/r.png', '/api/assets/0', '/api/assets/2147483648', '/api%2fassets/31', '/'+'x'.repeat(256)])
  ('rejects malformed recommendation intent %j before rows or sequences change', async value => f.withWriter(async runtime => {
    wiring.container = runtime.container; const body = await f.body({ recommend_image: value });
    await unchanged(async () => expect((await request('POST','/product/product/80',body)).status).toBe(400));
  }));

  it.each(['/api/assets/32','/api/assets/999'])('rejects unavailable or foreign recommendation %s even when historical bytes already match', async reference => f.withWriter(async runtime => {
    await f.db.update(storeProduct).set({ recommendImage: reference }).where(eq(storeProduct.id,80)); wiring.container=runtime.container;
    const body=await f.body({recommend_image:reference}); await unchanged(async()=>expect((await request('POST','/product/product/80',body)).status).toBe(400));
  }));

  it.each([
    { fileType: 2 }, { moduleType: 2 }, { type: 3 }, { imageType: 0 },
    { name: 'attachments/supplier/8/borrowed.png' }, { attType: 'text/html' }, { attDir: '/api/assets/32' },
  ])('rejects contradictory real private image metadata %j without writes', async patch => f.withWriter(async runtime => {
    await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId,31)); wiring.container=runtime.container;
    const body=await f.body({recommend_image:'/api/assets/31'}); await unchanged(async()=>expect((await request('POST','/product/product/80',body)).status).toBe(400));
  }));

  it('keeps malformed and foreign historical recommendations readable and omittable, and permits explicit clear', async () => f.withWriter(async runtime => {
    wiring.container=runtime.container;
    for(const reference of ['javascript:legacy()', '/api/assets/999', '/api/assets/32']) {
      await f.db.update(storeProduct).set({recommendImage:reference}).where(eq(storeProduct.id,80));
      const read=await request('GET','/product/product/80');expect(read.status).toBe(200);expect(read.data.media.previews[reference]).toEqual({status:'unavailable',expires_at:null});
      const body=await f.body();expect((await request('POST','/product/product/80',body)).status).toBe(200);expect((await f.product()).recommendImage).toBe(reference);
      expect((await request('POST','/product/product/80',{...body,recommend_image:''})).status).toBe(200);expect((await f.product()).recommendImage).toBe('');
    }
  }));

  it('does not mask a real attachment SELECT denial as an unavailable historical image', async () => f.withReader(async runtime => {
    await f.db.update(storeProduct).set({recommendImage:'/api/assets/31'}).where(eq(storeProduct.id,80));
    await f.exec(`REVOKE SELECT ON public.system_attachment FROM "${runtime.role}"`);wiring.container=runtime.container;
    await unchanged(async()=>{const read=await request('GET','/product/product/80',undefined,'viewer');expect(read.status).not.toBe(200);expect(read.data).toBeNull();});
  }));

  it('denies anonymous viewer foreign denied expired and changed-password authors without business or sequence writes', async () => f.withWriter(async runtime => {
    wiring.container=runtime.container;const body=await f.body({recommend_image:'/api/assets/31'});
    for(const actor of ['anonymous','viewer','other','denied']as const)await unchanged(async()=>expect((await request('POST','/product/product/80',body,actor)).status).not.toBe(200));
    const expired=(await createToken(21,'supplier',md5(supplierProductSchedulePassword),f.env.APP_KEY,'cinashop',Math.floor(Date.now()/1000)-8*86400)).token;
    await unchanged(async()=>expect((await request('POST','/product/product/80',body,'manager',expired)).status).not.toBe(200));
    await f.db.update(systemAdmin).set({pwd:'changed-password'}).where(eq(systemAdmin.id,21));
    await unchanged(async()=>expect((await request('POST','/product/product/80',body)).status).not.toBe(200));
  }));

  it('never targets recommend_image on omission or undefined while an UPDATE OF tripwire is active', async () => f.withWriter(async runtime => {
    wiring.container=runtime.container;const body=await f.body();
    await f.exec("CREATE FUNCTION owned_recommend_omitted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'recommend_image entered SQL target'; END $$; CREATE TRIGGER owned_recommend_omitted BEFORE UPDATE OF recommend_image ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_recommend_omitted()");
    await expect(f.db.update(storeProduct).set({recommendImage:'/positive-control.png'}).where(eq(storeProduct.id,80))).rejects.toThrow();
    const previous=(await f.product()).recommendImage;expect((await request('POST','/product/product/80',body)).status).toBe(200);
    await new SupplierProductManagementService(runtime.container,f.env).saveProduct(7,80,{...body,recommend_image:undefined});
    expect((await f.product()).recommendImage).toBe(previous);
  }));

  it('preserves a concurrent independently commissioned Admin image update while the omitted Supplier save waits on its real product row', async () => f.withWriter(async runtime => f.withAdminImageWriter(async admin => {
    const body=await f.body(),held=signal(),release=signal();wiring.container=runtime.container;
    const holding=withTx(admin.container,async tx=>{await tx.update(storeProduct).set({recommendImage:'/owned-media/admin-fresh.png'}).where(eq(storeProduct.id,80));held.resolve();await release.promise;});
    let saving:Promise<unknown>|undefined;
    try{await held.promise;saving=outcome(request('POST','/product/product/80',body));await waitForFinanceBlock(f.db,runtime.pid,admin.pid);release.resolve();await holding;expect(await saving).toMatchObject({ok:true,value:{status:200}});expect((await f.product()).recommendImage).toBe('/owned-media/admin-fresh.png');}
    finally{release.resolve();await holding;await saving;}
  })));

  it('refuses an actual private-metadata writer lock before touching business rows or sequences', async () => f.withWriter(async runtime => f.withPeer!(async metadata => {
    const body=await f.body({recommend_image:'/api/assets/31'}),held=signal(),release=signal();wiring.container=runtime.container;
    const holding=withTx(createContainerFromDb(metadata.db),async tx=>{await tx.update(systemAttachment).set({realName:'locked positive control'}).where(eq(systemAttachment.attId,31));held.resolve();await release.promise;throw Error('owned metadata rollback');}).catch(error=>{expect(error.message).toBe('owned metadata rollback');});
    try{await held.promise;await unchanged(async()=>expect((await request('POST','/product/product/80',body)).status).not.toBe(200));}
    finally{release.resolve();await holding;}
  })));

  it.each(['skip','rewrite']as const)('rejects executable main recommendation %s with positive control and whole-business rollback', async mode => f.withWriter(async runtime => {
    const mutation=mode==='skip'?'RETURN NULL;':"NEW.recommend_image='/owned-media/rewritten.png'; RETURN NEW;";
    await f.exec(`CREATE FUNCTION owned_recommend_main() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=80 THEN ${mutation} END IF; RETURN NEW; END $$; CREATE TRIGGER owned_recommend_main BEFORE UPDATE OF recommend_image ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_recommend_main()`);
    const marker=Error('owned main control rollback');
    await expect(f.db.transaction(async tx=>{const changed=await tx.update(storeProduct).set({recommendImage:'/api/assets/31'}).where(eq(storeProduct.id,80)).returning();if(mode==='skip')expect(changed).toHaveLength(0);else expect(changed[0].recommendImage).toBe('/owned-media/rewritten.png');throw marker;})).rejects.toBe(marker);
    wiring.container=runtime.container;const body=await f.body({recommend_image:'/api/assets/31'});
    await rollback(async()=>expect((await request('POST','/product/product/80',body)).status).toBe(409));
  }));

  it.each(['recommendation','metadata']as const)('rejects a later description author changing %s with executable positive control', async target => f.withWriter(async runtime => {
    const mutation=target==='recommendation'?"UPDATE public.store_product SET recommend_image='/owned-media/late.png' WHERE id=80;":"UPDATE public.system_attachment SET relation_id=8 WHERE att_id=31;";
    await f.exec(`CREATE FUNCTION owned_recommend_later() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN IF NEW.product_id=80 THEN ${mutation} END IF; RETURN NEW; END $$; CREATE TRIGGER owned_recommend_later AFTER INSERT OR UPDATE ON public.store_product_description FOR EACH ROW EXECUTE FUNCTION owned_recommend_later()`);
    const marker=Error('owned later control rollback');
    await expect(f.db.transaction(async tx=>{await tx.update(storeProductDescription).set({description:'positive-control'}).where(eq(storeProductDescription.productId,80));if(target==='recommendation')expect((await tx.select().from(storeProduct).where(eq(storeProduct.id,80)))[0].recommendImage).toBe('/owned-media/late.png');else expect((await tx.select().from(systemAttachment).where(eq(systemAttachment.attId,31)))[0].relationId).toBe(8);throw marker;})).rejects.toBe(marker);
    wiring.container=runtime.container;const body=await f.body({recommend_image:'/api/assets/31'});
    await rollback(async()=>expect((await request('POST','/product/product/80',body)).status).toBe(409));
  }));

  it.each(['recommendation','metadata']as const)('settles a real deferred trigger changing %s before its final proof and rolls back', async target => f.withWriter(async runtime => {
    const mutation=target==='recommendation'?"UPDATE public.store_product SET recommend_image='/owned-media/deferred.png' WHERE id=80;":"UPDATE public.system_attachment SET name='attachments/supplier/7/changed.png' WHERE att_id=31;";
    await f.exec(`CREATE FUNCTION owned_recommend_deferred() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN IF NEW.id=80 AND NEW.recommend_image='/api/assets/31' THEN ${mutation} END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER owned_recommend_deferred AFTER UPDATE ON public.store_product DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION owned_recommend_deferred()`);
    const marker=Error('owned deferred control rollback');
    await expect(f.db.transaction(async tx=>{await tx.update(storeProduct).set({recommendImage:'/api/assets/31'}).where(eq(storeProduct.id,80));await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);if(target==='recommendation')expect((await tx.select().from(storeProduct).where(eq(storeProduct.id,80)))[0].recommendImage).toBe('/owned-media/deferred.png');else expect((await tx.select().from(systemAttachment).where(eq(systemAttachment.attId,31)))[0].name).toBe('attachments/supplier/7/changed.png');throw marker;})).rejects.toBe(marker);
    wiring.container=runtime.container;const body=await f.body({recommend_image:'/api/assets/31'});
    await rollback(async()=>expect((await request('POST','/product/product/80',body)).status).toBe(409));
  }));

  it('supports all existing explicit authors together and keeps the expected final recommendation', async () => f.withWriter(async runtime => {
    wiring.container=runtime.container;const body=await f.body({recommend_image:'/api/assets/31',store_label_id:[31],brand_id:[104,105],ensure_id:[201],specs_id:301,specs:[{name:'材质',value:'棉'}],system_form_id:401,auto_on_time:Math.floor(Date.now()/1000)+3600});
    const saved=await request('POST','/product/product/80',body);expect(saved.status,saved.msg).toBe(200);
    expect(await f.product()).toMatchObject({recommendImage:'/api/assets/31',brandId:105,brandCom:'104,105',ensureId:'201',specsId:301,systemFormId:401,storeLabelId:'31',isShow:0,isVerify:0});
  }));

  it('revalidates real Supplier authority after a later description trigger revokes the role', async () => f.withWriter(async runtime => {
    await f.exec("CREATE FUNCTION owned_recommend_revoke() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN IF NEW.product_id=80 THEN UPDATE public.system_role SET rules='supplier.product.view' WHERE id=21; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_recommend_revoke AFTER INSERT OR UPDATE ON public.store_product_description FOR EACH ROW EXECUTE FUNCTION owned_recommend_revoke()");
    const marker=Error('owned revoke control rollback');await expect(f.db.transaction(async tx=>{await tx.update(storeProductDescription).set({description:'positive-control'}).where(eq(storeProductDescription.productId,80));expect((await tx.select().from(systemRole).where(eq(systemRole.id,21)))[0].rules).toBe('supplier.product.view');throw marker;})).rejects.toBe(marker);
    wiring.container=runtime.container;const body=await f.body({recommend_image:'/api/assets/31'});await rollback(async()=>expect((await request('POST','/product/product/80',body)).status).not.toBe(200));
  }));

  it('saves through Supplier JWT then requires a separate minimum Admin review before public products signs and serves the recommendation', async () => {
    const before=await f.snapshot(),previous=await f.product();
    await f.withWriter(async runtime=>{wiring.container=runtime.container;const result=await request('POST','/product/product/80',await f.body({recommend_image:'/api/assets/31'}));expect(result.status,result.msg).toBe(200);});
    await preserved(before,previous);
    await f.withPublicReader(async reader=>f.withModerator(async moderator=>{
      wiring.container=reader.container;wiring.moderator=moderator.container;
      expect((await catalogue()).list).toEqual([]);await moderate();
      expect((await f.snapshot()).store_product_attr_value).toEqual(before.store_product_attr_value);
      const listed=await catalogue();expect(listed.count).toBe(1);const product=listed.list[0];
      expect(product.id).toBe(80);expect(product.image).toBe(previous.image);expect(product.recommend_image).toMatch(/^\/api\/assets\/31\?expires=/);
      const asset=await app.request(product.recommend_image,{},f.env);expect(asset.status).toBe(200);expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect((await f.product()).recommendImage).toBe('/api/assets/31');expect(JSON.stringify(await f.snapshot())).not.toContain('signature=');
      const [rights]=await moderator.db.execute(sql`SELECT current_user=session_user AS independent,
        has_column_privilege(current_user,'store_product','is_verify','UPDATE') AS review,
        has_column_privilege(current_user,'store_product','recommend_image','UPDATE') AS image_edit,
        has_column_privilege(current_user,'store_product_attr_value','price','UPDATE') AS sku_edit,
        has_table_privilege(current_user,'system_admin','UPDATE') AND has_table_privilege(current_user,'system_role','UPDATE')
          AND has_table_privilege(current_user,'store_product_attr_value','UPDATE') AND has_table_privilege(current_user,'store_cart','UPDATE')
          AND has_table_privilege(current_user,'store_product_relation','UPDATE') AS required_table_barriers,
        has_table_privilege(current_user,'store_order','SELECT,INSERT,UPDATE,DELETE') AS orders_access,
        has_table_privilege(current_user,'system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_access`);
      expect(rights).toEqual({independent:true,review:true,image_edit:false,sku_edit:true,required_table_barriers:true,orders_access:false,answers_access:false});
      // A later metadata revocation is read as unavailable, never re-signed.
      await f.db.update(systemAttachment).set({relationId:8}).where(eq(systemAttachment.attId,31));
      const revoked=await catalogue();expect(revoked.list[0].recommend_image).toBe('');expect(revoked.list[0].image).toBe(previous.image);
      await f.withWriter(async writer=>{wiring.container=writer.container;const cleared=await request('POST','/product/product/80',await f.body({recommend_image:''}));expect(cleared.status,cleared.msg).toBe(200);});
      wiring.container=reader.container;expect((await catalogue()).list).toEqual([]);await moderate();
      const cleared=await catalogue();expect(cleared.list[0]).toMatchObject({id:80,recommend_image:'',image:previous.image});
      const after=await f.snapshot();for(const name of ['store_product_attr_value','store_order','store_order_cart_info','system_form_data'])expect(after[name],name).toEqual(before[name]);
    }));
  });

  it.each(['/'+'x'.repeat(255),'https://images.invalid/'+'x'.repeat(233)])('publishes an exact256-character recommendation %s while other picture callers retain255', async reference => {
    expect(reference).toHaveLength(256);
    await f.withWriter(async writer=>{wiring.container=writer.container;const result=await request('POST','/product/product/80',await f.body({recommend_image:reference}));expect(result.status,result.msg).toBe(200);});
    await f.withPublicReader(async reader=>f.withModerator(async moderator=>{wiring.container=reader.container;wiring.moderator=moderator.container;await moderate();expect((await catalogue()).list[0].recommend_image).toBe(reference);
      expect(await publicProductPictures(reader.db,[{image:reference,type:2,relationId:7}])).toEqual(['']);
    }));
  });
});

// Price switches use the same ordinary App LOGIN, current Supplier JWT and
// complete author as the preceding publication scenarios. No synthetic auth.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier member price and independent commission author',()=>{
  let f: Awaited<ReturnType<typeof supplierProductRecommendImageFixture>>;
  beforeEach(async()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Isolated Supplier pricing forbids providers'));
    f=await supplierProductRecommendImageFixture();wiring.container=f.container;},30_000);
  afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{await f?.close();wiring.container=null;wiring.moderator=null;vi.restoreAllMocks();}},30_000);
  const call=async(id:number,body?:object,actor:keyof typeof f.tokens='manager')=>{
    const response=await app.request('/supplierapi/product/product/'+id,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+f.tokens[actor],
      'X-Supplier-Id':'8',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})},f.env);
    return response.json<Envelope>();
  };
  it('saves and reads both switches, preserves them when omitted and clears disabled commission before validation',async()=>f.withWriter(async runtime=>{
    wiring.container=runtime.container;const body=await f.body({is_sub:[0,1]}),before=await f.snapshot();
    const saved=await call(80,body);expect(saved.status,saved.msg).toBe(200);
    expect(await f.product()).toMatchObject({isVip:1,isSub:1,isShow:0,isVerify:0});
    const detail=await call(80);expect(detail.status,detail.msg).toBe(200);expect(detail.data.price_selection).toEqual({version:1,is_vip:1,is_sub:1});
    const skus=await f.rows(),stock=skus.map(s=>({id:s.id,stock:s.stock,sales:s.sales,sumStock:s.sumStock,unique:s.unique}));
    expect((await call(80,await f.body())).status).toBe(200);expect(await f.product()).toMatchObject({isVip:1,isSub:1});
    const off=await f.body({is_sub:[]});off.attrs=(off.attrs as any[]).map(s=>({...s,brokerage:'discarded-invalid',brokerage_two:999999}));
    const cleared=await call(80,off);expect(cleared.status,cleared.msg).toBe(200);
    expect(await f.product()).toMatchObject({isVip:0,isSub:0});
    const after=await f.rows();expect(after.map(s=>({id:s.id,stock:s.stock,sales:s.sales,sumStock:s.sumStock,unique:s.unique}))).toEqual(stock);
    expect(after.filter(s=>s.isRetired===0).every(s=>s.brokerage==='0.00'&&s.brokerageTwo==='0.00')).toBe(true);
    const current=await f.snapshot();for(const name of ['store_order','store_order_cart_info','system_form_data','store_product_virtual'])expect(current[name],name).toEqual(before[name]);
  }));
  it.each([0,1,3])('authors member pricing without enabling independent commission for fulfillment type %i',async type=>{
    const id=type===1?81:80;if(type===3){await f.db.update(storeProduct).set({productType:3}).where(eq(storeProduct.id,id));
      await f.db.update(storeProductAttrValue).set({productType:3}).where(eq(storeProductAttrValue.productId,id));}
    await f.withWriter(async runtime=>{wiring.container=runtime.container;const body=await f.body({is_sub:[0]},id);
      body.attrs=(body.attrs as any[]).map(s=>({...s,vip_price:'7.50',brokerage:'ignored',brokerage_two:999999}));
      const result=await call(id,body);expect(result.status,result.msg).toBe(200);
      expect(await f.product(id)).toMatchObject({productType:type,isVip:1,isSub:0,vipPrice:'7.50'});
      expect((await call(id)).data.price_selection).toEqual({version:1,is_vip:1,is_sub:0});});
  });
  it.each(['flags','sku','actor'])('rolls back the complete product on deferred %s tampering',async target=>{
    const mutation=target==='flags'?'UPDATE store_product SET is_vip=0 WHERE id=NEW.product_id;':target==='sku'?'UPDATE store_product_attr_value SET brokerage=9 WHERE product_id=NEW.product_id AND is_retired=0;':'UPDATE system_admin SET status=0 WHERE id=21;';
    await f.exec(`CREATE FUNCTION test_supplier_price_drift() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN ${mutation} RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER test_supplier_price_drift AFTER INSERT OR UPDATE ON store_product_description DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_supplier_price_drift()`);
    await f.withWriter(async runtime=>{wiring.container=runtime.container;const before=await f.snapshot(),result=await call(80,await f.body({is_sub:[0,1]}));
      expect(result.status).not.toBe(200);expect(result.msg).toMatch(target==='actor'?/权限已变化/:/保存核对失败/);expect(await f.snapshot()).toEqual(before);});
  });
  it('requires current management authority and refuses foreign ownership or zero enabled member prices without writes',async()=>f.withWriter(async runtime=>{
    wiring.container=runtime.container;const body=await f.body({is_sub:[0,1]});
    for(const actor of ['viewer','denied','other'] as const){const before=await f.snapshot(),result=await call(80,body,actor);expect(result.status).not.toBe(200);expect(await f.snapshot()).toEqual(before);}
    const before=await f.snapshot();expect((await call(90,body)).status).not.toBe(200);expect(await f.snapshot()).toEqual(before);
    const invalid={...body,attrs:(body.attrs as any[]).map(s=>({...s,vip_price:'0.00'}))};const rejected=await call(80,invalid);
    expect(rejected.status).not.toBe(200);expect(rejected.msg).toContain('所有SKU会员价必须大于0');expect(await f.snapshot()).toEqual(before);
  }));
  it('creates new complete multi-SKU products with actual authenticated pricing options',async()=>f.withWriter(async runtime=>{
    wiring.container=runtime.container;const body=await f.body({is_sub:[0,1]});body.attrs=(body.attrs as any[]).map(({id,unique,...sku})=>sku);
    const result=await call(0,body);expect(result.status,result.msg).toBe(200);const id=Number(result.data.id);expect(id).not.toBe(80);
    expect(await f.product(id)).toMatchObject({type:2,relationId:7,isVip:1,isSub:1,isShow:0,isVerify:0});
    expect((await call(id)).data.price_selection).toEqual({version:1,is_vip:1,is_sub:1});
  }));
});

import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runRoutinePaymentRuntimeInstallation } from '@/migrations/routinePaymentRuntime';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { applyStoreOrderBalancePayment } from '@/services/order/StoreOrderPayService';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { StoreCartService } from '@/services/order/StoreCartService';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { user as pricingUser, systemSupplier as pricingSupplier, storeProductCategory as pricingCategory,
  systemConfig as pricingConfig, storeOrder as pricingOrder } from '@/models/schema';
import type { Env, OrderMessage } from '@/env';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier authored price actual paid and received lifecycle',()=>{
  it('uses actual Supplier and buyer JWT HTTP, review, isolated balance payment, delivery and receipt to settle exact independent commissions once',async()=>{
    const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Supplier price lifecycle forbids external providers'));
    const full=await refundRuntimeFixture();try{
      const config:Record<string,string>={member_card_status:'1',svip_price_status:'1',integral_ratio_status:'0',
        brokerage_func_status:'1',store_brokerage_statu:'1',brokerage_level:'2',brokerage_compute_type:'1',
        store_brokerage_ratio:'10',store_brokerage_two:'5',division_status:'0'};
      for(const [menuName,value]of Object.entries(config)){
        const updated=await full.db.update(pricingConfig).set({value}).where(sql`${pricingConfig.menuName}=${menuName} AND ${pricingConfig.isStore}=0`).returning({id:pricingConfig.id});
        if(!updated.length)await full.db.insert(pricingConfig).values({menuName,value});
      }
      await full.db.update(pricingUser).set({nowMoney:'100.00',isEverLevel:1,spreadUid:22}).where(eq(pricingUser.uid,11));
      await full.db.update(pricingUser).set({spreadUid:33}).where(eq(pricingUser.uid,22));
      await full.db.insert(pricingUser).values({uid:33,account:'local-second-referrer',status:1,isPromoter:1,spreadOpen:1});
      await full.db.update(pricingSupplier).set({adminId:21,isShow:1,isDel:0}).where(eq(pricingSupplier.id,7));
      const password='local-supplier-pricing-password',reviewPassword='local-product-review-password';
      await full.db.insert(systemAdmin).values([{id:21,account:'local-price-supplier',pwd:password,adminType:4,relationId:7,status:1,isDel:0},
        {id:101,account:'local-price-review',pwd:reviewPassword,adminType:1,relationId:0,level:0,status:1,isDel:0}]);
      await full.db.insert(pricingCategory).values({id:800001,type:2,relationId:7,cateName:'本地供应商分类',isShow:1});
      await full.exec(`SELECT setval(pg_get_serial_sequence('store_product','id'),800010,true);
        SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),800010,true);
        SELECT setval(pg_get_serial_sequence('store_cart','id'),800010,true)`);
      const env={...full.env,NODE_ENV:'test',APP_KEY:'isolated-supplier-pricing-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',
        CONFIG_KV:{...full.env.CONFIG_KV,get:async(key:string)=>key.startsWith('cfg_')&&Object.hasOwn(config,key.slice(4))?config[key.slice(4)]:(full.env.CONFIG_KV as any).get(key)}} as unknown as Env;
      const supplierToken=(await createToken(21,'supplier',md5(password),env.APP_KEY)).token;
      const reviewerToken=(await createToken(101,'admin',md5(reviewPassword),env.APP_KEY)).token;
      const [buyer]=await full.db.select().from(pricingUser).where(eq(pricingUser.uid,11));
      const buyerToken=(await createToken(11,'api',md5(buyer.pwd),env.APP_KEY)).token;
      if(!full.withRuntimeRole)throw Error('Independent owned LOGINs required');
      await full.withRuntimeRole(appRole=>full.withRuntimeRole!(async adminRole=>{
        const [database]=await full.db.execute(sql`SELECT current_database() AS name`);
        const names={app:appRole.role,admin:adminRole.role,maintenance:'finance_test',database:String(database.name),pricingOwner:full.pricingOwner};
        await runRuntimeBusinessCommissioning(full.db,names);expect((await runRoutinePaymentRuntimeInstallation(full.db,names)).after.ready).toBe(true);
        expect(await auditRuntimeBusinessPrivileges(appRole.db,'app',names)).toMatchObject({ready:true,failures:[]});
        const container=createContainerFromDb(appRole.db);wiring.container=container;wiring.moderator=createContainerFromDb(adminRole.db);
        const request=async(method:string,path:string,body:object|undefined,token:string)=>{
          const response=await app.request(path,{method,headers:{Authorization:'Bearer '+token,'X-Supplier-Id':'8',
            ...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})},env);
          const result=await response.json<Envelope>();expect(result.status,result.msg).toBe(200);return result;
        };
        const body={product_type:3,store_name:'实际会员佣金交付',cate_id:[800001],slider_image:['/supplier-price.png'],
          spec_type:0,is_sub:[0,1],attrs:[{price:'10.00',settle_price:'1.00',vip_price:'7.50',brokerage:'2.00',brokerage_two:'1.00',stock:5}]};
        const made=await request('POST','/supplierapi/product/product/0',body,supplierToken),id=Number(made.data.id);
        expect((await container.db.select().from(storeProduct).where(eq(storeProduct.id,id)))[0]).toMatchObject({type:2,relationId:7,isVip:1,isSub:1,isVerify:0,isShow:0});
        await request('POST','/adminapi/product/product/set_verify/'+id,{is_verify:1,is_show:1,refusal:'',auto_on_time:''},reviewerToken);
        const detail=await request('GET','/supplierapi/product/product/'+id,undefined,supplierToken);
        expect(detail.data.price_selection).toEqual({version:1,is_vip:1,is_sub:1});
        const [sku]=await container.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId,id));
        const [nonmember]=await container.db.select().from(pricingUser).where(eq(pricingUser.uid,22));
        const nonmemberToken=(await createToken(22,'api',md5(nonmember.pwd),env.APP_KEY)).token;
        const nonmemberCart=await new StoreCartService(container,env).add({uid:22,productId:id,unique:sku.unique,cartNum:1,isNew:1});
        const ordinary=await request('POST','/api/order/confirm',{cartIds:[nonmemberCart.id],shippingType:1,useIntegral:false},nonmemberToken);
        expect(ordinary.data.priceGroup.pay_price).toBe('10.00');
        const cart=await new StoreCartService(container,env).add({uid:11,productId:id,unique:sku.unique,cartNum:1,isNew:1});
        const selection={cartIds:[cart.id],shippingType:1,useIntegral:false};
        const confirmed=await request('POST','/api/order/confirm',selection,buyerToken);expect(confirmed.data.priceGroup.pay_price).toBe('7.50');
        const order=await StoreOrderCreateService.createWithRuntime(container,{CONFIG_KV:env.CONFIG_KV,requireConfirmation:true,requirePurchaseOrigin:true,
          nextOrderId:async()=> 'supplier_price_lifecycle'}, {...selection,uid:11,key:confirmed.data.orderKey,quoteToken:confirmed.data.quoteToken,userIp:'127.0.0.1'});
        const [root]=await container.db.select().from(pricingOrder).where(eq(pricingOrder.orderId,order.orderId));
        expect(root).toMatchObject({payPrice:'7.50',oneBrokerage:'2.00',twoBrokerage:'1.00',spreadUid:22,spreadTwoUid:33});
        const paid=await applyStoreOrderBalancePayment(container,{uid:11,orderId:order.orderId,routineNotice:env});expect(paid.outcome).toBe('paid');
        expect((await applyStoreOrderBalancePayment(container,{uid:11,orderId:order.orderId})).outcome).toBe('already-paid');
        const queue={send:vi.fn(async()=>{}),sendBatch:vi.fn(async()=>({successful:1}))};
        const consumer=new OrderOutboxService(container,{ORDER_QUEUE:queue as unknown as Queue<OrderMessage>,APP_KEY:env.APP_KEY});
        const message={action:'processOrderPaidOutbox' as const,outboxId:paid.outbox!.id,eventKey:paid.outbox!.eventKey};
        expect(await consumer.processMessage(message)).toBe('completed');expect(await consumer.processMessage(message)).toBe('already-completed');
        const leaves=await container.db.select().from(pricingOrder).where(sql`(${pricingOrder.id}=${root.id} OR ${pricingOrder.pid}=${root.id}) AND ${pricingOrder.pid}>=0 AND ${pricingOrder.supplierId}=7`);
        expect(leaves).toHaveLength(1);const leaf=leaves[0];expect(leaf).toMatchObject({productType:3,paid:1,status:0,payPrice:'7.50'});
        await request('PUT','/supplierapi/order/delivery/'+leaf.id,{delivery_type:'fictitious',fictitious_content:'本地会员价格结算交付'},supplierToken);
        await request('POST','/api/order/take',{order_id:leaf.orderId},buyerToken);
        const rows=await container.db.execute(sql`SELECT uid,number FROM user_brokerage WHERE link_id=${String(leaf.id)} AND pm=1 ORDER BY uid`);
        expect(rows).toEqual([{uid:22,number:'2.00'},{uid:33,number:'1.00'}]);
        await app.request('/api/order/take',{method:'POST',headers:{Authorization:'Bearer '+buyerToken,'Content-Type':'application/json'},body:JSON.stringify({order_id:leaf.orderId})},env);
        expect(await container.db.execute(sql`SELECT uid,number FROM user_brokerage WHERE link_id=${String(leaf.id)} AND pm=1 ORDER BY uid`)).toEqual(rows);
        const current=await request('GET','/supplierapi/product/product/'+id,undefined,supplierToken);
        await request('POST','/supplierapi/product/product/'+id,{...body,is_sub:[],attrs:current.data.attrs},supplierToken);
        await request('POST','/adminapi/product/product/set_verify/'+id,{is_verify:1,is_show:1,refusal:'',auto_on_time:''},reviewerToken);
        const freshCart=await new StoreCartService(container,env).add({uid:11,productId:id,unique:sku.unique,cartNum:1,isNew:1});
        const disabledSelection={cartIds:[freshCart.id],shippingType:1,useIntegral:false};
        const disabled=await request('POST','/api/order/confirm',disabledSelection,buyerToken);expect(disabled.data.priceGroup.pay_price).toBe('10.00');
        const normalOrder=await StoreOrderCreateService.createWithRuntime(container,{CONFIG_KV:env.CONFIG_KV,requireConfirmation:true,requirePurchaseOrigin:true,
          nextOrderId:async()=> 'supplier_default_commission'}, {...disabledSelection,uid:11,key:disabled.data.orderKey,quoteToken:disabled.data.quoteToken,userIp:'127.0.0.1'});
        expect((await container.db.select().from(pricingOrder).where(eq(pricingOrder.orderId,normalOrder.orderId)))[0]).toMatchObject({paid:0,payPrice:'10.00',oneBrokerage:'1.00',twoBrokerage:'0.50'});
        expect((await container.db.select().from(pricingOrder).where(eq(pricingOrder.id,root.id)))[0]).toMatchObject({paid:1,payPrice:'7.50',oneBrokerage:'2.00',twoBrokerage:'1.00'});
        expect(await container.db.execute(sql`SELECT uid,number FROM user_brokerage WHERE link_id=${String(leaf.id)} AND pm=1 ORDER BY uid`)).toEqual(rows);
        expect((await container.db.select().from(pricingUser).where(eq(pricingUser.uid,11)))[0].nowMoney).toBe('92.50');
      }));
      expect(network).not.toHaveBeenCalled();
    }finally{wiring.container=null;wiring.moderator=null;network.mockRestore();await full.close();}
  },180_000);
});

// Purchase author is appended without changing any preceding test bytes.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier purchase qualification and presale author', () => {
  let f: Awaited<ReturnType<typeof supplierProductRecommendImageFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned purchase author forbids providers'));
    f = await supplierProductRecommendImageFixture(); wiring.container = f.container; }, 30_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { await f?.close(); wiring.container = null; wiring.moderator = null; vi.restoreAllMocks(); } }, 30_000);
  async function call(id: number, body?: object, actor: keyof typeof f.tokens = 'manager') {
    return (await app.request('/supplierapi/product/product/' + id, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + f.tokens[actor], ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }, f.env)).json<Envelope>();
  }
  it.each([0, 1, 3])('authors and preserves member-only presale terms for fulfillment type %i', async type => {
    const id = type === 1 ? 81 : 80;
    if (type === 3) { await f.db.update(storeProduct).set({ productType: 3 }).where(eq(storeProduct.id, id));
      await f.db.update(storeProductAttrValue).set({ productType: 3 }).where(eq(storeProductAttrValue.productId, id)); }
    await f.withWriter(async writer => { wiring.container = writer.container; const now = Math.floor(Date.now() / 1000), start = now + 60, end = now + 600;
      const saved = await call(id, await f.body({ is_vip_product: 1, is_presale_product: 1, presale_time: [start, end], presale_day: 7 }, id));
      expect(saved.status, saved.msg).toBe(200); expect(await f.product(id)).toMatchObject({ isVipProduct: 1, isPresaleProduct: 1, presaleStartTime: start, presaleEndTime: end, presaleDay: 7, isVerify: 0, isShow: 0 });
      expect((await call(id)).data.purchase_selection).toEqual({ version: 1, is_vip_product: 1, is_presale_product: 1, presale_start_time: start, presale_end_time: end, presale_day: 7 });
      expect((await call(id, await f.body({}, id))).status).toBe(200);
      expect(await f.product(id)).toMatchObject({ isVipProduct: 1, isPresaleProduct: 1, presaleStartTime: start, presaleEndTime: end, presaleDay: 7 });
      expect((await call(id, await f.body({ is_vip_product: 0, is_presale_product: 0 }, id))).status).toBe(200);
      expect(await f.product(id)).toMatchObject({ isVipProduct: 0, isPresaleProduct: 0, presaleStartTime: 0, presaleEndTime: 0, presaleDay: 7 });
    });
  });
  it('keeps an already-started window on omission or days-only edits and refuses an explicit stale period', async () => {
    await f.db.update(storeProduct).set({ isVipProduct: 1, isPresaleProduct: 1, presaleStartTime: 100, presaleEndTime: 200, presaleDay: 7 }).where(eq(storeProduct.id, 80));
    await f.withWriter(async writer => { wiring.container = writer.container;
      expect((await call(80, await f.body())).status).toBe(200);
      expect((await call(80, await f.body({ presale_day: 9 }))).status).toBe(200);
      expect(await f.product()).toMatchObject({ isVipProduct: 1, presaleStartTime: 100, presaleEndTime: 200, presaleDay: 9 });
      const before = await f.snapshot(); expect((await call(80, await f.body({ presale_time: [100, 200] }))).status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
    });
  });
  it.each(['member', 'period', 'owner', 'actor'])('rolls back all business rows on deferred %s tampering', async target => {
    const change = target === 'member' ? 'UPDATE store_product SET is_vip_product=0 WHERE id=NEW.product_id;'
      : target === 'period' ? 'UPDATE store_product SET presale_day=99 WHERE id=NEW.product_id;'
      : target === 'owner' ? 'UPDATE store_product SET relation_id=8 WHERE id=NEW.product_id;' : 'UPDATE system_admin SET status=0 WHERE id=21;';
    await f.exec(`CREATE FUNCTION test_supplier_purchase_drift() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN ${change} RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER test_supplier_purchase_drift AFTER INSERT OR UPDATE ON store_product_description DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_supplier_purchase_drift()`);
    await f.withWriter(async writer => { wiring.container = writer.container; const now = Math.floor(Date.now() / 1000), before = await f.snapshot();
      const result = await call(80, await f.body({ is_vip_product: 1, is_presale_product: 1, presale_time: [now + 60, now + 600] }));
      expect(result.status).not.toBe(200); expect(result.msg).toMatch(target === 'actor' ? /权限已变化/ : /保存核对失败/); expect(await f.snapshot()).toEqual(before);
    });
  });
  it('uses the final DB wall clock after a delayed author, rather than its transaction start', async () => {
    await f.exec(`CREATE FUNCTION test_supplier_purchase_wait() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN PERFORM pg_sleep(3.2); RETURN NEW; END $$;
      CREATE TRIGGER test_supplier_purchase_wait AFTER INSERT OR UPDATE ON store_product_description FOR EACH ROW EXECUTE FUNCTION test_supplier_purchase_wait()`);
    await f.withWriter(async writer => { wiring.container = writer.container; const [clock] = await f.db.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
      const before = await f.snapshot(), result = await call(80, await f.body({ is_presale_product: 1, presale_time: [Number(clock.now) + 2, Number(clock.now) + 600] }));
      expect(result.status).not.toBe(200); expect(result.msg).toMatch(/开始时间不能小于/); expect(await f.snapshot()).toEqual(before);
    });
  });
  it('requires current management authority and rejects malformed or foreign intent before business writes', async () => f.withWriter(async writer => {
    wiring.container = writer.container; const body = await f.body({ is_vip_product: 1 }), before = await f.snapshot(), sequences = await f.sequences();
    for (const actor of ['viewer', 'denied', 'other'] as const) expect((await call(80, body, actor)).status).not.toBe(200);
    expect((await call(82, body)).status).not.toBe(200);
    expect((await call(80, { ...body, is_vip_product: 2 })).status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
  }));
});

import { storeOrderCartInfo as purchaseCartInfo, storeOrderOutbox as purchaseOutbox } from '@/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier authored paid-member presale actual HTTP lifecycle', () => {
  it.each([{ productType: 0, presale: true }, { productType: 1, presale: true }, { productType: 3, presale: true }, { productType: 3, presale: false }])('reviews, admits, pays and fulfills $productType with presale=$presale using immutable terms', async ({ productType, presale }) => {
    const orderType = presale ? 6 : 0;
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned presale lifecycle forbids providers'));
    const full = await refundRuntimeFixture();
    try {
      const config: Record<string, string> = { member_card_status: '1', svip_price_status: '0', integral_ratio_status: '0',
        brokerage_func_status: '0', store_brokerage_statu: '0', balance_func_status: '1', yue_pay_status: '1' };
      for (const [menuName, value] of Object.entries(config)) {
        const updated = await full.db.update(pricingConfig).set({ value }).where(sql`${pricingConfig.menuName}=${menuName} AND ${pricingConfig.isStore}=0`).returning({ id: pricingConfig.id });
        if (!updated.length) await full.db.insert(pricingConfig).values({ menuName, value });
      }
      await full.db.update(pricingUser).set({ nowMoney: '100.00', isEverLevel: 1, isMoneyLevel: 0, overdueTime: 0 }).where(eq(pricingUser.uid, 11));
      await full.db.update(pricingSupplier).set({ adminId: 21, isShow: 1, isDel: 0 }).where(eq(pricingSupplier.id, 7));
      const password = 'local-purchase-supplier-password', reviewPassword = 'local-purchase-review-password';
      await full.db.insert(systemAdmin).values([{ id: 21, account: 'local-presale-supplier', pwd: password, adminType: 4, relationId: 7, status: 1, isDel: 0 },
        { id: 101, account: 'local-presale-review', pwd: reviewPassword, adminType: 1, relationId: 0, level: 0, status: 1, isDel: 0 }]);
      await full.db.insert(pricingCategory).values({ id: 800001, type: 2, relationId: 7, cateName: '本地预售分类', isShow: 1 });
      await full.exec(`SELECT setval(pg_get_serial_sequence('store_product','id'),800010,true);
        SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),800010,true);
        SELECT setval(pg_get_serial_sequence('store_cart','id'),800010,true)`);
      const queue = { send: vi.fn(async () => {}), sendBatch: vi.fn(async () => ({ successful: 1 })) };
      const sequence = vi.fn(async () => new Response('supplier_presale_http_' + productType));
      const env = { ...full.env, NODE_ENV: 'test', APP_KEY: 'isolated-supplier-presale-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', ORDER_QUEUE: queue,
        SEQUENCE: { idFromName: () => 'owned-supplier-presale', get: () => ({ fetch: sequence }) },
        CONFIG_KV: { ...full.env.CONFIG_KV, get: async (key: string) => key.startsWith('cfg_') && Object.hasOwn(config, key.slice(4)) ? config[key.slice(4)] : (full.env.CONFIG_KV as any).get(key) } } as unknown as Env;
      const supplierToken = (await createToken(21, 'supplier', md5(password), env.APP_KEY)).token;
      const reviewerToken = (await createToken(101, 'admin', md5(reviewPassword), env.APP_KEY)).token;
      const [buyer] = await full.db.select().from(pricingUser).where(eq(pricingUser.uid, 11));
      const [ordinary] = await full.db.select().from(pricingUser).where(eq(pricingUser.uid, 22));
      const buyerToken = (await createToken(11, 'api', md5(buyer.pwd), env.APP_KEY)).token;
      const nonmemberToken = (await createToken(22, 'api', md5(ordinary.pwd), env.APP_KEY)).token;
      if (!full.withRuntimeRole) throw Error('Independent owned LOGINs required');
      await full.withRuntimeRole(appRole => full.withRuntimeRole!(async adminRole => {
        const [database] = await full.db.execute(sql`SELECT current_database() AS name`);
        const names = { app: appRole.role, admin: adminRole.role, maintenance: 'finance_test', database: String(database.name), pricingOwner: full.pricingOwner };
        await runRuntimeBusinessCommissioning(full.db, names); expect((await runRoutinePaymentRuntimeInstallation(full.db, names)).after.ready).toBe(true);
        expect(await auditRuntimeBusinessPrivileges(appRole.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
        const container = createContainerFromDb(appRole.db); wiring.container = container; wiring.moderator = createContainerFromDb(adminRole.db);
        async function request(method: string, path: string, body?: object, token?: string) {
          const background: Promise<unknown>[] = [];
          const response = await app.request(path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, env,
            { waitUntil: task => { background.push(task); }, passThroughOnException() {}, props: {} });
          await Promise.all(background); return response.json<Envelope>();
        }
        async function ok(method: string, path: string, body?: object, token?: string) {
          const result = await request(method, path, body, token); expect(result.status, result.msg).toBe(200); return result.data;
        }
        async function waitUntil(seconds: number) {
          const deadline = performance.now() + 30_000;
          while (performance.now() < deadline) {
            const [clock] = await full.db.execute(sql`SELECT clock_timestamp() >= to_timestamp(${seconds}) AS ready`);
            if (clock.ready) return;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw Error('Owned PostgreSQL clock did not reach presale boundary');
        }
        const [clock] = await full.db.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
        const start = Number(clock.now) + 5, end = Number(clock.now) + 20;
        const body = { product_type: productType, store_name: '实际会员预售 ' + productType, cate_id: [800001], slider_image: ['/supplier-presale.png'],
          spec_type: 0, freight: 1, is_postage: 1, is_sub: [], is_vip_product: 1, is_presale_product: Number(presale), presale_time: presale ? [start, end] : [], presale_day: 7,
          attrs: [{ price: '10.00', settle_price: '1.00', vip_price: '0.00', stock: 5,
            ...(productType === 1 ? { delivery_mode: 'fixed', disk_info: 'Supplier presale fixed delivery' } : {}) }] };
        const made = await ok('POST', '/supplierapi/product/product/0', body, supplierToken), id = Number(made.id);
        const read = await ok('GET', '/supplierapi/product/product/' + id, undefined, supplierToken);
        expect(read.purchase_selection).toMatchObject({ is_vip_product: 1, is_presale_product: Number(presale), presale_start_time: presale ? start : 0, presale_end_time: presale ? end : 0, presale_day: 7 });
        await ok('POST', '/adminapi/product/product/set_verify/' + id, { is_verify: 1, is_show: 1, refusal: '', auto_on_time: '' }, reviewerToken);
        if (presale) {
          for (const token of [undefined, nonmemberToken]) expect((await ok('GET', '/api/presale/list', undefined, token)).list.some((row: any) => row.id === id)).toBe(false);
          expect((await ok('GET', '/api/presale/list', undefined, buyerToken)).list.some((row: any) => row.id === id)).toBe(true);
        }
        expect((await ok('GET', '/api/product/detail/' + id, undefined, buyerToken)).storeInfo.is_vip_product).toBe(1);
        const [sku] = await container.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, id));
        const add = { productId: id, unique: sku.unique, cartNum: 1, new: 1, type: orderType };
        if (presale) {
          const early = await request('POST', '/api/cart/add', add, buyerToken); expect(early.status).not.toBe(200); expect(early.msg).toMatch(/未开始/);
          await waitUntil(start);
        }
        const denied = await request('POST', '/api/cart/add', add, nonmemberToken); expect(denied.status).not.toBe(200); expect(denied.msg).toMatch(/付费会员/);
        await full.db.update(pricingUser).set({ isEverLevel: 0, isMoneyLevel: 1, overdueTime: Math.floor(Date.now() / 1000) - 1 }).where(eq(pricingUser.uid, 11));
        expect((await request('POST', '/api/cart/add', add, buyerToken)).status).not.toBe(200);
        await full.db.update(pricingUser).set({ isEverLevel: 1, isMoneyLevel: 0, overdueTime: 0 }).where(eq(pricingUser.uid, 11));
        const cart = await ok('POST', '/api/cart/add', add, buyerToken);
        const selection = { cartIds: [cart.id], type: orderType, shippingType: 1, useIntegral: false, ...(productType === 0 ? { addressId: 11 } : {}) };
        const confirmed = await ok('POST', '/api/order/confirm', selection, buyerToken); expect(confirmed.priceGroup.pay_price).toBe('10.00');
        const createBody = { ...selection, quoteToken: confirmed.quoteToken };
        const order = await ok('POST', '/api/order/create/' + confirmed.orderKey, createBody, buyerToken);
        expect((await ok('POST', '/api/order/create/' + confirmed.orderKey, createBody, buyerToken)).orderId).toBe(order.orderId); expect(sequence).toHaveBeenCalledTimes(1);
        const [root] = await container.db.select().from(pricingOrder).where(eq(pricingOrder.orderId, order.orderId));
        expect(root).toMatchObject({ type: orderType, productType, payPrice: '10.00', paid: 0 });
        expect((await ok('POST', '/api/order/pay', { uni: order.orderId, paytype: 'yue' }, buyerToken)).paid).toBe(true);
        expect((await ok('POST', '/api/order/pay', { uni: order.orderId, paytype: 'yue' }, buyerToken)).paid).toBe(true);
        expect((await container.db.select().from(pricingUser).where(eq(pricingUser.uid, 11)))[0].nowMoney).toBe('90.00');
        const [paid] = await container.db.select().from(purchaseOutbox).where(eq(purchaseOutbox.eventType, 'order.paid'));
        const consumer = new OrderOutboxService(container, env);
        const paidMessage = { action: 'processOrderPaidOutbox' as const, outboxId: paid.id, eventKey: paid.eventKey };
        expect(await consumer.processMessage(paidMessage)).toBe('completed'); expect(await consumer.processMessage(paidMessage)).toBe('already-completed');
        const leaves = await container.db.select().from(pricingOrder).where(sql`(${pricingOrder.id}=${root.id} OR ${pricingOrder.pid}=${root.id}) AND ${pricingOrder.pid}>=0 AND ${pricingOrder.supplierId}=7`);
        expect(leaves).toHaveLength(1); const leaf = leaves[0]; expect(leaf).toMatchObject({ type: orderType, productType, paid: 1, status: 0 });
        const [line] = await container.db.select().from(purchaseCartInfo).where(eq(purchaseCartInfo.oid, leaf.id));
        const frozen = JSON.parse(line.cartInfo!);
        if (presale) expect(frozen.presale).toEqual({ version: 'presale-full-payment-v1', productId: id, startsAt: start, endsAt: end,
          shippingDaysAfterEnd: 7, paidMemberOnly: true, perOrderLimit: null });
        else expect(frozen).not.toHaveProperty('presale');
        const current = await ok('GET', '/supplierapi/product/product/' + id, undefined, supplierToken);
        await ok('POST', '/supplierapi/product/product/' + id, { ...body, is_vip_product: 0, is_presale_product: 0, presale_time: [], attrs: current.attrs }, supplierToken);
        expect((await container.db.select().from(purchaseCartInfo).where(eq(purchaseCartInfo.id, line.id)))[0].cartInfo).toBe(line.cartInfo);
        const delivery = productType === 0 ? { delivery_type: 'express', delivery_name: 'Local', delivery_code: 'local', delivery_id: 'NO-SHIPMENT' }
          : { delivery_type: 'fictitious', fictitious_content: '本地预售人工交付' };
        let due: typeof purchaseOutbox.$inferSelect | undefined;
        if (productType === 1) {
          [due] = await container.db.select().from(purchaseOutbox).where(eq(purchaseOutbox.eventType, 'order.presale.fulfillment'));
          expect(due).toMatchObject({ availableTime: end });
          expect(await consumer.processMessage({ action: 'processPresaleDeliveryOutbox', outboxId: due!.id, eventKey: due!.eventKey })).toBe('deferred');
        } else if (presale) {
          const beforeEnd = await request('PUT', '/supplierapi/order/delivery/' + leaf.id, delivery, supplierToken);
          expect(beforeEnd.status).not.toBe(200); expect(beforeEnd.msg).toMatch(/尚未结束/);
        }
        if (presale) await waitUntil(end);
        if (productType === 1) {
          const message = { action: 'processPresaleDeliveryOutbox' as const, outboxId: due!.id, eventKey: due!.eventKey };
          expect(await consumer.processMessage(message)).toBe('completed'); expect(await consumer.processMessage(message)).toBe('already-completed');
          expect((await container.db.select().from(pricingOrder).where(eq(pricingOrder.id, leaf.id)))[0].virtualInfo).toContain('Supplier presale fixed delivery');
        } else await ok('PUT', '/supplierapi/order/delivery/' + leaf.id, delivery, supplierToken);
        await ok('POST', '/api/order/take', { order_id: leaf.orderId }, buyerToken);
        expect((await container.db.select().from(pricingOrder).where(eq(pricingOrder.id, leaf.id)))[0]).toMatchObject({ status: 2, paid: 1, type: orderType, payPrice: '10.00' });
        expect((await container.db.select().from(pricingUser).where(eq(pricingUser.uid, 11)))[0].nowMoney).toBe('90.00');
        await ok('POST', '/adminapi/product/product/set_verify/' + id, { is_verify: 1, is_show: 1, refusal: '', auto_on_time: '' }, reviewerToken);
        expect((await ok('POST', '/api/cart/add', { ...add, type: 0 }, nonmemberToken)).id).toBeGreaterThan(0);
      }));
      expect(network).not.toHaveBeenCalled();
    } finally { wiring.container = null; wiring.moderator = null; network.mockRestore(); await full.close(); }
  }, 180_000);
});


// Integral author is appended without changing any preceding acceptance cases.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier product integral author', () => {
  let f: Awaited<ReturnType<typeof supplierProductRecommendImageFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned integral author forbids providers'));
    f = await supplierProductRecommendImageFixture(); wiring.container = f.container; }, 30_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { await f?.close(); wiring.container = null; wiring.moderator = null; vi.restoreAllMocks(); } }, 30_000);
  async function call(id: number, body?: object, actor: keyof typeof f.tokens = 'manager') {
    return (await app.request('/supplierapi/product/product/' + id, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + f.tokens[actor], ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }, f.env)).json<Envelope>();
  }
  it.each([0, 1, 3])('authors fractional points, preserves omission and explicitly clears fulfillment type %i', async type => {
    const id = type === 1 ? 81 : 80;
    if (type === 3) { await f.db.update(storeProduct).set({ productType: 3 }).where(eq(storeProduct.id, id));
      await f.db.update(storeProductAttrValue).set({ productType: 3 }).where(eq(storeProductAttrValue.productId, id)); }
    await f.withWriter(async writer => { wiring.container = writer.container;
      const before = await f.product(id), relations = (await f.snapshot()).store_product_relation;
      expect((await call(id, await f.body({ give_integral: '0002.75' }, id))).status).toBe(200);
      expect(await f.product(id)).toMatchObject({ giveIntegral: '2.75', type: 2, relationId: 7, isShow: 0, isVerify: 0 });
      expect((await call(id)).data.integral_selection).toEqual({ version: 1, give_integral: '2.75' });
      await f.exec("CREATE FUNCTION owned_integral_omit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'integral entered SQL target'; END $$; CREATE TRIGGER owned_integral_omit BEFORE UPDATE OF give_integral ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_integral_omit()");
      await expect(f.db.update(storeProduct).set({ giveIntegral: '0.00' }).where(eq(storeProduct.id, id))).rejects.toThrow('integral');
      const body = await f.body({}, id); expect((await call(id, body)).status).toBe(200);
      await new SupplierProductManagementService(writer.container, f.env).saveProduct(7, id, { ...body, give_integral: undefined });
      expect((await f.product(id)).giveIntegral).toBe('2.75');
      await f.exec('DROP TRIGGER owned_integral_omit ON public.store_product');
      expect((await call(id, { ...body, give_integral: 0 })).status).toBe(200);
      const current = await f.product(id); expect(current.giveIntegral).toBe('0.00');
      for (const key of ['labelId', 'commandWord', 'customForm', 'systemFormId', 'isVipProduct', 'isPresaleProduct', 'presaleStartTime', 'presaleEndTime', 'presaleDay'] as const) expect(current[key]).toEqual(before[key]);
      expect((await f.snapshot()).store_product_relation.filter(row => row.row.type !== 1)).toEqual(relations.filter(row => row.row.type !== 1));
    });
  });
  it('denies malformed, foreign and unauthorized requests before rows or sequences change', async () => f.withWriter(async writer => {
    wiring.container = writer.container; const body = await f.body({ give_integral: '2.75' }), before = await f.snapshot(), seq = await f.sequences();
    for (const actor of ['viewer', 'denied', 'other'] as const) expect((await call(80, body, actor)).status).not.toBe(200);
    expect((await call(82, body)).status).not.toBe(200);
    for (const value of [null, false, [], {}, '', '-1', '1.001', '10000000000']) expect((await call(80, { ...body, give_integral: value })).status).toBe(400);
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq);
  }));
  it.each(['skip', 'rewrite', 'deferred', 'deferred-owner', 'deferred-review', 'deferred-type', 'revoke'] as const)('rolls back executable %s tampering after an independently verified positive control', async mode => f.withWriter(async writer => {
    const action = mode === 'skip' ? 'RETURN NULL;' : mode === 'rewrite' ? "NEW.give_integral=99; RETURN NEW;"
      : mode.startsWith('deferred') ? `IF NEW.give_integral=2.75 AND NEW.relation_id=7 AND NEW.is_show=0 AND NEW.product_type=0 THEN UPDATE public.store_product SET ${mode === 'deferred-owner' ? 'relation_id=8' : mode === 'deferred-review' ? 'is_show=1' : mode === 'deferred-type' ? 'product_type=3' : 'give_integral=99'} WHERE id=80; END IF; RETURN NEW;`
      : "UPDATE public.system_role SET rules='supplier.product.view' WHERE id=21; RETURN NEW;";
    const timing = mode.startsWith('deferred') ? 'CREATE CONSTRAINT TRIGGER owned_integral_tamper AFTER UPDATE ON public.store_product DEFERRABLE INITIALLY DEFERRED'
      : 'CREATE TRIGGER owned_integral_tamper BEFORE UPDATE OF give_integral ON public.store_product';
    await f.exec(`CREATE FUNCTION owned_integral_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN IF NEW.id=80 THEN ${action} END IF; RETURN NEW; END $$; ${timing} FOR EACH ROW EXECUTE FUNCTION owned_integral_tamper()`);
    const marker = Error('owned integral control rollback');
    await expect(f.db.transaction(async tx => {
      const changed = await tx.update(storeProduct).set({ giveIntegral: '2.75' }).where(eq(storeProduct.id, 80)).returning();
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      if (mode === 'skip') expect(changed).toHaveLength(0);
      else if (mode === 'revoke') expect((await tx.select().from(systemRole).where(eq(systemRole.id, 21)))[0].rules).toBe('supplier.product.view');
      else { const actual = (await tx.select().from(storeProduct).where(eq(storeProduct.id, 80)))[0];
        if (mode === 'deferred-owner') expect(actual.relationId).toBe(8);
        else if (mode === 'deferred-review') expect(actual.isShow).toBe(1);
        else if (mode === 'deferred-type') expect(actual.productType).toBe(3);
        else expect(actual.giveIntegral).toBe('99.00'); }
      throw marker;
    })).rejects.toBe(marker);
    wiring.container = writer.container; const body = await f.body({ give_integral: '2.75' }), before = await f.snapshot();
    expect((await call(80, body)).status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
  }));
  it('reads points through a SELECT-only viewer without any business or sequence write', async () => f.withReader(async reader => {
    await f.db.update(storeProduct).set({ giveIntegral: '2.75' }).where(eq(storeProduct.id, 80));
    wiring.container = reader.container; const before = await f.snapshot(), seq = await f.sequences();
    expect((await call(80, undefined, 'viewer')).data.integral_selection).toEqual({ version: 1, give_integral: '2.75' });
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq);
    const [rights] = await reader.db.execute(sql`SELECT current_user=session_user AS independent, has_any_column_privilege(current_user,'store_product','UPDATE') AS write`);
    expect(rights).toEqual({ independent: true, write: false });
  }));
  it('combines points with all existing explicit product authors', async () => f.withWriter(async writer => {
    wiring.container = writer.container;
    const result = await call(80, await f.body({ give_integral: '2.75', recommend_image: '/api/assets/31', store_label_id: [31], brand_id: [104, 105], ensure_id: [201], specs_id: 301, specs: [{ name: '材质', value: '棉' }], system_form_id: 401,
      is_vip_product: 1, is_presale_product: 0, is_sub: [] }));
    expect(result.status, result.msg).toBe(200); expect(await f.product()).toMatchObject({ giveIntegral: '2.75', recommendImage: '/api/assets/31', brandId: 105, ensureId: '201', systemFormId: 401, isVipProduct: 1 });
  }));
});


import { userBill as integralBill } from '@/models/schema';
import { applyOrderRefundWithMaterialization, finalizeStoreOrderRefund } from '@/services/order/StoreOrderRefundService';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier authored product integral actual HTTP lifecycle and balance refund', () => {
  it.each([{ productType: 0, received: true }, { productType: 1, received: true }, { productType: 3, received: true }, { productType: 0, received: false }])
  ('snapshots fractional points and refunds $productType with received=$received under independent LOGINs', async ({ productType, received }) => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned integral lifecycle forbids providers'));
    const full = await refundRuntimeFixture();
    try {
      const config: Record<string, string> = { integral_ratio_status: '0', order_give_integral: '0', order_give_exp: '0', member_func_status: '0',
        brokerage_func_status: '0', store_brokerage_statu: '0', balance_func_status: '1', yue_pay_status: '1' };
      for (const [menuName, value] of Object.entries(config)) {
        const changed = await full.db.update(pricingConfig).set({ value }).where(sql`${pricingConfig.menuName}=${menuName} AND ${pricingConfig.isStore}=0`).returning({ id: pricingConfig.id });
        if (!changed.length) await full.db.insert(pricingConfig).values({ menuName, value });
      }
      await full.db.update(pricingUser).set({ nowMoney: '100.00', integral: 100 }).where(eq(pricingUser.uid, 11));
      await full.db.update(pricingSupplier).set({ adminId: 21, isShow: 1, isDel: 0 }).where(eq(pricingSupplier.id, 7));
      const password = 'local-integral-supplier-password', reviewPassword = 'local-integral-review-password';
      await full.db.insert(systemAdmin).values([{ id: 21, account: 'local-integral-supplier', pwd: password, adminType: 4, relationId: 7, status: 1, isDel: 0 },
        { id: 101, account: 'local-integral-review', pwd: reviewPassword, adminType: 1, relationId: 0, level: 0, status: 1, isDel: 0 }]);
      await full.db.insert(pricingCategory).values({ id: 800001, type: 2, relationId: 7, cateName: '本地积分分类', isShow: 1 });
      await full.exec(`SELECT setval(pg_get_serial_sequence('store_product','id'),800010,true);
        SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),800010,true);
        SELECT setval(pg_get_serial_sequence('store_cart','id'),800010,true)`);
      const queue = { send: vi.fn(async () => {}), sendBatch: vi.fn(async () => ({ successful: 1 })) };
      const sequence = vi.fn(async () => new Response('supplier_integral_http_' + productType + '_' + received));
      const env = { ...full.env, NODE_ENV: 'test', APP_KEY: 'isolated-supplier-integral-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', ORDER_QUEUE: queue,
        SEQUENCE: { idFromName: () => 'owned-supplier-integral', get: () => ({ fetch: sequence }) },
        CONFIG_KV: { ...full.env.CONFIG_KV, get: async (key: string) => key.startsWith('cfg_') && Object.hasOwn(config, key.slice(4)) ? config[key.slice(4)] : (full.env.CONFIG_KV as any).get(key) } } as unknown as Env;
      const supplierToken = (await createToken(21, 'supplier', md5(password), env.APP_KEY)).token;
      const reviewerToken = (await createToken(101, 'admin', md5(reviewPassword), env.APP_KEY)).token;
      const [buyer] = await full.db.select().from(pricingUser).where(eq(pricingUser.uid, 11));
      const buyerToken = (await createToken(11, 'api', md5(buyer.pwd), env.APP_KEY)).token;
      if (!full.withRuntimeRole) throw Error('Independent owned LOGINs required');
      await full.withRuntimeRole(appRole => full.withRuntimeRole!(async adminRole => {
        const [database] = await full.db.execute(sql`SELECT current_database() AS name`);
        const names = { app: appRole.role, admin: adminRole.role, maintenance: 'finance_test', database: String(database.name), pricingOwner: full.pricingOwner };
        await runRuntimeBusinessCommissioning(full.db, names); expect((await runRoutinePaymentRuntimeInstallation(full.db, names)).after.ready).toBe(true);
        expect(await auditRuntimeBusinessPrivileges(appRole.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
        expect(await auditRuntimeBusinessPrivileges(adminRole.db, 'admin', names)).toMatchObject({ ready: true, failures: [] });
        const container = createContainerFromDb(appRole.db); wiring.container = container; wiring.moderator = createContainerFromDb(adminRole.db);
        async function request(method: string, path: string, body?: object, token?: string) {
          const background: Promise<unknown>[] = [];
          const response = await app.request(path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, env,
            { waitUntil: task => { background.push(task); }, passThroughOnException() {}, props: {} });
          await Promise.all(background); return response.json<Envelope>();
        }
        async function ok(method: string, path: string, body?: object, token?: string) {
          const result = await request(method, path, body, token); expect(result.status, result.msg).toBe(200); return result.data;
        }
        const body = { product_type: productType, store_name: '实际赠送积分 ' + productType, cate_id: [800001], slider_image: ['/supplier-integral.png'],
          spec_type: 0, freight: 1, is_postage: 1, is_support_refund: 1, is_sub: [], give_integral: '2.75',
          attrs: [{ price: '10.00', settle_price: '1.00', vip_price: '0.00', stock: 5,
            ...(productType === 1 ? { delivery_mode: 'fixed', disk_info: 'Supplier integral fixed delivery' } : {}) }] };
        const made = await ok('POST', '/supplierapi/product/product/0', body, supplierToken), id = Number(made.id);
        const read = await ok('GET', '/supplierapi/product/product/' + id, undefined, supplierToken);
        expect(read.integral_selection).toEqual({ version: 1, give_integral: '2.75' });
        await ok('POST', '/adminapi/product/product/set_verify/' + id, { is_verify: 1, is_show: 1, refusal: '', auto_on_time: '' }, reviewerToken);
        const [sku] = await container.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, id));
        const cart = await ok('POST', '/api/cart/add', { productId: id, unique: sku.unique, cartNum: 3, new: 1, type: 0 }, buyerToken);
        const selection = { cartIds: [cart.id], type: 0, shippingType: 1, useIntegral: false, ...(productType === 0 ? { addressId: 11 } : {}) };
        const confirmed = await ok('POST', '/api/order/confirm', selection, buyerToken); expect(confirmed.priceGroup.pay_price).toBe('30.00');
        const createBody = { ...selection, quoteToken: confirmed.quoteToken };
        const order = await ok('POST', '/api/order/create/' + confirmed.orderKey, createBody, buyerToken);
        expect((await ok('POST', '/api/order/create/' + confirmed.orderKey, createBody, buyerToken)).orderId).toBe(order.orderId); expect(sequence).toHaveBeenCalledTimes(1);
        const [root] = await container.db.select().from(pricingOrder).where(eq(pricingOrder.orderId, order.orderId));
        expect(root).toMatchObject({ type: 0, productType, payPrice: '30.00', gainIntegral: '8.00', paid: 0 });
        const current = await ok('GET', '/supplierapi/product/product/' + id, undefined, supplierToken);
        await ok('POST', '/supplierapi/product/product/' + id, { ...body, give_integral: 0, attrs: current.attrs }, supplierToken);
        expect((await ok('GET', '/supplierapi/product/product/' + id, undefined, supplierToken)).integral_selection.give_integral).toBe('0.00');
        expect((await ok('POST', '/api/order/pay', { uni: order.orderId, paytype: 'yue' }, buyerToken)).paid).toBe(true);
        expect((await ok('POST', '/api/order/pay', { uni: order.orderId, paytype: 'yue' }, buyerToken)).paid).toBe(true);
        const [paid] = await container.db.select().from(purchaseOutbox).where(eq(purchaseOutbox.eventType, 'order.paid'));
        const consumer = new OrderOutboxService(container, env), paidMessage = { action: 'processOrderPaidOutbox' as const, outboxId: paid.id, eventKey: paid.eventKey };
        expect(await consumer.processMessage(paidMessage)).toBe('completed'); expect(await consumer.processMessage(paidMessage)).toBe('already-completed');
        const leaves = await container.db.select().from(pricingOrder).where(sql`(${pricingOrder.id}=${root.id} OR ${pricingOrder.pid}=${root.id}) AND ${pricingOrder.pid}>=0 AND ${pricingOrder.supplierId}=7`);
        expect(leaves).toHaveLength(1); const leaf = leaves[0]; expect(leaf).toMatchObject({ type: 0, productType, paid: 1, gainIntegral: '8.00' });
        const [line] = await container.db.select().from(purchaseCartInfo).where(eq(purchaseCartInfo.oid, leaf.id));
        expect(JSON.parse(line.cartInfo!).product.giveIntegral).toBe('2.75');
        const account = async () => (await container.db.select().from(pricingUser).where(eq(pricingUser.uid, 11)))[0];
        const gifts = () => container.db.select().from(integralBill).where(sql`${integralBill.uid}=11 AND ${integralBill.eventKey}='pay_give_integral'`);
        expect(await account()).toMatchObject({ nowMoney: '70.00', integral: 100 }); expect(await gifts()).toEqual([]);
        if (received) {
          if (productType !== 1) await ok('PUT', '/supplierapi/order/delivery/' + leaf.id,
            productType === 0 ? { delivery_type: 'express', delivery_name: 'Local', delivery_code: 'local', delivery_id: 'NO-SHIPMENT' }
              : { delivery_type: 'fictitious', fictitious_content: '本地积分人工交付' }, supplierToken);
          await ok('POST', '/api/order/take', { order_id: leaf.orderId }, buyerToken);
          expect(await account()).toMatchObject({ nowMoney: '70.00', integral: 108 });
          expect(await gifts()).toMatchObject([{ number: '8.00', linkId: String(leaf.id), pm: 1 }]);
          const stable = await gifts(); expect((await request('POST', '/api/order/take', { order_id: leaf.orderId }, buyerToken)).status).not.toBe(200);
          expect(await gifts()).toEqual(stable); expect((await account()).integral).toBe(108);
        }
        const application = await applyOrderRefundWithMaterialization(container, { uid: 11, orderId: leaf.orderId, applyType: 1,
          refundReason: 'Owned Supplier integral full return', refundExplain: '', applicationOrderId: 'owned_integral_refund', cartSelections: [{ cartId: Number(line.cartId), cartNum: 3 }] });
        expect(await finalizeStoreOrderRefund(container, application.refundId, undefined, undefined, env)).toBe('completed');
        expect(await account()).toMatchObject({ nowMoney: '100.00', integral: 100 });
        const after = await account(), bills = await container.db.select().from(integralBill).where(eq(integralBill.uid, 11));
        expect(bills.filter(row => row.eventKey === 'integral_refund').reduce((sum, row) => sum + Number(row.number), 0)).toBe(received ? 8 : 0);
        expect(await finalizeStoreOrderRefund(container, application.refundId, undefined, undefined, env)).toBe('already-completed');
        expect(await account()).toEqual(after); expect(await container.db.select().from(integralBill).where(eq(integralBill.uid, 11))).toEqual(bills);
        expect(JSON.parse((await container.db.select().from(purchaseCartInfo).where(eq(purchaseCartInfo.id, line.id)))[0].cartInfo!).product.giveIntegral).toBe('2.75');
      }));
      expect(network).not.toHaveBeenCalled();
    } finally { wiring.container = null; wiring.moderator = null; network.mockRestore(); await full.close(); }
  }, 180_000);
});


import { storeProductCoupon as supplierCouponLink, storeCouponIssue as supplierCouponIssue } from '@/models/schema';
import { supplierProductCouponsFixture } from './helpers/supplierProductCoupons';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier product coupon author and readonly catalogue', () => {
  let f: Awaited<ReturnType<typeof supplierProductCouponsFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned coupon author forbids providers')); f = await supplierProductCouponsFixture(); wiring.container = f.container; }, 30_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { await f?.close(); wiring.container = null; wiring.moderator = null; vi.restoreAllMocks(); } }, 30_000);
  async function call(path: string, body?: object, actor: keyof typeof f.tokens | 'anonymous' = 'manager') {
    const response = await app.request('/supplierapi' + path, { method: body ? 'POST' : 'GET', headers: {
      ...(actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + f.tokens[actor] }), 'X-Supplier-Id': '8',
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store'); return response.json<Envelope>();
  }
  const links = () => f.db.select().from(supplierCouponLink).where(eq(supplierCouponLink.productId, 80)).orderBy(supplierCouponLink.id);
  it.each([0, 1, 3])('writes, reads, preserves omission and clears coupons for fulfillment %i', async type => {
    const id = type === 1 ? 81 : 80;
    if (type === 3) { await f.db.update(storeProduct).set({ productType: 3 }).where(eq(storeProduct.id, id)); await f.db.update(storeProductAttrValue).set({ productType: 3 }).where(eq(storeProductAttrValue.productId, id)); }
    await f.withCouponWriter(async writer => { wiring.container = writer.container; const body = await f.body({}, id);
      const before = await f.product(id), saved = await call('/product/product/' + id, { ...body, coupon_ids: ['9102', 9101, 9101] }); expect(saved.status, saved.msg).toBe(200);
      const read = await call('/product/product/' + id); expect(read.data.coupon_selection).toEqual({ version: 1, ids: [9101, 9102], entries: [{ id: 9101, title: '本地固定窗口赠券', available: true }, { id: 9102, title: '本地停用赠券', available: true }], consistent: true, truncated: false });
      const bound = await f.db.select().from(supplierCouponLink).where(eq(supplierCouponLink.productId, id));
      expect((await call('/product/product/' + id, body)).status).toBe(200); expect(await f.db.select().from(supplierCouponLink).where(eq(supplierCouponLink.productId, id))).toEqual(bound);
      expect((await call('/product/product/' + id, { ...body, coupon_ids: [] })).status).toBe(200); expect((await call('/product/product/' + id)).data.coupon_selection.ids).toEqual([]);
      const current = await f.product(id); for (const key of ['giveIntegral', 'labelId', 'commandWord', 'customForm', 'systemFormId', 'isVipProduct', 'isPresaleProduct'] as const) expect(current[key]).toEqual(before[key]);
      const [rights] = await writer.db.execute(sql`SELECT current_user=session_user AS independent, has_table_privilege(current_user,'store_product_coupon','UPDATE') AS link_update, has_column_privilege(current_user,'store_coupon_issue','coupon_title','UPDATE') AS catalogue_edit`);
      expect(rights).toEqual({ independent: true, link_update: false, catalogue_edit: false });
    });
  });
  it('pages and searches literal titles under a SELECT-only viewer and rejects hidden query scope', async () => f.withReader(async reader => {
    wiring.container = reader.container; const before = await f.snapshot(), seq = await f.sequences();
    const one = await call('/product/coupon/catalog?page=1&limit=2', undefined, 'viewer'); expect(one.status, one.msg).toBe(200); expect(one.data).toMatchObject({ version: 1, count: 3, page: 1, limit: 2 }); expect(one.data.list.map((x: any) => x.id)).toEqual([9104, 9102]);
    const two = await call('/product/coupon/catalog?page=2&limit=2', undefined, 'viewer'); expect(two.data.list.map((x: any) => x.id)).toEqual([9101]);
    const literal = await call('/product/coupon/catalog?keyword='+encodeURIComponent('%_'), undefined, 'viewer'); expect(literal.data.list.map((x: any) => x.id)).toEqual([9104]);
    for (const query of ['supplier_id=8', 'limit=51', 'page=0', 'page=1&page=2', 'is_del=1']) expect((await call('/product/coupon/catalog?'+query, undefined, 'viewer')).status).toBe(400);
    for (const actor of ['denied', 'anonymous'] as const) expect((await call('/product/coupon/catalog', undefined, actor)).status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq);
    const [rights] = await reader.db.execute(sql`SELECT has_any_column_privilege(current_user,'store_coupon_issue','UPDATE') AS issue_write, has_any_column_privilege(current_user,'store_product_coupon','UPDATE') AS link_write`); expect(rights).toEqual({ issue_write: false, link_write: false });
  }));
  it('reads missing, deleted, duplicate and excessive historical links without granting new author authority', async () => f.withCouponWriter(async writer => {
    wiring.container = writer.container;
    await f.db.insert(supplierCouponLink).values([{ productId: 80, issueCouponId: 9103, title: '历史删除券' }, { productId: 80, issueCouponId: 99999, title: '历史缺失券' }, { productId: 80, issueCouponId: 99999, title: '重复行' }]);
    const read = await call('/product/product/80'); expect(read.data.coupon_selection).toMatchObject({ ids: [9103, 99999], consistent: false, truncated: false }); expect(read.data.coupon_selection.entries.every((x: any) => !x.available)).toBe(true);
    const before = await links(); expect((await call('/product/product/80', await f.body())).status).toBe(200); expect(await links()).toEqual(before);
    for (const ids of [[9103], [99999]]) { const state = await f.snapshot(); expect((await call('/product/product/80', await f.body({ coupon_ids: ids }))).status).not.toBe(200); expect(await f.snapshot()).toEqual(state); }
    await f.db.insert(supplierCouponLink).values(Array.from({ length: 101 }, () => ({ productId: 80, issueCouponId: 9101, title: '过多历史行' })));
    expect((await call('/product/product/80')).data.coupon_selection.truncated).toBe(true);
    expect((await call('/product/product/80', await f.body({ coupon_ids: [] }))).status).toBe(200); expect(await links()).toEqual([]);
  }));
  it('never targets coupon links on omission or undefined, even under executable DML tripwires', async () => f.withCouponWriter(async writer => {
    wiring.container = writer.container; await f.db.insert(supplierCouponLink).values({ productId: 80, issueCouponId: 9101, title: '保留原行' });
    await f.exec("CREATE FUNCTION owned_coupon_omit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'coupon DML entered'; END $$; CREATE TRIGGER owned_coupon_omit BEFORE INSERT OR DELETE ON public.store_product_coupon FOR EACH STATEMENT EXECUTE FUNCTION owned_coupon_omit()");
    await expect(f.db.delete(supplierCouponLink).where(eq(supplierCouponLink.productId, 80))).rejects.toThrow(); const before = await links(), body = await f.body();
    expect((await call('/product/product/80', body)).status).toBe(200); await new SupplierProductManagementService(writer.container, f.env).saveProduct(7, 80, { ...body, coupon_ids: undefined }); expect(await links()).toEqual(before);
  }));
  it('denies malformed, foreign and unauthorized writes without business or sequence changes', async () => f.withCouponWriter(async writer => {
    wiring.container = writer.container; const body = await f.body({ coupon_ids: [9101] }), before = await f.snapshot(), seq = await f.sequences();
    for (const actor of ['viewer', 'denied', 'other', 'anonymous'] as const) expect((await call('/product/product/80', body, actor)).status).not.toBe(200);
    for (const value of [null, false, {}, [0], [-1], ['bad'], [2147483648], Array(101).fill(1)]) expect((await call('/product/product/80', { ...body, coupon_ids: value })).status).toBe(400);
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq);
  }));
  it.each(['skip', 'rewrite', 'issue', 'main', 'actor', 'deferred'] as const)('rolls back %s coupon tampering with executable positive control', async mode => f.withCouponWriter(async writer => {
    const action = mode === 'skip' ? 'RETURN NULL;' : mode === 'rewrite' ? 'NEW.issue_coupon_id=9102; RETURN NEW;'
      : mode === 'issue' ? "UPDATE public.store_coupon_issue SET coupon_title='tampered' WHERE id=9101; RETURN NEW;"
      : mode === 'main' ? 'UPDATE public.store_product SET give_integral=99 WHERE id=80; RETURN NEW;'
      : mode === 'actor' ? "UPDATE public.system_role SET rules='supplier.product.view' WHERE id=21; RETURN NEW;"
      : "UPDATE public.store_product_coupon SET title='tampered' WHERE id=NEW.id; RETURN NEW;";
    const timing = mode === 'deferred' ? 'CREATE CONSTRAINT TRIGGER owned_coupon_tamper AFTER INSERT ON public.store_product_coupon DEFERRABLE INITIALLY DEFERRED'
      : `CREATE TRIGGER owned_coupon_tamper ${['skip','rewrite'].includes(mode) ? 'BEFORE' : 'AFTER'} INSERT ON public.store_product_coupon`;
    await f.exec(`CREATE FUNCTION owned_coupon_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN IF NEW.product_id=80 THEN ${action} END IF; RETURN NEW; END $$; ${timing} FOR EACH ROW EXECUTE FUNCTION owned_coupon_tamper()`);
    const marker = Error('owned coupon positive rollback');
    await expect(f.db.transaction(async tx => {
      const rows = await tx.insert(supplierCouponLink).values({ productId: 80, issueCouponId: 9101, title: '原题' }).returning(); await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      if (mode === 'skip') expect(rows).toHaveLength(0);
      else if (mode === 'rewrite') expect(rows[0].issueCouponId).toBe(9102);
      else if (mode === 'issue') expect((await tx.select().from(supplierCouponIssue).where(eq(supplierCouponIssue.id, 9101)))[0].couponTitle).toBe('tampered');
      else if (mode === 'main') expect((await tx.select().from(storeProduct).where(eq(storeProduct.id, 80)))[0].giveIntegral).toBe('99.00');
      else if (mode === 'actor') expect((await tx.select().from(systemRole).where(eq(systemRole.id, 21)))[0].rules).toBe('supplier.product.view');
      else expect((await tx.select().from(supplierCouponLink).where(eq(supplierCouponLink.id, rows[0].id)))[0].title).toBe('tampered');
      throw marker;
    })).rejects.toBe(marker);
    wiring.container = writer.container; const body = await f.body({ coupon_ids: [9101] }), before = await f.snapshot(); expect((await call('/product/product/80', body)).status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
  }));
  it('refuses an actual concurrent issuance writer lock with whole-business rollback', async () => f.withCouponWriter(async writer => f.withPeer!(async peer => {
    const held = signal(), release = signal(); wiring.container = writer.container;
    const holding = peer.db.transaction(async tx => { await tx.update(supplierCouponIssue).set({ title: 'locked' }).where(eq(supplierCouponIssue.id, 9101)); held.resolve(); await release.promise; throw Error('owned issue lock rollback'); }).catch(error => expect(error.message).toBe('owned issue lock rollback'));
    try { await held.promise; const body = await f.body({ coupon_ids: [9101] }), before = await f.snapshot(); expect((await call('/product/product/80', body)).status).not.toBe(200); expect(await f.snapshot()).toEqual(before); }
    finally { release.resolve(); await holding; }
  })));
});


import { storeCouponUser as supplierOwnedCoupon, storeCouponIssueUser as supplierRawCoupon,
  storeOrderProductCouponReward as supplierCouponReward } from '@/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier authored coupons actual paid HTTP lifecycle', () => {
  it.each([0, 1, 3])('grants current product issuance once for fulfillment %i after real payment and durable replay', async productType => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned Supplier coupon lifecycle forbids providers'));
    const full = await refundRuntimeFixture();
    try {
      const config: Record<string, string> = { integral_ratio_status: '0', order_give_integral: '0', order_give_exp: '0', member_func_status: '0', brokerage_func_status: '0', store_brokerage_statu: '0', balance_func_status: '1', yue_pay_status: '1' };
      for (const [menuName, value] of Object.entries(config)) { const changed = await full.db.update(pricingConfig).set({ value }).where(sql`${pricingConfig.menuName}=${menuName} AND ${pricingConfig.isStore}=0`).returning({ id: pricingConfig.id }); if (!changed.length) await full.db.insert(pricingConfig).values({ menuName, value }); }
      await full.db.update(pricingUser).set({ nowMoney: '100.00' }).where(eq(pricingUser.uid, 11));
      await full.db.update(pricingSupplier).set({ adminId: 21, isShow: 1, isDel: 0 }).where(eq(pricingSupplier.id, 7));
      const password = 'local-coupon-supplier-password', reviewPassword = 'local-coupon-review-password';
      await full.db.insert(systemAdmin).values([{ id: 21, account: 'local-coupon-supplier', pwd: password, adminType: 4, relationId: 7, status: 1, isDel: 0 }, { id: 101, account: 'local-coupon-review', pwd: reviewPassword, adminType: 1, relationId: 0, level: 0, status: 1, isDel: 0 }]);
      await full.db.insert(pricingCategory).values({ id: 800001, type: 2, relationId: 7, cateName: '本地赠券分类', isShow: 1 });
      const now = Math.floor(Date.now()/1000);
      await full.db.insert(supplierCouponIssue).values(Array.from({length:9},(_,i)=>({id:9100+i,title:'实际赠券 '+(9100+i),couponTitle:'实际赠券 '+(9100+i),couponType:0,type:1,couponPrice:'5.00',useMinPrice:'10.00',totalCount:10,remainCount:i===5?0:10,status:i===3?0:1,
        category:i===2?2:0,day:i===2?7:0,useStartTime:new Date((now-86400)*1000),useEndTime:new Date((now+(i===4?-1:86400))*1000),startTime:i===7?new Date((now+86400)*1000):null})));
      await full.exec(`SELECT setval(pg_get_serial_sequence('store_product','id'),800010,true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),800010,true); SELECT setval(pg_get_serial_sequence('store_cart','id'),800010,true)`);
      const queue = { send: vi.fn(async () => {}), sendBatch: vi.fn(async () => ({ successful: 1 })) }, sequence = vi.fn(async () => new Response('supplier_coupons_http_' + productType));
      const env = { ...full.env, NODE_ENV: 'test', APP_KEY: 'isolated-supplier-coupons-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', ORDER_QUEUE: queue,
        SEQUENCE: { idFromName: () => 'owned-supplier-coupons', get: () => ({ fetch: sequence }) }, CONFIG_KV: { ...full.env.CONFIG_KV, get: async (key:string) => key.startsWith('cfg_') && Object.hasOwn(config,key.slice(4)) ? config[key.slice(4)] : (full.env.CONFIG_KV as any).get(key) } } as unknown as Env;
      const supplierToken = (await createToken(21,'supplier',md5(password),env.APP_KEY)).token, reviewerToken = (await createToken(101,'admin',md5(reviewPassword),env.APP_KEY)).token;
      const [buyer] = await full.db.select().from(pricingUser).where(eq(pricingUser.uid,11)), [other] = await full.db.select().from(pricingUser).where(eq(pricingUser.uid,22));
      const buyerToken = (await createToken(11,'api',md5(buyer.pwd),env.APP_KEY)).token, otherToken = (await createToken(22,'api',md5(other.pwd),env.APP_KEY)).token;
      if (!full.withRuntimeRole) throw Error('Independent owned LOGINs required');
      await full.withRuntimeRole(appRole => full.withRuntimeRole!(async adminRole => {
        const [database] = await full.db.execute(sql`SELECT current_database() AS name`), names = { app: appRole.role, admin: adminRole.role, maintenance: 'finance_test', database: String(database.name), pricingOwner: full.pricingOwner };
        await runRuntimeBusinessCommissioning(full.db,names); expect((await runRoutinePaymentRuntimeInstallation(full.db,names)).after.ready).toBe(true);
        expect(await auditRuntimeBusinessPrivileges(appRole.db,'app',names)).toMatchObject({ready:true,failures:[]}); expect(await auditRuntimeBusinessPrivileges(adminRole.db,'admin',names)).toMatchObject({ready:true,failures:[]});
        const container = createContainerFromDb(appRole.db); wiring.container = container; wiring.moderator = createContainerFromDb(adminRole.db);
        async function request(method:string,path:string,body?:object,token?:string) { const tasks:Promise<unknown>[]=[];const response=await app.request(path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})},env,{waitUntil:task=>{tasks.push(task);},passThroughOnException(){},props:{}});await Promise.all(tasks);return response.json<Envelope>(); }
        async function ok(method:string,path:string,body?:object,token?:string) {const result=await request(method,path,body,token);expect(result.status,result.msg).toBe(200);return result.data;}
        const body={product_type:productType,store_name:'实际赠券商品 '+productType,cate_id:[800001],slider_image:['/supplier-coupons.png'],spec_type:0,freight:1,is_postage:1,is_sub:[],coupon_ids:[9100],attrs:[{price:'10.00',settle_price:'1.00',vip_price:'0.00',stock:8,...(productType===1?{delivery_mode:'fixed',disk_info:'Supplier coupon fixed delivery'}:{})}]};
        const made=await ok('POST','/supplierapi/product/product/0',body,supplierToken), id=Number(made.id);
        expect((await ok('GET','/supplierapi/product/product/'+id,undefined,supplierToken)).coupon_selection.ids).toEqual([9100]);
        await ok('POST','/adminapi/product/product/set_verify/'+id,{is_verify:1,is_show:1,refusal:'',auto_on_time:''},reviewerToken);
        const [sku]=await container.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId,id));
        const cart=await ok('POST','/api/cart/add',{productId:id,unique:sku.unique,cartNum:3,new:1,type:0},buyerToken), cartIds=[cart.id];
        if(productType===0) {
          const sibling=await ok('POST','/supplierapi/product/product/0',{...body,store_name:'同单重复赠券商品',coupon_ids:[9101,9102]},supplierToken);
          await ok('POST','/adminapi/product/product/set_verify/'+sibling.id,{is_verify:1,is_show:1,refusal:'',auto_on_time:''},reviewerToken);
          const [siblingSku]=await container.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId,sibling.id));cartIds.push((await ok('POST','/api/cart/add',{productId:sibling.id,unique:siblingSku.unique,cartNum:1,new:1,type:0},buyerToken)).id);
        }
        const selection={cartIds,type:0,shippingType:1,useIntegral:false,...(productType===0?{addressId:11}:{})}, price=productType===0?'40.00':'30.00';
        const confirmed=await ok('POST','/api/order/confirm',selection,buyerToken);expect(confirmed.priceGroup.pay_price).toBe(price);
        const createBody={...selection,quoteToken:confirmed.quoteToken}, order=await ok('POST','/api/order/create/'+confirmed.orderKey,createBody,buyerToken);
        expect((await ok('POST','/api/order/create/'+confirmed.orderKey,createBody,buyerToken)).orderId).toBe(order.orderId);expect(sequence).toHaveBeenCalledTimes(1);
        const [root]=await container.db.select().from(pricingOrder).where(eq(pricingOrder.orderId,order.orderId));
        const frozen=await container.db.select().from(purchaseCartInfo).where(eq(purchaseCartInfo.oid,root.id));
        const read=await ok('GET','/supplierapi/product/product/'+id,undefined,supplierToken);
        await ok('POST','/supplierapi/product/product/'+id,{...body,attrs:read.attrs,coupon_ids:[9101,9102,9103,9104,9105,9106,9107,9108]},supplierToken);
        expect(await container.db.select().from(purchaseCartInfo).where(eq(purchaseCartInfo.oid,root.id))).toEqual(frozen);
        expect((await ok('POST','/api/order/prize/'+order.orderId,{},buyerToken)).coupons).toEqual([]);
        expect((await ok('POST','/api/order/pay',{uni:order.orderId,paytype:'yue'},buyerToken)).paid).toBe(true);expect((await ok('POST','/api/order/pay',{uni:order.orderId,paytype:'yue'},buyerToken)).paid).toBe(true);
        expect((await container.db.select().from(pricingUser).where(eq(pricingUser.uid,11)))[0].nowMoney).toBe(productType===0?'60.00':'70.00');
        expect(await container.db.select().from(supplierCouponReward)).toEqual([]);
        await full.db.update(supplierCouponIssue).set({isDel:1}).where(eq(supplierCouponIssue.id,9106));
        const [paid]=await container.db.select().from(purchaseOutbox).where(eq(purchaseOutbox.eventType,'order.paid'));
        const consumer=new OrderOutboxService(container,env),message={action:'processOrderPaidOutbox' as const,outboxId:paid.id,eventKey:paid.eventKey};expect(await consumer.processMessage(message)).toBe('completed');
        const owned=await container.db.select().from(supplierOwnedCoupon).where(eq(supplierOwnedCoupon.uid,11)).orderBy(supplierOwnedCoupon.issueCouponId);
        expect(owned.map(x=>x.issueCouponId)).toEqual([9101,9102,9108]);expect(owned.every(x=>x.receiveSource==='order'&&x.status===0)).toBe(true);
        expect(owned.find(x=>x.issueCouponId===9102)!.endTime!.getTime()-owned.find(x=>x.issueCouponId===9102)!.startTime!.getTime()).toBe(7*86400*1000);
        const rewards=await container.db.select().from(supplierCouponReward).orderBy(supplierCouponReward.issueCouponId);expect(rewards).toHaveLength(3);expect(rewards.every(x=>x.orderId===root.id&&x.uid===11)).toBe(true);
        expect((await container.db.select().from(supplierRawCoupon).where(eq(supplierRawCoupon.uid,11))).map(x=>x.issueCouponId).sort()).toEqual([9101,9108]);
        const issues=await container.db.select().from(supplierCouponIssue).where(sql`${supplierCouponIssue.id} BETWEEN 9100 AND 9108`).orderBy(supplierCouponIssue.id);
        expect(issues.map(x=>[x.id,x.remainCount])).toEqual([[9100,10],[9101,9],[9102,9],[9103,10],[9104,10],[9105,0],[9106,10],[9107,10],[9108,9]]);
        const prize=await ok('POST','/api/order/prize/'+order.orderId,{},buyerToken);expect(prize.coupons.map((x:any)=>x.cid)).toEqual([9101,9102,9108]);
        expect((await request('POST','/api/order/prize/'+order.orderId,{},otherToken)).status).not.toBe(200);
        const current=await ok('GET','/supplierapi/product/product/'+id,undefined,supplierToken);await ok('POST','/supplierapi/product/product/'+id,{...body,attrs:current.attrs,coupon_ids:[]},supplierToken);
        expect(await consumer.processMessage(message)).toBe('already-completed');
        expect(await container.db.select().from(supplierOwnedCoupon).where(eq(supplierOwnedCoupon.uid,11)).orderBy(supplierOwnedCoupon.issueCouponId)).toEqual(owned);
        expect(await container.db.select().from(supplierCouponReward).orderBy(supplierCouponReward.issueCouponId)).toEqual(rewards);expect((await ok('POST','/api/order/prize/'+order.orderId,{},buyerToken)).coupons).toEqual(prize.coupons);
      }));
      expect(network).not.toHaveBeenCalled();
    } finally { wiring.container=null; wiring.moderator=null; network.mockRestore(); await full.close(); }
  },180_000);
});

import { userLabel as purchasedUserLabel, userLabelRelation as purchasedUserRelation, storeProductRelation as purchasedProductRelation } from '@/models/schema';
import { supplierProductUserLabelsFixture } from './helpers/supplierProductUserLabels';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier purchased user label author and readonly catalogue', () => {
  let f: Awaited<ReturnType<typeof supplierProductUserLabelsFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Owned user-label test forbids external providers')); f=await supplierProductUserLabelsFixture(); wiring.container=f.container; },30000);
  afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{await f?.close();wiring.container=null;wiring.moderator=null;vi.restoreAllMocks();}},30000);
  async function call(path:string,body?:object,actor:keyof typeof f.tokens|'anonymous'='manager') {
    const response=await app.request('/supplierapi'+path,{method:body?'POST':'GET',headers:{...(actor==='anonymous'?{}:{Authorization:'Bearer '+f.tokens[actor]}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})},f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store');return response.json<Envelope>();
  }
  const links=(id=80)=>f.db.select().from(purchasedProductRelation).where(sql`${purchasedProductRelation.productId}=${id} AND ${purchasedProductRelation.type}=4`).orderBy(purchasedProductRelation.id);
  it.each([0,1,3])('binds platform user labels without changing display labels, preserves omission and clears fulfillment %i',async type=>f.withUserLabelWriter(async writer=>{
    wiring.container=writer.container;const id=type===1?81:80;
    if(type===3){await f.db.update(storeProduct).set({productType:3}).where(eq(storeProduct.id,id));await f.db.update(storeProductAttrValue).set({productType:3}).where(eq(storeProductAttrValue.productId,id));}
    const body=await f.body({},id),before=await f.product(id);
    const saved=await call('/product/product/'+id,{...body,label_id:[{id:'9202',name:'forged'},9201]});expect(saved.status,saved.msg).toBe(200);
    const read=await call('/product/product/'+id);expect(read.data.user_label_selection).toEqual({version:1,ids:[9202,9201],entries:[{id:9202,title:'平台%_客户',available:true},{id:9201,title:'平台购买用户',available:true}],consistent:true,truncated:false});
    expect((await f.product(id)).storeLabelId).toBe(before.storeLabelId);const bound=await links(id);expect((await call('/product/product/'+id,body)).status).toBe(200);expect(await links(id)).toEqual(bound);
    expect((await call('/product/product/'+id,{...body,label_id:[]})).status).toBe(200);expect(await links(id)).toEqual([]);expect((await f.product(id)).labelId).toBe('');
    const [rights]=await writer.db.execute(sql`SELECT current_user=session_user AS independent,has_column_privilege(current_user,'user_label','name','UPDATE') AS catalogue_edit`);expect(rights).toEqual({independent:true,catalogue_edit:false});
  }));
  it('filters platform scope and active status using an actual SELECT-only viewer and literal search',async()=>f.withReader(async reader=>{
    wiring.container=reader.container;const before=await f.snapshot(),seq=await f.sequences();
    const page=await call('/product/user-label/catalog?limit=1',undefined,'viewer');expect(page.status,page.msg).toBe(200);expect(page.data).toEqual({version:1,list:[{id:9202,title:'平台%_客户'}],count:2,page:1,limit:1,runtime_configured:false});
    expect((await call('/product/user-label/catalog?keyword=%25_',undefined,'viewer')).data.list.map((x:any)=>x.id)).toEqual([9202]);
    for(const query of ['supplier_id=7','type=2','status=0','page=0','limit=51','page=1&page=2'])expect((await call('/product/user-label/catalog?'+query,undefined,'viewer')).status).toBe(400);
    for(const actor of ['denied','anonymous'] as const)expect((await call('/product/user-label/catalog',undefined,actor)).status).not.toBe(200);
    const [rights]=await reader.db.execute(sql`SELECT has_any_column_privilege(current_user,'user_label','UPDATE') AS write`);expect(rights.write).toBe(false);expect(await f.snapshot()).toEqual(before);expect(await f.sequences()).toEqual(seq);
  }));
  it('preserves unsupported legacy IDs and malformed scalar on omission, hides foreign names and allows explicit repair',async()=>f.withUserLabelWriter(async writer=>{
    wiring.container=writer.container;await f.db.update(storeProduct).set({labelId:'61,9203,9204,99999'}).where(eq(storeProduct.id,80));
    const read=await call('/product/product/80');expect(read.data.user_label_selection).toMatchObject({ids:[61,9203,9204,99999],consistent:false});expect(read.data.user_label_selection.entries.every((x:any)=>!x.available)).toBe(true);expect(JSON.stringify(read.data.user_label_selection)).not.toContain('外部门店私密');
    const body=await f.body();expect((await call('/product/product/80',body)).status).toBe(200);expect((await f.product(80)).labelId).toBe('61,9203,9204,99999');
    for(const id of [61,9203,9204,99999]){const before=await f.snapshot();expect((await call('/product/product/80',{...body,label_id:[id]})).status).not.toBe(200);expect(await f.snapshot()).toEqual(before);}
    await f.db.update(storeProduct).set({labelId:'bad,01'}).where(eq(storeProduct.id,80));expect((await call('/product/product/80')).data.user_label_selection).toMatchObject({ids:[],consistent:false});
    expect((await call('/product/product/80',{...body,label_id:[]})).status).toBe(200);expect((await f.product(80)).labelId).toBe('');
  }));
  it('does not perform type4 DML on omitted or undefined fields even with executable tripwires',async()=>f.withUserLabelWriter(async writer=>{
    wiring.container=writer.container;await f.exec("CREATE FUNCTION owned_user_label_omit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (TG_OP='DELETE' AND OLD.type=4) OR (TG_OP='INSERT' AND NEW.type=4) THEN RAISE EXCEPTION 'type4 DML entered'; END IF; IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_user_label_omit BEFORE INSERT OR DELETE ON public.store_product_relation FOR EACH ROW EXECUTE FUNCTION owned_user_label_omit()");
    await expect(f.db.insert(purchasedProductRelation).values({productId:80,type:4,relationId:9201})).rejects.toThrow();const body=await f.body(),before=await links();
    expect((await call('/product/product/80',body)).status).toBe(200);await new SupplierProductManagementService(writer.container,f.env).saveProduct(7,80,{...body,label_id:undefined});expect(await links()).toEqual(before);
  }));
  it('rejects invalid, foreign and unauthorized author intent before business or sequence changes',async()=>f.withUserLabelWriter(async writer=>{
    wiring.container=writer.container;const body=await f.body(),before=await f.snapshot(),seq=await f.sequences();
    for(const actor of ['viewer','denied','other','anonymous'] as const)expect((await call('/product/product/80',{...body,label_id:[9201]},actor)).status).not.toBe(200);
    for(const label_id of [null,'9201',false,[9201,9201],[0],['01'],[2147483648],Array(101).fill(1),Array.from({length:7},(_,i)=>2147483640+i)])expect((await call('/product/product/80',{...body,label_id})).status).toBe(400);
    expect(await f.snapshot()).toEqual(before);expect(await f.sequences()).toEqual(seq);
  }));
  it('combines user labels with every existing explicit metadata author without weakening protected relations',async()=>f.withUserLabelWriter(async writer=>{
    wiring.container=writer.container;
    const result=await call('/product/product/80',await f.body({label_id:[9201],give_integral:'2.75',recommend_image:'/api/assets/31',store_label_id:[31],brand_id:[104,105],ensure_id:[201],specs_id:301,specs:[{name:'材质',value:'棉'}],system_form_id:401,is_vip_product:1,is_presale_product:0,is_sub:[],auto_on_time:Math.floor(Date.now()/1000)+3600}));
    expect(result.status,result.msg).toBe(200);expect(await f.product()).toMatchObject({labelId:'9201',storeLabelId:'31',giveIntegral:'2.75',recommendImage:'/api/assets/31',brandId:105,ensureId:'201',specsId:301,systemFormId:401,isVipProduct:1});
    const relations=await f.db.select().from(purchasedProductRelation).where(eq(purchasedProductRelation.productId,80));expect(relations.filter(x=>x.type===4).map(x=>x.relationId)).toEqual([9201]);expect(relations.filter(x=>x.type===3).map(x=>x.relationId)).toEqual([31]);expect(relations.some(x=>x.type===1)).toBe(true);
  }));
  it.each(['skip','rewrite','catalogue','main','other-relation','actor','deferred'] as const)('rolls back %s tampering after an executable positive control',async mode=>f.withUserLabelWriter(async writer=>{
    const action=mode==='skip'?'RETURN NULL;':mode==='rewrite'?'NEW.relation_id=9202; RETURN NEW;':mode==='catalogue'?"UPDATE user_label SET name='tampered' WHERE id=9201; RETURN NEW;":mode==='main'?'UPDATE store_product SET give_integral=99 WHERE id=80; RETURN NEW;':mode==='other-relation'?'DELETE FROM store_product_relation WHERE product_id=80 AND type=1; RETURN NEW;':mode==='actor'?"UPDATE system_role SET rules='supplier.product.view' WHERE id=21; RETURN NEW;":'UPDATE store_product_relation SET relation_pid=99 WHERE id=NEW.id; RETURN NEW;';
    const timing=mode==='deferred'?'CREATE CONSTRAINT TRIGGER owned_user_tamper AFTER INSERT ON store_product_relation DEFERRABLE INITIALLY DEFERRED':`CREATE TRIGGER owned_user_tamper ${['skip','rewrite'].includes(mode)?'BEFORE':'AFTER'} INSERT ON store_product_relation`;
    await f.exec(`CREATE FUNCTION owned_user_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN IF NEW.product_id=80 AND NEW.type=4 THEN ${action} END IF; RETURN NEW; END $$; ${timing} FOR EACH ROW EXECUTE FUNCTION owned_user_tamper()`);
    const marker=Error('owned positive control rollback');await expect(f.db.transaction(async tx=>{
      const rows=await tx.insert(purchasedProductRelation).values({productId:80,type:4,relationId:9201}).returning();await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      if(mode==='skip')expect(rows).toHaveLength(0);else if(mode==='rewrite')expect(rows[0].relationId).toBe(9202);else if(mode==='catalogue')expect((await tx.select().from(purchasedUserLabel).where(eq(purchasedUserLabel.id,9201)))[0].name).toBe('tampered');else if(mode==='main')expect((await tx.select().from(storeProduct).where(eq(storeProduct.id,80)))[0].giveIntegral).toBe('99.00');else if(mode==='other-relation')expect(await tx.select().from(purchasedProductRelation).where(sql`${purchasedProductRelation.productId}=80 AND ${purchasedProductRelation.type}=1`)).toEqual([]);else if(mode==='actor')expect((await tx.select().from(systemRole).where(eq(systemRole.id,21)))[0].rules).toBe('supplier.product.view');else expect((await tx.select().from(purchasedProductRelation).where(eq(purchasedProductRelation.id,rows[0].id)))[0].relationPid).toBe(99);throw marker;
    })).rejects.toBe(marker);
    wiring.container=writer.container;const body=await f.body({label_id:[9201]}),before=await f.snapshot(),catalog=await f.db.select().from(purchasedUserLabel);expect((await call('/product/product/80',body)).status).not.toBe(200);expect(await f.snapshot()).toEqual(before);expect(await f.db.select().from(purchasedUserLabel)).toEqual(catalog);
  }));
  it('refuses an actual concurrent platform user label writer without partial writes',async()=>f.withUserLabelWriter(async writer=>f.withPeer!(async peer=>{
    const held=signal(),release=signal();wiring.container=writer.container;
    const holding=peer.db.transaction(async tx=>{await tx.update(purchasedUserLabel).set({name:'locked'}).where(eq(purchasedUserLabel.id,9201));held.resolve();await release.promise;throw Error('owned label rollback');}).catch(error=>expect(error.message).toBe('owned label rollback'));
    try{await held.promise;const body=await f.body({label_id:[9201]}),before=await f.snapshot();expect((await call('/product/product/80',body)).status).not.toBe(200);expect(await f.snapshot()).toEqual(before);}finally{release.resolve();await holding;}
  })));
});

import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { installPurchasedProductLabelStorage } from '@/migrations/installPurchasedProductLabelStorage';
import { upgradePurchasedProductLabelRuntime } from '@/migrations/upgradePurchasedProductLabelRuntime';
import { capturePurchasedLabelRuntimeDeclaration } from '@/services/order/PurchasedProductLabelRuntimeDeclaration';
import { PurchasedProductLabelTaskService } from '@/services/order/PurchasedProductLabelTaskService';
import { capturePurchasedProductLabelMessage } from '@/services/order/PurchasedProductLabelQueue';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier authored purchased user labels actual five-profile paid lifecycle',()=>{
  it('creates real Supplier orders for all three fulfillments, consumes current config once and preserves immutable replay results',async()=>{
    const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Owned Supplier user-label lifecycle forbids providers'));
    const f=await customerCashierRuntimeHttpFixture();
    try {
      const db=f.maintenanceDb,addon={purchasedProductLabels:true} as const;
      await installPurchasedProductLabelStorage(db,{database:f.target.database,maintenance:f.target.maintenance},addon);
      const peers=capturePurchasedLabelRuntimeDeclaration({...f.peers,purchasedProductLabels:addon});
      await upgradePurchasedProductLabelRuntime(db,peers,f.appReaders);
      const config:Record<string,string>={integral_ratio_status:'0',order_give_integral:'0',order_give_exp:'0',member_func_status:'0',brokerage_func_status:'0',store_brokerage_statu:'0',balance_func_status:'1',yue_pay_status:'1'};
      for(const [menuName,value] of Object.entries(config)){const rows=await db.update(pricingConfig).set({value}).where(sql`${pricingConfig.menuName}=${menuName} AND ${pricingConfig.isStore}=0`).returning({id:pricingConfig.id});if(!rows.length)await db.insert(pricingConfig).values({menuName,value});}
      await db.insert(pricingSupplier).values({id:7,adminId:21,isShow:1,isDel:0,supplierName:'Owned Supplier labels'}).onConflictDoUpdate({target:pricingSupplier.id,set:{adminId:21,isShow:1,isDel:0}});
      const password='owned-user-label-supplier-password';await db.insert(systemAdmin).values({id:21,account:'owned-user-label-supplier',pwd:password,adminType:4,relationId:7,status:1,isDel:0});
      await db.insert(pricingCategory).values({id:800001,type:2,relationId:7,cateName:'本地购买标签分类',isShow:1});
      await f.exec("SELECT setval(pg_get_serial_sequence('store_product','id'),800010,true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),800010,true); SELECT setval(pg_get_serial_sequence('store_cart','id'),800010,true)");
      let counter=0;const sequence=vi.fn(async()=>new Response('supplier_user_labels_http_'+(++counter))),queue={send:vi.fn(async()=>{}),sendBatch:vi.fn(async()=>{})};
      const env={...f.env,NODE_ENV:'test',PURCHASED_PRODUCT_LABEL_RUNTIME:peers,ORDER_QUEUE:queue,SEQUENCE:{idFromName:()=>({}),get:()=>({fetch:sequence})},CONFIG_KV:{...f.env.CONFIG_KV,get:async(key:string)=>key.startsWith('cfg_')&&Object.hasOwn(config,key.slice(4))?config[key.slice(4)]:(f.env.CONFIG_KV as any).get(key)}} as unknown as Env;
      const container=createContainerFromDb(f.appRuntime.db);wiring.container=container;wiring.moderator=createContainerFromDb(f.adminRuntime.db);
      const supplierToken=(await createToken(21,'supplier',md5(password),env.APP_KEY)).token,reviewerToken=await f.bearer(1,'admin','offline-native-admin-password'),buyerToken=await f.bearer(11);
      async function request(method:string,path:string,body?:object,token=supplierToken,bindings=env){const tasks:Promise<unknown>[]=[];const response=await app.request(path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})},bindings,{waitUntil:task=>{tasks.push(task);},passThroughOnException(){},props:{}});await Promise.all(tasks);return response.json<Envelope>();}
      async function ok(method:string,path:string,body?:object,token=supplierToken,bindings=env){const response=await request(method,path,body,token,bindings);expect(response.status,response.msg).toBe(200);return response.data;}
      expect((await ok('GET','/supplierapi/product/user-label/catalog')).runtime_configured).toBe(true);
      for(const productType of [0,1,3]) {
        const base=9300+productType*10;await db.update(pricingUser).set({nowMoney:'100.00'}).where(eq(pricingUser.uid,11));
        await db.insert(purchasedUserLabel).values(Array.from({length:4},(_,i)=>({id:base+i,name:'实际购买用户标签 '+(base+i),type:0,relationId:0,status:1})));
        await db.insert(purchasedUserRelation).values([{uid:11,type:0,relationId:0,labelId:base+1},{uid:22,type:1,relationId:8,labelId:base+3}]);
        const body={product_type:productType,store_name:'实际用户标签商品 '+productType,cate_id:[800001],slider_image:['/supplier-user-label.png'],spec_type:0,freight:1,is_postage:1,is_sub:[],label_id:[base],attrs:[{price:'10.00',settle_price:'1.00',vip_price:'0.00',stock:8,...(productType===1?{delivery_mode:'fixed',disk_info:'Owned user label fixed delivery'}:{})}]};
        const made=await ok('POST','/supplierapi/product/product/0',body),id=Number(made.id);
        expect((await ok('GET','/supplierapi/product/product/'+id)).user_label_selection.ids).toEqual([base]);
        await ok('POST','/adminapi/product/product/set_verify/'+id,{is_verify:1,is_show:1,refusal:'',auto_on_time:''},reviewerToken);
        const [sku]=await container.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId,id));
        const cart=await ok('POST','/api/cart/add',{productId:id,unique:sku.unique,cartNum:3,new:1,type:0},buyerToken);
        const selection={cartIds:[cart.id],type:0,shippingType:1,useIntegral:false,...(productType===0?{addressId:11}:{})};
        const quote=await ok('POST','/api/order/confirm',selection,buyerToken),creation={...selection,quoteToken:quote.quoteToken};expect(quote.priceGroup.pay_price).toBe('30.00');
        const order=await ok('POST','/api/order/create/'+quote.orderKey,creation,buyerToken);expect((await ok('POST','/api/order/create/'+quote.orderKey,creation,buyerToken)).orderId).toBe(order.orderId);
        const [root]=await container.db.select().from(pricingOrder).where(eq(pricingOrder.orderId,order.orderId));
        const frozen=await container.db.select().from(purchaseCartInfo).where(eq(purchaseCartInfo.oid,root.id));
        expect((await ok('POST','/api/order/pay',{uni:order.orderId,paytype:'yue'},buyerToken)).paid).toBe(true);expect((await ok('POST','/api/order/pay',{uni:order.orderId,paytype:'yue'},buyerToken)).paid).toBe(true);
        expect((await container.db.select().from(pricingUser).where(eq(pricingUser.uid,11)))[0].nowMoney).toBe('70.00');
        const [paid]=await container.db.select().from(purchaseOutbox).where(sql`${purchaseOutbox.aggregateId}=${root.id} AND ${purchaseOutbox.eventType}='order.paid'`);
        const consumer=new OrderOutboxService(container,env),paidMessage={action:'processOrderPaidOutbox' as const,outboxId:paid.id,eventKey:paid.eventKey};expect(await consumer.processMessage(paidMessage)).toBe('completed');
        const [leaf]=await container.db.select().from(pricingOrder).where(sql`(${pricingOrder.id}=${root.id} OR ${pricingOrder.pid}=${root.id}) AND ${pricingOrder.pid}>=0 AND ${pricingOrder.supplierId}=7`);expect(leaf).toMatchObject({paid:1,supplierId:7,storeId:0,productType});
        const tasks=await db.execute<{taskId:string;eventKey:string;status:string}>(sql`SELECT i.task_id::text AS "taskId",i.event_key AS "eventKey",s.status FROM purchased_product_label_intent i JOIN purchased_product_label_state s USING(task_id) WHERE i.order_id=${leaf.id}`);expect(tasks).toHaveLength(1);expect(['PENDING','ENQUEUED']).toContain(tasks[0].status);
        const message=capturePurchasedProductLabelMessage({action:'processPurchasedProductLabels',taskId:tasks[0].taskId,eventKey:tasks[0].eventKey});
        expect(await db.execute(sql`SELECT * FROM purchased_product_label_result WHERE task_id=${message.taskId}::uuid`)).toEqual([]);
        const memberships=()=>db.select().from(purchasedUserRelation).where(sql`${purchasedUserRelation.labelId} BETWEEN ${base} AND ${base+3}`).orderBy(purchasedUserRelation.id);
        expect((await memberships()).filter(x=>x.uid===11).map(x=>x.labelId)).toEqual([base+1]);
        // Change after both real payment and independent task creation. The
        // current, now hidden pending-review source still supplies task config.
        const read=await ok('GET','/supplierapi/product/product/'+id);await ok('POST','/supplierapi/product/product/'+id,{...body,attrs:read.attrs,label_id:[base+1,base+2,base+3]});
        await db.update(purchasedUserLabel).set({status:0}).where(eq(purchasedUserLabel.id,base+2));
        const task=new PurchasedProductLabelTaskService(container,env);expect(await task.process(message)).toBe('completed');
        const [receipt]=await db.execute<{result:any}>(sql`SELECT result FROM purchased_product_label_result WHERE task_id=${message.taskId}::uuid`);
        expect(receipt.result).toMatchObject({userId:11,financialStoreId:0,products:[{productId:id,found:true,labelIds:[base+1,base+2,base+3].join(',')}],targets:[{labelId:base+1,type:0,relationId:0,added:false},{labelId:base+3,type:0,relationId:0,added:true}],skipped:[{labelId:base+2,reason:'retired'}]});
        expect((await memberships()).filter(x=>x.uid===11).map(x=>x.labelId).sort()).toEqual([base+1,base+3]);expect((await memberships()).filter(x=>x.uid===22)).toMatchObject([{type:1,relationId:8,labelId:base+3}]);
        const current=await ok('GET','/supplierapi/product/product/'+id);await ok('POST','/supplierapi/product/product/'+id,{...body,attrs:current.attrs,label_id:[]});
        expect(await consumer.processMessage(paidMessage)).toBe('already-completed');expect(await task.process(message)).toBe('already-completed');
        // Receipt-first replay never recreates a manually removed membership.
        await db.delete(purchasedUserRelation).where(sql`${purchasedUserRelation.uid}=11 AND ${purchasedUserRelation.labelId}=${base+3}`);const stable=await memberships();
        expect(await task.process(message)).toBe('already-completed');expect(await memberships()).toEqual(stable);expect((await db.execute<{result:any}>(sql`SELECT result FROM purchased_product_label_result WHERE task_id=${message.taskId}::uuid`))[0].result).toEqual(receipt.result);
        expect(await container.db.select().from(purchaseCartInfo).where(eq(purchaseCartInfo.oid,root.id))).toEqual(frozen);
      }
      expect(sequence).toHaveBeenCalledTimes(3);expect(network).not.toHaveBeenCalled();
    }finally{wiring.container=null;wiring.moderator=null;network.mockRestore();await f.close();}
  },240000);
});
