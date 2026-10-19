import { eq, SQL, sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { expressCompany, storeOrderRefund, orderWaybillJob, storeDeliveryOrder, storeOrder, storeOrderStatus } from '@/models/schema';
import { customerCityDeliveryJob, customerCityDeliveryAttempt, customerCityDeliveryBinding } from '@/models/schema/customer_city_delivery';
import { SupplierOrderDistributionService } from '@/services/supplier/SupplierOrderDistributionService';
import { supplierOrderTrackingFixture, supplierTrackingAppKey } from './supplierOrderTracking';

export const supplierDistributionIds = { single: 100, virtual: 102, legacySend: 103, managedSend: 104,
  root: 200, first: 201, second: 202, platform: 300, allocated: 301, foreign: 900 } as const;
/** Owned native PG16 only. Reader/writer are independent true LOGINs from the
 * existing owned tracking fixture. The writer requires table UPDATE on auth
 * tables for its established authority-table barriers; it is not SELECT-only. */
export async function supplierOrderDistributionFixture() {
  const f = await supplierOrderTrackingFixture();
  try {
    const extra = [expressCompany, storeOrderRefund, orderWaybillJob, storeDeliveryOrder,
      customerCityDeliveryJob, customerCityDeliveryAttempt, customerCityDeliveryBinding], dialect = new PgDialect();
    for (const table of extra) {
      const definition = getTableConfig(table), columns = definition.columns.map(column => {
        const value = column.default, initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public."${definition.name}" (${columns.join(',')})`);
    }
    await f.db.insert(expressCompany).values([{ id: 11, name: '本机真实快递', code: 'zhongtong', isShow: 1, status: 1 },
      { id: 12, name: '本机新快递', code: 'shentong', isShow: 1, status: 1 }, { id: 13, name: '停用快递', code: 'disabled', isShow: 0, status: 0 }]);
    const [base] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, 100));
    await f.db.insert(storeOrder).values([{ ...base, id: 102, orderId: 'manual-virtual-102', productType: 3, deliveryType: 'fictitious',
      deliveryName: '', deliveryCode: '', deliveryId: '', fictitiousContent: '原手工交付\n历史下载说明' },
      { ...base, id: 103, orderId: 'legacy-send-103', deliveryType: 'send', deliveryName: '历史手工送货人', deliveryCode: '', deliveryId: '13800138000', deliveryUid: 0 },
      { ...base, id: 104, orderId: 'managed-send-104', deliveryType: 'send', deliveryName: '实名配送员', deliveryCode: '', deliveryId: '13800138001', deliveryUid: 13 }]);
    await f.exec("SELECT setval('public.store_order_status_id_seq',GREATEST((SELECT max(id) FROM store_order_status),1),true)");
    function role(value: string) { if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(value)) throw Error('Unowned distribution LOGIN'); return '"' + value + '"'; }
    const grantDistributionReader = async (name: string) => { await f.exec(`GRANT SELECT ON public.express_company,public.store_order_refund,
      public.order_waybill_job,public.store_delivery_order,public.customer_city_delivery_job,public.customer_city_delivery_attempt,public.customer_city_delivery_binding TO ${role(name)}`); };
    const grantDistributionWriter = async (name: string) => { await grantDistributionReader(name);
      await f.exec(`GRANT UPDATE ON public.system_admin,public.system_supplier,public.system_role,public.system_menus,public.express_company,public.store_delivery_order TO ${role(name)};
        GRANT UPDATE(delivery_name,delivery_code,delivery_id,fictitious_content) ON public.store_order TO ${role(name)};
        GRANT INSERT ON public.store_order_status TO ${role(name)}; GRANT USAGE ON SEQUENCE public.store_order_status_id_seq TO ${role(name)}`); };
    type Peer = Parameters<Parameters<typeof f.withReader>[0]>[0];
    const withDistributionReader = <T>(work: (peer: Peer) => Promise<T>) => f.withReader(async peer => { await grantDistributionReader(peer.role); return work(peer); });
    const withDistributionWriter = <T>(work: (peer: Peer) => Promise<T>) => f.withReader(async peer => { await grantDistributionWriter(peer.role); return work(peer); });
    return { ...f, ids: supplierDistributionIds, grantDistributionReader, grantDistributionWriter, withDistributionReader, withDistributionWriter, withWriter: withDistributionWriter,
      service: (db = f.db) => new SupplierOrderDistributionService(createContainerFromDb(db), supplierTrackingAppKey),
      body: (revision: string, name = '本机新快递', number = 'CORRECTED-100') => ({ expected_revision: revision, delivery_name: name, delivery_id: number, fictitious_content: '' }),
      audit: () => f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id) };
  } catch (error) { await f.close(); throw error; }
}
