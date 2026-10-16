import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin, systemSupplier, systemRole, systemMenus, storeOrder, storeOrderCartInfo,
  storeOrderStatus, storeOrderOutbox, user } from '@/models/schema';
import { installSupplierOrderPriceRevision } from '@/migrations/supplierOrderPriceRevision';
import { installSupplierOrderEditOperation } from '@/migrations/supplierOrderEditOperation';
import { SupplierUnpaidOrderEditService } from '@/services/supplier/SupplierUnpaidOrderEditService';
import { md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './refundRuntimeFixture';

export const supplierOrderEditAppKey = 'owned-native-unpaid-order-edit-key';
export const supplierOrderEditPassword = 'owned-native-unpaid-order-edit-password';
export const supplierOrderEditActor = (id = 21) => ({ id, supplierId: id >= 30 ? 8 : 7,
  authVersion: md5(supplierOrderEditPassword), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
export async function supplierUnpaidOrderEditFixture() {
  const f = await refundRuntimeFixture(), container = createContainerFromDb(f.db);
  try {
    await f.db.transaction(async tx => { await installSupplierOrderEditOperation(tx); await installSupplierOrderPriceRevision(tx); });
    await f.db.update(systemSupplier).set({ adminId: 29 }).where(eq(systemSupplier.id, 7));
    await f.db.insert(systemSupplier).values({ id: 8, adminId: 39, supplierName: 'Foreign unpaid edit fixture' });
    await f.db.insert(systemRole).values([
      { id: 21, type: 4, relationId: 7, rules: 'supplier.order.manage' },
      { id: 22, type: 4, relationId: 7, rules: 'supplier.order.view' },
      { id: 23, type: 4, relationId: 7, rules: '991901' },
      { id: 31, type: 4, relationId: 8, rules: 'supplier.order.manage' },
    ]);
    await f.db.insert(systemAdmin).values([21, 22, 23, 29, 31, 39].map(id => ({ id,
      account: 'owned-unpaid-edit-' + id, pwd: supplierOrderEditPassword, adminType: 4,
      relationId: id >= 30 ? 8 : 7, roles: [29, 39].includes(id) ? '' : String(id), level: [29, 39].includes(id) ? 0 : 1 })));
    await f.db.insert(systemMenus).values({ id: 991901, type: 4, authType: 2, apiUrl: 'order/edit/<id>', methods: 'GET', menuName: 'Owned edit view' });
    await f.db.update(user).set({ nowMoney: '1000.00', integral: 100 }).where(eq(user.uid, 11));
    const service = new SupplierUnpaidOrderEditService(container, supplierOrderEditAppKey);
    const checkout = async () => f.withRuntime(async runtime => {
      const created = await runtime.checkout({ key: 'edit' + randomUUID().replaceAll('-', ''), orderId: 'wx' + randomUUID().replaceAll('-', '').slice(0, 28) });
      return (await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId)))[0];
    });
    const body = async (id: number, actor = supplierOrderEditActor()) => {
      const seed = await service.seed(id, actor);
      return { ...seed.values, operation_id: randomUUID(), revision: seed.revision };
    };
    const state = async (id: number) => ({
      order: (await f.db.select().from(storeOrder).where(eq(storeOrder.id, id)))[0],
      carts: await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(storeOrderCartInfo.id),
      statuses: await f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id)).orderBy(storeOrderStatus.id),
      outbox: (await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.aggregateId, id)).orderBy(storeOrderOutbox.id)),
      operations: await f.db.execute(sql`SELECT * FROM public.supplier_order_edit_operation_v1 WHERE order_id = ${id} ORDER BY created_at, operation_id`),
    });
    const withEditRuntime = <T>(work: (runtime: ReturnType<typeof f.operationsFor>, service: SupplierUnpaidOrderEditService) => Promise<T>) => f.withRuntime(async runtime => {
      // Explicit feature commissioning on this fresh owned non-owner LOGIN.
      // Neither the frozen app plan nor production role is broadened.
      await f.exec(`GRANT SELECT,UPDATE ON public.system_admin,public.system_supplier,public.system_role,public.system_menus TO "${runtime.role}"`);
      await f.exec(`GRANT SELECT ON public.store_order_promotions TO "${runtime.role}"; GRANT UPDATE(id) ON public.store_order_promotions TO "${runtime.role}"`);
      await f.exec(`GRANT SELECT,INSERT ON public.supplier_order_edit_operation_v1 TO "${runtime.role}"`);
      return work(runtime, new SupplierUnpaidOrderEditService(runtime.container, supplierOrderEditAppKey));
    });
    return { ...f, container, service, checkout, body, editState: state, withEditRuntime };
  } catch (error) { await f.close(); throw error; }
}
export function supplierOrderEditService(db: DbClient) { return new SupplierUnpaidOrderEditService(createContainerFromDb(db), supplierOrderEditAppKey); }
