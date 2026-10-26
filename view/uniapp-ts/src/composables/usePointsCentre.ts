import { computed, ref, watch } from 'vue';
import { onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createPointsRequests, type PointsRequests, type PointsSummary } from '@/api/pointsCentre';

export function usePointsCentre() {
  const auth = useAuthStore(), visible = ref(false), summary = ref<PointsSummary | null>(null), signEnabled = ref(false);
  const loading = ref(false), loaded = ref(false), error = ref('');
  const loggedIn = computed(() => auth.isLoggedIn && auth.uid > 0);
  let epoch = 0, disposed = false, requests: PointsRequests | undefined;
  function clear() { epoch++; requests?.abort(); requests = undefined; summary.value = null; signEnabled.value = false; loading.value = false; loaded.value = false; error.value = ''; }
  async function load() {
    if (!visible.value || disposed || !loggedIn.value || loading.value) return;
    clear(); const id = epoch, scope = createPointsRequests(() => visible.value && !disposed && epoch === id); requests = scope;
    loading.value = true;
    try {
      const [points, enabled] = await Promise.all([scope.summary(), scope.signEnabled()]);
      if (!scope.active()) return;
      summary.value = points; signEnabled.value = enabled; loaded.value = true;
    } catch (e) { if (scope.active()) error.value = e instanceof Error ? e.message : '积分详情加载失败'; }
    finally { if (id === epoch) loading.value = false; scope.abort(); if (requests === scope) requests = undefined; }
  }
  function login() { if (visible.value && !disposed && !loggedIn.value) uni.navigateTo({ url: '/pages/auth/login' }); }
  function go(target: 'shop' | 'mall' | 'lottery' | 'sign' | 'ledger') {
    if (!visible.value || disposed || !loggedIn.value || !loaded.value || target === 'sign' && !signEnabled.value) return;
    if (target === 'shop') uni.switchTab({ url: '/pages/index/index' });
    else uni.navigateTo({ url: { mall: '/pages/user/integral', lottery: '/pages/activity/lottery?factor=1', sign: '/pages/user/sign', ledger: '/pages/user/integralLogs' }[target] });
  }
  watch(() => [auth.uid, auth.token, auth.sessionVersion], clear, { flush: 'sync' });
  onShow(() => { visible.value = true; clear(); void load(); });
  onHide(() => { visible.value = false; clear(); });
  onUnload(() => { visible.value = false; disposed = true; clear(); });
  return { summary, signEnabled, loading, loaded, error, loggedIn, load, login, go };
}
