import { onScopeDispose, reactive, watch, type Ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { createProductEstimateRequests, type ProductEstimateRequests, type PublicProductEstimate } from '@/api/productEstimate';
import { validPublicEstimateSku } from '../../../common/publicProductEstimate';

/** Independent advisory reads never touch the purchase or coupon-claim journal. */
export function useProductEstimate(productId: Ref<number>, skuUnique: Ref<string>, active: Ref<boolean>, captureView: () => () => boolean) {
  const auth = useAuthStore(), state = reactive({ result: null as PublicProductEstimate | null, loading: false, error: '' });
  const requests = new Set<ProductEstimateRequests>();
  let generation = 0, disposed = false, browserVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  function persisted() {
    try { return String(uni.getStorageSync('uni_token') || '') === auth.token
      && (Number(uni.getStorageSync('uni_uid')) || 0) === auth.uid; } catch { return false; }
  }
  const current = () => !disposed && active.value && browserVisible && Number.isSafeInteger(productId.value)
    && productId.value > 0 && productId.value <= 2_147_483_647 && validPublicEstimateSku(skuUnique.value) && persisted();
  function clear() {
    generation++; for (const request of requests) request.abort(); requests.clear();
    state.result = null; state.loading = false; state.error = '';
  }
  async function load() {
    clear(); if (!current()) return;
    const epoch = generation, id = productId.value, unique = skuUnique.value, view = captureView();
    const request = createProductEstimateRequests(() => current() && epoch === generation
      && id === productId.value && unique === skuUnique.value && view(), id, unique);
    requests.add(request); state.loading = true;
    try { const result = await request.read(); if (request.active()) state.result = result; }
    catch (error) { if (request.active()) state.error = error instanceof Error ? error.message : '商品单件预估读取失败，请重试'; }
    finally { if (request.active()) state.loading = false; requests.delete(request); request.abort(); }
  }
  function reload() {
    clear(); const epoch = generation;
    void Promise.resolve().then(() => { if (epoch === generation && current()) void load(); });
  }
  watch(() => [active.value, productId.value, skuUnique.value, auth.uid, auth.token, auth.sessionVersion], reload,
    { immediate: true, flush: 'sync' });
  function changed() {
    if (disposed) return;
    let token = '', uid = 0;
    try { token = String(uni.getStorageSync('uni_token') || ''); uid = Number(uni.getStorageSync('uni_uid')) || 0; }
    catch { clear(); return; }
    if (token !== auth.token || uid !== auth.uid) { clear(); auth.$patch({ token, uid, sessionVersion: auth.sessionVersion + 1 }); }
    else reload();
  }
  function visibility() { browserVisible = document.visibilityState !== 'hidden'; reload(); }
  // #ifdef H5
  if (typeof window !== 'undefined') { window.addEventListener('focus', changed); window.addEventListener('storage', changed); }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
  // #endif
  onScopeDispose(() => {
    disposed = true; clear();
    // #ifdef H5
    if (typeof window !== 'undefined') { window.removeEventListener('focus', changed); window.removeEventListener('storage', changed); }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility);
    // #endif
  });
  return { state, load, clear };
}
