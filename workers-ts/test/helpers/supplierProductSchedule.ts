/** Real complete Supplier saves in an owned PG16 database. Runtime roles are
 * independent LOGINs; the timer receives only its existing visibility write. */
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { systemAdmin, systemSupplier, systemRole, storeProductCategory,
  supplierFlowingWater, supplierExtract } from '@/models/schema';
import { SupplierProductManagementService } from '@/services/supplier/SupplierProductManagementService';
import { createToken, md5 } from '@/utils/jwt';
import { legacySaveSchema } from './adminLegacyProductSave';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

export const supplierProductSchedulePassword = 'owned-supplier-product-schedule-password';
export const supplierProductScheduleActor = (id = 21) => ({ id, authVersion: md5(supplierProductSchedulePassword), expiresAt: 2_147_483_647 });
export type SupplierProductScheduleRuntime = SequenceRunnerPeer & { role: string; connectionString: string; container: Container };
export function supplierProductScheduleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { product_type: 0, store_name: '本机定时商品', store_info: '定时计划完整编辑', keyword: 'schedule', unit_name: '件',
    bar_code: '000080', cate_id: [11], slider_image: ['/owned-media/schedule.png'], description: '<p>本机定时商品</p>',
    spec_type: 0, attrs: [{ suk: '默认', image: '/owned-media/schedule.png', price: '19.99', settle_price: '12.34',
      cost: '10.00', ot_price: '29.99', vip_price: '18.00', stock: 7 }], freight: 1, is_postage: 0, is_support_refund: 1, ...overrides };
}
export async function supplierProductScheduleFixture() {
  if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Supplier schedule fixture requires owned native PG16');
  const f = await sequenceRunnerDatabase();
  try {
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Supplier schedule requires independent PG16 LOGINs');
    const tables = [...Object.values(legacySaveSchema), supplierFlowingWater, supplierExtract] as PgTable[], dialect = new PgDialect();
    for (const table of tables) {
      const definition = getTableConfig(table), columns = definition.columns.map(column => {
        const initial = column.default, defaultSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
      });
      await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
    }
    // The real save uses its declared composite conflict key. This is the
    // existing ORM index, not an alternate production schema or migration.
    await f.exec('CREATE UNIQUE INDEX spd_product_type_unique ON public.store_product_description(product_id,type)');
    await f.db.insert(systemSupplier).values([{ id: 7, adminId: 99, supplierName: '本机计划供应商甲' }, { id: 8, adminId: 199, supplierName: '本机计划供应商乙' }]);
    await f.db.insert(systemRole).values([{ id: 21, type: 4, relationId: 7, rules: 'supplier.product.view,supplier.product.manage' },
      { id: 22, type: 4, relationId: 7, rules: 'supplier.product.view' }, { id: 23, type: 4, relationId: 7, rules: 'supplier.order.view' },
      { id: 31, type: 4, relationId: 8, rules: 'supplier.product.view,supplier.product.manage' }]);
    await f.db.insert(systemAdmin).values([21, 22, 23, 31].map(id => ({ id, adminType: 4, relationId: id === 31 ? 8 : 7,
      account: 'owned-schedule-' + id, pwd: supplierProductSchedulePassword, level: 1, roles: String(id), status: 1, isDel: 0 })));
    await f.db.insert(storeProductCategory).values([{ id: 11, type: 2, relationId: 7, cateName: '本机计划分类' }, { id: 12, type: 2, relationId: 8, cateName: '别店计划分类' }]);
    await f.db.insert(supplierFlowingWater).values({ id: 1, supplierId: 7, orderId: 'UNCHANGED-SCHEDULE-FLOW', pm: 1, number: '100.00', type: 1 });
    await f.db.insert(supplierExtract).values({ id: 1, supplierId: 7, extractType: 'bank', extractPrice: '10.00', balance: '90.00' });
    const container = createContainerFromDb(f.db), env = { APP_KEY: 'owned-supplier-product-schedule-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
    const service = new SupplierProductManagementService(container, env);
    await f.exec("SELECT setval('public.store_product_id_seq',80,false)");
    const first = await service.saveProduct(7, 0, supplierProductScheduleBody());
    const second = await service.saveProduct(7, 0, supplierProductScheduleBody({ store_name: '本机第二商品' }));
    await f.exec("SELECT setval('public.store_product_id_seq',90,false)");
    const foreign = await service.saveProduct(8, 0, supplierProductScheduleBody({ cate_id: [12], store_name: '别店商品' }));
    if (first.id !== 80 || second.id !== 81 || foreign.id !== 90) throw Error('Owned schedule product IDs changed');
    const now = Math.floor(Date.now() / 1000), initialOn = now + 3600, initialOff = now + 7200;
    await f.exec(`UPDATE public.store_product SET auto_on_time=${initialOn},auto_off_time=${initialOff},is_verify=1 WHERE id=80`);
    const readNames = ['system_admin', 'system_supplier', 'system_role', 'system_menus', 'store_product', 'store_product_attr',
      'store_product_attr_value', 'store_product_relation', 'store_product_description', 'system_attachment', 'store_product_category'];
    const withReader = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withRuntimeRole!(async peer => {
      await f.exec(`GRANT SELECT ON ${readNames.map(name => 'public."' + name + '"').join(',')} TO "${peer.role}"`);
      return work({ ...peer, container: createContainerFromDb(peer.db) });
    });
    const withWriter = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => withReader(async runtime => {
      await f.exec(`GRANT SELECT ON public.store_product_attr_result,public.store_cart,public.store_product_stock_record,public.store_product_virtual TO "${runtime.role}";
        GRANT UPDATE(id) ON public.system_admin,public.system_supplier,public.system_role,public.system_menus TO "${runtime.role}";
        GRANT UPDATE ON public.store_product,public.store_product_attr_value,public.store_cart,public.store_product_description TO "${runtime.role}";
        GRANT INSERT ON public.store_product,public.store_product_attr_value,public.store_product_attr,public.store_product_attr_result,public.store_product_relation,public.store_product_description,public.store_product_stock_record TO "${runtime.role}";
        GRANT DELETE ON public.store_product_attr,public.store_product_attr_result,public.store_product_relation TO "${runtime.role}";
        GRANT USAGE ON SEQUENCE public.store_product_id_seq,public.store_product_attr_value_id_seq,public.store_product_attr_id_seq,public.store_product_attr_result_id_seq,public.store_product_relation_id_seq,public.store_product_stock_record_id_seq TO "${runtime.role}"`);
      return work(runtime);
    });
    const withScheduler = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withRuntimeRole!(async peer => {
      await f.exec(`GRANT SELECT ON public.store_product TO "${peer.role}"; GRANT UPDATE(is_show) ON public.store_product TO "${peer.role}"`);
      return work({ ...peer, container: createContainerFromDb(peer.db) });
    });
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table => {
      const name = getTableConfig(table).name;
      return [name, await f.exec(`SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`)];
    })));
    const sequences = async () => {
      const rows = await f.exec("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename");
      return Promise.all(rows.map(async row => { const name = String(row.sequencename); if (!/^[a-z_]+$/.test(name)) throw Error('Owned schedule sequence identity');
        return { name, ...(await f.exec(`SELECT last_value,is_called FROM public."${name}"`))[0] }; }));
    };
    const token = async (id: number) => (await createToken(id, 'supplier', md5(supplierProductSchedulePassword), env.APP_KEY)).token;
    return { ...f, container, service, env, withReader, withWriter, withScheduler, snapshot, sequences,
      body: supplierProductScheduleBody, initialOn, initialOff,
      tokens: { manager: await token(21), viewer: await token(22), denied: await token(23), other: await token(31) },
      ids: { product: 80, secondProduct: 81, foreignProduct: 90 } };
  } catch (error) { await f.close(); throw error; }
}
