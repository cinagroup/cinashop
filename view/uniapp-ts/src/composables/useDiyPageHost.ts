import { computed, onScopeDispose, ref, watch } from "vue";
import type { DiyPage } from "@/api/diy";
import { useAuthStore } from "@/stores/auth";
import { closeDiyStation, DiyPageLoadError, isDiyEnabled, loadDiyPage } from "@/utils/diy";
import { diyEditorialMediaDeadline } from '@/utils/diyEditorialMediaLease';

/** A page owns adoption and native title/refresh effects. Its children own their
 * separate optional-auth reads and never persist those responses as schema. */
export function useDiyPageHost(id: () => number | null, active: () => boolean) {
  const auth = useAuthStore(), page = ref<DiyPage | null>(null), loading = ref(false), error = ref("");
  const phase = ref<"idle" | "loading" | "ready" | "empty" | "closed" | "error">("idle");
  const offline = ref(false);
  let generation = 0, pullGeneration = 0, disposed = false;
  let mediaTimer: ReturnType<typeof setTimeout> | undefined, mediaTimerEpoch = 0;
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const visible = () => !disposed && active() && id() !== null;
  const available = computed(() => visible() && phase.value === "ready" && !!page.value && isDiyEnabled(page.value.is_show));
  function cancelMediaTimer() {
    mediaTimerEpoch++;
    if (mediaTimer !== undefined) { clearTimeout(mediaTimer); mediaTimer = undefined; }
  }
  function scheduleMediaRefresh(data: DiyPage | null, cachedAt: number, current: () => boolean) {
    cancelMediaTimer();
    if (!current()) return;
    const deadline = diyEditorialMediaDeadline(data, cachedAt);
    if (deadline === Infinity) return;
    const timerEpoch = mediaTimerEpoch;
    mediaTimer = setTimeout(() => {
      if (timerEpoch !== mediaTimerEpoch || !current()) return;
      mediaTimer = undefined;
      void reload(true);
    }, Math.max(0, deadline - Date.now()));
  }
  function invalidate(clear = false) {
    cancelMediaTimer();
    generation++; pullGeneration++; if (clear) page.value = null;
    loading.value = false; error.value = ""; offline.value = false; phase.value = page.value ? "ready" : "idle";
  }
  async function reload(force = false): Promise<boolean> {
    const pageId = id(); if (!visible() || pageId === null) return false;
    cancelMediaTimer();
    const revision = ++generation, actor = owner();
    const current = () => visible() && revision === generation && pageId === id() && actor === owner();
    loading.value = true; error.value = ""; offline.value = false; phase.value = "loading";
    try {
      const snapshot = await loadDiyPage(pageId, force, current);
      if (!current()) return false;
      page.value = snapshot.data; offline.value = snapshot.source === "offline";
      phase.value = page.value ? "ready" : "empty";
      if (page.value) uni.setNavigationBarTitle({ title: page.value.title });
      scheduleMediaRefresh(snapshot.data, snapshot.cachedAt, current);
      return true;
    } catch (reason) {
      if (!current()) return false;
      page.value = null;
      error.value = reason instanceof Error ? reason.message.slice(0, 400) : "页面加载失败，请稍后重试";
      phase.value = reason instanceof DiyPageLoadError && reason.kind === "closed" ? "closed" : "error";
      return true;
    } finally { if (current()) loading.value = false; }
  }
  async function refresh(additional?: () => Promise<unknown>): Promise<void> {
    if (!visible()) return;
    const revision = ++pullGeneration;
    const [result] = await Promise.allSettled([reload(true), Promise.resolve().then(() => additional?.())]);
    const adopted = result.status === "fulfilled" && result.value;
    if (adopted && visible() && revision === pullGeneration) uni.stopPullDownRefresh();
  }
  function close(message: string): void {
    if (!visible()) return;
    closeDiyStation(message); invalidate(true); error.value = message; phase.value = "closed";
  }
  const stop = watch([id, active, owner], (next, previous) => {
    invalidate(!previous || next[0] !== previous[0] || next[2] !== previous[2]);
    if (visible()) void reload();
  }, { immediate: true, flush: "sync" });
  function dispose() { if (disposed) return; disposed = true; stop(); invalidate(true); }
  onScopeDispose(dispose);
  return { page, loading, error, phase, offline, available, reload, refresh, close, dispose };
}
