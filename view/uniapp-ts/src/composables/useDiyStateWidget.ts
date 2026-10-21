import { computed, onScopeDispose, ref, watch } from 'vue';
import { apiDiyNewcomerList, apiDiyProductRank, apiDiySign, apiDiyUserInfo } from '@/api/diy';
import { apiDiyMemberLevel, diyLevelBadgeStyle, type DiyMemberLevel } from '@/api/diyState';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';
import { checkedDiyStateData, diyMemberProgress, emptyDiyStateData, normalizeDiyStateWidget } from '@/utils/diyStateWidget';
import { openDiyLink, safeDiyImageUrl } from '@/utils/diy';
import { RequestError } from '@/utils/request';
import { communityClosedResponse } from '../../../common/communityAvailability';

export function useDiyStateWidget(block: () => unknown, active: () => boolean, onClosed: (message: string) => void = () => {}) {
  const auth = useAuthStore(), theme = useThemeStore();
  const config = computed(() => normalizeDiyStateWidget(block(), theme.preset));
  const fingerprint = computed(() => JSON.stringify(config.value));
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const data = ref(emptyDiyStateData()), loading = ref(false), loaded = ref(false), error = ref(''), closed = ref(false);
  const level = ref<DiyMemberLevel | null>(null), levelLoading = ref(false), levelError = ref('');
  let generation = 0, disposed = false;
  const ready = () => !disposed && active() && config.value.enabled;
  const current = (revision: number, actor: string, key: string) => ready() && revision === generation && actor === owner() && key === fingerprint.value;
  function invalidate() { generation++; data.value = emptyDiyStateData(); loading.value = false; loaded.value = false; error.value = ''; closed.value = false; level.value = null; levelLoading.value = false; levelError.value = ''; }
  async function load() {
    if (!ready() || loading.value || !config.value.kind) return;
    const revision = ++generation, actor = owner(), key = fingerprint.value, kind = config.value.kind, uid = auth.uid;
    data.value = emptyDiyStateData(); level.value = null; levelError.value = ''; levelLoading.value = false; loading.value = true; loaded.value = false; error.value = ''; closed.value = false;
    try {
      const value = kind === 'userInfor' ? auth.isLoggedIn ? await apiDiyUserInfo() : []
        : kind === 'newVip' ? await apiDiyNewcomerList(1, 10) : kind === 'signIn' ? await apiDiySign() : await apiDiyProductRank(3);
      if (!current(revision, actor, key)) return;
      const checked = checkedDiyStateData(kind, value, uid);
      data.value = checked; loaded.value = true;
      if (kind === 'userInfor' && checked.user && auth.isLoggedIn) void loadLevel(revision, actor, key, checked.user.level);
    } catch (reason) {
      if (!current(revision, actor, key)) return;
      error.value = reason instanceof Error ? reason.message : 'DIY内容加载失败，请重试';
      closed.value = reason instanceof RequestError && communityClosedResponse(reason);
      if (closed.value) onClosed(error.value);
    } finally { if (current(revision, actor, key)) loading.value = false; }
  }
  async function loadLevel(revision: number, actor: string, key: string, expectedLevel: number) {
    levelLoading.value = true; levelError.value = '';
    try { const value = await apiDiyMemberLevel(expectedLevel); if (current(revision, actor, key)) level.value = value; }
    catch (reason) { if (current(revision, actor, key)) levelError.value = reason instanceof Error ? reason.message : '会员等级暂不可用'; }
    finally { if (current(revision, actor, key)) levelLoading.value = false; }
  }
  const badgeStyle = computed(() => ({ ...config.value.badgeStyle, ...diyLevelBadgeStyle(level.value?.color ?? '') }));
  const navigable = () => ready() && loaded.value && !loading.value && !error.value && !closed.value;
  function openMember(action: string) {
    if (!navigable() || config.value.kind !== 'userInfor') return;
    const actions: Record<string, { checkbox: number; path: string }> = {
      integral: { checkbox: 1, path: '/pages/user/integral' }, money: { checkbox: 2, path: '/pages/users/user_money/index' },
      coupon: { checkbox: 0, path: '/pages/user/coupon' }, code: { checkbox: 3, path: '/pages/user/memberCode' },
      collect: { checkbox: 4, path: '/pages/user/collect' }, visit: { checkbox: 5, path: '/pages/user/visitHistory' },
    };
    if (action === 'profile') { openDiyLink(auth.isLoggedIn ? '/pages/user/index' : '/pages/auth/login'); return; }
    const target = actions[action]; if (!target || !config.value.checks.includes(target.checkbox)) return;
    openDiyLink(auth.isLoggedIn && data.value.user ? target.path : '/pages/auth/login');
  }
  function openMore() {
    if (!navigable()) return;
    const target = config.value.kind === 'ranking' ? '/pages/columnGoods/rank/index'
      : config.value.kind === 'signIn' ? '/pages/user/sign' : config.value.kind === 'newVip' ? '/pages/activity/new_customer/index' : '';
    if (target) openDiyLink(target);
  }
  function openCoupons() { if (navigable() && config.value.kind === 'newVip' && config.value.checks.includes(1)) openDiyLink('/pages/user/coupon'); }
  function openNewcomer(id: number) {
    if (navigable() && config.value.kind === 'newVip' && config.value.checks.includes(2)
      && data.value.newcomer?.newcomer_products.some(row => row.id === id)) openDiyLink(`/pages/activity/newcomerDetail?id=${id}`);
  }
  const stop = watch([fingerprint, owner, active], () => {
    invalidate(); const revision = generation;
    // Clear immediately but coalesce auth's synchronous uid/token/version assignments.
    if (ready()) void Promise.resolve().then(() => { if (revision === generation && ready()) void load(); });
  }, { immediate: true, flush: 'sync' });
  function dispose() { if (disposed) return; disposed = true; stop(); invalidate(); }
  onScopeDispose(dispose);
  const progress = computed(() => diyMemberProgress(data.value.user));
  return { config, data, loading, loaded, error, closed, load, dispose, openMember, openMore, openCoupons, openNewcomer, progress, level, levelLoading, levelError, badgeStyle, media: safeDiyImageUrl };
}
