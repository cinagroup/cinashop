import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { useAuthStore } from './auth';
import { http } from '@/utils/request';
import { apiDiyVersion } from '@/api/diy';
import { normalizeDiyFooter } from '@/utils/diyFooterConfig';
import { diyEditorialMediaDeadline } from '@/utils/diyEditorialMediaLease';
import { closeDiyStation, confirmDiyStationOpen, diyStationEpoch, diyStationClosure } from '@/utils/diy';
import { RequestError } from '@/utils/request';

/** /navigation has its own row selection. Homepage version is liveness only. */
export const useDiyFooterStore = defineStore('diy-footer', () => {
  const auth = useAuthStore(), block = ref<Record<string, unknown> | null>(null), loading = ref(false), error = ref(''), active = ref(true), closed = ref(false), deadline = ref(0);
  let epoch = 0, pending: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  function cancelTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function invalidate() { epoch++; pending = undefined; cancelTimer(); loading.value = false; }
  function refresh(): Promise<void> {
    if (!active.value) return Promise.resolve();
    if (pending) return pending;
    cancelTimer(); const revision = ++epoch, actor = owner(), station = diyStationEpoch(); loading.value = true; error.value = '';
    const current = () => active.value && epoch === revision && actor === owner();
    const job = (async () => {
      try {
        // Always read navigation, including null/unchanged homepage versions.
        const [, value] = await Promise.all([apiDiyVersion(0), http.get<Record<string, unknown>>('navigation', {}, { noAuth: true })]);
        if (!current()) return;
        if (station !== diyStationEpoch()) throw new Error('站点状态已变化，请重新读取导航');
        const empty = value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
        if (!empty) normalizeDiyFooter(value);
        const expiry = empty ? Infinity : diyEditorialMediaDeadline({ value: [value] }, Date.now());
        if (expiry <= Date.now()) throw new Error('底部导航图片已过期，请重新读取');
        confirmDiyStationOpen(station);
        block.value = empty ? null : value; deadline.value = expiry; closed.value = false;
        if (expiry !== Infinity) timer = setTimeout(() => { if (current()) void refresh(); }, Math.max(0, expiry - Date.now()));
      } catch (reason) {
        if (!current()) return;
        block.value = null; deadline.value = 0;
        closed.value = !!diyStationClosure.value;
        error.value = reason instanceof Error ? reason.message : '底部导航读取失败';
        if (reason instanceof RequestError && reason.status === 410010) { closed.value = true; closeDiyStation(error.value); }
      } finally { if (current()) { loading.value = false; pending = undefined; } }
    })(); pending = job; return job;
  }
  function pause() { active.value = false; invalidate(); }
  function resume() { active.value = true; void refresh(); }
  watch(owner, () => { invalidate(); block.value = null; deadline.value = 0; if (active.value) void refresh(); }, { flush: 'sync' });
  return { block, loading, error, active, closed, deadline, refresh, pause, resume };
});
