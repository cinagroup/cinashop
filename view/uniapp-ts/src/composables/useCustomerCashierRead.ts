import { createCustomerCashierReadRequests, type CustomerCashierReadRequests } from '@/api/customerWorkCashierRead';
import { parseCustomerCashierReadEnvelope } from '@/utils/customerWorkCashierRead';
import type { CustomerCashierReadEnvelope } from '@/types/customerWorkCashierRead';
import type { CustomerWorkController } from './useCustomerWork';

export function useCustomerCashierRead(manager: CustomerWorkController) {
  const scopes = new Set<CustomerCashierReadRequests>(); let epoch = 0;
  function clear() { epoch++; for (const scope of scopes) scope.abort(); scopes.clear(); }
  async function read<T>(path: string, guard: (data: unknown) => data is T, query: Record<string, string | number> = {}): Promise<CustomerCashierReadEnvelope<T>> {
    const authority = manager.context.value;
    if (!manager.current() || !authority || authority.data.capabilities.cashier_records !== true) throw Error('当前账号没有本人次卡收银记录查询权限');
    const valid = manager.fence(), version = epoch;
    const scope = createCustomerCashierReadRequests(() => valid() && version === epoch);
    scopes.add(scope);
    try {
      const result = parseCustomerCashierReadEnvelope(await scope.request(`/mobile/work/cashier/second-card/${path}`,
        { ...query, scope_key: authority.scope_key }), scope.owner.uid, guard, authority);
      if (!scope.active()) throw Error('页面或经营账号已变化');
      return result;
    } finally { scope.abort(); scopes.delete(scope); }
  }
  return { clear, read };
}
