import { ref, watch } from 'vue';
import { onHide, onLoad, onReachBottom, onShow, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiProductRank, parseProductRankType, PRODUCT_RANK_PAGE_SIZE,
  type ProductRankType, type RankedProduct } from '@/api/productRank';

export function useProductRank() {
  const auth = useAuthStore();
  const type = ref<ProductRankType>(1);
  const products = ref<RankedProduct[]>([]);
  const page = ref(0), hasMore = ref(false), loading = ref(false), error = ref('');
  const navigating = ref(false), visible = ref(false);
  let revision = 0, navigationRevision = 0, disposed = false;

  function clear() {
    revision++; navigationRevision++;
    products.value = []; page.value = 0; hasMore.value = false;
    loading.value = false; error.value = ''; navigating.value = false;
  }

  async function load(append = false) {
    if (!visible.value || disposed || loading.value || navigating.value || append && (!hasMore.value || page.value >= 10_000)) return;
    const current = ++revision, owner = auth.sessionVersion, selected = type.value;
    const nextPage = append ? page.value + 1 : 1;
    if (!append) { products.value = []; page.value = 0; hasMore.value = false; }
    loading.value = true; error.value = '';
    try {
      const rows = await apiProductRank(selected, nextPage);
      if (current !== revision || !visible.value || disposed || owner !== auth.sessionVersion || selected !== type.value) return;
      if (append && rows.some((row) => products.value.some((previous) => previous.id === row.id))) {
        throw new Error('商品排行已变化，请刷新后重试');
      }
      products.value = append ? [...products.value, ...rows] : rows;
      page.value = nextPage; hasMore.value = rows.length === PRODUCT_RANK_PAGE_SIZE && nextPage < 10_000;
    } catch (cause) {
      if (current === revision && visible.value && !disposed && owner === auth.sessionVersion) {
        error.value = cause instanceof Error ? cause.message : '商品排行加载失败';
      }
    } finally { if (current === revision) loading.value = false; }
  }

  function select(next: ProductRankType) {
    if (![1, 2, 3].includes(next) || next === type.value || !visible.value || disposed) return;
    clear(); type.value = next; void load();
  }

  function openProduct(id: number) {
    if (!visible.value || disposed || loading.value || navigating.value) return;
    const product = products.value.find((row) => row.id === id);
    if (!product) return;
    if (product.navigationExpiresAt !== null && Date.now() >= product.navigationExpiresAt) {
      uni.showToast({ title: '活动已过期，请刷新榜单', icon: 'none' }); return;
    }
    if (!product.destination) {
      uni.showToast({ title: product.navigationHint, icon: 'none' }); return;
    }
    const current = ++navigationRevision;
    navigating.value = true;
    const fail = () => {
      if (current !== navigationRevision || !visible.value || disposed) return;
      navigating.value = false;
      uni.showToast({ title: '商品详情打开失败，请重试', icon: 'none' });
    };
    try {
      uni.navigateTo({ url: product.destination, fail });
    } catch { fail(); }
  }

  watch(() => auth.sessionVersion, () => {
    clear();
    if (visible.value) void load();
  }, { flush: 'sync' });
  onLoad((query) => { type.value = parseProductRankType(query?.type); });
  onShow(() => { if (!disposed) { visible.value = true; clear(); void load(); } });
  onHide(() => { visible.value = false; clear(); });
  onUnload(() => { disposed = true; visible.value = false; clear(); });
  onReachBottom(() => { if (!error.value) void load(true); });
  return { type, products, page, hasMore, loading, error, navigating, visible, load, select, openProduct };
}
