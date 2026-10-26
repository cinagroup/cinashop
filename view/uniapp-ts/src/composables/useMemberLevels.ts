import { computed, ref, watch } from 'vue';
import { onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createMemberLevelRequests, memberLevelMediaDeadline, type MemberOverview, type MemberLevel, type MemberLevelRequests } from '@/api/memberLevels';

export function useMemberLevels() {
  const auth = useAuthStore(), visible = ref(false), overview = ref<MemberOverview | null>(null), selectedId = ref(0);
  const loading = ref(false), checking = ref(false), error = ref(''), checkNotice = ref(''), mediaUnavailable = ref(false), failedMedia = ref<string[]>([]);
  const loggedIn = computed(() => auth.isLoggedIn && auth.uid > 0);
  const levels = computed(() => overview.value?.levels ?? []), selectedIndex = computed(() => Math.max(0, levels.value.findIndex(v => v.id === selectedId.value)));
  const selected = computed(() => levels.value.find(v => v.id === selectedId.value) ?? null);
  let generation = 0, disposed = false, requests: MemberLevelRequests | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let attempted: { uid: number; token: string; version: number; result: 'pending' | 'confirmed' | 'uncertain' } | undefined;
  const sameAttempt = () => attempted?.uid === auth.uid && attempted.token === auth.token && attempted.version === auth.sessionVersion;
  const uncertain = '等级检查结果未确认，当前显示已保存的等级信息。可手动重新检查。';
  function clear() {
    generation++; requests?.abort(); requests = undefined; if (timer) clearTimeout(timer); timer = undefined;
    if (sameAttempt() && attempted?.result === 'pending') attempted.result = 'uncertain';
    overview.value = null; selectedId.value = 0; loading.value = false; checking.value = false; error.value = ''; checkNotice.value = ''; mediaUnavailable.value = false; failedMedia.value = [];
  }
  function scheduleMedia(data: MemberOverview) {
    if (timer) clearTimeout(timer); timer = undefined;
    const now = Date.now(), deadline = memberLevelMediaDeadline(data, now);
    mediaUnavailable.value = deadline !== null && deadline <= now;
    if (deadline === null || deadline <= now) return;
    const ticket = generation;
    timer = setTimeout(() => {
      timer = undefined;
      if (!visible.value || disposed || ticket !== generation) return;
      mediaUnavailable.value = true;
      // Renew expiring image capabilities with an info read; never repeat detection.
      void load();
    }, Math.min(deadline - now, 2147483647));
  }
  async function load(check = false) {
    if (!visible.value || disposed || !loggedIn.value || loading.value) return;
    if (timer) clearTimeout(timer); timer = undefined;
    const ticket = ++generation;
    requests?.abort(); const scope = createMemberLevelRequests(() => visible.value && !disposed && ticket === generation); requests = scope;
    loading.value = true; error.value = ''; checkNotice.value = sameAttempt() && attempted?.result === 'uncertain' ? uncertain : '';
    try {
      if (check) {
        const attempt = { ...scope.owner, result: 'pending' as 'pending' | 'confirmed' | 'uncertain' }; attempted = attempt; checking.value = true;
        try { await scope.check(); if (scope.active()) { attempt.result = 'confirmed'; checkNotice.value = ''; } }
        catch { if (scope.active()) { attempt.result = 'uncertain'; checkNotice.value = uncertain; } }
        finally { if (scope.active()) checking.value = false; }
        // A cancelled GET may already have committed eligibility on the server.
        // Do not chain another owner's info or silently replay an uncertain check.
        if (!scope.active()) return;
      }
      const data = await scope.overview(); if (!scope.active()) return;
      overview.value = data; failedMedia.value = [];
      if (!data.levels.some(v => v.id === selectedId.value)) selectedId.value = data.current_level_id || data.levels[0]?.id || 0;
      scheduleMedia(data);
    } catch (cause) {
      if (scope.active()) {
        error.value = cause instanceof Error ? cause.message : '会员等级加载失败';
        // A retained snapshot still owns its old image expiry, including when
        // a manual refresh failed after cancelling the previous timer.
        if (overview.value) scheduleMedia(overview.value);
      }
    }
    finally { if (ticket === generation) { loading.value = false; checking.value = false; } scope.abort(); if (requests === scope) requests = undefined; }
  }
  function enter() { if (visible.value && !disposed && loggedIn.value) void load(!sameAttempt()); }
  function select(id: number) { if (visible.value && levels.value.some(v => v.id === id)) selectedId.value = id; }
  function swipe(event: { detail: { current: number } }) { const index = event.detail.current; if (Number.isInteger(index) && levels.value[index]) select(levels.value[index]!.id); }
  function state(level: MemberLevel): string {
    const data = overview.value;
    if (!data || data.current_grade === null) return '等级预览';
    return level.id === data.current_level_id ? '当前等级' : level.grade <= data.current_grade ? '已解锁' : '待解锁';
  }
  function image(level: MemberLevel | null, kind: 'icon' | 'image') {
    return !level || mediaUnavailable.value || failedMedia.value.includes(`${level.id}:${kind}`) ? '' : level[kind];
  }
  function imageFailed(id: number, kind: 'icon' | 'image') { const key = `${id}:${kind}`; if (!failedMedia.value.includes(key)) failedMedia.value.push(key); }
  function openTask(kind: 'sign' | 'order' | 'invite') {
    if (!visible.value || disposed || !loggedIn.value || !overview.value?.enabled) return;
    if (kind === 'sign' && overview.value.task.sign_enabled) uni.navigateTo({ url: '/pages/user/sign' });
    if (kind === 'order') uni.switchTab({ url: '/pages/goods/cate' });
    if (kind === 'invite') uni.navigateTo({ url: '/pages/user/spread' });
  }
  function login() { if (visible.value && !disposed && !loggedIn.value) uni.navigateTo({ url: '/pages/auth/login' }); }
  watch(() => [auth.uid, auth.token, auth.sessionVersion], () => {
    clear(); attempted = undefined;
    // Pinia setLogin updates its fields synchronously. Enter after the complete tuple.
    void Promise.resolve().then(enter);
  }, { flush: 'sync' });
  onShow(() => { visible.value = true; clear(); enter(); });
  onHide(() => { visible.value = false; clear(); });
  onUnload(() => { visible.value = false; disposed = true; clear(); attempted = undefined; });
  return { overview, levels, selected, selectedId, selectedIndex, loading, checking, error, checkNotice, mediaUnavailable, loggedIn,
    load, recheck: () => load(true), select, swipe, state, image, imageFailed, openTask, login };
}
