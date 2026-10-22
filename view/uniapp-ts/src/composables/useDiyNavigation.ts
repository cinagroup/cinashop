import { computed, onScopeDispose, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';
import { normalizeDiyNavigation } from '@/utils/diyNavigationConfig';
import { diyAuthoredPageFingerprint, diyEditorialMediaCacheUsable } from '@/utils/diyEditorialMediaLease';
import { openDiyLink } from '@/utils/diy';
import type { DiyCarouselTab } from '@/utils/diyCarouselConfig';

export function useDiyNavigation(block: () => unknown, active: () => boolean, select: (tab: DiyCarouselTab) => void = () => {}) {
  const auth = useAuthStore(), theme = useThemeStore();
  const config = computed(() => normalizeDiyNavigation(block(), theme.preset));
  const fingerprint = computed(() => JSON.stringify(config.value)), authored=computed(()=>diyAuthoredPageFingerprint([block()])), epoch = ref(0), currentPage=ref(0), owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  let disposed = false, admittedAt = Date.now();
  const ready = () => !disposed && active() && config.value.enabled && diyEditorialMediaCacheUsable({value:[block()]}, admittedAt);
  function lease() { const generation = epoch.value, actor = owner(), key = fingerprint.value; return () => ready() && epoch.value === generation && owner() === actor && fingerprint.value === key; }
  function reset() { epoch.value++; admittedAt = Date.now(); }
  function open(index: number) { if (!ready()) return; const item = config.value.items.find(item => item.index === index); if (item?.visible && item.link && (config.value.kind !== 'pictureCube' || config.value.hasCube)) openDiyLink(item.link); }
  function title() { if (ready() && config.value.kind === 'headerSerch' && config.value.style === 1 && config.value.title && config.value.titleLink) openDiyLink(config.value.titleLink); }
  // HeaderSerch's navigator opens search without adopting the visual hot word.
  function search() { if (ready() && config.value.kind === 'headerSerch') openDiyLink('/pages/goods/search'); }
  function choose(index: number) { if (!ready() || config.value.kind !== 'tabNav') return; const tab = config.value.tabs.find(tab => tab.index === index); if (tab?.valid && tab.title) select(tab); }
  function pageChanged(index:number){if(ready()&&config.value.kind==='menus'&&Number.isInteger(index)&&index>=0&&index<config.value.pages.length)currentPage.value=index;}
  const stopPage=watch([authored,owner,active],()=>{currentPage.value=0;},{flush:'sync'});
  const stop = watch([fingerprint, owner, active], reset, {immediate:true, flush:'sync'});
  function dispose() { if (disposed) return; disposed = true; stop();stopPage();currentPage.value=0;reset(); }
  onScopeDispose(dispose);
  return {config, fingerprint, epoch, currentPage, ready, lease, open, title, search, choose, pageChanged, dispose};
}
