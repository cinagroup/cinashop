import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { eq } from 'drizzle-orm';
import { storeOrder } from '@/models/schema';
import { installAdminOrderEditRuntime } from '@/migrations/adminOrderEditRuntime';
import { withRemarkScenario, type RemarkScenario } from './adminOrderRemark';

export interface EditScenario extends RemarkScenario {
  roles: { app: string; admin: string }; databases: { app: DbClient; admin: DbClient };
  checkout(): Promise<{ id: number; orderId: string }>;
}
export function withEditScenario(work: (s: EditScenario) => Promise<void>) {
  let roles: EditScenario['roles'], databases: EditScenario['databases'];
  return withRemarkScenario(s => work({ ...s, roles, databases,
    checkout: async () => s.f.withRuntime(async runtime => {
      const created = await runtime.checkout({ key: 'admin' + crypto.randomUUID().replaceAll('-', ''), orderId: 'ad' + crypto.randomUUID().replaceAll('-', '').slice(0, 28) });
      const [order] = await s.f.db.select({ id: storeOrder.id, orderId: storeOrder.orderId }).from(storeOrder)
        .where(eq(storeOrder.orderId, created.orderId)).limit(1);
      if (!order) throw Error('Owned checkout order missing');
      return order;
    }),
    snapshot: async () => ({ ...await s.snapshot(),
      carts: await s.f.exec('SELECT to_jsonb(t) AS row FROM public.store_order_cart_info t ORDER BY id'),
      operations: await s.f.exec('SELECT to_jsonb(t) AS row FROM public.admin_order_edit_operation_v1 t ORDER BY operation_id'),
      partitions: await s.f.exec('SELECT to_jsonb(t) AS row FROM public.admin_order_gain_partition_v1 t ORDER BY partition_id'),
    }),
  }), async (f, configured, connections) => {
    roles = configured; databases = connections;
    await withTx(createContainerFromDb(f.db), tx => installAdminOrderEditRuntime(tx, { admin: roles.admin, financial: [roles.app] }));
  });
}
