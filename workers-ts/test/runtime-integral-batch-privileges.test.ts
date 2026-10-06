/** Native, separately authenticated restricted LOGINs. This finite catalog
 * installs the exact production privilege-plan slice used by integral bulk;
 * it does not claim whole-shop commissioning or Hyperdrive acceptance. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb } from '../src/lib/di';
import { AdminIntegralBatchService } from '../src/services/admin/AdminIntegralBatchService';
import { runtimeBusinessPrivilegePlan } from '../src/migrations/runtimeBusinessPrivilegePlan';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { integralBatchTables, integralBatchKey, integralBatchActor } from './helpers/integralBatchFixture';
import { shippingTemplates, storeIntegral, storeProduct, storeProductAttr,
  storeProductAttrResult, storeProductAttrValue, storeProductCategory,
  storeProductDescription, storeProductRelation, systemAttachment,
  systemStore, systemSupplier } from '../src/models/schema';

type Peer = SequenceRunnerPeer & { role: string };
const native = describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL));
const definitions = integralBatchTables.map(getTableConfig);
const identifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned integral privilege identifier');
  return `"${value}"`;
};
async function sqlDenied(work: Promise<unknown>) {
  let error: unknown = await work.then(() => undefined, cause => cause);
  expect(error).toBeDefined();
  for (let depth = 0; depth < 8 && error && typeof error === 'object'; depth++) {
    if ('code' in error) { expect(error.code).toBe('42501'); return; }
    error = 'cause' in error ? error.cause : undefined;
  }
  throw Error('Expected genuine PostgreSQL insufficient_privilege refusal');
}

native('integral bulk production grant slice on independent restricted Admin and application LOGINs', () => {
  let f: Extract<Awaited<ReturnType<typeof sequenceRunnerDatabase>>, { format: 'pg16' }>;
  beforeEach(async () => {
    const created = await sequenceRunnerDatabase();
    if (!created.withRuntimeRole || created.format !== 'pg16') throw Error('Real native runtime LOGIN is required');
    f = created;
    const dialect = new PgDialect();
    for (const definition of definitions) {
      const columns = definition.columns.map(column => {
        const initial = column.default;
        const initialSql = initial === undefined ? '' : ` DEFAULT ${initial instanceof SQL
          ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${initialSql}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
    }
    await f.db.insert(systemStore).values({ id: 11, name: '受限账号来源门店', isShow: 1, isDel: 0, isStore: 1 });
    await f.db.insert(systemSupplier).values({ id: 7, adminId: 700, supplierName: '受限账号来源供应商', isShow: 1, isDel: 0 });
    await f.db.insert(shippingTemplates).values({ id: 11, name: '门店运费模板', ownerType: 1, relationId: 11, type: 1 });
    await f.db.insert(storeProduct).values([
      { id: 70, pid: 0, type: 0, relationId: 0, storeName: '受限平台多规格来源',
        stock: 20, price: '10.00', specType: 1, isShow: 1, isVerify: 1,
        freight: 1, tempId: 0, deliveryType: '1', image: '/images/runtime-70.png' },
      { id: 72, pid: 70, type: 1, relationId: 11, storeName: '受限门店副本来源',
        stock: 5, price: '12.00', isShow: 1, isVerify: 1,
        freight: 3, tempId: 11, deliveryType: '1,2', image: '/images/runtime-72.png' },
      { id: 73, pid: 70, type: 2, relationId: 7, storeName: '受限供应商副本来源',
        stock: 7, price: '15.00', isShow: 1, isVerify: 1,
        freight: 2, postage: '3.00', tempId: 0, deliveryType: '1', image: '/images/runtime-73.png' },
    ]);
    await f.db.insert(storeProductAttrValue).values([
      { id: 1, productId: 70, type: 0, unique: 'base0070', suk: '红', stock: 8,
        sumStock: 8, price: '10.00', cost: '2.00', image: '/images/runtime-red.png' },
      { id: 2, productId: 70, type: 0, unique: 'blue0070', suk: '蓝', stock: 12,
        sumStock: 12, price: '12.00', cost: '4.00', image: '/images/runtime-blue.png' },
      { id: 3, productId: 72, type: 0, unique: 'base0072', suk: '默认', stock: 5,
        sumStock: 5, price: '12.00', image: '/images/runtime-72.png' },
      { id: 4, productId: 73, type: 0, unique: 'base0073', suk: '默认', stock: 7,
        sumStock: 7, price: '15.00', image: '/images/runtime-73.png' },
    ]);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),4,true)");
    await f.db.insert(storeProductCategory).values({ id: 21, pid: 0, type: 0, relationId: 0, cateName: '受限来源分类', isShow: 1 });
    for (const productId of [70, 72, 73]) {
      await f.db.insert(storeProductAttr).values({ productId, type: 0,
        attrName: productId === 70 ? '颜色' : '规格', attrValues: productId === 70 ? '红,蓝' : '默认' });
      await f.db.insert(storeProductAttrResult).values({ productId, type: 0,
        result: JSON.stringify({ attr: [{ value: productId === 70 ? '颜色' : '规格', detail: productId === 70 ? ['红', '蓝'] : ['默认'] }], value: [] }) });
      await f.db.insert(storeProductDescription).values({ productId, type: 0, description: `<p>受限来源${productId}详情</p>` });
      await f.db.insert(storeProductRelation).values({ productId, type: 1, relationId: 21 });
    }
    await f.db.insert(systemAttachment).values({ attId: 43, type: 4, relationId: 7,
      moduleType: 1, fileType: 1, imageType: 8, attDir: '/api/assets/43', name: 'attachments/supplier/7/native.png', attType: 'image/png' });
  }, 40_000);
  afterEach(async () => { await f?.close(); }, 30_000);

  const service = (peer: Peer) => new AdminIntegralBatchService(createContainerFromDb(peer.db), integralBatchKey);
  async function installSlice(peer: Peer, kind: 'app' | 'admin') {
    const plan = runtimeBusinessPrivilegePlan(kind);
    for (const definition of definitions) {
      const privileges = plan.tables[definition.name];
      if (!privileges?.includes('SELECT')) throw Error('Required table is absent from reviewed production plan');
      await f.exec(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
      const columns = plan.updateColumns[definition.name];
      if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
      if (privileges.includes('INSERT')) for (const column of definition.columns) {
        if (!['serial', 'bigserial'].includes(column.getSQLType())) continue;
        const [row] = await f.exec(`SELECT pg_get_serial_sequence('public.${definition.name}','${column.name}') AS name`);
        const sequence = String(row.name).split('.');
        if (sequence.length !== 2 || sequence[0] !== 'public') throw Error('Unexpected owned serial sequence');
        await f.exec(`GRANT USAGE ON SEQUENCE public.${identifier(sequence[1])} TO ${identifier(peer.role)}`);
      }
      const [actual] = await peer.exec(`SELECT has_table_privilege(current_user,'public.${definition.name}','SELECT') AS read,
        has_table_privilege(current_user,'public.${definition.name}','INSERT') AS insert,
        has_table_privilege(current_user,'public.${definition.name}','UPDATE') AS update,
        has_table_privilege(current_user,'public.${definition.name}','DELETE') AS delete,
        has_table_privilege(current_user,'public.${definition.name}','SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION') AS delegate`);
      expect(actual).toEqual({ read: true, insert: privileges.includes('INSERT'),
        update: privileges.includes('UPDATE'), delete: privileges.includes('DELETE'), delegate: false });
    }
    const [identity] = await peer.exec(`SELECT current_user,session_user,pg_backend_pid() AS pid,
      NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls) AS restricted
      FROM pg_roles WHERE rolname=current_user`);
    expect(identity).toEqual({ current_user: peer.role, session_user: peer.role, pid: peer.pid, restricted: true });
    await peer.exec('RESET ROLE');
    expect((await peer.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: peer.role, session_user: peer.role });
  }
  async function profiles(run: (app: Peer, admin: Peer) => Promise<void>) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      await installSlice(app, 'app'); await installSlice(admin, 'admin');
      const [owner] = await f.exec('SELECT pg_backend_pid() AS pid');
      expect(new Set([owner.pid, app.pid, admin.pid]).size).toBe(3);
      await run(app, admin);
    }));
  }
  async function input(peer: Peer) {
    const products = [];
    for (const productId of [70, 72, 73]) {
      const source = await service(peer).source(productId);
      products.push({ product_id: productId, revision: source.revision,
        skus: source.skus.map(sku => ({ base_unique: sku.base_unique,
          price: sku.base_unique === 'base0070' ? '9.00' : '4.25',
          integral: sku.base_unique === 'base0070' ? 5 : 10, quota: 2,
          image: productId === 73 ? '/api/assets/43' : sku.image })) });
    }
    return { request_id: crypto.randomUUID(), is_show: 1, products };
  }
  const state = () => f.exec(definitions.map(({ name }) =>
    `SELECT '${name}' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public.${identifier(name)} t`).join(' UNION ALL ') + ' ORDER BY name');
  const catalog = () => f.exec(`SELECT 'relation' AS kind,oid::text AS key,relname AS name,relowner::text AS owner,relacl::text AS acl,NULL::text AS definition
    FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'column',c.oid::text||'.'||a.attnum::text,c.relname||'.'||a.attname,NULL,a.attacl::text,
      format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')
      FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'function',oid::text,proname,proowner::text,proacl::text,prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace
    UNION ALL SELECT 'trigger',oid::text,tgname,NULL,NULL,pg_get_triggerdef(oid) FROM pg_trigger
      WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
    ORDER BY kind,key`);

  it('lets an independent restricted Admin select all owners and create one full multi-SKU graph with its own durable receipt', async () => {
    await profiles(async (_app, admin) => {
      const selection = await service(admin).candidates(new URLSearchParams('category_id=21'));
      expect(selection.count).toBe(3);
      expect(selection.list.map(row => row.owner_type).sort()).toEqual([0, 1, 2]);
      expect(selection.list.every(row => row.valid)).toBe(true);
      const before = await state(), schema = await catalog(), submitted = await input(admin);
      const receipt = await service(admin).create(submitted, integralBatchActor);
      expect(receipt.count).toBe(3);
      expect(receipt.products.map(row => row.product_id)).toEqual([70, 72, 73]);
      expect(await service(admin).receipt(submitted.request_id, integralBatchActor)).toEqual(receipt);
      expect(await service(admin).create(submitted, integralBatchActor)).toEqual(receipt);
      await expect(service(admin).receipt(submitted.request_id, { id: 8 })).rejects.toThrow();
      const roots = await f.db.select().from(storeIntegral);
      expect(roots).toHaveLength(3);
      expect(roots.find(row => row.productId === 70)).toMatchObject({ type: 0, relationId: 0, stock: 20, quota: 4, integral: 5, price: '9.00' });
      expect(roots.find(row => row.productId === 72)).toMatchObject({ type: 1, relationId: 11, stock: 5, tempId: 11, deliveryType: '1,2' });
      expect(roots.find(row => row.productId === 73)).toMatchObject({ type: 2, relationId: 7, stock: 7, freight: 2, postage: '3.00' });
      expect(await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.type, 4))).toHaveLength(4);
      for (const table of [storeProductAttr, storeProductAttrResult, storeProductDescription])
        expect(await f.db.select().from(table).where(eq(table.type, 4))).toHaveLength(3);
      const after = await state();
      for (const name of ['store_product', 'store_product_attr_value']) {
        const original = before.find(row => row.name === name)!.rows;
        if (name === 'store_product') expect(after.find(row => row.name === name)!.rows).toEqual(original);
        else expect((after.find(row => row.name === name)!.rows as Array<{ type: number }>).filter(row => row.type === 0)).toEqual(original);
      }
      expect(after.find(row => row.name === 'system_log')!.rows).toHaveLength(4);
      expect(await catalog()).toEqual(schema);
    });
  }, 40_000);

  it('denies application LOGIN bulk root INSERT at PostgreSQL with zero graph changes despite ordinary catalog/SKU authority', async () => {
    await profiles(async (app, admin) => {
      const submitted = await input(admin), before = await state(), schema = await catalog();
      expect((await service(app).source(70)).skus).toHaveLength(2);
      expect((await app.exec(`SELECT has_table_privilege(current_user,'public.store_product_attr_value','INSERT') AS sku,
        has_table_privilege(current_user,'public.store_integral','INSERT') AS integral`))[0]).toEqual({ sku: true, integral: false });
      await sqlDenied(service(app).create(submitted, integralBatchActor));
      expect(await state()).toEqual(before);
      expect(await catalog()).toEqual(schema);
      await sqlDenied(app.exec('CREATE TABLE public.unauthorized_bulk_repair(id integer)'));
      expect(await catalog()).toEqual(schema);
    });
  }, 40_000);

  it('rolls back every new graph after revoked Admin journal INSERT and neither repairs ACLs nor installs schema', async () => {
    await profiles(async (_app, admin) => {
      const submitted = await input(admin);
      await f.exec(`REVOKE INSERT ON public.system_log FROM ${identifier(admin.role)}`);
      const before = await state(), schema = await catalog();
      expect((await admin.exec("SELECT has_table_privilege(current_user,'public.system_log','INSERT') AS write"))[0]).toEqual({ write: false });
      await sqlDenied(service(admin).create(submitted, integralBatchActor));
      expect(await state()).toEqual(before);
      expect(await catalog()).toEqual(schema);
      await expect(service(admin).receipt(submitted.request_id, integralBatchActor)).rejects.toThrow();
      expect((await admin.exec("SELECT has_table_privilege(current_user,'public.system_log','INSERT') AS write"))[0]).toEqual({ write: false });
      // Explicit test-owner restoration proves the rejected UUID has no
      // durable partial receipt; the business service performed no repair.
      await f.exec(`GRANT INSERT ON public.system_log TO ${identifier(admin.role)}`);
      expect((await service(admin).create(submitted, integralBatchActor)).count).toBe(3);
      expect(await f.db.select().from(storeIntegral)).toHaveLength(3);
    });
  }, 40_000);
});
