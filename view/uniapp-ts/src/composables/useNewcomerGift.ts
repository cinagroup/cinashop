import { computed, ref, watch } from 'vue';
import { onShow, onHide, onUnload, onReachBottom } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiNewcomerInfo, apiNewcomerProducts, type NewcomerInfo, type NewcomerProduct } from '@/api/newcomer';
import { sanitizeArticleRichText } from '@/utils/articleRichText';

export function useNewcomerGift() {
  const auth = useAuthStore();
  const info = ref<NewcomerInfo | null>(null), products = ref<NewcomerProduct[]>([]);
  const loading = ref(false), error = ref(''), page = ref(0), hasMore = ref(false);
  const visible = ref(false), navigating = ref(false), rulesOpen = ref(false);
  const agreement = computed(() => sanitizeArticleRichText(info.value?.agreement ?? ''));
  let generation = 0, navigationGeneration = 0, disposed = false;

  function clear() {
    generation++; navigationGeneration++;
    info.value = null; products.value = []; page.value = 0; hasMore.value = false;
    loading.value = false; navigating.value = false; rulesOpen.value = false;
  }
  function navigate(url: string) {
    if (!visible.value || disposed || navigating.value) return;
    const current = ++navigationGeneration;
    navigating.value = true;
    const fail = () => {
      if (current !== navigationGeneration || !visible.value || disposed) return;
      navigating.value = false;
      uni.showToast({ title: '页面打开失败，请重试', icon: 'none' });
    };
    try { uni.navigateTo({ url, fail }); } catch { fail(); }
  }
  function login() { if (!auth.isLoggedIn) navigate('/pages/auth/login'); }
  async function load(append = false) {
    if (!visible.value || disposed || loading.value || navigating.value) return;
    if (!auth.isLoggedIn) { clear(); error.value = '登录后查看新人礼'; login(); return; }
    if (append && (!hasMore.value || page.value >= 10_000)) return;
    const current = ++generation, owner = auth.sessionVersion, nextPage = append ? page.value + 1 : 1;
    loading.value = true; error.value = '';
    if (!append) { info.value = null; products.value = []; page.value = 0; hasMore.value = false; rulesOpen.value = false; }
    try {
      const [nextInfo, rows] = append
        ? [info.value, await apiNewcomerProducts(nextPage)]
        : await Promise.all([apiNewcomerInfo(), apiNewcomerProducts(1)]);
      if (current !== generation || !visible.value || disposed || owner !== auth.sessionVersion) return;
      if (append && rows.some(row => products.value.some(previous => previous.id === row.id))) throw new Error('新人商品列表已变化，请刷新后重试');
      info.value = nextInfo;
      products.value = append ? [...products.value, ...rows] : rows;
      page.value = nextPage; hasMore.value = rows.length === 9 && nextPage < 10_000;
    } catch (cause) {
      if (current === generation && visible.value && owner === auth.sessionVersion) error.value = cause instanceof Error ? cause.message : '新人礼加载失败';
    } finally { if (current === generation) loading.value = false; }
  }
  function openProduct(id: number) {
    if (!visible.value || !auth.isLoggedIn || loading.value || navigating.value || !products.value.some(row => row.id === id)) return;
    navigate(`/pages/activity/newcomerDetail?id=${id}`);
  }
  function openWallet() { if (auth.isLoggedIn) navigate('/pages/user/coupon'); else login(); }
  function openBalance() { if (auth.isLoggedIn) navigate('/pages/user/balanceLogs'); else login(); }
  function openPoints() { if (auth.isLoggedIn) navigate('/pages/user/integralLogs'); else login(); }
  function openGoods() { navigate('/pages/goods/list'); }
  function showRules() { if (visible.value && info.value) rulesOpen.value = true; }
  function hideRules() { rulesOpen.value = false; }

  watch(() => auth.sessionVersion, () => {
    clear(); error.value = auth.isLoggedIn ? '' : '登录后查看新人礼';
    if (visible.value && auth.isLoggedIn) void load();
  }, { flush: 'sync' });
  onShow(() => { if (!disposed) { visible.value = true; clear(); void load(); } });
  onHide(() => { visible.value = false; clear(); });
  onUnload(() => { disposed = true; visible.value = false; clear(); });
  onReachBottom(() => { if (!error.value && !loading.value) void load(true); });

  return { auth, info, products, loading, error, page, hasMore, visible, navigating, rulesOpen, agreement,
    load, login, openProduct, openWallet, openBalance, openPoints, openGoods, showRules, hideRules };
}
