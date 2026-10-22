import { defineStore } from 'pinia';
import { ref } from 'vue';
import { createNativeFooterCoordinator } from '@/utils/nativeFooterCoordinator';

export const useNativeFooterStore = defineStore('native-footer', () => {
  const owner = ref<string | null>(null), error = ref(''), pending = ref(false), hidden = ref<boolean | undefined>();
  const coordinator = createNativeFooterCoordinator((hide, done) => {
    const api = hide ? uni.hideTabBar : uni.showTabBar;
    if (typeof api !== 'function') { done('底部导航暂时无法调整'); return; }
    try { api({ animation: false, success: () => done(), fail: reason => {
      // Uni removes the native bar on non-tab routes before running Page hooks.
      if (hide && /not.*tab.?bar|非.*tab.?bar/iu.test(reason.errMsg ?? '')) { done(); return; }
      done(hide ? '底部导航暂未收起，请重试' : '底部导航暂未恢复，请重试');
    } }); }
    catch { done('底部导航暂时无法调整'); }
  }, (id, message, busy, applied) => { owner.value = id; error.value = message; pending.value = busy; hidden.value = applied; });
  return { owner, error, pending, hidden, claim: coordinator.claim, release: coordinator.release, retry: coordinator.retry,
    invalidatePhysical: coordinator.invalidatePhysical, reconcilePhysical: coordinator.reconcilePhysical };
});
