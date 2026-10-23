import { computed, onScopeDispose, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { http } from '@/utils/request';
import { closeDiyStation, diyStationClosure } from '@/utils/diy';
import { diyEditorialMediaDeadline } from '@/utils/diyEditorialMediaLease';
import { normalizeDiyCustomerService, openCustomerServiceEntry, openCustomerServiceLink, readCustomerServiceEntry, type CustomerServiceEntry } from '@/utils/diyCustomerService';

export function useDiyCustomerService(block: () => unknown, active: () => boolean) {
  const auth = useAuthStore(), epoch = ref(0), expired = ref(false), deadline = ref(Infinity);
  const entry = ref<CustomerServiceEntry | null>(null), loading = ref(false), error = ref('');
  const config = computed(() => {
    try { return { value: normalizeDiyCustomerService(block()), error: '' }; }
    catch (reason) { return { value: null, error: reason instanceof Error ? reason.message : '悬浮客服配置无效' }; }
  });
  let mini = false;
  // #ifdef MP
  mini = true;
  // #endif
  const nativeContact = computed(() => mini && config.value.value?.contactType === 1);
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, request = 0, entryUntil = 0;
  const ready = () => !disposed && active() && !diyStationClosure.value && !expired.value && deadline.value > Date.now()
    && !!config.value.value?.enabled && !!config.value.value.logo
    && (!mini || config.value.value.contactType === 0 || nativeContact.value);
  function lease() {
    const generation = epoch.value, actor = owner();
    return () => ready() && generation === epoch.value && actor === owner();
  }
  async function loadEntry() {
    if (!ready() || !config.value.value?.service || nativeContact.value || loading.value) return;
    const allowed = lease(), serial = ++request;
    entry.value = null; entryUntil = 0; loading.value = true; error.value = '';
    try {
      const value = await http.get('/get_customer_type', {}, {noAuth: true, headers: {'Cache-Control': 'no-cache'}});
      if (!allowed() || serial !== request) return;
      entry.value = readCustomerServiceEntry(value); entryUntil = Date.now() + 60_000;
    } catch (reason) {
      if (!allowed() || serial !== request) return;
      if (reason && typeof reason === 'object' && 'status' in reason && reason.status === 410010) {
        closeDiyStation(reason instanceof Error ? reason.message : '站点暂未开放'); return;
      }
      error.value = reason instanceof Error ? reason.message : '客服入口读取失败，请重新读取';
    } finally { if (allowed() && serial === request) loading.value = false; }
  }
  function open(allowed: () => boolean) {
    if (!allowed() || nativeContact.value) return;
    if (!config.value.value?.service) {
      openCustomerServiceLink(config.value.value?.link ?? '', allowed, () => { error.value = '页面链接无效或暂时无法打开'; }); return;
    }
    // Platform customer-chat APIs require the actual user gesture. Never call
    // them from the asynchronous config response, retry or page activation.
    if (!entry.value || Date.now() >= entryUntil) {
      error.value = loading.value ? '正在读取客服入口，请稍后点击' : '客服入口需重新读取，完成后请再次点击';
      if (!loading.value) void loadEntry();
      return;
    }
    const failed = () => { if (allowed()) error.value = '客服入口暂时无法打开，请再次点击重试'; };
    try { openCustomerServiceEntry(entry.value, allowed, failed); } catch { failed(); }
  }
  function reset() {
    if (timer !== undefined) clearTimeout(timer);
    epoch.value++; request++; expired.value = false; loading.value = false; entry.value = null; entryUntil = 0; error.value = '';
    deadline.value = diyEditorialMediaDeadline({value: [block()]}, Date.now());
    const generation = epoch.value;
    if (active() && Number.isFinite(deadline.value)) timer = setTimeout(() => {
      if (!disposed && generation === epoch.value) { expired.value = true; epoch.value++; request++; entry.value = null; loading.value = false; }
    }, Math.max(0, deadline.value - Date.now()));
    if (ready() && config.value.value?.service && !nativeContact.value) void loadEntry();
  }
  const stop = watch([() => JSON.stringify(block()), owner, active, () => diyStationClosure.value], reset, {immediate: true, flush: 'sync'});
  onScopeDispose(() => { disposed = true; stop(); if (timer !== undefined) clearTimeout(timer); epoch.value++; request++; entry.value = null; loading.value = false; });
  return {config, epoch, expired, entry, loading, error, nativeContact, ready, lease, open, loadEntry};
}
