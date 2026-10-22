import { computed, onScopeDispose, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';
import { normalizeDiyCarousel, type DiyCarouselTab } from '@/utils/diyCarouselConfig';
import { diyEditorialMediaCacheUsable } from '@/utils/diyEditorialMediaLease';
import { openDiyLink } from '@/utils/diy';

export function useDiyMediaCarousel(block: () => unknown, active: () => boolean, select: (tab: DiyCarouselTab) => void) {
  const auth = useAuthStore(), theme = useThemeStore();
  const config = computed(() => normalizeDiyCarousel(block(), theme.preset));
  const fingerprint = computed(() => JSON.stringify(config.value)), owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const epoch = ref(0), current = ref(0), word = ref(0), categoryOpen = ref(false);
  let disposed = false, admittedAt = Date.now();
  const ready = () => !disposed && active() && config.value.enabled && diyEditorialMediaCacheUsable({ value: [block()] }, admittedAt);
  function lease() { const generation = epoch.value, actor = owner(), key = fingerprint.value; return () => ready() && generation === epoch.value && actor === owner() && key === fingerprint.value; }
  function reset() { epoch.value++; admittedAt = Date.now(); current.value = 0; word.value = 0; categoryOpen.value = false; }
  function changed(index: number) { if (ready() && Number.isInteger(index) && index >= 0 && index < config.value.items.length) current.value = index; }
  function wordChanged(event: unknown) {
    const index = Number((event as { detail?: { current?: unknown } })?.detail?.current);
    if (ready() && Number.isInteger(index) && index >= 0 && index < config.value.hotWords.length) word.value = index;
  }
  function open(index: number) { if (ready()) { const item = config.value.items[index]; if (item?.link) openDiyLink(item.link); } }
  function search() { if (ready() && config.value.kind === 'homeComb') openDiyLink('/pages/goods/search' + (config.value.hotWords[word.value] ? `?searchVal=${encodeURIComponent(config.value.hotWords[word.value]!)}` : '')); }
  function toggleCategory() { if (ready() && config.value.showTabs) categoryOpen.value = !categoryOpen.value; }
  function closeCategory() { categoryOpen.value = false; }
  function choose(index: number) {
    if (!ready() || !config.value.showTabs) return;
    const tab = config.value.tabs.find(item => item.index === index);
    if (!tab?.valid || !tab.title) return;
    closeCategory(); select(tab);
  }
  const stop = watch([fingerprint, owner, active], reset, { immediate: true, flush: 'sync' });
  function dispose() { if (disposed) return; disposed = true; stop(); reset(); }
  onScopeDispose(dispose);
  return { config, fingerprint, epoch, current, word, categoryOpen, ready, lease, changed, wordChanged, open, search, toggleCategory, closeCategory, choose, dispose };
}
