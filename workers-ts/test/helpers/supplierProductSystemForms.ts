import { eq, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { systemForm, systemFormData, storeProduct, storeCart, storeProductAttrValue, storeOrderCartInfo, storeOrderStatus, printDocument, user } from '@/models/schema';
import { supplierProductParametersFixture } from './supplierProductParameters';
import type { SupplierProductScheduleRuntime } from './supplierProductSchedule';
import { createPcCheckoutQuoteFixture } from './pcCheckoutQuoteFixture';
import { createToken, md5 } from '@/utils/jwt';
export { supplierProductParametersActor as supplierProductSystemFormsActor } from './supplierProductParameters';
export const supplierSystemFormTemplate = (title = '收件补充信息') => [{ id: 'message', name: 'texts', titleConfig: { value: title }, titleShow: { val: true }, value: '' }];
/** New native fixture only. Additional SELECT and UPDATE(id) are scoped to
 * its independent owned LOGIN; there is no definition/answer edit grant. */
export async function supplierProductSystemFormsFixture() {
  const f = await supplierProductParametersFixture();
  try {
    const answer = getTableConfig(systemFormData), dialect = new PgDialect();
    const answerColumns = answer.columns.map(column => {
      const initial = column.default, defaultSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
      return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
    });
    await f.exec(`CREATE TABLE "${answer.name}" (${answerColumns.join(',')})`);
    await f.db.insert(systemForm).values([
      { id: 71, name: '原有订单留言', status: 1, value: JSON.stringify(supplierSystemFormTemplate('原有必填项目')) },
      { id: 401, name: '平台收件留言', status: 1, value: JSON.stringify(supplierSystemFormTemplate()) },
      { id: 402, name: '停用留言', status: 0, value: JSON.stringify(supplierSystemFormTemplate()) },
      { id: 403, name: '删除留言', status: 1, isDel: 1, value: JSON.stringify(supplierSystemFormTemplate()) },
      { id: 404, name: '坏定义留言', status: 1, value: '{bad-json' },
      { id: 405, name: '空定义留言', status: 1, value: '[]' },
      { id: 406, name: '不支持组件留言', status: 1, value: '[{"id":"secret","name":"executeCode"}]' },
    ]);
    await f.db.update(storeProduct).set({ customForm: '[{"legacy":"原字节必须保留"}]' }).where(eq(storeProduct.id, 80));
    const withReader = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withReader(work);
    const withWriter = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withWriter(async runtime => {
      await f.exec(`GRANT UPDATE(id) ON public.system_form TO "${runtime.role}"`); return work(runtime);
    });
    const snapshot = async (): Promise<Record<string, any[]>> => ({ ...await f.snapshot(), system_form_data: await f.exec('SELECT to_jsonb(t) AS row FROM public.system_form_data t ORDER BY to_jsonb(t)::text') });
    return { ...f, withReader, withWriter, snapshot, forms: { original: 71, active: 401, disabled: 402, deleted: 403, bad: 404, empty: 405, unsupported: 406 } };
  } catch (error) { await f.close(); throw error; }
}
/** Real existing quote fixture over this owned database. Its pricing capability
 * is installed by the existing explicit native commissioner; the source table
 * fixture gains only missing ORM tables/indexes required by actual checkout. */
export async function supplierSystemFormCheckoutFixture(f: Pick<Awaited<ReturnType<typeof supplierProductSystemFormsFixture>>, 'db' | 'exec' | 'env'>) {
  const dialect = new PgDialect();
  // Both mature fixtures reserve SKU id1. Move only this freshly owned source
  // fixture's synthetic IDs before any checkout baseline, preserving unique
  // identities and all product/stock fields. There are no order references yet.
  await f.exec('UPDATE public.store_product_attr_value SET id=id+1000');
  const checkout = await createPcCheckoutQuoteFixture([systemForm, systemFormData, storeOrderCartInfo, storeOrderStatus, printDocument], async (tables: PgTable[]) => {
    for (const table of tables) {
      const definition = getTableConfig(table), [present] = await f.db.execute<{ present: boolean }>(sql`SELECT to_regclass(${'public.' + definition.name}) IS NOT NULL AS present`);
      if (present.present) continue;
      const columns = definition.columns.map(column => {
        const initial = column.default, defaultSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
      });
      await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
    }
    await f.exec('CREATE INDEX owned_form_order_pid ON public.store_order(pid); CREATE INDEX owned_form_line_oid ON public.store_order_cart_info(oid)');
    return { db: f.db, exec: f.exec, close: async () => {} };
  });
  try {
    await checkout.setConfig(Object.fromEntries(Object.keys(checkout.config).map(key => [key, '0'])));
    await f.exec("SELECT setval('public.store_cart_id_seq',(SELECT max(id) FROM public.store_cart),true)");
    await f.db.update(user).set({ pwd: 'owned-system-form-customer', status: 1 }).where(eq(user.uid, 11));
    const token = (await createToken(11, 'api', md5('owned-system-form-customer'), f.env.APP_KEY)).token;
    let sequence = 0;
    Object.assign(f.env, { CONFIG_KV: checkout.env.CONFIG_KV, SEQUENCE: {
      idFromName: () => 'owned-system-form-sequence', get: () => ({ fetch: async () => new Response('owned_form_' + ++sequence) }),
    } });
    const createCart = async () => {
      const [sku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, 80)).limit(1);
      const [cart] = await f.db.insert(storeCart).values({ uid: 11, productId: 80, productAttrUnique: sku.unique, cartNum: 1, isNew: 1, status: 1 }).returning();
      return cart.id;
    };
    return { ...checkout, token, createCart, sequence: () => sequence, close: checkout.close };
  } catch (error) { await checkout.close(); throw error; }
}
