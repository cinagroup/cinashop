import { computed, ref, watch } from 'vue';
import { onShow, onHide, onUnload, onReachBottom } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createPointsRequests, groupPointsRows, type PointsLedgerRow, type PointsRequests } from '@/api/pointsCentre';

export function usePointsLedger() {
  const auth = useAuthStore(), visible = ref(false), rows = ref<PointsLedgerRow[]>([]), total = ref<number | null>(null);
  const loading = ref(false), loaded = ref(false), error = ref(''), hasMore = ref(false);
  const loggedIn = computed(() => auth.isLoggedIn && auth.uid > 0), groups = computed(() => groupPointsRows(rows.value));
  let epoch = 0, nextPage = 1, disposed = false, requests: PointsRequests | undefined;
  function clear() { epoch++; requests?.abort(); requests = undefined; rows.value = []; total.value = null; loading.value = false; loaded.value = false; error.value = ''; hasMore.value = false; nextPage = 1; }
  async function load(append = false) {
    if (!visible.value || disposed || !loggedIn.value || loading.value || append && !hasMore.value) return;
    if (!append) clear();
    const id = epoch, scope = createPointsRequests(() => visible.value && !disposed && id === epoch); requests = scope;
    const page = nextPage; loading.value = true; error.value = '';
    try {
      const data = await scope.ledger(page); if (!scope.active()) return;
      if (append && (data.count !== total.value || data.list.length && rows.value.length && data.list[0]!.id >= rows.value.at(-1)!.id)) throw Error('积分记录已变化，请刷新后查看');
      if (data.list.length !== Math.max(0, Math.min(10, data.count - (page - 1) * 10))) throw Error('积分分页不完整，请刷新后查看');
      rows.value = append ? [...rows.value, ...data.list] : data.list; total.value = data.count;
      hasMore.value = rows.value.length < data.count; loaded.value = true; nextPage = page + 1;
    } catch (e) { if (scope.active()) error.value = e instanceof Error ? e.message : '积分明细加载失败'; }
    finally { if (id === epoch) loading.value = false; scope.abort(); if (requests === scope) requests = undefined; }
  }
  function login() { if (visible.value && !disposed && !loggedIn.value) uni.navigateTo({ url: '/pages/auth/login' }); }
  watch(() => [auth.uid, auth.token, auth.sessionVersion], clear, { flush: 'sync' });
  onShow(() => { visible.value = true; clear(); void load(); });
  onHide(() => { visible.value = false; clear(); });
  onUnload(() => { visible.value = false; disposed = true; clear(); });
  onReachBottom(() => { if (loaded.value && !error.value) void load(true); });
  return { groups, rows, total, loading, loaded, error, hasMore, loggedIn, load, login };
}
