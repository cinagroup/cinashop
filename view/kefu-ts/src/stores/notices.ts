import { defineStore } from 'pinia';
import { ref } from 'vue';
import { ApiError, apiRequest, websocketUrl } from '@/api/client';
import { parseInboxPage } from '@/services/inbox';
import { StaffNoticeClient, bindNoticeLifecycle, type NoticeState } from '../../../common/staff-notifications';

/** One notification connection per app, independent of the selected chat and chat online status. */
export const useNoticeStore = defineStore('staff-notices', () => {
  const state = ref<NoticeState>('idle'), version = ref(0), unread = ref<number | null>(null);
  let token = '', generation = 0, pending: Promise<void> | undefined, repeat = false;
  let release: (() => void) | undefined, poll: ReturnType<typeof setInterval> | undefined;
  const client = new StaffNoticeClient({
    url: () => websocketUrl('/kefuapi/messages/socket'),
    onState: (value) => { state.value = value; },
    onRefresh: () => { refresh(); },
    onDenied: () => { invalidate(); version.value++; },
  });
  function invalidate() { generation++; pending = undefined; repeat = false; unread.value = null; }
  function refresh() {
    if (!token || document.hidden || state.value === 'denied') return;
    version.value++;
    if (pending) { repeat = true; return; }
    const current = generation;
    pending = Promise.resolve().then(async () => {
      do {
        repeat = false;
        if (current !== generation) return;
        try {
          const page = parseInboxPage(await apiRequest('/kefuapi/messages?limit=1'));
          if (current !== generation) return;
          unread.value = page.unread_count;
        } catch (error) {
          if (current !== generation) return;
          unread.value = null;
          if (error instanceof ApiError && [401, 403, 410000, 410001, 410002].includes(error.status)) { client.deny(); return; }
        }
      } while (repeat);
    }).finally(() => { if (current === generation) pending = undefined; });
  }
  function setSession(value: string) {
    if (token === value) return;
    invalidate(); token = value; version.value++; client.setSession(value);
    if (value) refresh();
  }
  function retry() { client.retry(); refresh(); }
  function start() {
    if (release) return;
    release = bindNoticeLifecycle(client, window, document, () => navigator.onLine); poll = setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
  }
  function stop() { release?.(); release = undefined; clearInterval(poll); invalidate(); window.removeEventListener('focus', refresh); }
  return { state, version, unread, refresh, retry, setSession, start, stop };
});
