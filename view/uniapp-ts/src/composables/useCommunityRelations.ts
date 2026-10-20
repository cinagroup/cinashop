import { computed, ref, watch, type Ref } from "vue";
import { onHide, onShow, onUnload } from "@dcloudio/uni-app";
import { useAuthStore } from "@/stores/auth";
import { apiCommunityProducts, apiCommunityTopics, type CommunityProduct, type CommunityProductSource, type CommunityTopic } from "@/api/community";

export function useCommunityRelations(locked: Ref<boolean> = ref(false)) {
  const auth = useAuthStore(), panel = ref<"" | "topics" | "products">("");
  const topics = ref<CommunityTopic[]>([]), products = ref<CommunityProduct[]>([]);
  const selectedTopics = ref<CommunityTopic[]>([]), selectedProducts = ref<CommunityProduct[]>([]);
  const keyword = ref(""), source = ref<CommunityProductSource>("pay");
  const loading = ref(false), error = ref(""), hasMore = ref(false), pendingTopic = ref(0);
  let generation = 0, page = 0, appliedKeyword = "", visible = true, disposed = false;
  const identity = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const availableTopics = computed(() => topics.value.filter(topic => topic.name.includes(keyword.value.trim())));
  const editable = () => visible && !disposed && !locked.value && auth.isLoggedIn;
  function close() { generation++; panel.value = ""; products.value = []; loading.value = false; error.value = ""; }
  function clear() {
    close(); topics.value = []; selectedTopics.value = []; selectedProducts.value = [];
    keyword.value = ""; source.value = "pay"; pendingTopic.value = 0; page = 0; hasMore.value = false;
  }
  async function loadTopics() {
    if (!editable()) return;
    const revision = ++generation, owner = identity();
    loading.value = true; error.value = "";
    try {
      const rows = await apiCommunityTopics();
      if (revision !== generation || owner !== identity() || !visible || disposed) return;
      if (!Array.isArray(rows) || rows.some(row => !row || !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.name !== "string")) {
        throw Error("话题列表格式错误");
      }
      topics.value = rows;
      if (pendingTopic.value) {
        const row = rows.find(item => item.id === pendingTopic.value);
        if (!row) throw Error("原话题已停用或不存在，请重新选择");
        if (!selectedTopics.value.some(item => item.id === row.id)) {
          if (selectedTopics.value.length >= 5) throw Error("最多选择5个话题");
          selectedTopics.value.push(row);
        }
        pendingTopic.value = 0;
      }
    } catch (cause) {
      if (revision === generation && owner === identity()) { topics.value = []; error.value = cause instanceof Error ? cause.message : "话题加载失败"; }
    } finally { if (revision === generation) loading.value = false; }
  }
  async function openTopics() { if (editable()) { panel.value = "topics"; keyword.value = ""; await loadTopics(); } }
  async function seedTopic(id: number) {
    if (!editable() || !Number.isSafeInteger(id) || id <= 0) return;
    pendingTopic.value = id; await openTopics();
  }
  function discardPendingTopic() { if (editable()) { pendingTopic.value = 0; error.value = ""; } }
  function toggleTopic(row: CommunityTopic) {
    if (!editable() || loading.value || !topics.value.some(item => item.id === row.id)) return;
    error.value = "";
    const index = selectedTopics.value.findIndex(item => item.id === row.id);
    if (index >= 0) selectedTopics.value.splice(index, 1);
    else if (selectedTopics.value.length < 5) selectedTopics.value.push(row);
    else error.value = "最多选择5个话题";
  }
  function removeTopic(id: number) { if (editable()) selectedTopics.value = selectedTopics.value.filter(item => item.id !== id); }
  async function loadProducts(reset = false) {
    if (!editable() || panel.value !== "products" || (!reset && (loading.value || !hasMore.value))) return;
    const revision = ++generation, owner = identity(), type = source.value;
    if (reset) { page = 0; products.value = []; appliedKeyword = keyword.value.trim().slice(0, 100); }
    const next = page + 1, term = appliedKeyword;
    loading.value = true; error.value = "";
    try {
      const rows = await apiCommunityProducts(type, term, next);
      if (revision !== generation || owner !== identity() || !visible || disposed) return;
      const known = new Set(products.value.map(item => item.product_id));
      for (const row of rows) {
        if (!known.has(row.product_id)) { products.value.push(row); known.add(row.product_id); }
      }
      page = next; hasMore.value = rows.length === 10 && next < 1000;
    } catch (cause) {
      if (revision === generation && owner === identity()) error.value = cause instanceof Error ? cause.message : "商品加载失败";
    } finally { if (revision === generation) loading.value = false; }
  }
  async function openProducts() { if (editable()) { panel.value = "products"; keyword.value = ""; await loadProducts(true); } }
  async function changeSource(type: CommunityProductSource) {
    if (editable() && ["pay", "collect", "visit"].includes(type)) { source.value = type; await loadProducts(true); }
  }
  function toggleProduct(row: CommunityProduct) {
    if (!editable() || loading.value || !products.value.some(item => item.product_id === row.product_id)) return;
    error.value = "";
    const index = selectedProducts.value.findIndex(item => item.product_id === row.product_id);
    if (index >= 0) selectedProducts.value.splice(index, 1);
    else if (selectedProducts.value.length < 5) selectedProducts.value.push(row);
    else error.value = "最多选择5件商品";
  }
  function removeProduct(id: number) { if (editable()) selectedProducts.value = selectedProducts.value.filter(item => item.product_id !== id); }
  function leave() { visible = false; close(); }
  onHide(leave); onUnload(() => { leave(); disposed = true; }); onShow(() => { if (!disposed) visible = true; });
  watch(identity, clear, { flush: "sync" });
  return { panel, topics, availableTopics, products, selectedTopics, selectedProducts, keyword, source, loading, error, hasMore,
    pendingTopic, clear, close, openTopics, loadTopics, seedTopic, discardPendingTopic, toggleTopic, removeTopic,
    openProducts, changeSource, loadProducts, toggleProduct, removeProduct };
}
