import { computed, onScopeDispose, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';
import { normalizeDiyPromotion, promotionProductBlock, promotionTabPresentation } from '@/utils/diyPromotion';
import { diyAuthoredPageFingerprint, diyEditorialMediaCacheUsable, diyEditorialMediaDeadline } from '@/utils/diyEditorialMediaLease';
import type { DiyComponent } from '@/api/diy';

/** The list child owns product reads/actions; this controller owns only tabs and
 * their authored raster capabilities. Native callbacks never acquire new leases. */
export function useDiyPromotion(block: () => unknown, active: () => boolean) {
  const auth = useAuthStore(), theme = useThemeStore();
  const config = computed(() => normalizeDiyPromotion(block(), theme.preset));
  const fingerprint = computed(() => diyAuthoredPageFingerprint([block()]));
  const selectedTab = ref(-1), epoch = ref(0), nativeEpoch = ref(0), mediaDeadline = ref(0), clock = ref(Date.now());
  const imageFailures = ref<Record<number, boolean>>({});
  let alive = true, admittedAt = Date.now(), timer: ReturnType<typeof setTimeout> | undefined;
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const ready = () => alive && active() && config.value.enabled && mediaDeadline.value > clock.value && diyEditorialMediaCacheUsable({ value: [block()] }, admittedAt);
  function lease(index: number, image: string) {
    const issued = nativeEpoch.value, actor = owner(), key = fingerprint.value, selection = selectedTab.value;
    return () => ready() && nativeEpoch.value === issued && owner() === actor && fingerprint.value === key && selectedTab.value === selection && config.value.tabs.some(tab => tab.index === index && tab.image === image);
  }
  function select(index: number) { if (ready() && config.value.tabs.some(tab => tab.index === index) && selectedTab.value !== index) { nativeEpoch.value++; imageFailures.value = {}; selectedTab.value = index; } }
  const tabs = computed(() => config.value.tabs.map(tab => {
    const current = lease(tab.index, tab.image);
    return { ...tab, styles: promotionTabPresentation(config.value, tab.index, selectedTab.value),
      key: `${nativeEpoch.value}:${tab.index}:${tab.image}`, current,
      tap: () => { if (current()) select(tab.index); },
      loaded: () => { if (current()) imageFailures.value = { ...imageFailures.value, [tab.index]: false }; },
      failed: () => { if (current()) imageFailures.value = { ...imageFailures.value, [tab.index]: true }; },
    };
  }));
  const productBlock = computed(() => promotionProductBlock(block(), selectedTab.value) as unknown as DiyComponent | null);
  function invalidate() { epoch.value++; nativeEpoch.value++; selectedTab.value = config.value.tabs[0]?.index ?? -1; imageFailures.value = {}; }
  function expire() {
    if (!alive) return;
    clock.value = Date.now();
    if (mediaDeadline.value > clock.value) timer = setTimeout(expire, Math.max(1, mediaDeadline.value - clock.value));
    else nativeEpoch.value++;
  }
  function renew() {
    nativeEpoch.value++; imageFailures.value = {};
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined; admittedAt = Date.now(); clock.value = admittedAt;
    mediaDeadline.value = diyEditorialMediaDeadline({ value: [block()] }, admittedAt);
    if (Number.isFinite(mediaDeadline.value) && mediaDeadline.value > clock.value) timer = setTimeout(expire, mediaDeadline.value - clock.value);
  }
  const stop = watch([fingerprint, owner, active], invalidate, { immediate: true, flush: 'sync' });
  const stopMedia = watch(block, renew, { immediate: true, deep: true, flush: 'sync' });
  function dispose() { if (!alive) return; alive = false; stop(); stopMedia(); if (timer !== undefined) clearTimeout(timer); invalidate(); }
  onScopeDispose(dispose);
  return { config, fingerprint, selectedTab, epoch, nativeEpoch, mediaDeadline, imageFailures, tabs, productBlock, ready, select, lease, dispose };
}
