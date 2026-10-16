import { randomUUID } from 'node:crypto';
import type { Env } from '@/env';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import { storeOrder, storeOrderOutbox, systemRole } from '@/models/schema';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { StoreOrderPayService } from '@/services/order/StoreOrderPayService';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { SupplierOfflinePaymentService } from '@/services/supplier/SupplierOfflinePaymentService';
import { installSupplierOfflinePaymentOperation } from '@/migrations/supplierOfflinePaymentOperation';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import { supplierUnpaidOrderEditFixture, supplierOrderEditActor, supplierOrderEditAppKey } from './supplierUnpaidOrderEdit';

// Reviewed existing worker capabilities, applied only to a separate, newly
// authenticated owned paid-consumer LOGIN. The Supplier writer is not given
// the queue consumer's DML or a Customer principal/capability.
export const supplierPaidConsumerExtraTables = ['store_order_outbox', 'store_order_economize', 'store_product_coupon',
  'store_coupon_issue', 'store_coupon_issue_user', 'store_coupon_user', 'store_order_product_coupon_reward',
  'store_order_promotion_gift_coupon_reward', 'store_promotions', 'store_promotions_auxiliary',
  'user_label', 'user_label_relation', 'order_print_job', 'order_print_job_action', 'store_product_virtual',
  'system_user_level', 'user_level', 'store_service_record', 'store_order_promotions', 'system_notification', 'system_message',
  'order_notification_delivery', 'store_product_log', 'store_order_writeoff'] as const;
export async function supplierOfflinePaymentFixture() {
  const f = await supplierUnpaidOrderEditFixture();
  try {
    await f.db.transaction(tx => installSupplierOfflinePaymentOperation(tx));
    await f.db.update(systemRole).set({ rules: 'supplier.order.manage,supplier.refund.manage' }).where(eq(systemRole.id, 21));
    const environment = { ...f.env, APP_KEY: supplierOrderEditAppKey, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      ORDER_QUEUE: { send: async () => {}, sendBatch: async () => {} } } as unknown as Env;
    const service = new SupplierOfflinePaymentService(f.container, supplierOrderEditAppKey);
    const withPaymentRuntime = <T>(work: (runtime: Parameters<Parameters<typeof f.withEditRuntime>[0]>[0], payment: SupplierOfflinePaymentService) => Promise<T>) =>
      f.withEditRuntime(async runtime => {
        await f.exec(`GRANT SELECT,INSERT ON public.supplier_offline_payment_operation_v1 TO "${runtime.role}"`);
        await f.exec(`GRANT UPDATE ON public.store_order_outbox TO "${runtime.role}"`);
        return work(runtime, new SupplierOfflinePaymentService(runtime.container, supplierOrderEditAppKey));
      });
    const createOffline = async () => withPaymentRuntime(async runtime => {
      const created = await StoreOrderCreateService.createWithRuntime(runtime.container,
        { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'wx' + randomUUID().replaceAll('-', '').slice(0, 28) },
        { uid: 11, key: randomUUID(), cartIds: [1, 2], addressId: 11, userIp: '127.0.0.1', useIntegral: true, payType: 'offline', from: 'pc' });
      const selected = await new StoreOrderPayService(runtime.container, environment).offlinePay(11, created.orderId, 'pc');
      if (selected.paid !== false || selected.pay_type !== 'offline') throw Error('Actual customer offline selection failed');
      const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
      if (!order || order.paid !== 0 || order.supplierId !== 7 || order.payType !== 'offline') throw Error('Actual owned Supplier offline root absent');
      return order;
    });
    const body = async (id: number, payment = service, actor = supplierOrderEditActor()) => {
      const seed = await payment.seed(id, actor);
      return { operation_id: randomUUID(), revision: seed.revision, order_no: seed.order_no, amount: seed.amount,
        ...(seed.cash_required ? { cash_received: true as const } : {}) };
    };
    const withPaidConsumer = <T>(work: (runtime: Parameters<Parameters<typeof f.withRuntime>[0]>[0], consumer: OrderOutboxService) => Promise<T>) =>
      f.withRuntime(async runtime => {
        const plan = runtimeBusinessPrivilegePlan('app');
        for (const table of supplierPaidConsumerExtraTables) {
          const privileges = plan.tables[table]; if (!privileges?.length) throw Error('Reviewed paid consumer capability absent: ' + table);
          await f.exec(`GRANT ${privileges.join(',')} ON public."${table}" TO "${runtime.role}"`);
          const columns = plan.updateColumns[table];
          if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(value => '"' + value + '"').join(',')}) ON public."${table}" TO "${runtime.role}"`);
        }
        const sequences = await f.db.execute<{ name: string; table_name: string }>(sql`SELECT s.relname AS name,t.relname AS table_name
          FROM pg_catalog.pg_class s JOIN pg_catalog.pg_depend d ON d.objid=s.oid AND d.deptype IN ('a','i')
          JOIN pg_catalog.pg_class t ON t.oid=d.refobjid WHERE s.relkind='S' AND s.relnamespace='public'::regnamespace`);
        for (const sequence of sequences) if ((supplierPaidConsumerExtraTables as readonly string[]).includes(sequence.table_name)
          && plan.tables[sequence.table_name]?.includes('INSERT')) await f.exec(`GRANT USAGE ON SEQUENCE public."${sequence.name}" TO "${runtime.role}"`);
        await f.exec(`GRANT SELECT ON public.supplier_order_edit_operation_v1,public.supplier_offline_payment_operation_v1 TO "${runtime.role}"`);
        return work(runtime, new OrderOutboxService(createContainerFromDb(runtime.db), environment));
      });
    const consume = async (id: number, replay = false) => withPaidConsumer(async (_runtime, consumer) => {
      const events = await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, `order.paid:${id}`));
      if (events.length !== 1) throw Error('Genuine Supplier payment must have one paid event');
      const message = { action: 'processOrderPaidOutbox' as const, outboxId: events[0].id, eventKey: events[0].eventKey };
      const outcome = await consumer.processMessage(message);
      if (outcome !== (replay ? 'already-completed' : 'completed')) throw Error('Genuine Supplier paid consumer result inconsistent: ' + outcome);
      return { consumer, message };
    });
    const paymentState = async () => ({ ...await f.state(),
      payment_operations: [...await f.db.execute(sql`SELECT * FROM public.supplier_offline_payment_operation_v1 ORDER BY operation_id`)],
      edit_operations: [...await f.db.execute(sql`SELECT * FROM public.supplier_order_edit_operation_v1 ORDER BY operation_id`)],
      consumer_tables: Object.fromEntries(await Promise.all(supplierPaidConsumerExtraTables.map(async name => [name,
        [...await f.db.execute(sql.raw(`SELECT to_jsonb(t) row FROM public."${name}" t ORDER BY to_jsonb(t)::text`))]]))),
    });
    return { ...f, paymentEnvironment: environment, paymentService: service, withPaymentRuntime, withPaidConsumer, createOffline, paymentBody: body, consumePaid: consume, paymentState };
  } catch (error) { await f.close(); throw error; }
}
