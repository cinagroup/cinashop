import { computed, onScopeDispose, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { safeDiyColor } from '@/utils/diy';
import { apiDiyLiveBroadcastRooms } from '@/api/diyLiveBroadcastAuthor';
import { liveBroadcastPresentation, liveBroadcastPluginDestination } from '../../../common/diyLiveBroadcast';
import type { DiyLiveBroadcastRoom } from '../../../common/diyLiveBroadcastData';

/** Independent read-only MP-only controller. No authored media slots exist,
 * therefore this has no ticket renewal/signing/admission or gallery capability. */
export function useDiyLiveBroadcast(block: () => unknown, active: () => boolean) {
  const auth = useAuthStore(), config = computed(() => liveBroadcastPresentation(block(), safeDiyColor));
  const fingerprint = computed(() => JSON.stringify(block()) ?? 'undefined'), nativeEpoch = ref(0);
  const rooms = ref<DiyLiveBroadcastRoom[]>([]), loading = ref(false), loaded = ref(false), error = ref('');
  const failedImages = ref<Record<string, boolean>>({}), loadedImages = ref<Record<string, boolean>>({});
  let miniProgram = false;
  // #ifdef MP-WEIXIN
  miniProgram = true;
  // #endif
  let alive = true, generation = 0;
  const actor = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const ready = () => alive && miniProgram && active() && config.value.enabled;
  const current = (n: number, owner: string, intent: string) => ready() && generation === n && actor() === owner && fingerprint.value === intent;
  function clear() { rooms.value = []; loading.value = loaded.value = false; error.value = ''; failedImages.value = {}; loadedImages.value = {}; }
  async function load() {
    if (!ready() || loading.value) return;
    const n = ++generation, owner = actor(), intent = fingerprint.value, limit = config.value.limit;
    nativeEpoch.value++; clear(); loading.value = true;
    try {
      const rows = limit > 0 ? await apiDiyLiveBroadcastRooms(limit) : [];
      if (!current(n, owner, intent)) return;
      rooms.value = rows; loaded.value = true;
    } catch (reason) {
      if (current(n, owner, intent)) { clear(); error.value = reason instanceof Error ? reason.message : '直播目录读取失败，请重试'; }
    } finally { if (current(n, owner, intent)) loading.value = false; }
  }
  function issued(room?: DiyLiveBroadcastRoom, source?: () => string) {
    const n = generation, epoch = nativeEpoch.value, owner = actor(), intent = fingerprint.value, original = source?.();
    return () => current(n, owner, intent) && nativeEpoch.value === epoch && (!room || loaded.value && !loading.value && !error.value && rooms.value.includes(room)) && (!source || source() === original);
  }
  const entries = computed(() => rooms.value.map((room, index) => {
    const valid = issued(room), uid = auth.uid;
    function image(key: string, source: () => string) {
      const validSource = issued(room, source), original = source();
      return { key: `${nativeEpoch.value}:${key}:${original}`, src: failedImages.value[key] ? '' : original,
        loaded: () => { if (validSource()) loadedImages.value = { ...loadedImages.value, [key]: true }; },
        failed: () => { if (validSource()) { nativeEpoch.value++; failedImages.value = { ...failedImages.value, [key]: true }; loadedImages.value = { ...loadedImages.value, [key]: false }; } },
      };
    }
    return { key: `${nativeEpoch.value}:${room.id}:${room.room_id}`, room, index, tap: () => {
      if (!valid()) return;
      const url = liveBroadcastPluginDestination(room.room_id, uid);
      // This is the existing destination contract, not evidence the plugin is
      // registered, deployed or authorized for the user's real WeChat tenant.
      // #ifdef MP-WEIXIN
      uni.navigateTo({ url });
      // #endif
    }, media: {
      cover: image(`${room.id}:cover`, () => room.cover_img), anchor: image(`${room.id}:anchor`, () => room.anchor_img),
      goods: Object.fromEntries(room.goods.map(good => [good.id, image(`${room.id}:goods:${good.id}`, () => good.cover_img)])),
    } };
  }));
  const actions = computed(() => { const valid = issued(); return { key: nativeEpoch.value, refresh: () => { if (valid() && !loading.value) void load(); } }; });
  const stop = watch([fingerprint, actor, active], () => {
    generation++; nativeEpoch.value++; clear();
    const n = generation;
    if (ready()) void Promise.resolve().then(() => { if (ready() && n === generation) void load(); });
  }, { immediate: true, flush: 'sync' });
  function dispose() { if (!alive) return; alive = false; stop(); generation++; nativeEpoch.value++; clear(); }
  onScopeDispose(dispose);
  return { config, rooms, loading, loaded, error, nativeEpoch, entries, actions, miniProgram, failedImages, loadedImages, ready, load, dispose };
}
