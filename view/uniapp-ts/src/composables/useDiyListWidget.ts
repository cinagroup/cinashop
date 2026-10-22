import { computed, onScopeDispose, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';
import { normalizeDiyList } from '@/utils/diyListConfig';
import { diyWaterfallColumns, readDiyListArticles, readDiyListProducts, type DiyListProduct } from '@/utils/diyListData';
import type { ArticleListItem } from '@/api/article';
import { openDiyLink } from '@/utils/diy';
import { useCategoryPurchase } from './useCategoryPurchase';

export function useDiyListWidget(block: () => unknown, active: () => boolean) {
  const auth = useAuthStore(), theme = useThemeStore();
  const config = computed(() => normalizeDiyList(block(), theme.preset)), fingerprint = computed(() => JSON.stringify(config.value));
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const products = ref<DiyListProduct[]>([]), articles = ref<ArticleListItem[]>([]);
  const loading = ref(false), loaded = ref(false), error = ref(''), notice = ref('');
  const heights = ref<Map<number, number>>(new Map());
  let generation = 0, disposed = false;
  const ready = () => !disposed && active() && config.value.enabled;
  function lease() { const epoch = generation, actor = owner(), key = fingerprint.value; return () => ready() && epoch === generation && actor === owner() && key === fingerprint.value; }
  const navigable = () => ready() && loaded.value && !loading.value && !error.value;
  const purchase = useCategoryPurchase(computed(() => navigable() && config.value.kind === 'goodList'));
  const columns = computed(() => diyWaterfallColumns(products.value, heights.value));
  function clear() { products.value = []; articles.value = []; heights.value = new Map(); loading.value = false; loaded.value = false; error.value = ''; notice.value = ''; }
  async function load() {
    if (!ready() || loading.value) return;
    generation++; clear(); const current = lease(), cfg = config.value;
    if (cfg.error) { error.value = cfg.error; return; }
    loading.value = true;
    try {
      if (cfg.kind === 'goodList') {
        const rows = cfg.query ? await readDiyListProducts(cfg.query) : [];
        if (!current()) return; products.value = rows;
      } else {
        const rows = cfg.limit > 0 ? await readDiyListArticles(cfg.cid, cfg.limit) : [];
        if (!current()) return; articles.value = rows;
      }
      if (current()) loaded.value = true;
    } catch (reason) { if (current()) { clear(); error.value = reason instanceof Error ? reason.message : '列表读取失败，请重试'; } }
    finally { if (current()) loading.value = false; }
  }
  function openProduct(id: number) {
    if (!navigable()) return; const product = products.value.find(row => row.id === id); if (!product) return;
    if (!product.destination || product.navigationExpiresAt !== null && product.navigationExpiresAt <= Date.now()) { notice.value = '商品活动入口待核实，请刷新当前组件'; return; }
    openDiyLink(product.activityKind === 'bargain' && !auth.isLoggedIn ? '/pages/auth/login'
      : product.destination + (product.activityKind === 'bargain' && auth.uid > 0 ? `&spid=${auth.uid}` : ''));
  }
  async function productAction(id: number) {
    if (!navigable() || !config.value.showAction) return;
    const product = products.value.find(row => row.id === id); if (!product) return;
    if (!config.value.cartMode || product.activityKind || product.is_presale_product || product.cart_button === 0 || !product.destination || product.navigationExpiresAt !== null) { openProduct(id); return; }
    await purchase.open(product, 'cart', product.spec_type === 0);
  }
  function openArticle(id: number) { if (navigable() && articles.value.some(row => row.id === id)) openDiyLink(`/pages/article/detail?id=${id}`); }
  function adoptMeasurements(rows: { id: number; height: number }[], current: () => boolean) {
    if (!current() || config.value.style !== 1 || config.value.kind !== 'goodList') return;
    const allowed = new Set(products.value.map(row => row.id));
    if (rows.some(row => !allowed.has(row.id) || !Number.isFinite(row.height) || row.height <= 0 || row.height > 10000)) return;
    const next=new Map(heights.value);let changed=false;
    for(const row of rows)if(Math.abs((next.get(row.id)??0)-row.height)>0.5){next.set(row.id,row.height);changed=true;}
    if(changed)heights.value=next;
  }
  const stop = watch([fingerprint, owner, active], () => {
    generation++; clear(); const current = lease();
    if (ready()) void Promise.resolve().then(() => { if (current()) void load(); });
  }, { immediate: true, flush: 'sync' });
  function dispose() { if (disposed) return; disposed = true; stop(); generation++; clear(); }
  onScopeDispose(dispose);
  return { config, fingerprint, products, articles, columns, loading, loaded, error, notice, purchase, load, openProduct, productAction, openArticle, lease, adoptMeasurements, dispose };
}
