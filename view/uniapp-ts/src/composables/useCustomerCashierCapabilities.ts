import { computed, ref, watch } from 'vue';
import { onHide, onUnload } from '@dcloudio/uni-app';
import { createCustomerCashierRequests, type CustomerCashierRequests } from '@/api/customerWorkCashier';
import { parseCustomerCashierCapabilities } from '@/utils/customerCashierCapabilities';
import type { CustomerCashierCapabilities } from '@/types/customerCashierCapabilities';
import type { CustomerWorkController } from './useCustomerWork';

/** Page-local display authority. Every author still obtains fresh server authorization. */
export function useCustomerCashierCapabilities(manager: CustomerWorkController) {
  const state = ref<CustomerCashierCapabilities | null>(null), loading = ref(false), error = ref('');
  let disposed = false, epoch = 0, request: CustomerCashierRequests | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null, accepted: (() => boolean) | null = null;
  function clear() {
    epoch++; request?.abort(); request = null; if (timer) clearTimeout(timer); timer = null;
    accepted = null; state.value = null; loading.value = false; error.value = '';
  }
  function authority(): CustomerCashierCapabilities | null {
    // Always track the reactive snapshot, including the first pending render.
    // The plain accepted fence must not short-circuit the computed dependency.
    const value = state.value;
    return !disposed && manager.current() && manager.auth.isLoggedIn && accepted?.()
      && value && value.data.lease.session_expires_at * 1000 > Date.now() ? value : null;
  }
  const ready = computed(() => authority()?.data.capabilities.cashier_second_card === true);
  const imagesReady = computed(() => authority()?.data.capabilities.cashier_form_images === true);
  function requireAuthority(images = false) {
    const value = authority();
    if (!value || value.data.capabilities.cashier_second_card !== true || images && value.data.capabilities.cashier_form_images !== true)
      throw Error(images ? '当前账号暂不能准备次卡表单图片，请重新读取' : '当前账号暂不能进行次卡收银，请重新读取');
    return value;
  }
  function fence() {
    const version = epoch, value = authority();
    return () => value !== null && version === epoch && authority() === value;
  }
  async function load(): Promise<boolean> {
    clear(); const ordinary = manager.context.value, valid = manager.fence(), version = epoch;
    if (disposed || !manager.current() || !manager.auth.isLoggedIn || !ordinary || !valid()) return false;
    const owner = { uid: manager.auth.uid, token: manager.auth.token, version: manager.auth.sessionVersion };
    const ownerScope = { key: ordinary.scope_key, service: ordinary.principal.service_id, consistency: ordinary.consistency_key };
    const same = () => !disposed && epoch === version && manager.auth.uid === owner.uid && manager.auth.token === owner.token
      && manager.auth.sessionVersion === owner.version && manager.context.value === ordinary && ordinary.scope_key === ownerScope.key
      && ordinary.principal.service_id === ownerScope.service && ordinary.consistency_key === ownerScope.consistency;
    const scope = createCustomerCashierRequests(() => same() && manager.current() && valid()); request = scope; loading.value = true;
    try {
      const response = parseCustomerCashierCapabilities(await scope.request('/mobile/work/cashier/second-card/capabilities'), owner.uid, ordinary);
      if (!scope.active()) return false;
      accepted = same; state.value = response;
      // The short GET lease rejects a stale arrival. An accepted display snapshot
      // follows this page/session lifetime; it never authorizes a server write.
      // Normal form entry must not be erased after sixty seconds.
      const expireSession = () => {
        if (!same()) return;
        const remaining = response.data.lease.session_expires_at * 1000 - Date.now();
        if (remaining <= 0) { clear(); error.value = '原登录已到期，请重新登录后核对原编号'; return; }
        timer = setTimeout(expireSession, Math.min(2_147_483_647, remaining));
      };
      expireSession();
      return response.data.capabilities.cashier_second_card;
    } catch (failure) {
      if (scope.active()) error.value = failure instanceof Error ? failure.message : '次卡收银能力暂不可读';
      return false;
    } finally {
      if (same()) loading.value = false;
      scope.abort(); if (request === scope) request = null;
    }
  }
  onHide(() => { if (!manager.suspendLeaseActive()) clear(); });
  onUnload(() => { disposed = true; clear(); });
  watch(() => [manager.auth.uid, manager.auth.token, manager.auth.sessionVersion], clear, { flush: 'sync' });
  watch(() => [manager.context.value, manager.context.value?.scope_key, manager.context.value?.principal.service_id, manager.context.value?.consistency_key], clear, { flush: 'sync' });
  return { state, loading, error, ready, imagesReady, authority, requireAuthority, fence, load, clear };
}
export type CustomerCashierCapabilityController = ReturnType<typeof useCustomerCashierCapabilities>;
