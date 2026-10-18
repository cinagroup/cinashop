import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { storeProductUnit, storeProductLog, storeVisit, systemDise } from '@/models/schema';
import { cloneProductDetailDesign } from '../../../view/common/productDetailDesign';
import { supplierProductRecommendImageFixture } from './supplierProductRecommendImage';
import type { SupplierProductScheduleRuntime } from './supplierProductSchedule';

export const supplierUnitDirectory = [
  { id: 201, name: '件', sort: 10 }, { id: 202, name: '箱', sort: 20 },
  { id: 203, name: '本店盒', type: 2, relationId: 7, sort: 20 },
  { id: 204, name: '箱', type: 2, relationId: 7, sort: 20 },
  { id: 205, name: '外店桶', type: 2, relationId: 8, sort: 99 },
  { id: 206, name: '停用单位', status: 0, sort: 99 },
  { id: 207, name: '删除单位', isDel: 1, sort: 99 },
  { id: 208, name: '错配平台归属', type: 0, relationId: 7, sort: 99 },
  { id: 209, name: '门店单位', type: 1, relationId: 7, sort: 99 },
  { id: 210, name: '长'.repeat(50), sort: 0 },
];
export const supplierUnitExpectedDirectory = [204, 203, 202, 201, 210].map(id => {
  const row = supplierUnitDirectory.find(unit => unit.id === id)!;
  return { id: row.id, name: row.name };
});

/** Existing real App/JWT/independent LOGIN commissioning, confined to one owned
 * PG16 database. Units are text suggestions; there is no product FK or CRUD. */
export async function supplierProductUnitsFixture() {
  const f = await supplierProductRecommendImageFixture();
  try {
    const extras = [storeProductUnit, storeProductLog, storeVisit, systemDise], dialect = new PgDialect();
    for (const table of extras) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const initial = column.default;
        const defaultSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
      });
      await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
    }
    await f.db.insert(storeProductUnit).values(supplierUnitDirectory);
    // A valid narrow public detail configuration avoids unrelated reply,
    // community and package schemas; the real detail reader still runs.
    const design = { ...cloneProductDetailDesign(), showRank: 0 as const, showReply: 0 as const,
      showCommunity: 0 as const, showRecommend: 0 as const, showMatch: 0 as const, showService: [1] };
    await f.db.insert(systemDise).values([
      { id: 1001, templateName: 'color_change', type: 3, value: '3' },
      { id: 1002, templateName: 'category', type: 3, value: '{"level":2,"index":1}' },
      { id: 1003, templateName: 'product_detail', type: 3, value: JSON.stringify(design) },
    ]);
    const snapshot = async (): Promise<Record<string, Array<{ row: Record<string, any> }>>> => {
      const state = { ...await f.snapshot() };
      for (const table of extras) {
        const name = getTableConfig(table).name;
        state[name] = await f.exec(`SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`);
      }
      return state;
    };
    const withReader = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withReader(async runtime => {
      await f.exec(`GRANT SELECT ON public.store_product_unit TO "${runtime.role}"`); return work(runtime);
    });
    const withWriter = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withWriter(async runtime => {
      await f.exec(`GRANT SELECT ON public.store_product_unit TO "${runtime.role}"`); return work(runtime);
    });
    const withDetailReader = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withPublicReader(async runtime => {
      // Drizzle explicitly names every ORM INSERT column, including columns
      // filled with DEFAULT. PG16 therefore checks INSERT for all listed
      // columns, not only the five visit values supplied by recordVisit.
      // Grant that exact column list; no analytics log UPDATE/DELETE, visit
      // identity edits, product writes or order/answer access are added.
      await f.exec(`GRANT SELECT ON public.system_dise,public.store_product_description,public.store_product_attr,public.store_product_attr_value,
        public.store_product_ensure,public.store_product_log,public.store_visit TO "${runtime.role}";
        GRANT INSERT(id,type,product_id,uid,visit_num,cart_num,order_num,pay_num,pay_price,cost_price,pay_uid,refund_num,refund_price,collect_num,add_time,delete_time) ON public.store_product_log TO "${runtime.role}";
        GRANT INSERT(id,product_id,product_type,cate_id,type,uid,count,content,add_time),UPDATE(count,cate_id,add_time) ON public.store_visit TO "${runtime.role}";
        GRANT USAGE,SELECT ON SEQUENCE public.store_product_log_id_seq,public.store_visit_id_seq TO "${runtime.role}"`);
      return work(runtime);
    });
    return { ...f, snapshot, withReader, withWriter, withDetailReader, units: supplierUnitExpectedDirectory };
  } catch (error) { await f.close(); throw error; }
}
