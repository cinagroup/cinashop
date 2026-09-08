import { computed, ref, shallowRef, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { http } from '@/utils/request';
import { decodePinkCancellation, parsePinkCancellation, pinkCancellationKey, pinkCancellationText, type PinkCancellationIntent, type PinkCancellationReceipt } from '../../../common/pinkCancellation';
import { PINK_STATUS_PATH, pinkRouteId, pinkQueryFromHash, parsePinkStatus, pinkCanJoin, pinkAwaitingSettlement, type PinkStatus } from '../../../common/pinkStatus';

export function usePinkStatus() {
  const auth = useAuthStore(), recordId = ref(0), detail = shallowRef<PinkStatus | null>(null);
  const loading = ref(false), error = ref(''), visible = ref(false), navigating = ref(false), clock = ref(Date.now());
  const cancelIntent = shallowRef<PinkCancellationIntent | null>(null), cancellation = shallowRef<PinkCancellationReceipt | null>(null);
  const cancelBusy = ref(false), cancelError = ref('');
  let revision = 0, navRevision = 0, disposed = false, timer: ReturnType<typeof setInterval> | undefined;
  const loggedIn = computed(() => auth.isLoggedIn);
  const pending = computed(() => !!detail.value && pinkAwaitingSettlement(detail.value, clock.value));
  const canJoin = computed(() => !!detail.value && !cancelIntent.value && !cancelBusy.value && pinkCanJoin(detail.value, clock.value) && !loading.value && !navigating.value);
  const title = computed(() => !detail.value ? '' : detail.value.state === 'success' ? '拼团成功' : detail.value.state === 'failed' ? '拼团失败' : detail.value.cancellationPending ? '团长取消处理中' : pending.value ? '等待结算确认' : '拼团进行中');
  const remaining = computed(() => {
    if (!detail.value || pending.value || detail.value.leader.status !== 1) return '';
    const seconds = Math.max(0, Math.ceil((detail.value.leader.deadline * 1000 - clock.value) / 1000));
    return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分${seconds % 60}秒`;
  });
  const cancellationMessage = computed(() => cancellation.value ? pinkCancellationText[cancellation.value.state] : '尚未确认取消结果。刷新只查询，不会提交退款。');
  const canCancel = computed(() => freshCancellation() && !cancelBusy.value);
  const canResumeCancellation = computed(() => !!identity() && !!cancellation.value &&
    (cancellation.value.resumable || !!cancelIntent.value && cancellation.value.state === 'not_applied') && !loading.value && !cancelBusy.value && !navigating.value);
  const canInvite = computed(() => !!detail.value && !pinkAwaitingSettlement(detail.value, clock.value) && !!invitation());
  function freshCancellation() {
    const d = detail.value;
    return !!d && !cancelIntent.value && cancellation.value?.state === 'not_applied' && d.leader.id === recordId.value &&
      d.leader.uid === auth.uid && !!d.orderId && d.leader.people > 1 && d.count > 0 && d.leader.status === 1 &&
      !pinkAwaitingSettlement(d, clock.value) && !loading.value && !navigating.value && visible.value && !disposed;
  }
  function identity(): PinkCancellationIntent | null {
    if (cancelIntent.value) return cancelIntent.value;
    const d = detail.value;
    return d && d.leader.uid === auth.uid && d.leader.id === recordId.value && d.orderId
      ? { version: 1, uid: auth.uid, pinkId: recordId.value, cid: d.activity.id } : null;
  }
  function reset() { revision++; navRevision++; detail.value = null; loading.value = false; navigating.value = false;
    cancelIntent.value = null; cancellation.value = null; cancelBusy.value = false; cancelError.value = ''; }
  function setRoute(query: Record<string, unknown> = {}) {
    reset(); recordId.value = 0; error.value = '';
    try { recordId.value = pinkRouteId(query); } catch { error.value = '团记录链接无效，请检查链接或返回活动列表'; }
    if (visible.value) void load();
  }
  async function load() {
    if (!visible.value || disposed || !recordId.value || navigating.value || cancelBusy.value) return;
    const current = ++revision; detail.value = null; cancellation.value = null; cancelIntent.value = null; cancelError.value = ''; error.value = ''; loading.value = false;
    if (!auth.isLoggedIn) return;
    const uid = auth.uid, version = auth.sessionVersion, id = recordId.value; loading.value = true;
    const active = () => current === revision && visible.value && !disposed && version === auth.sessionVersion;
    try {
      try {
        const raw = uni.getStorageSync(pinkCancellationKey(uid, id));
        if (raw !== undefined && raw !== null && raw !== '') cancelIntent.value = decodePinkCancellation(raw, uid, id);
      } catch (e) { cancelError.value = e instanceof Error ? e.message : '无法读取原取消记录'; return; }
      // Recover from the ORIGINAL identity before querying a potentially promoted
      // or delisted group. A status-page 404 must not hide a saved receipt.
      if (cancelIntent.value) await readCancellation(cancelIntent.value, active);
      if (!active()) return;
      const value = await http.get<unknown>(`/combination/pink/${id}`);
      if (!active()) return;
      detail.value = parsePinkStatus(value, uid); clock.value = Date.now();
      const own = identity(); if (own && !cancelIntent.value) await readCancellation(own, active);
    } catch (e) { if (current === revision && visible.value) error.value = e instanceof Error ? e.message : '拼团状态加载失败'; }
    finally { if (current === revision && visible.value) loading.value = false; }
  }
  async function readCancellation(intent: PinkCancellationIntent, active: () => boolean) {
    try {
      const value = await http.get<unknown>(`/combination/remove/${intent.pinkId}`, { cid: intent.cid });
      if (!active()) return;
      cancellation.value = parsePinkCancellation(value, intent); cancelError.value = '';
    } catch (e) { if (active()) { cancellation.value = null; cancelError.value = e instanceof Error ? e.message : '取消结果查询失败'; } }
  }
  function cancelPink() {
    clock.value = Date.now();
    if (cancelBusy.value || !visible.value || disposed || !auth.isLoggedIn || (!canCancel.value && !canResumeCancellation.value)) return;
    const intent = identity(); if (!intent) return;
    const current = revision, version = auth.sessionVersion, resuming = !!cancelIntent.value || cancellation.value?.state !== 'not_applied';
    const active = () => current === revision && version === auth.sessionVersion && visible.value && !disposed && auth.uid === intent.uid;
    cancelBusy.value = true; cancelError.value = '';
    let answered = false;
    try { uni.showModal({ title: resuming ? '继续处理原取消申请？' : '确认取消本人的拼团？',
      content: `原团记录 #${intent.pinkId}。${resuming ? '仅处理同一取消申请，不改为取消其他团。' : '取消后不能撤销，服务端将重新校验资格并申请退款。'}退款可能异步完成，请勿把请求成功视为到账。`,
      confirmText: resuming ? '继续处理' : '确认取消', cancelText: '暂不取消',
      success: async result => {
        if (answered) return; answered = true;
        if (!active()) return;
        if (!result.confirm) { cancelBusy.value = false; return; }
        clock.value = Date.now();
        if (!resuming && !freshCancellation()) { cancelBusy.value = false; cancelError.value = '拼团资格已变化，请刷新后确认'; return; }
        try {
          const key = pinkCancellationKey(intent.uid, intent.pinkId), raw = uni.getStorageSync(key);
          if (raw !== undefined && raw !== null && raw !== '') {
            const saved = decodePinkCancellation(raw, intent.uid, intent.pinkId);
            if (saved.cid !== intent.cid) throw new Error('原取消记录已变化，请刷新核对');
          } else {
            const encoded = JSON.stringify(intent); uni.setStorageSync(key, encoded);
            if (uni.getStorageSync(key) !== encoded) throw new Error('无法保存原取消记录，尚未发送请求');
          }
          cancelIntent.value = intent;
          // Even a successful POST is not the receipt. Always read persisted
          // evidence; uncertain transport never deletes or retargets the intent.
          let submissionError = '';
          try { await http.post<unknown>('/combination/remove', { id: intent.pinkId, cid: intent.cid }); }
          catch (e) { submissionError = e instanceof Error ? e.message : '提交结果未知，请查询原取消申请'; }
          if (active()) {
            await readCancellation(intent, active);
            if (active() && submissionError && !cancellation.value?.completed) cancelError.value = submissionError;
          }
        } catch (e) { if (active()) cancelError.value = e instanceof Error ? e.message : '原取消记录无法保存'; }
        finally { if (active()) cancelBusy.value = false; }
      }, fail: () => { if (active()) { cancelBusy.value = false; cancelError.value = '无法打开确认窗口，请重试'; } },
    }); } catch { if (active()) { cancelBusy.value = false; cancelError.value = '无法打开确认窗口，请重试'; } }
  }
  function cancellationOrder() {
    if (cancellation.value && !cancelBusy.value) navigate(`/pages/order/detail?orderId=${encodeURIComponent(cancellation.value.orderId)}`);
  }
  function navigate(url: string) {
    if (!visible.value || disposed || navigating.value || cancelBusy.value) return;
    const current = revision, navigation = ++navRevision; navigating.value = true;
    const fail = () => { if (current === revision && navigation === navRevision && visible.value && !disposed) {
      navigating.value = false; error.value = '页面打开失败，请重试';
    } };
    try { uni.navigateTo({ url, fail }); } catch { fail(); }
  }
  function login() { if (!auth.isLoggedIn && recordId.value) navigate('/pages/auth/login'); }
  function join() {
    if (!detail.value || cancelIntent.value || cancelBusy.value || loading.value || !pinkCanJoin(detail.value, Date.now())) return;
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
    if (!data || loading.value || cancelBusy.value || cancelIntent.value || cancellation.value && cancellation.value.state !== 'not_applied' || data.leader.status !== 1 || pinkAwaitingSettlement(data, Date.now())) return null;
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
    cancelIntent, cancellation, cancellationMessage, cancelBusy, cancelError, canCancel, canResumeCancellation, canInvite, cancelPink, cancellationOrder,
    setRoute, load, login, join, openActivity, order, orders, list, invitation, copyInvite };
}
