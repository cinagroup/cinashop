import { computed, ref, shallowRef, watch } from 'vue';
import { onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { useCartStore } from '@/stores/cart';
import { apiCategoryStyle, apiCategoryTree, apiCategoryProducts } from '@/api/product';
import type { CategoryNode } from '@/types/product';
import { categoryTemplate, categoryBigCards, categoryPath, categoryScopeForPath, categoryListUrl,
  type CategoryStyle, type CategoryScope, type CategoryProduct } from '../../../common/categoryCatalog';

/** Every read is owned by the visible page, its actor, and its applied category scope. */
export function useCategoryCatalog() {
  const auth = useAuthStore(), cart = useCartStore(), visible = ref(false);
  const style = shallowRef<CategoryStyle>({ level: 2, index: 1, configured: false, issues: [] });
  const tree = shallowRef<CategoryNode[]>([]), products = shallowRef<CategoryProduct[]>([]);
  const loading = ref(false), error = ref(''), styleError = ref(''), productError = ref(''), productLoading = ref(false);
  const scope = ref<CategoryScope>({}), draft = ref<CategoryScope>({}), page = ref(1), count = ref(0), hasMore = ref(false);
  const sort = ref<'default' | 'sales' | 'price_asc' | 'price_desc'>('default'), drawer = ref<'categories' | 'filter' | null>(null);
  const expanded = ref<number[]>([]), disposed = ref(false);
  let generation = 0, listGeneration = 0;
  const template = computed(() => categoryTemplate(style.value)), bigCards = computed(() => categoryBigCards(style.value));
  const primary = computed(() => tree.value.find(item => item.id === scope.value.cid) ?? tree.value[0]);
  const secondary = computed(() => primary.value?.children.find(item => item.id === scope.value.sid));
  const thirds = computed(() => secondary.value?.children ?? []);
  const draftPrimary = computed(() => tree.value.find(item => item.id === draft.value.cid) ?? tree.value[0]);
  function owner() {
    const epoch = auth.sessionVersion, token = auth.token, uid = auth.uid, life = generation;
    return () => visible.value && !disposed.value && life === generation && epoch === auth.sessionVersion && token === auth.token && uid === auth.uid;
  }
  function emitScroll() { uni.$emit?.('scroll'); }
  function closeDrawer() { drawer.value = null; }
  function openDrawer(kind: 'categories' | 'filter') {
    if (!visible.value || loading.value || disposed.value) return;
    draft.value = { ...scope.value }; expanded.value = []; drawer.value = kind;
  }
  function locate() {
    const requested = uni.getStorageSync('cate_selected');
    if (requested === undefined || requested === null || requested === '') return;
    const id = typeof requested === 'number' ? requested : Number(requested), path = categoryPath(tree.value, id);
    if (!path.length) { if (tree.value.length) uni.removeStorageSync('cate_selected'); return; }
    scope.value = categoryScopeForPath(path.slice(0, style.value.level)); uni.removeStorageSync('cate_selected');
  }
  async function readProducts(reset = false) {
    if (!visible.value || disposed.value || loading.value || template.value === 'tree' || !scope.value.cid || !reset && (productLoading.value || !hasMore.value)) return;
    const current = owner(), request = ++listGeneration;
    if (reset) { page.value = 1; products.value = []; count.value = 0; hasMore.value = false; }
    const requestedPage = page.value, filters = { ...scope.value };
    productLoading.value = true; productError.value = '';
    try {
      const result = await apiCategoryProducts({ ...filters, page: requestedPage, limit: 10, is_big: bigCards.value || template.value === 'filter-products' ? 1 : 0,
        ...(sort.value === 'sales' ? { salesOrder: 'desc' as const } : sort.value.startsWith('price_') ? { priceOrder: sort.value === 'price_asc' ? 'asc' as const : 'desc' as const } : {}) });
      if (!current() || request !== listGeneration) return;
      const seen = new Set(products.value.map(item => item.id));
      products.value = [...products.value, ...result.list.filter(item => !seen.has(item.id))]; count.value = result.count;
      page.value = requestedPage + 1; hasMore.value = result.list.length === 10 && requestedPage * 10 < result.count;
    } catch (e) { if (current() && request === listGeneration) productError.value = e instanceof Error ? e.message : '商品读取失败'; }
    finally { if (current() && request === listGeneration) productLoading.value = false; }
  }
  function selectPrimary(id: number, draftOnly = false) {
    if (!tree.value.some(item => item.id === id) || !visible.value || loading.value) return;
    if (draftOnly) { draft.value = { cid: id }; return; }
    scope.value = { cid: id }; closeDrawer(); emitScroll(); void readProducts(true);
  }
  function selectSecondary(id: number, draftOnly = false) {
    const main = draftOnly ? draftPrimary.value : primary.value;
    if (!main || id !== 0 && !main.children.some(item => item.id === id) || !visible.value || loading.value) return;
    const value = { cid: main.id, ...(id ? { sid: id } : {}) };
    if (draftOnly) draft.value = value; else { scope.value = value; emitScroll(); void readProducts(true); }
  }
  function selectThird(id: number, draftOnly = false, parentId?: number) {
    const main = draftOnly ? draftPrimary.value : primary.value;
    const child = main?.children.find(item => item.id === (parentId ?? (draftOnly ? draft.value.sid : scope.value.sid)));
    if (!main || !child || id !== 0 && !child.children.some(item => item.id === id) || !visible.value || loading.value) return;
    const value = { cid: main.id, sid: child.id, ...(id ? { tid: id } : {}) };
    if (draftOnly) draft.value = value; else { scope.value = value; emitScroll(); void readProducts(true); }
  }
  function applyFilter() { if (drawer.value !== 'filter' || !visible.value) return; scope.value = { ...draft.value }; closeDrawer(); void readProducts(true); }
  function resetFilter() { if (drawer.value === 'filter') { draft.value = { cid: tree.value[0]?.id }; expanded.value = []; } }
  function toggleExpanded(id: number) { expanded.value = expanded.value.includes(id) ? expanded.value.filter(value => value !== id) : [...expanded.value, id]; }
  function setSort(value: typeof sort.value) { if (loading.value || !visible.value) return; sort.value = value; void readProducts(true); }
  function navigateScope(value: CategoryScope) { if (visible.value && !loading.value) uni.navigateTo({ url: categoryListUrl(value) }); }
  function search() { if (visible.value) uni.navigateTo({ url: '/pages/goods/search' }); }
  function goCart() { if (visible.value) uni.switchTab({ url: '/pages/cart/index' }); }
  async function load() {
    if (!visible.value || disposed.value) return;
    generation++; listGeneration++; closeDrawer(); loading.value = true; productLoading.value = false; error.value = ''; styleError.value = '';
    products.value = []; tree.value = []; const current = owner();
    const [layout, categories] = await Promise.allSettled([apiCategoryStyle(), apiCategoryTree()]);
    if (!current()) return;
    if (layout.status === 'fulfilled') style.value = layout.value;
    else { style.value = { level: 2, index: 1, configured: false, issues: [] }; styleError.value = '分类布局读取失败，正在使用默认布局'; }
    if (categories.status === 'fulfilled') {
      tree.value = categories.value;
      const old = scope.value.tid ?? scope.value.sid ?? scope.value.cid;
      const path = old ? categoryPath(tree.value, old) : [];
      scope.value = path.length ? categoryScopeForPath(path.slice(0, style.value.level)) : tree.value[0] ? { cid: tree.value[0].id } : {};
      locate();
    } else error.value = categories.reason instanceof Error ? categories.reason.message : '分类读取失败';
    loading.value = false;
    if (tree.value.length) void readProducts(true);
    if (auth.isLoggedIn) void cart.fetchList().then(() => { if (current()) void cart.fetchCount(); }).catch(() => {});
  }
  function suspend() { visible.value = false; generation++; listGeneration++; loading.value = false; productLoading.value = false; closeDrawer(); cart.cancelPending(); }
  watch(() => auth.sessionVersion, () => { generation++; listGeneration++; products.value = []; tree.value = []; closeDrawer(); if (visible.value) void Promise.resolve().then(load); }, { flush: 'sync' });
  onShow(() => { visible.value = true; void load(); }); onHide(suspend); onUnload(() => { disposed.value = true; suspend(); });
  return { auth, cart, visible, style, tree, products, loading, error, styleError, productError, productLoading, scope, draft, page, count, hasMore, sort, drawer, expanded,
    template, bigCards, primary, secondary, thirds, draftPrimary, load, readProducts, locate, selectPrimary, selectSecondary, selectThird,
    openDrawer, closeDrawer, applyFilter, resetFilter, toggleExpanded, setSort, navigateScope, search, goCart, emitScroll };
}
