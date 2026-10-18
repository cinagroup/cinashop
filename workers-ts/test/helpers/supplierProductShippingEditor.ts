import { eq, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb } from '@/lib/di';
import { shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery,
  systemCity, systemRole, storeProduct } from '@/models/schema';
import { SupplierShippingTemplateService } from '@/services/supplier/SupplierShippingTemplateService';
import { SHIPPING_TEMPLATE_CREATE_REPLAY_SQL } from '@/migrations/shippingTemplateCreateReplay';
import { supplierProductUnitsFixture } from './supplierProductUnits';
import { supplierSystemFormCheckoutFixture } from './supplierProductSystemForms';
import type { SupplierProductScheduleRuntime } from './supplierProductSchedule';

export type SupplierShippingEditorState = Record<string, Array<{ row: Record<string, any> }>>;
export const supplierShippingEditorTemplateIds = { own: 60, foreign: 61, deleted: 62, missing: 999 } as const;
export const supplierShippingEditorBody = (firstPrice = '8.00', name = '商品内联运费模板') => ({
  name, type: 1, appoint: 1, no_delivery: 1, sort: 12,
  region_info: [
    { city_ids: [[0]], first: '1.00', first_price: firstPrice, continue: '1.00', continue_price: '2.00' },
    { city_ids: [[44, 4401]], first: '1.00', first_price: '6.50', continue: '1.00', continue_price: '1.50' },
  ],
  appoint_info: [{ city_ids: [[44, 4401]], number: '100.00', price: '999.00' }],
  no_delivery_info: [{ city_ids: [[11, 1101]] }],
});

/** Newly owned PG16 only. The Supplier template writer uses its own real LOGIN;
 * native Customer JWT checkout deliberately retains the existing maintenance SQL
 * boundary. No production privilege or mature fixture is changed. */
export async function supplierProductShippingEditorFixture() {
  const f = await supplierProductUnitsFixture();
  let checkout: Awaited<ReturnType<typeof supplierSystemFormCheckoutFixture>> | undefined;
  try {
    const dialect = new PgDialect();
    for (const table of [shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery, systemCity]) {
      const definition = getTableConfig(table), columns = definition.columns.map(column => {
        const initial = column.default;
        const defaultSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
      });
      await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
    }
    await f.exec(SHIPPING_TEMPLATE_CREATE_REPLAY_SQL);
    await f.db.insert(systemCity).values([
      { id: 1, cityId: 44, name: '本机省甲', parentId: 0, level: 1 },
      { id: 2, cityId: 4401, name: '本机城市甲', parentId: 44, level: 2 },
      { id: 3, cityId: 11, name: '本机省乙', parentId: 0, level: 1 },
      { id: 4, cityId: 1101, name: '本机城市乙', parentId: 11, level: 2 },
    ]);
    await f.db.insert(shippingTemplates).values([
      { id: 60, ownerType: 2, relationId: 7, name: '商品内联运费模板', type: 1 },
      { id: 61, ownerType: 2, relationId: 8, name: '外店私有运费模板', type: 1 },
      { id: 62, ownerType: 2, relationId: 7, name: '已退役运费模板', status: 0, isDel: 1 },
    ]);
    // Reserve the mature checkout commissioner's explicit region IDs1/2.
    // This owned fixture's grouped rule identities are fixed before baselines.
    await f.exec("SELECT setval('public.shipping_templates_region_id_seq',1000,true)");
    // Canonical grouped rows are fixture setup, before every invariant baseline.
    const shipping = new SupplierShippingTemplateService(f.container);
    for (const [supplier, id, name] of [[7, 60, '商品内联运费模板'], [8, 61, '外店私有运费模板']] as const) {
      const opened = await shipping.detail(supplier, id);
      await shipping.save(supplier, id, { ...supplierShippingEditorBody('8.00', name), expectedRevision: opened.revision });
    }
    await f.db.update(storeProduct).set({ freight: 3, tempId: 60, systemFormId: 0, deliveryType: '1' }).where(eq(storeProduct.id, 80));
    await f.db.update(systemRole).set({ rules: 'supplier.product.view,supplier.product.manage,supplier.attachment.view,supplier.shipping.view,supplier.shipping.manage' }).where(eq(systemRole.id, 21));
    await f.db.update(systemRole).set({ rules: 'supplier.product.view,supplier.shipping.view' }).where(eq(systemRole.id, 22));
    await f.db.update(systemRole).set({ rules: 'supplier.product.view,supplier.product.manage' }).where(eq(systemRole.id, 23));
    await f.db.update(systemRole).set({ rules: 'supplier.product.view,supplier.product.manage,supplier.shipping.view,supplier.shipping.manage' }).where(eq(systemRole.id, 31));
    for (const name of ['shipping_templates', 'shipping_templates_region', 'shipping_templates_free', 'shipping_templates_no_delivery', 'system_city']) {
      await f.exec(`SELECT setval(pg_get_serial_sequence('public.${name}','id'),GREATEST((SELECT COALESCE(max(id),0) FROM public.${name}),1),true)`);
    }
    // Dynamic full-public snapshots also include tables installed by the optional
    // genuine checkout commissioner. No fixed count or silently omitted table.
    const snapshot = async (): Promise<SupplierShippingEditorState> => {
      const names = await f.exec("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
      const result: SupplierShippingEditorState = {};
      for (const row of names) {
        const name = String(row.tablename); if (!/^[a-z][a-z0-9_]*$/.test(name)) throw Error('Unexpected owned shipping table');
        result[name] = await f.exec(`SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`) as unknown as SupplierShippingEditorState[string];
      }
      return result;
    };
    const sequences = async () => {
      const names = await f.exec("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename");
      return Promise.all(names.map(async row => {
        const name = String(row.sequencename); if (!/^[a-z][a-z0-9_]*$/.test(name)) throw Error('Unexpected owned shipping sequence');
        return { name, ...(await f.exec(`SELECT last_value,is_called FROM public."${name}"`))[0] };
      }));
    };
    function ownedRole(role: string) { if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Unowned shipping runtime role'); return '"' + role + '"'; }
    const grantShippingReader = async (role: string) => {
      await f.exec(`GRANT SELECT ON public.system_admin,public.system_supplier,public.system_role,public.system_menus,
        public.shipping_templates,public.shipping_templates_region,public.shipping_templates_free,public.shipping_templates_no_delivery,public.system_city TO ${ownedRole(role)}`);
    };
    const grantShippingWriter = async (role: string) => {
      await grantShippingReader(role);
      await f.exec(`GRANT INSERT,UPDATE(name,type,appoint,no_delivery,sort,add_time) ON public.shipping_templates TO ${ownedRole(role)};
        GRANT INSERT,DELETE ON public.shipping_templates_region,public.shipping_templates_free,public.shipping_templates_no_delivery TO ${ownedRole(role)};
        GRANT SELECT,INSERT(owner_type,relation_id,actor_id,request_key,request_hash,template_id) ON public.shipping_template_create_replay TO ${ownedRole(role)};
        GRANT USAGE,SELECT ON SEQUENCE public.shipping_templates_id_seq,public.shipping_templates_region_id_seq,public.shipping_templates_free_id_seq,public.shipping_templates_no_delivery_id_seq TO ${ownedRole(role)}`);
    };
    const withShippingReader = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withRuntimeRole!(async peer => {
      await grantShippingReader(peer.role); return work({ ...peer, container: createContainerFromDb(peer.db) });
    });
    const withShippingWriter = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withRuntimeRole!(async peer => {
      await grantShippingWriter(peer.role); return work({ ...peer, container: createContainerFromDb(peer.db) });
    });
    const prepareCheckout = async () => {
      // This helper moves synthetic SKU IDs and adds product70/template10 before
      // checkout baselines. It provides real JWT/quote/create dependencies, not
      // an independent Buyer SQL LOGIN. Keep that evidence limit explicit.
      checkout ??= await supplierSystemFormCheckoutFixture(f);
      return checkout;
    };
    return { ...f, snapshot, sequences, withShippingReader, withShippingWriter, grantShippingReader, grantShippingWriter,
      prepareCheckout, shippingBody: supplierShippingEditorBody, shippingIds: supplierShippingEditorTemplateIds,
      tokens: { ...f.tokens, productOnly: f.tokens.denied }, buyerSqlBoundary: 'owned finance_test maintenance connection' as const,
      close: async () => { try { await checkout?.close(); } finally { await f.close(); } } };
  } catch (error) { try { await checkout?.close(); } finally { await f.close(); } throw error; }
}
