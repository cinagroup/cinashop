import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from './auth';

/** A recovery lease belongs to the authenticated owner even after view/manage
 * revocation. Each caller separately admits reads, writes or owner recovery. */
export function useWechatAppSession(source: () => string, discard: () => void, resume: () => void) {
  const auth = useAuthStore(), revision = ref(0), requests = new Map<string, AbortController>();
  const has = (key: string) => !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.some(value => value === '*' || value === 'wechat_app.*' || value === key || key === 'wechat_app.view' && value === 'wechat_app.manage'));
  const identity = computed(() => JSON.stringify([auth.token, auth.userInfo, auth.uniqueAuth, auth.menus]));
  const signedIn = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && Number.isSafeInteger(auth.userInfo.id) && auth.userInfo.id > 0);
  const allowed = computed(() => signedIn.value && has('wechat_app.view'));
  let alive = false, syncing = false, scheduled = false, stored = localStorage.getItem('admin_session'), stopAction: (() => void) | undefined;
  function cancel(channel: string) { requests.get(channel)?.abort(); requests.delete(channel); }
  function invalidate() { revision.value++; requests.forEach(controller => controller.abort()); requests.clear(); discard(); }
  function again() { if (scheduled) return; scheduled = true; void Promise.resolve().then(() => { scheduled = false; if (alive) resume(); }); }
  function lease() { const capture = { revision: revision.value, identity: identity.value, source: source(), stored }; let retired = false;
    return { current: () => { if (retired) return false; const valid = alive && signedIn.value && auth.token === getToken() && revision.value === capture.revision && identity.value === capture.identity && source() === capture.source
      && stored === capture.stored && capture.stored === localStorage.getItem('admin_session'); if (!valid) retired = true; return valid; } };
  }
  function begin(channel: string) { const view = lease(); if (!view.current()) return null; cancel(channel); const controller = new AbortController(); requests.set(channel, controller);
    return { signal: controller.signal, current: () => view.current() && !controller.signal.aborted && requests.get(channel) === controller,
      finish: () => { if (requests.get(channel) === controller) requests.delete(channel); } };
  }
  function sync() { syncing = true; invalidate(); const saved = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: saved?.userInfo ?? null, menus: (saved?.menus as typeof auth.menus) ?? [], uniqueAuth: saved?.uniqueAuth ?? [] });
    stored = localStorage.getItem('admin_session'); syncing = false; again(); }
  function storage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session' || event.key.startsWith('cinashop_wechat_app_pending_v1_')) sync(); }
  watch(identity, () => { if (alive && !syncing) { invalidate(); again(); } }, { flush: 'sync' });
  watch(source, () => { if (alive) { invalidate(); again(); } }, { flush: 'sync' });
  onMounted(() => { alive = true; window.addEventListener('admin-session-changed', sync); window.addEventListener('admin-auth-expired', sync); window.addEventListener('storage', storage);
    stopAction = auth.$onAction(({ name, after }) => { if (name === 'logout') invalidate(); if (name === 'login') after(() => { if (alive) sync(); }); }); sync(); });
  onBeforeUnmount(() => { alive = false; invalidate(); stopAction?.(); window.removeEventListener('admin-session-changed', sync); window.removeEventListener('admin-auth-expired', sync); window.removeEventListener('storage', storage); });
  return { allowed, signedIn, revision, has, lease, begin, cancel };
}
