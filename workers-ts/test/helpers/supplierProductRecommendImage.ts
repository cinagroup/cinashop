import { eq, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb } from '@/lib/di';
import { memberRight, storePromotions, storePromotionsAuxiliary, storeOrder, storeOrderCartInfo,
  storeProduct, systemAdmin, systemRole } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { supplierSkuBatchFixture } from './supplierSkuBatch';
import type { SupplierProductScheduleRuntime } from './supplierProductSchedule';

/** Every table, role and grant below belongs to one newly owned PG16 database.
 * Ordinary Supplier writes retain the inherited minimum LOGIN and real JWT. */
export async function supplierProductRecommendImageFixture() {
  const f = await supplierSkuBatchFixture();
  try {
    const extras = [memberRight, storePromotions, storePromotionsAuxiliary, storeOrder, storeOrderCartInfo];
    const dialect = new PgDialect();
    for (const table of extras) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const initial = column.default;
        const defaultSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
      });
      await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
    }
    // Historical immutable rows are a baseline, not a claim of a browser or
    // checkout creation flow. Existing native checkout suites own that proof.
    await f.db.insert(storeOrder).values({ id: 701, orderId: 'OWNED-RECOMMEND-HISTORICAL', uid: 999,
      paid: 1, status: 2, payPrice: '20.01' });
    await f.db.insert(storeOrderCartInfo).values({ id: 702, oid: 701, uid: 999, productId: 80,
      skuUnique: 'sbtred01', cartNum: 1, cartInfo: '{"historical_recommend_image":"/owned-media/history.png"}' });
    const password = 'owned-recommend-image-review-password';
    await f.db.insert(systemRole).values({ id: 101, type: 1, rules: 'product.manage' });
    await f.db.insert(systemAdmin).values({ id: 101, adminType: 1, relationId: 0, level: 1,
      account: 'owned-recommend-review', pwd: password, roles: '101', status: 1, isDel: 0 });
    const adminToken = (await createToken(101, 'admin', md5(password), f.env.APP_KEY)).token;
    const snapshot = async () => {
      const state = { ...await f.snapshot() };
      for (const table of extras) {
        const name = getTableConfig(table).name;
        state[name] = await f.exec(`SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`);
      }
      return state;
    };
    const withPublicReader = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withRuntimeRole!(async peer => {
      await f.exec(`GRANT SELECT ON public.store_product,public.store_product_category,public.store_product_relation,
        public.system_supplier,public.system_store,public.system_attachment,public.store_brand,public.store_cart,public.system_config,
        public.member_right,public.store_promotions,public.store_promotions_auxiliary,
        public.system_admin,public.system_role,public.system_menus TO "${peer.role}"`);
      return work({ ...peer, container: createContainerFromDb(peer.db) });
    });
    const withModerator = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withRuntimeRole!(async peer => {
      // Mature review uses real SHARE ROW EXCLUSIVE table barriers. PG16
      // requires these table UPDATE grants; UPDATE(id/status) is insufficient.
      // This owned commissioning role can therefore edit SKU columns, while
      // the real moderation service is separately proved to leave every SKU
      // unchanged. Recommendation, orders and answers remain ungranted.
      await f.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_menus,public.system_log,
        public.store_product,public.store_product_attr_value,public.store_cart,public.store_product_relation TO "${peer.role}";
        GRANT UPDATE ON public.system_admin,public.system_role,public.store_product_attr_value,public.store_cart,public.store_product_relation TO "${peer.role}";
        GRANT UPDATE(is_verify,refusal,is_show,auto_on_time) ON public.store_product TO "${peer.role}";
        GRANT INSERT ON public.system_log TO "${peer.role}";
        GRANT USAGE,SELECT ON SEQUENCE public.system_log_id_seq TO "${peer.role}"`);
      return work({ ...peer, container: createContainerFromDb(peer.db) });
    });
    const withAdminImageWriter = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withRuntimeRole!(async peer => {
      await f.exec(`GRANT SELECT(id,recommend_image) ON public.store_product TO "${peer.role}";
        GRANT UPDATE(recommend_image) ON public.store_product TO "${peer.role}"`);
      return work({ ...peer, container: createContainerFromDb(peer.db) });
    });
    const product = async (id = 80) => (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0];
    return { ...f, snapshot, withPublicReader, withModerator, withAdminImageWriter, product, adminToken };
  } catch (error) { await f.close(); throw error; }
}
