import { ref, watch, type Ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { apiIntegralCollect, apiIntegralCollectState } from '@/api/activity';
import type { IntegralDetail } from '../../../common/integralPurchase';

/** Legacy type 4 collects the related ordinary product, never the activity id. */
export function useIntegralCollection(detail: Ref<IntegralDetail | null>, visible: Ref<boolean>) {
  const auth = useAuthStore(), collected = ref<boolean | null>(null), collectionLoading = ref(false), collectionSaving = ref(false), collectionError = ref('');
  let generation = 0;
  function reset() { generation++; collected.value = null; collectionLoading.value = false; collectionSaving.value = false; collectionError.value = ''; }
  async function loadCollection() {
    const productId = detail.value?.storeInfo.productId;
    if (!productId || !visible.value || !auth.isLoggedIn || collectionSaving.value) return;
    const current = ++generation, owner = auth.sessionVersion;
    collectionLoading.value = true; collectionError.value = ''; collected.value = null;
    try {
      const result = await apiIntegralCollectState(productId);
      if (current !== generation || owner !== auth.sessionVersion || !visible.value || detail.value?.storeInfo.productId !== productId) return;
      collected.value = result;
    } catch (e) { if (current === generation && visible.value) collectionError.value = e instanceof Error ? e.message : '收藏状态读取失败'; }
    finally { if (current === generation) collectionLoading.value = false; }
  }
  async function toggleCollection() {
    if (!detail.value || !visible.value || collectionLoading.value || collectionSaving.value) return;
    if (!auth.isLoggedIn) { uni.navigateTo({ url: '/pages/auth/login' }); return; }
    if (collected.value === null) { await loadCollection(); return; }
    const current = generation, owner = auth.sessionVersion, productId = detail.value.storeInfo.productId, previous = collected.value;
    collectionSaving.value = true; collectionError.value = '';
    try {
      await apiIntegralCollect(productId, previous);
      if (current !== generation || owner !== auth.sessionVersion || !visible.value || detail.value?.storeInfo.productId !== productId) return;
      collected.value = !previous;
    } catch (e) {
      if (current === generation && visible.value) { collected.value = null; collectionError.value = e instanceof Error ? e.message : '收藏结果未确认，请重新读取收藏状态'; }
    } finally { if (current === generation) collectionSaving.value = false; }
  }
  watch(() => [detail.value?.storeInfo.productId, visible.value, auth.sessionVersion, auth.token, auth.uid], () => { reset(); void loadCollection(); }, { flush: 'sync' });
  return { collected, collectionLoading, collectionSaving, collectionError, loadCollection, toggleCollection };
}
