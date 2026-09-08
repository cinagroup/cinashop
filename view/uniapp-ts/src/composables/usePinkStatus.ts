import { computed, ref, shallowRef, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { http } from '@/utils/request';
import { PINK_STATUS_PATH, pinkRouteId, pinkQueryFromHash, parsePinkStatus, pinkCanJoin, pinkAwaitingSettlement, type PinkStatus } from '../../../common/pinkStatus';

export function usePinkStatus() {
  const auth = useAuthStore(), recordId = ref(0), detail = shallowRef<PinkStatus | null>(null);
  const loading = ref(false), error = ref(''), visible = ref(false), navigating = ref(false), clock = ref(Date.now());
  let revision = 0, navRevision = 0, disposed = false, timer: ReturnType<typeof setInterval> | undefined;
  const loggedIn = computed(() => auth.isLoggedIn);
  const pending = computed(() => !!detail.value && pinkAwaitingSettlement(detail.value, clock.value));
  const canJoin = computed(() => !!detail.value && pinkCanJoin(detail.value, clock.value) && !loading.value && !navigating.value);
  const title = computed(() => !detail.value ? '' : detail.value.state === 'success' ? '拼团成功' : detail.value.state === 'failed' ? '拼团失败' : pending.value ? '等待结算确认' : '拼团进行中');
  const remaining = computed(() => {
    if (!detail.value || pending.value || detail.value.leader.status !== 1) return '';
    const seconds = Math.max(0, Math.ceil((detail.value.leader.deadline * 1000 - clock.value) / 1000));
    return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分${seconds % 60}秒`;
  });
  function reset() { revision++; navRevision++; detail.value = null; loading.value = false; navigating.value = false; }
  function setRoute(query: Record<string, unknown> = {}) {
    reset(); recordId.value = 0; error.value = '';
    try { recordId.value = pinkRouteId(query); } catch { error.value = '团记录链接无效，请检查链接或返回活动列表'; }
    if (visible.value) void load();
  }
  async function load() {
    if (!visible.value || disposed || !recordId.value || navigating.value) return;
    const current = ++revision; detail.value = null; error.value = ''; loading.value = false;
    if (!auth.isLoggedIn) return;
    const uid = auth.uid, version = auth.sessionVersion, id = recordId.value; loading.value = true;
    try {
      const value = await http.get<unknown>(`/combination/pink/${id}`);
      if (current !== revision || !visible.value || disposed || version !== auth.sessionVersion) return;
      detail.value = parsePinkStatus(value, uid); clock.value = Date.now();
    } catch (e) { if (current === revision && visible.value) error.value = e instanceof Error ? e.message : '拼团状态加载失败'; }
    finally { if (current === revision && visible.value) loading.value = false; }
  }
  function navigate(url: string) {
    if (!visible.value || disposed || navigating.value) return;
    const current = revision, navigation = ++navRevision; navigating.value = true;
    const fail = () => { if (current === revision && navigation === navRevision && visible.value && !disposed) {
      navigating.value = false; error.value = '页面打开失败，请重试';
    } };
    try { uni.navigateTo({ url, fail }); } catch { fail(); }
  }
  function login() { if (!auth.isLoggedIn && recordId.value) navigate('/pages/auth/login'); }
  function join() {
    if (!detail.value || loading.value || !pinkCanJoin(detail.value, Date.now())) return;
    navigate(`/pages/activity/detail?id=${detail.value.activity.id}&pinkId=${detail.value.leader.id}`);
  }
  function openActivity(id?: number) {
    if (!detail.value || loading.value) return;
    const chosen = id ?? detail.value.activity.id;
    if (chosen !== detail.value.activity.id && !detail.value.hosts.some(item => item.id === chosen)) return;
    navigate(`/pages/activity/detail?id=${chosen}`);
  }
  function order() {
    if (detail.value?.orderId && !loading.value) navigate(`/pages/order/detail?orderId=${encodeURIComponent(detail.value.orderId)}`);
  }
  function list() { navigate('/pages/activity/index'); }
  function orders() { if (auth.isLoggedIn) navigate('/pages/order/list'); }
  function invitation() {
    const data = detail.value;
    if (!data || loading.value || data.leader.status !== 1 || pinkAwaitingSettlement(data, Date.now())) return null;
    return { title: `邀请您参加${data.activity.title}`, path: `${PINK_STATUS_PATH}?id=${data.leader.id}`, imageUrl: data.activity.image };
  }
  function copyInvite() {
    const invite = invitation(); if (!invite || navigating.value) return;
    let data = invite.path;
    // #ifdef H5
    if (typeof window !== 'undefined') data = `${window.location.origin}${window.location.pathname}#${invite.path}`;
    // #endif
    const current = revision;
    uni.setClipboardData({ data, success: () => { if (current === revision && visible.value) uni.showToast({ title: '邀请链接已复制', icon: 'none' }); },
      fail: () => { if (current === revision && visible.value) error.value = '复制失败，请重试'; } });
  }
  function suspend() { visible.value = false; reset(); if (timer) { clearInterval(timer); timer = undefined; } }
  watch(() => auth.sessionVersion, () => { reset(); error.value = '登录状态已变化，请刷新拼团状态'; }, { flush: 'sync' });
  onLoad(query => setRoute(query));
  onShow(() => {
    if (disposed) return; visible.value = true; clock.value = Date.now();
    if (timer) clearInterval(timer); timer = setInterval(() => { clock.value = Date.now(); }, 1000);
    // #ifdef H5
    if (typeof window !== 'undefined') {
      const query = pinkQueryFromHash(window.location.hash); if (query) { setRoute(query); return; }
    }
    // #endif
    void load();
  });
  // H5 can reuse a page for hash-query changes without another onLoad/onShow.
  function hashChanged() {
    // #ifdef H5
    if (typeof window !== 'undefined' && visible.value && !disposed) {
      const query = pinkQueryFromHash(window.location.hash);
      if (query) setRoute(query); else reset();
    }
    // #endif
  }
  // #ifdef H5
  if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
  // #endif
  onHide(suspend);
  onUnload(() => {
    disposed = true; suspend();
    // #ifdef H5
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
    // #endif
  });
  return { recordId, detail, loading, error, navigating, loggedIn, pending, canJoin, title, remaining,
    setRoute, load, login, join, openActivity, order, orders, list, invitation, copyInvite };
}
