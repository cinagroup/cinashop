import { createCustomerCashierRequests, type CustomerCashierRequests } from '@/api/customerWorkCashier';
import { parseCustomerCashierCatalogEnvelope } from '@/utils/customerWorkCashierCatalog';
import { parseCustomerWorkUserEnvelope, isCustomerWorkUserList, isCustomerWorkUserDetailData } from '@/utils/customerWorkUsersContract';
import type { CustomerWorkController } from './useCustomerWork';
import type { CustomerCashierCapabilityController } from './useCustomerCashierCapabilities';
export function useCustomerCashierCatalog(manager: CustomerWorkController, domain: CustomerCashierCapabilityController) {
  const requests = new Set<CustomerCashierRequests>(); let epoch = 0;
  function clear() { epoch++; for (const scope of requests) scope.abort(); requests.clear(); }
  async function run<T>(path: string, parse: (value: unknown, uid: number, authority: NonNullable<typeof manager.context.value>) => T, data: Record<string, unknown> = {}): Promise<T> {
    const authority = manager.context.value, fence = manager.fence(), domainFence = domain.fence(), version = epoch;
    if (!manager.current() || !authority || !domain.ready.value) throw Error('当前账号没有次卡收银选品权限');
    const scope = createCustomerCashierRequests(() => manager.current() && fence() && domainFence() && version === epoch); requests.add(scope);
    try {
      const result = parse(await scope.request(path, 'GET', { ...data, scope_key: authority.scope_key }), scope.owner.uid, authority);
      if (!scope.active()) throw Error('次卡选品页面或账号已变化'); return result;
    } catch (failure) { if (scope.active()) manager.invalidate(failure); throw failure; }
    finally { scope.abort(); requests.delete(scope); }
  }
  const read = <T>(path: string, guard: (value: unknown) => value is T, data: Record<string, unknown> = {}) => run(path, (value, uid, authority) => parseCustomerCashierCatalogEnvelope(value, uid, guard, authority), data);
  const users = (data: Record<string, unknown> = {}) => run('/mobile/work/users', (value, uid, authority) => parseCustomerWorkUserEnvelope(value, uid, isCustomerWorkUserList, authority), data);
  const user = (uid: number) => run(`/mobile/work/users/${uid}`, (value, owner, authority) => parseCustomerWorkUserEnvelope(value, owner, isCustomerWorkUserDetailData, authority));
  return { read, users, user, clear };
}
