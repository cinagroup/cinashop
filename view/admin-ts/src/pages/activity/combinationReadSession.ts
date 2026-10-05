import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';

// Each read surface owns its permission and cancels all requests when the actor
// changes, including an A → B → A replacement using the same token again.
export function useCombinationReadSession(permission: () => string, discard: () => void, resume: () => void) {
  const auth = useAuthStore();
  const has = (key: string) => !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes(key));
  const allowed = computed(() => !!auth.token && auth.token === getToken() && has(permission()));
  const identity = computed(() => JSON.stringify([auth.token, auth.userInfo?.id, auth.userInfo?.level, auth.uniqueAuth]));
  let alive = false, syncing = false, generation = 0;
  let stored = localStorage.getItem('admin_session');
  const requests = new Map<string, AbortController>();
  function invalidate() {
    generation++;
    requests.forEach(controller => controller.abort());
    requests.clear();
    discard();
  }
  function begin(channel: string) {
    if (!alive || !allowed.value || stored !== localStorage.getItem('admin_session')) return null;
    requests.get(channel)?.abort();
    const controller = new AbortController(), captured = { generation, identity: identity.value, stored };
    requests.set(channel, controller);
    return {
      signal: controller.signal,
      current: () => alive && allowed.value && !controller.signal.aborted && requests.get(channel) === controller &&
        generation === captured.generation && identity.value === captured.identity && auth.token === getToken() &&
        captured.stored === localStorage.getItem('admin_session'),
      finish: () => { if (requests.get(channel) === controller) requests.delete(channel); },
    };
  }
  function cancel(channel: string) { requests.get(channel)?.abort(); requests.delete(channel); }
  function sync() {
    syncing = true;
    invalidate();
    const session = getAdminSession();
    auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null,
      menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
    stored = localStorage.getItem('admin_session');
    syncing = false;
    resume();
  }
  function storage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') sync(); }
  watch(identity, () => { if (alive && !syncing) { invalidate(); resume(); } }, { flush: 'sync' });
  onMounted(() => {
    alive = true;
    window.addEventListener('admin-session-changed', sync);
    window.addEventListener('admin-auth-expired', sync);
    window.addEventListener('storage', storage);
    sync();
  });
  onBeforeUnmount(() => {
    alive = false; invalidate();
    window.removeEventListener('admin-session-changed', sync);
    window.removeEventListener('admin-auth-expired', sync);
    window.removeEventListener('storage', storage);
  });
  return { allowed, has, begin, cancel, invalidate };
}

export function combinationReadTime(value: number | string | null) {
  const time = typeof value === 'number' ? value * 1000 : typeof value === 'string' && value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time <= 0) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(time);
}
