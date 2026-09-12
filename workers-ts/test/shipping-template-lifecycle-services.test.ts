import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import type { AppVariables, Env } from '../src/env';
import { errorHandler } from '../src/middleware/error';
import { adminShippingTemplateDel, adminShippingTemplateSave, adminActivitySave } from '../src/controllers/api/v1/AdminCrudController';
import { SupplierShippingTemplateService } from '../src/services/supplier/SupplierShippingTemplateService';
import { SupplierProductManagementService } from '../src/services/supplier/SupplierProductManagementService';
import { OutProductService } from '../src/services/out/OutProductService';
import { AdminMobileProductService } from '../src/services/admin/AdminMobileProductService';
import { AdminDiscountPackageService } from '../src/services/activity/AdminDiscountPackageService';
import { lockShippingTemplateBindings, retireShippingTemplate } from '../src/services/product/ShippingTemplateLifecycleService';
import { ValidateException } from '../src/utils/errors';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const refs = ['store_product', 'store_seckill', 'store_bargain', 'store_combination', 'store_integral', 'store_discounts_products'] as const;
const stateTables = [...refs, 'shipping_templates', 'shipping_templates_region', 'shipping_templates_free', 'shipping_templates_no_delivery',
  'store_order', 'store_product_attr_value', 'store_product_attr', 'store_product_attr_result', 'store_product_relation',
  'store_product_description', 'store_discounts', 'out_product_write_replay', 'system_log'];
const product = (supplier = false) => ({ product_type: 0, store_name: 'lifecycle product', cate_id: [supplier ? 12 : 9],
  slider_image: ['/isolated.png'], spec_type: 0, freight: 3, temp_id: supplier ? 20 : 10, delivery_type: [1],
  attrs: [{ suk: '默认', price: '10.00', settle_price: '5.00', stock: 10 }], is_show: 1 });
const actor = { id: 7, name: 'fixture', ip: '127.0.0.1' };
const app = (db: DbClient) => {
  const a = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  a.use('*', async (c, next) => { c.set('container', createContainerFromDb(db)); await next(); });
  // Actual error handling, not an all-errors-to-400 test substitute.
  a.onError(errorHandler);
  a.delete('/delete/:id', adminShippingTemplateDel); a.post('/save', adminShippingTemplateSave); a.post('/activity', adminActivitySave);
  return a;
};
const http = async (db: DbClient, path: string, body?: object) => {
  const r = await app(db).request(path, { method: body ? 'POST' : 'DELETE',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() as { status: number; msg: string } };
};

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual shipping lifecycle services, full ORM PG16 without candidate triggers', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
    await f.exec("INSERT INTO store_order(id,order_id,pay_postage,cart_id) VALUES(999,'historical-shipping','12.34','[77]')");
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);
  beforeEach(async () => {
    // All targets belong to this suite's random database. Historical order is
    // deliberately retained across every case, and included in row snapshots.
    await f.exec(`TRUNCATE ${stateTables.filter(t => t !== 'store_order').join(',')},store_product_category RESTART IDENTITY CASCADE`);
    await f.exec(`INSERT INTO shipping_templates(id,name,owner_type,relation_id) VALUES(1,'default',0,0),(10,'platform',0,0),(20,'supplier',2,20);
      INSERT INTO shipping_templates_region(template_id,first_price) VALUES(10,'6.00'),(20,'7.00');
      INSERT INTO shipping_templates_free(temp_id) VALUES(20); INSERT INTO shipping_templates_no_delivery(temp_id) VALUES(20);
      INSERT INTO store_product(id,store_name,stock,is_show,is_verify,type,relation_id,temp_id,freight) VALUES(100,'platform',10,1,1,0,0,0,1),(200,'supplier',10,1,1,2,20,0,1);
      INSERT INTO store_product_attr_value(id,product_id,"unique",suk,price,stock) VALUES(101,100,'BASE0001','默认','10.00',10),(201,200,'SUPP0001','默认','10.00',10);
      INSERT INTO store_product_category(id,cate_name,type,relation_id) VALUES(9,'platform',0,0),(12,'supplier',2,20);
      SELECT setval(pg_get_serial_sequence('store_product','id'),1000,false);
      SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1000,false)`);
  });
  const snapshot = () => f.query(`SELECT jsonb_build_object(${stateTables.map(t => `'${t}',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM ${t} t)`).join(',')}) AS state`);
  const bind = (table: typeof refs[number], template = 10) => f.exec(table === 'store_product'
    ? `UPDATE store_product SET temp_id=${template},freight=3 WHERE id=100`
    : table === 'store_discounts_products'
      ? `INSERT INTO ${table}(id,product_id,temp_id) VALUES(1,100,${template})`
      : `INSERT INTO ${table}(id,product_id,temp_id,freight) VALUES(1,100,${template},3)`);
  const write = (kind: string, db: DbClient): Promise<unknown> => {
    const container = createContainerFromDb(db);
    if (kind === 'out') return new OutProductService(container).save({ id: 7 }, 0, product(), crypto.randomUUID());
    if (kind === 'supplier') return new SupplierProductManagementService(container).saveProduct(20, 0, product(true));
    if (kind === 'mobile') return new AdminMobileProductService(container).batchProcess({ type: 8, ids: [100], data: { freight: 3, temp_id: 10 } }, actor);
    if (kind === 'package') return new AdminDiscountPackageService(container).save({ title: 'package', image: '/isolated.png', type: 0,
      products: [{ product_id: 100, skus: [{ base_unique: 'BASE0001', price: '5.00' }] },
        { product_id: 200, skus: [{ base_unique: 'SUPP0001', price: '4.00' }] }] });
    throw new Error('Unexpected writer');
  };

  it.each(refs)('Admin refuses retained %s references with a domain error and no row changes', async table => {
    await bind(table); const before = await snapshot(); const r = await http(f.db, '/delete/10');
    expect(r).toMatchObject({ status: 200, body: { status: 400, msg: '运费模板仍被商品或活动引用，请先解除引用' } });
    expect(r.cache).toContain('no-store'); expect(await snapshot()).toEqual(before);
  });
  it.each(refs)('Supplier refuses even foreign/retired %s references, without deleting any rule', async table => {
    await bind(table, 20); if (table === 'store_product') await f.exec('UPDATE store_product SET is_del=1 WHERE id=100');
    const before = await snapshot();
    await expect(new SupplierShippingTemplateService(createContainerFromDb(f.db)).delete(20, 20)).rejects.toBeInstanceOf(ValidateException);
    expect(await snapshot()).toEqual(before);
  });
  it('refuses referenced disable and implicit default deletion, but allows explicit unbind and idempotent retirement', async () => {
    await bind('store_product'); const before = await snapshot();
    expect((await http(f.db, '/save', { id: 10, status: 0, name: 'must roll back' })).body.status).toBe(400);
    expect(await snapshot()).toEqual(before);
    await f.exec('UPDATE store_product SET temp_id=0,freight=3 WHERE id=100');
    expect((await http(f.db, '/delete/1')).body.status).toBe(400);
    await f.exec('UPDATE store_product SET freight=1 WHERE id=100');
    expect((await http(f.db, '/delete/1')).body.status).toBe(200);
    const after = await snapshot(); expect((await http(f.db, '/delete/1')).body.status).toBe(200); expect(await snapshot()).toEqual(after);
  });
  it('validates IDs and supplier ownership without touching foreign templates', async () => {
    const before = await snapshot();
    for (const id of ['0', '-1', 'NaN', '1.5', '2147483648', '1e1', '0xA']) expect((await http(f.db, '/delete/' + id)).body.status).toBe(400);
    expect((await http(f.db, '/delete/99')).body.status).toBe(404);
    await expect(new SupplierShippingTemplateService(createContainerFromDb(f.db)).delete(20, 10)).rejects.toMatchObject({ code: 404 });
    expect(await snapshot()).toEqual(before);
  });
  it('deletes supplier rules atomically and preserves the entire historical order', async () => {
    const orders = await f.query('SELECT * FROM store_order');
    await new SupplierShippingTemplateService(createContainerFromDb(f.db)).delete(20, 20);
    expect((await f.query('SELECT is_del,status FROM shipping_templates WHERE id=20')).rows).toMatchObject([{ is_del: 1, status: 0 }]);
    for (const [table, key] of [['shipping_templates_region', 'template_id'], ['shipping_templates_free', 'temp_id'], ['shipping_templates_no_delivery', 'temp_id']]) {
      expect((await f.query(`SELECT id FROM ${table} WHERE ${key}=20`)).rows).toEqual([]);
    }
    expect(await f.query('SELECT * FROM store_order')).toEqual(orders);
  });
  it.each(['out', 'supplier', 'mobile', 'package'])('%s actual writer admits a valid template and creates a protected reference', async kind => {
    if (kind === 'package') await bind('store_product');
    await write(kind, f.db);
    await expect(retireShippingTemplate(createContainerFromDb(f.db), kind === 'supplier' ? 20 : 10)).rejects.toBeInstanceOf(ValidateException);
  });
  it.each(['out', 'supplier', 'mobile', 'package'].flatMap(kind => ['missing', 'deleted', 'disabled', 'foreign'].map(state => [kind, state])))('%s writer refuses %s parent with no partial rows', async (kind, state) => {
    if (kind === 'package') await bind('store_product');
    const template = kind === 'supplier' ? 20 : 10;
    if (state === 'missing') await f.exec(`DELETE FROM shipping_templates WHERE id=${template}`);
    else await f.exec(`UPDATE shipping_templates SET ${state === 'deleted' ? 'is_del=1' : state === 'disabled' ? 'status=0' : 'owner_type=1,relation_id=99'} WHERE id=${template}`);
    const before = await snapshot(); await expect(write(kind, f.db)).rejects.toThrow('运费模板'); expect(await snapshot()).toEqual(before);
  });
  it('Mobile does not admit platform templates for a supplier product, matching checkout authority', async () => {
    const before = await snapshot();
    await expect(new AdminMobileProductService(createContainerFromDb(f.db)).batchProcess(
      { type: 8, ids: [200], data: { freight: 3, temp_id: 10 } }, actor)).rejects.toThrow('不属于');
    expect(await snapshot()).toEqual(before);
  });
  it.each(['seckill', 'combination', 'integral'])('%s actual legacy editor refuses rebinding a retained template to another source owner', async kind => {
    await bind(`store_${kind}` as typeof refs[number]); const before = await snapshot();
    const r = await http(f.db, '/activity', { type: kind, id: 1, productId: 200 });
    expect(r.body).toMatchObject({ status: 400, msg: '运费模板不属于商品所属方' }); expect(await snapshot()).toEqual(before);
    expect((await http(f.db, '/activity', { type: kind, id: 1, productId: 100 })).body.status).toBe(200);
    expect((await http(f.db, '/activity', { type: kind, id: 1, storeName: 'rename only' })).body.status).toBe(200);
    expect((await f.query(`SELECT product_id,temp_id FROM store_${kind} WHERE id=1`)).rows).toEqual([{ product_id: 100, temp_id: 10 }]);
  });
  it('rolls back supplier rule removal when the later parent update fails', async () => {
    await f.exec(`CREATE FUNCTION qa_refuse_retirement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'private-shipping-sql-marker'; END $$;
      CREATE TRIGGER qa_refuse_retirement BEFORE UPDATE ON shipping_templates FOR EACH ROW EXECUTE FUNCTION qa_refuse_retirement()`);
    try {
      const before = await snapshot();
      await expect(new SupplierShippingTemplateService(createContainerFromDb(f.db)).delete(20, 20)).rejects.not.toBeInstanceOf(ValidateException);
      expect(await snapshot()).toEqual(before);
      const r = await http(f.db, '/delete/10');
      expect(r.body).toMatchObject({ status: 500, msg: '系统繁忙,请稍后再试' });
      expect(JSON.stringify(r)).not.toContain('private-shipping-sql-marker'); expect(await snapshot()).toEqual(before);
    } finally { await f.exec('DROP TRIGGER qa_refuse_retirement ON shipping_templates; DROP FUNCTION qa_refuse_retirement()'); }
  });
  it('bounds retirement waits, preserves stricter session settings, and refuses repeatable-read writes', async () => {
    const before = await snapshot();
    await f.withPeer!(holder => f.withPeer!(async writer => {
      await holder.exec('BEGIN; SELECT id FROM shipping_templates WHERE id=10 FOR SHARE');
      await writer.exec("SET lock_timeout='120ms'; SET statement_timeout='3500ms'; SET idle_in_transaction_session_timeout='2500ms'");
      try { await expect(retireShippingTemplate(createContainerFromDb(writer.db), 10)).rejects.toThrow('正在更新'); }
      finally { await holder.exec('ROLLBACK'); }
      expect(await writer.exec("SELECT current_setting('lock_timeout') AS l,current_setting('statement_timeout') AS s,current_setting('idle_in_transaction_session_timeout') AS i"))
        .toMatchObject([{ l: '120ms', s: '3500ms', i: '2500ms' }]);
      await writer.exec("SET default_transaction_isolation='repeatable read'");
      try { await expect(retireShippingTemplate(createContainerFromDb(writer.db), 10)).rejects.toThrow('READ COMMITTED'); }
      finally { await writer.exec("SET default_transaction_isolation='read committed'"); }
    }));
    expect(await snapshot()).toEqual(before);
  }, 15000);
  it.each(['out', 'supplier'])('%s bind-first holds the parent until real save commits; waiting retirement then sees the reference', async kind => {
    const template = kind === 'supplier' ? 20 : 10;
    await f.exec(`CREATE FUNCTION qa_pause_shipping_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.store_name='lifecycle product' THEN PERFORM pg_advisory_xact_lock(731649,1); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_pause_shipping_insert BEFORE INSERT ON store_product FOR EACH ROW EXECUTE FUNCTION qa_pause_shipping_insert()`);
    try {
      await f.withPeer!(holder => f.withPeer!(binder => f.withPeer!(async deleter => {
        await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731649,1)');
        try {
          const binding = outcome(write(kind, binder.db)); await waitForFinanceBlock(f.db, binder.pid, holder.pid);
          const deleting = outcome(retireShippingTemplate(createContainerFromDb(deleter.db), template));
          await waitForFinanceBlock(f.db, deleter.pid, binder.pid); await holder.exec('COMMIT');
          expect(await binding).toMatchObject({ ok: true });
          expect(await deleting).toMatchObject({ ok: false, error: { code: 400 } });
        } finally { await holder.exec('ROLLBACK'); }
      })));
    } finally { await f.exec('DROP TRIGGER qa_pause_shipping_insert ON store_product; DROP FUNCTION qa_pause_shipping_insert()'); }
  }, 20000);
  it.each(['COMMIT', 'ROLLBACK'])('retire-first: actual Mobile writer refuses NOWAIT then honors %s', async end => {
    await f.withPeer!(async deleter => {
      await deleter.exec('BEGIN; UPDATE shipping_templates SET is_del=1 WHERE id=10');
      try {
        const before = await snapshot(); await expect(write('mobile', f.db)).rejects.toThrow('正在更新'); expect(await snapshot()).toEqual(before);
        await deleter.exec(end);
        if (end === 'COMMIT') await expect(write('mobile', f.db)).rejects.toThrow('已停用');
        else await write('mobile', f.db);
      } finally { await deleter.exec('ROLLBACK'); }
    });
  }, 15000);
  it('Supplier retirement no longer waits backwards on a source product row held by an editor', async () => {
    await bind('store_product', 20);
    await f.withPeer!(async editor => {
      await editor.exec('BEGIN; SELECT id FROM store_product WHERE id=100 FOR UPDATE');
      try { await expect(new SupplierShippingTemplateService(createContainerFromDb(f.db)).delete(20, 20)).rejects.toThrow('仍被商品或活动引用'); }
      finally { await editor.exec('ROLLBACK'); }
    });
  }, 10000);
  it('a real restricted LOGIN cannot retire when RLS hides stored references', async () => {
    await bind('store_product'); const before = await snapshot();
    await f.exec('ALTER TABLE store_product ENABLE ROW LEVEL SECURITY; CREATE POLICY qa_hide_shipping ON store_product USING(false)');
    try {
      await f.withRuntimeRole!(async runtime => {
        await f.exec(`GRANT SELECT ON shipping_templates,${refs.join(',')} TO "${runtime.role}"; GRANT UPDATE(is_del) ON shipping_templates TO "${runtime.role}"`);
        await expect(retireShippingTemplate(createContainerFromDb(runtime.db), 10)).rejects.toMatchObject({ cause: { code: '42501' } });
      });
      expect(await snapshot()).toEqual(before);
    } finally { await f.exec('DROP POLICY qa_hide_shipping ON store_product; ALTER TABLE store_product DISABLE ROW LEVEL SECURITY'); }
  });
  it('a genuine restricted LOGIN can use the admission protocol without parent identity UPDATE privileges', async () => {
    await f.withRuntimeRole!(async runtime => {
      await f.exec(`GRANT SELECT,UPDATE(name) ON shipping_templates TO "${runtime.role}"`);
      await runtime.db.transaction(tx => lockShippingTemplateBindings(tx as unknown as DbClient, [{ tempId: 10, freight: 3, ownerType: 0, relationId: 0 }]));
      await expect(runtime.exec('UPDATE shipping_templates SET is_del=1 WHERE id=10')).rejects.toMatchObject({ code: '42501' });
    });
  });
});
