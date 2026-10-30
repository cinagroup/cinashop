import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from './auth';

/** Client-only lifetime admission. The server still verifies JWT signature,
 * session/password and fresh domain authority for every operation. */
export function pcBaseSessionClaims(token: string): { actor: number; expiresAt: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1] || parts[1].length > 16384 || !/^[A-Za-z0-9_-]+$/u.test(parts[1])) return null;
    const encoded = parts[1].replace(/-/gu, '+').replace(/_/gu, '/');
    const value = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))) as { exp?: unknown; jti?: { id?: unknown; type?: unknown } };
    if (typeof value.exp !== 'number' || !Number.isSafeInteger(value.exp) || value.exp <= 0 || value.exp > Number.MAX_SAFE_INTEGER / 1000
      || value.jti?.type !== 'admin' || typeof value.jti.id !== 'number' || !Number.isSafeInteger(value.jti.id) || value.jti.id <= 0 || value.jti.id > 2147483647) return null;
    return { actor: value.jti.id, expiresAt: value.exp };
  } catch { return null; }
}
/** An owner recovery lease survives grant loss, never account/session/route
 * replacement, same-value session events, expiry or unmount. */
export function usePcBaseSession(source: () => string, discard: () => void, resume: () => void) {
  const activePage = () => /^\/(?:config\/pc|admin\/app\/pc)\/?(?:[?#]|$)/u.test(source());
  const auth = useAuthStore(), revision = ref(0), clock = ref(Date.now()), requests = new Map<string, AbortController>();
  const has = (key: string) => !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.some(value => value === '*' || value === 'pc_base.*' || value === key || key === 'pc_base.view' && value === 'pc_base.manage'));
  const identity = computed(() => JSON.stringify([auth.token, auth.userInfo, auth.uniqueAuth, auth.menus]));
  const principal = () => {
    const claims = pcBaseSessionClaims(auth.token);
    return auth.token && auth.token === getToken() && !!auth.userInfo && claims && claims.actor === auth.userInfo.id && Date.now() < claims.expiresAt * 1000 ? claims : null;
  };
  const signedIn = computed(() => { revision.value; clock.value; return !!principal(); });
  const allowed = computed(() => activePage() && signedIn.value && has('pc_base.view'));
  let alive = false, syncing = false, scheduled = false, stored = localStorage.getItem('admin_session'), stopAction: (() => void) | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  function clearTimer() { if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined; }
  function cancel(channel: string) { requests.get(channel)?.abort(); requests.delete(channel); }
  function invalidate() { revision.value++; requests.forEach(controller => controller.abort()); requests.clear(); discard(); }
  function again() { if (scheduled) return; scheduled = true; void Promise.resolve().then(() => { scheduled = false; if (alive && activePage()) resume(); }); }
  function armExpiry() {
    clearTimer(); const claims = principal(); if (!alive || !claims) return;
    expiryTimer = setTimeout(() => { clock.value = Date.now(); if (!alive) return; if (!principal()) { invalidate(); again(); } else armExpiry(); }, Math.min(2147483647, Math.max(1, claims.expiresAt * 1000 - Date.now() + 1)));
  }
  function lease() {
    const capture = { revision: revision.value, identity: identity.value, source: source(), stored, claims: principal() }; let retired = false;
    return { current: () => {
      if (retired) return false;
      const current = principal(), valid = alive && activePage() && !!current && !!capture.claims && current.actor === capture.claims.actor && current.expiresAt === capture.claims.expiresAt
        && revision.value === capture.revision && identity.value === capture.identity && source() === capture.source
        && stored === capture.stored && capture.stored === localStorage.getItem('admin_session');
      if (!valid) retired = true; return valid;
    } };
  }
  function begin(channel: string) {
    const view = lease(); if (!view.current()) return null; cancel(channel);
    const controller = new AbortController(); requests.set(channel, controller);
    return { signal: controller.signal, current: () => view.current() && !controller.signal.aborted && requests.get(channel) === controller,
      finish: () => { if (requests.get(channel) === controller) requests.delete(channel); } };
  }
  function sync() {
    syncing = true; clearTimer(); invalidate();
    const saved = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: saved?.userInfo ?? null, menus: (saved?.menus as typeof auth.menus) ?? [], uniqueAuth: saved?.uniqueAuth ?? [] });
    stored = localStorage.getItem('admin_session'); clock.value = Date.now(); syncing = false; armExpiry(); again();
  }
  function storage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session' || event.key.startsWith('cinashop_pc_base_pending_v1_')) sync(); }
  watch(identity, () => { if (alive && !syncing) { invalidate(); armExpiry(); again(); } }, { flush: 'sync' });
  watch(source, () => { if (alive) { invalidate(); if (activePage()) again(); } }, { flush: 'sync' });
  onMounted(() => {
    alive = true; window.addEventListener('admin-session-changed', sync); window.addEventListener('admin-auth-expired', sync); window.addEventListener('storage', storage);
    stopAction = auth.$onAction(({ name, after }) => { if (name === 'logout') invalidate(); if (name === 'login') after(() => { if (alive) sync(); }); }); sync();
  });
  onBeforeUnmount(() => { alive = false; clearTimer(); invalidate(); stopAction?.(); window.removeEventListener('admin-session-changed', sync); window.removeEventListener('admin-auth-expired', sync); window.removeEventListener('storage', storage); });
  return { allowed, signedIn, revision, has, lease, begin, cancel };
}
