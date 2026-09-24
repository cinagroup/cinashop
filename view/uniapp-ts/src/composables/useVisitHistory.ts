import { computed, ref, watch } from "vue";
import { onShow, onHide, onUnload, onReachBottom } from "@dcloudio/uni-app";
import { useAuthStore } from "@/stores/auth";
import { apiVisitHistory, apiDeleteVisitHistory, apiCollectVisitProducts, apiVisitRecommendations, VISIT_PAGE_SIZE, VISIT_COLLECT_LIMIT,
  VISIT_RECOMMENDATION_PAGE_SIZE, type VisitProduct, type VisitRecommendation } from "@/api/visitHistory";

export function useVisitHistory() {
  const auth = useAuthStore(), visible = ref(false), items = ref<VisitProduct[]>([]), total = ref(0);
  const loading = ref(false), loaded = ref(false), error = ref(""), nextPage = ref(1), hasMore = ref(false);
  const managing = ref(false), selected = ref<number[]>([]), confirming = ref(false), deleting = ref(false), uncertain = ref(false);
  const collecting = ref(false);
  const recommendations = ref<VisitRecommendation[]>([]), recommendationLoading = ref(false), recommendationLoaded = ref(false);
  const recommendationError = ref(""), recommendationPage = ref(1), recommendationHasMore = ref(true);
  let generation = 0;
  const loggedIn = computed(() => auth.isLoggedIn && auth.uid > 0);
  const blocked = computed(() => !visible.value || !loggedIn.value || loading.value || confirming.value || deleting.value || collecting.value || !!error.value || uncertain.value);
  const groups = computed(() => {
    const result: { time: string; products: VisitProduct[] }[] = [];
    for (const item of items.value) {
      let group = result.find(row => row.time === item.timeKey);
      if (!group) { group = { time: item.timeKey, products: [] }; result.push(group); }
      group.products.push(item);
    }
    return result;
  });
  function reset() {
    generation++; items.value = []; total.value = 0; loading.value = false; loaded.value = false;
    error.value = ""; nextPage.value = 1; hasMore.value = false; managing.value = false;
    selected.value = []; confirming.value = false; deleting.value = false; collecting.value = false; uncertain.value = false;
    recommendations.value = []; recommendationLoading.value = false; recommendationLoaded.value = false;
    recommendationError.value = ""; recommendationPage.value = 1; recommendationHasMore.value = true;
  }
  const current = (id: number) => id === generation && visible.value && loggedIn.value;
  async function load(append = false) {
    if (!visible.value || deleting.value || collecting.value) return;
    if (!loggedIn.value) { reset(); return; }
    if (append && (loading.value || confirming.value || uncertain.value || !hasMore.value)) return;
    if (!append) reset();
    const id = generation, page = nextPage.value;
    loading.value = true; error.value = "";
    try {
      const result = await apiVisitHistory(page);
      if (!current(id)) return;
      if (append && (result.count !== total.value || result.list.some(row => items.value.some(old => old.productId === row.productId)))) {
        throw Error("浏览记录已变化，请刷新后查看");
      }
      items.value = append ? [...items.value, ...result.list] : result.list;
      total.value = result.count; loaded.value = true; nextPage.value = page + 1;
      hasMore.value = result.list.length === VISIT_PAGE_SIZE;
    } catch (e) { if (current(id)) error.value = e instanceof Error ? e.message : "浏览记录加载失败，请重试"; }
    finally { if (current(id)) loading.value = false; }
    if (current(id) && loaded.value && !items.value.length && !error.value) await loadRecommendations();
  }
  async function loadRecommendations() {
    if (!visible.value || !loggedIn.value || loading.value || !loaded.value || items.value.length || error.value
      || recommendationLoading.value || !recommendationHasMore.value) return;
    const id = generation, page = recommendationPage.value;
    recommendationLoading.value = true; recommendationError.value = "";
    try {
      const rows = await apiVisitRecommendations(page);
      if (!current(id)) return;
      if (rows.some(row => recommendations.value.some(old => old.productId === row.productId))) throw Error("推荐商品已变化，请刷新记录后查看");
      recommendations.value = [...recommendations.value, ...rows]; recommendationLoaded.value = true;
      recommendationPage.value = page + 1; recommendationHasMore.value = rows.length === VISIT_RECOMMENDATION_PAGE_SIZE;
    } catch (e) { if (current(id)) recommendationError.value = e instanceof Error ? e.message : "推荐商品加载失败，请重试"; }
    finally { if (current(id)) recommendationLoading.value = false; }
  }
  function openRecommendation(id: number) {
    if (!visible.value || !loggedIn.value || loading.value || error.value || items.value.length || recommendationError.value) return;
    const item = recommendations.value.find(row => row.productId === id);
    if (!item) return;
    if (item.navigationExpiresAt !== null && Date.now() >= item.navigationExpiresAt) {
      uni.showToast({ title: "活动信息已过期，请刷新记录", icon: "none" }); return;
    }
    if (!item.destination) { uni.showToast({ title: item.navigationHint, icon: "none" }); return; }
    const owner = generation;
    const fail = () => { if (current(owner)) uni.showToast({ title: "页面打开失败，请重试", icon: "none" }); };
    try { uni.navigateTo({ url: item.destination, fail }); } catch { fail(); }
  }
  function toggleManage() {
    if (blocked.value) return;
    managing.value = !managing.value; selected.value = [];
  }
  function toggle(id: number) {
    if (blocked.value || !managing.value || !items.value.some(row => row.productId === id)) return;
    if (selected.value.includes(id)) selected.value = selected.value.filter(value => value !== id);
    else if (selected.value.length < 200) selected.value = [...selected.value, id];
    else uni.showToast({ title: "一次最多选择 200 件商品", icon: "none" });
  }
  function toggleAll() {
    if (blocked.value || !managing.value) return;
    if (selected.value.length) selected.value = [];
    else selected.value = items.value.slice(0, 200).map(row => row.productId);
  }
  function openProduct(id: number) {
    if (blocked.value) return;
    if (managing.value) { toggle(id); return; }
    const item = items.value.find(row => row.productId === id);
    if (item?.visible) uni.navigateTo({ url: `/pages/goods/detail?id=${id}` });
  }
  async function removeSelected() {
    if (blocked.value || !managing.value || !selected.value.length) return;
    const id = generation, ids = [...selected.value];
    confirming.value = true;
    const confirmed = await new Promise<boolean>(resolve => {
      try { uni.showModal({ title: "删除浏览记录", content: `删除所选 ${ids.length} 件商品的浏览记录？不会删除收藏、商品或订单。`,
        confirmText: "删除", cancelText: "取消", success: result => resolve(result.confirm === true), fail: () => resolve(false) }); }
      catch { resolve(false); }
    });
    if (!current(id)) return;
    confirming.value = false;
    if (!confirmed) return;
    deleting.value = true;
    try {
      await apiDeleteVisitHistory(ids);
      if (!current(id)) return;
      deleting.value = false;
      uni.showToast({ title: "已删除浏览记录", icon: "success" });
      // Offset pages must restart after deletion; otherwise unseen rows can be skipped.
      await load();
    } catch {
      if (current(id)) {
        uncertain.value = true; error.value = "删除结果未确认，可能已经生效。请刷新核对后再操作。";
        selected.value = []; managing.value = false;
      }
    } finally { if (current(id)) deleting.value = false; }
  }
  async function collectSelected() {
    if (blocked.value || !managing.value || !selected.value.length) return;
    if (selected.value.length > VISIT_COLLECT_LIMIT) {
      uni.showToast({ title: "一次最多收藏 100 件商品，请减少选择", icon: "none" }); return;
    }
    const id = generation, ids = [...selected.value]; collecting.value = true;
    try {
      await apiCollectVisitProducts(ids);
      if (!current(id)) return;
      selected.value = []; managing.value = false;
      uni.showToast({ title: "已加入收藏，浏览记录保留", icon: "none" });
    } catch {
      if (current(id)) {
        error.value = "收藏结果未确认，请到我的收藏核对，刷新后再操作。";
        uncertain.value = true; selected.value = []; managing.value = false;
      }
    } finally { if (current(id)) collecting.value = false; }
  }
  function login() { if (visible.value && !loggedIn.value) uni.navigateTo({ url: "/pages/auth/login" }); }
  function suspend() { visible.value = false; reset(); }
  watch(() => [auth.uid, auth.token, auth.sessionVersion], () => { reset(); error.value = "登录状态已变化，请刷新后重新加载"; }, { flush: "sync" });
  onShow(() => { visible.value = true; void load(); }); onHide(suspend); onUnload(suspend);
  onReachBottom(() => {
    // Automatic scrolling never retries a failed page; retry remains an explicit action.
    if (!error.value && items.value.length && hasMore.value) void load(true);
    else if (!error.value && !recommendationError.value && !items.value.length) void loadRecommendations();
  });
  return { items, total, groups, loading, loaded, error, hasMore, managing, selected, confirming, deleting, collecting, uncertain,
    loggedIn, blocked, load, toggleManage, toggle, toggleAll, openProduct, removeSelected, collectSelected, login,
    recommendations, recommendationLoading, recommendationLoaded, recommendationError, recommendationHasMore, loadRecommendations, openRecommendation };
}
