import { computed, onScopeDispose, ref, watch } from "vue";
import type { DiyPage } from "@/api/diy";
import { useAuthStore } from "@/stores/auth";
import { closeDiyStation, diyStationClosure, DiyPageLoadError, isDiyEnabled, loadDiyPage } from "@/utils/diy";
import { diyEditorialMediaDeadline } from '@/utils/diyEditorialMediaLease';

/** A page owns adoption and native title/refresh effects. Its children own their
 * separate optional-auth reads and never persist those responses as schema. */
export function useDiyPageHost(id: () => number | null, active: () => boolean, options: { adoptTitle?: boolean } = {}) {
  const auth = useAuthStore(), page = ref<DiyPage | null>(null), loading = ref(false), error = ref("");
  const phase = ref<"idle" | "loading" | "ready" | "empty" | "closed" | "error">("idle");
  const offline = ref(false), paintAdmitted = ref(false);
  let generation = 0, pullGeneration = 0, disposed = false;
  let paintTimer: ReturnType<typeof setTimeout> | undefined, paintEpoch = 0;
  let mediaTimer: ReturnType<typeof setTimeout> | undefined, mediaTimerEpoch = 0;
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const visible = () => !disposed && active() && id() !== null;
  const available = computed(() => visible() && phase.value === "ready" && !!page.value && isDiyEnabled(page.value.is_show));
  const refreshing = computed(() => visible() && loading.value && !!page.value && isDiyEnabled(page.value.is_show));
  // Passive CSS needs its own lease clock: an in-flight refresh cancels the
  // refresh timer but must never extend the accepted background's lifetime.
  const appearanceAvailable = computed(() => visible() && paintAdmitted.value && !!page.value && isDiyEnabled(page.value.is_show) && (phase.value === "ready" || phase.value === "loading"));
  function cancelPaint() {
    paintEpoch++; paintAdmitted.value = false;
    if (paintTimer !== undefined) { clearTimeout(paintTimer); paintTimer = undefined; }
  }
  function admitPaint(data: DiyPage | null, cachedAt: number) {
    cancelPaint();
    if (!data || !isDiyEnabled(data.is_show)) return;
    const deadline = diyEditorialMediaDeadline(data, cachedAt);
    if (deadline <= Date.now()) return;
    paintAdmitted.value = true;
    if (deadline === Infinity) return;
    const issued = paintEpoch;
    paintTimer = setTimeout(() => {
      if (issued !== paintEpoch) return;
      paintTimer = undefined; paintAdmitted.value = false;
    }, Math.max(0, deadline - Date.now()));
  }
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
    cancelMediaTimer(); cancelPaint();
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
      if (page.value && options.adoptTitle !== false) uni.setNavigationBarTitle({ title: page.value.title });
      admitPaint(snapshot.data, snapshot.cachedAt);
      scheduleMediaRefresh(snapshot.data, snapshot.cachedAt, current);
      return true;
    } catch (reason) {
      if (!current()) return false;
      cancelPaint(); page.value = null;
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
  const stopClosure = watch(diyStationClosure, message => { if (message && !disposed) { cancelMediaTimer(); cancelPaint(); page.value = null; loading.value = false; offline.value = false; error.value = message; phase.value = 'closed'; } }, { flush: 'sync' });
  function dispose() { if (disposed) return; disposed = true; stop(); stopClosure(); invalidate(true); }
  onScopeDispose(dispose);
  return { page, loading, error, phase, offline, available, refreshing, appearanceAvailable, reload, refresh, close, dispose };
}
