import { computed, ref, watch } from 'vue';
import { onShow, onHide, onUnload, onReachBottom } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createSignRequests, type SignMonth, type SignRequests } from '@/api/signCentre';

export function useSignRecords() {
  const auth = useAuthStore(), visible = ref(false), groups = ref<SignMonth[]>([]), loading = ref(false), loaded = ref(false), error = ref(''), hasMore = ref(false);
  const loggedIn = computed(() => auth.isLoggedIn && auth.uid > 0);
  let epoch = 0, nextPage = 1, disposed = false, scope: SignRequests | undefined;
  function clear() { epoch++; scope?.abort(); scope = undefined; groups.value = []; loading.value = false; loaded.value = false; error.value = ''; hasMore.value = false; nextPage = 1; }
  async function load(append = false) {
    if (!visible.value || disposed || loading.value || !loggedIn.value || (append && !hasMore.value)) return;
    if (!append) clear();
    const id = epoch, current = () => !disposed && visible.value && id === epoch;
    const s = createSignRequests(current); scope = s; const page = nextPage;
    loading.value = true; error.value = '';
    try {
      const rows = await s.months(page);
      if (!s.active()) return;
      if (append && rows.length && groups.value.length && rows[0]!.month >= groups.value.at(-1)!.month) throw Error('签到记录已变化，请刷新后查看');
      const ids = new Set(groups.value.flatMap(g => g.list.map(r => r.id)));
      if (append && rows.some(g => g.list.some(r => ids.has(r.id)))) throw Error('签到记录已变化，请刷新后查看');
      groups.value = append ? [...groups.value, ...rows] : rows; hasMore.value = rows.length === 8; loaded.value = true; nextPage = page + 1;
    } catch (e) { if (s.active()) error.value = e instanceof Error ? e.message : '签到记录加载失败'; }
    finally { if (current()) loading.value = false; s.abort(); if (scope === s) scope = undefined; }
  }
  function login() { if (visible.value && !loggedIn.value) uni.navigateTo({ url: '/pages/auth/login' }); }
  watch(() => [auth.uid, auth.token, auth.sessionVersion], clear, { flush: 'sync' });
  onShow(() => { visible.value = true; clear(); void load(); });
  onHide(() => { visible.value = false; clear(); });
  onUnload(() => { disposed = true; visible.value = false; clear(); });
  onReachBottom(() => { if (!error.value && groups.value.length) void load(true); });
  return { groups, loading, loaded, error, hasMore, loggedIn, load, login };
}
