import type { DbClient } from '@/lib/di';
import { withRemarkScenario, type RemarkScenario } from './adminOrderRemark';
import { preparePriceFixture } from './adminOrderPriceFixture';

export interface PriceScenario extends RemarkScenario { roles: { app: string; admin: string }; databases: { app: DbClient; admin: DbClient } }
export function withPriceScenario(work: (s: PriceScenario) => Promise<void>) {
  let roles: PriceScenario['roles'], databases: PriceScenario['databases'];
  return withRemarkScenario(s => work({ ...s, roles, databases, snapshot: async () => ({ ...await s.snapshot(),
    store_order_cart_info: await s.f.exec('SELECT to_jsonb(t) AS row FROM public.store_order_cart_info t ORDER BY id'),
    admin_order_price_operation: await s.f.exec('SELECT to_jsonb(t) AS row FROM public.admin_order_price_operation_v1 t ORDER BY operation_id'),
  }) }), async (f, configured, connections) => { roles = configured; databases = connections; await preparePriceFixture(f.db, roles.admin, [roles.app]); });
}
