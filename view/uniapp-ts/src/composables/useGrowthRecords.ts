import { computed, ref, watch } from 'vue';
import { onShow, onHide, onUnload, onReachBottom } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createGrowthRecordRequests, groupGrowthRecords, type GrowthRecord, type GrowthRecordRequests } from '@/api/growthRecords';

export function useGrowthRecords() {
  const auth = useAuthStore(), visible = ref(false), rows = ref<GrowthRecord[]>([]), total = ref<number | null>(null);
  const loading = ref(false), loaded = ref(false), error = ref(''), hasMore = ref(false);
  const loggedIn = computed(() => auth.isLoggedIn && auth.uid > 0), groups = computed(() => groupGrowthRecords(rows.value));
  let generation = 0, nextPage = 1, failedAppend = false, disposed = false, requests: GrowthRecordRequests | undefined;
  function clear() {
    generation++; requests?.abort(); requests = undefined; rows.value = []; total.value = null;
    loading.value = false; loaded.value = false; error.value = ''; hasMore.value = false; nextPage = 1; failedAppend = false;
  }
  async function load(append = false) {
    if (!visible.value || disposed || !loggedIn.value || loading.value || append && !hasMore.value) return;
    const ticket = ++generation, page = append ? nextPage : 1;
    requests?.abort(); const scope = createGrowthRecordRequests(() => visible.value && !disposed && ticket === generation); requests = scope;
    loading.value = true; error.value = ''; failedAppend = append;
    try {
      if (!append && loaded.value) uni.pageScrollTo({ scrollTop: 0, duration: 0 });
      const data = await scope.ledger(page); if (!scope.active()) return;
      if (data.list.length !== Math.max(0, Math.min(20, data.count - (page - 1) * 20))) throw Error('经验分页不完整，请刷新后查看');
      if (append && (data.count !== total.value || data.list.length > 0 && rows.value.length > 0 && data.list[0]!.id >= rows.value.at(-1)!.id)) throw Error('经验记录已变化，请刷新后查看');
      rows.value = append ? [...rows.value, ...data.list] : data.list; total.value = data.count;
      nextPage = page + 1; hasMore.value = rows.value.length < data.count; loaded.value = true;
    } catch (cause) { if (scope.active()) error.value = cause instanceof Error ? cause.message : '经验记录加载失败'; }
    finally { if (ticket === generation) loading.value = false; scope.abort(); if (requests === scope) requests = undefined; }
  }
  function retry() { if (error.value) void load(failedAppend); }
  function login() { if (visible.value && !disposed && !loggedIn.value) uni.navigateTo({ url: '/pages/auth/login' }); }
  watch(() => [auth.uid, auth.token, auth.sessionVersion], clear, { flush: 'sync' });
  onShow(() => { visible.value = true; clear(); void load(); });
  onHide(() => { visible.value = false; clear(); });
  onUnload(() => { visible.value = false; disposed = true; clear(); });
  onReachBottom(() => { if (loaded.value && !error.value) void load(true); });
  return { groups, rows, total, loading, loaded, error, hasMore, loggedIn, load, retry, login };
}
