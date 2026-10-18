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
