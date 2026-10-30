import { computed, ref, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiSearchHotwords, apiSearchProducts } from '@/api/searchHotwords';
import { API_BASE } from '@/utils/request';
import { parseSearchHistory, searchQuery, type SearchHotword } from '../../../common/searchHotwords';
import type { CategoryProduct } from '../../../common/categoryCatalog';

const HISTORY_KEY = 'h5_search_history';

export function useGoodsSearch() {
  const auth = useAuthStore(), owner = () => JSON.stringify([auth.uid, auth.token, auth.sessionVersion]);
  const visible = ref(false), context = ref(0), interaction = ref(0);
  const keyword = ref(''), hotWords = ref<SearchHotword[]>([]), history = ref<string[]>([]), results = ref<CategoryProduct[]>([]);
  const hotLoading = ref(false), hotError = ref(''), searchLoading = ref(false), searchError = ref(''), historyError = ref(''), searched = ref(false);
  const hotGeneration = ref(0), searchGeneration = ref(0), historyGeneration = ref(0), failedIcons = ref<string[]>([]);
  let alive = true, initial: unknown = undefined, initialPending = false, loaded = false, scheduled = false, scheduledContext = -1;
  const stamp = () => ({ context: context.value, owner: owner() });
  const current = (s: ReturnType<typeof stamp>) => alive && visible.value && s.context === context.value && s.owner === owner();
  const errorText = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;

  function retire() {
    context.value++; interaction.value++; hotGeneration.value++; searchGeneration.value++; historyGeneration.value++;
    hotLoading.value = false; searchLoading.value = false;
    hotWords.value = []; results.value = []; failedIcons.value = [];
    hotError.value = ''; searchError.value = ''; searched.value = false;
  }
  function loadHistory() {
    historyGeneration.value++; history.value = []; historyError.value = '';
    try { history.value = parseSearchHistory(uni.getStorageSync(HISTORY_KEY)); }
    catch { historyError.value = '本机搜索历史格式无效，请清空后重试'; }
  }
  function pushHistory(word: string) {
    if (historyError.value) return; // Do not overwrite malformed persistent data implicitly.
    const next = [word, ...history.value.filter(v => v !== word)].slice(0, 10);
    try { uni.setStorageSync(HISTORY_KEY, JSON.stringify(next)); history.value = next; historyGeneration.value++; }
    catch { historyError.value = '本机搜索历史暂时无法保存'; }
  }
  async function loadHot() {
    const s = stamp(); if (!current(s)) return;
    const generation = ++hotGeneration.value;
    hotWords.value = []; failedIcons.value = []; hotLoading.value = true; hotError.value = '';
    const admitted = () => current(s) && generation === hotGeneration.value;
    try { const rows = await apiSearchHotwords(); if (admitted()) hotWords.value = rows; }
    catch (e) { if (admitted()) hotError.value = errorText(e, '热词加载失败'); }
    finally { if (admitted()) hotLoading.value = false; }
  }
  function changeDraft(value: string) {
    if (value === keyword.value) return;
    keyword.value = value; interaction.value++; searchGeneration.value++;
    searchLoading.value = false; searchError.value = ''; searched.value = false; results.value = [];
  }
  async function search() {
    const s = stamp(); if (!current(s) || searchLoading.value) return;
    let word: string;
    try { word = searchQuery(keyword.value); }
    catch (e) { searchError.value = errorText(e, '搜索关键词无效'); searched.value = true; return; }
    keyword.value = word; interaction.value++;
    const generation = ++searchGeneration.value;
    results.value = []; searched.value = true; searchLoading.value = true; searchError.value = '';
    pushHistory(word);
    const admitted = () => current(s) && generation === searchGeneration.value && keyword.value === word;
    try { const page = await apiSearchProducts(word); if (admitted()) results.value = page.list; }
    catch (e) { if (admitted()) searchError.value = errorText(e, '商品搜索失败'); }
    finally { if (admitted()) searchLoading.value = false; }
  }
  function choose(word: string) { changeDraft(word); void search(); }
  function clearHistory() {
    try { uni.removeStorageSync(HISTORY_KEY); history.value = []; historyError.value = ''; historyGeneration.value++; }
    catch { historyError.value = '本机搜索历史暂时无法清空'; }
  }
  // Loop-local immutable functions survive native event caching without forwarding
  // old events to current state. Input identity changes only with page/session.
  const controls = computed(() => {
    const s = stamp(), revision = interaction.value, hg = historyGeneration.value, hot = hotGeneration.value;
    const admitted = () => current(s) && revision === interaction.value;
    return [{ key: s.context,
      input: (event: unknown) => {
        const value = (event as { detail?: { value?: unknown } } | null)?.detail?.value;
        if (current(s) && typeof value === 'string') changeDraft(value);
      },
      search: () => { if (admitted()) void search(); },
      refresh: () => { if (admitted() && hot === hotGeneration.value) void loadHot(); },
      clear: () => { if (admitted() && hg === historyGeneration.value) clearHistory(); },
    }];
  });
  const hotEntries = computed(() => {
    const s = stamp(), generation = hotGeneration.value, revision = interaction.value;
    return hotWords.value.map(row => {
      const source = JSON.stringify(row), name = row.name, icon = row.icon;
      const key = `${s.context}:${generation}:${row.id}:${icon}`;
      const admitted = () => current(s) && generation === hotGeneration.value && hotWords.value.includes(row) && JSON.stringify(row) === source;
      const signedAsset = /^\/api\/assets\/([1-9]\d{0,9})\?expires=\d{10}&signature=[A-Za-z0-9_-]{43}$/u.exec(icon);
      const displayIcon = API_BASE && signedAsset && Number(signedAsset[1]) <= 2147483647 ? API_BASE + icon : icon;
      return { key, row, icon: failedIcons.value.includes(key) ? '' : displayIcon,
        style: { color: row.color || '#666', backgroundColor: row.bg_color || '#f5f5f5', border: row.border_color ? `1px solid ${row.border_color}` : 'none' },
        tap: () => { if (admitted() && revision === interaction.value) choose(name); },
        error: () => { if (admitted() && !failedIcons.value.includes(key)) failedIcons.value = [...failedIcons.value, key]; },
      };
    });
  });
  const historyEntries = computed(() => {
    const s = stamp(), generation = historyGeneration.value, revision = interaction.value;
    return history.value.map((word, index) => ({ key: `${s.context}:${generation}:${index}`, word,
      tap: () => { if (current(s) && generation === historyGeneration.value && revision === interaction.value) choose(word); },
    }));
  });
  const resultEntries = computed(() => {
    const s = stamp(), generation = searchGeneration.value, revision = interaction.value;
    return results.value.map(row => {
      const id = row.id, source = JSON.stringify(row);
      return { key: `${s.context}:${generation}:${id}`, row,
        tap: () => { if (current(s) && generation === searchGeneration.value && revision === interaction.value && results.value.includes(row) && JSON.stringify(row) === source) uni.navigateTo({ url: `/pages/goods/detail?id=${id}` }); },
      };
    });
  });

  function admit() {
    if (!alive || !visible.value) return;
    loadHistory(); void loadHot();
    if (initialPending) {
      initialPending = false;
      if (typeof initial === 'string' && initial.trim()) { keyword.value = initial; void search(); }
      else if (initial !== undefined && initial !== '') { searched.value = true; searchError.value = '搜索关键词无效'; }
    }
  }
  const unwatch = watch(owner, () => {
    retire(); keyword.value = ''; history.value = []; historyError.value = ''; initialPending = false;
    scheduledContext = context.value;
    if (!visible.value || scheduled) return;
    scheduled = true;
    void Promise.resolve().then(() => { scheduled = false; if (scheduledContext === context.value) admit(); });
  }, { flush: 'sync' });
  onLoad(options => {
    if (!alive || loaded) return; loaded = true;
    initial = options?.keyword ?? options?.searchVal; initialPending = initial !== undefined;
  });
  onShow(() => { if (!alive || visible.value) return; visible.value = true; context.value++; admit(); });
  // Returning to the page requires an explicit search. Avoid another server
  // search-history write just because the app regained visibility.
  onHide(() => { visible.value = false; retire(); });
  onUnload(() => { visible.value = false; alive = false; retire(); unwatch(); });

  return { keyword, hotWords, history, results, hotLoading, hotError, searchLoading, searchError, historyError, searched, controls, hotEntries, historyEntries, resultEntries };
}
