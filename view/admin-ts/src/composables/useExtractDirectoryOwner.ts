import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import type { ExtractDirectoryReadOwner } from '@/api/extractDirectory';

/** Every async completion and retained handler checks current persistent ownership. */
export function useExtractDirectoryOwner() {
  const auth = useAuthStore(), revision = ref(0), alive = ref(false);
  let persisted = '';
  function stamp(): string {
    return JSON.stringify([revision.value, auth.token, auth.userInfo?.id, auth.userInfo?.level,
      auth.uniqueAuth, getToken(), localStorage.getItem('admin_session')]);
  }
  function has(permission: 'extract.view' | 'extract.manage' = 'extract.view'): boolean {
    const session = getAdminSession();
    if (!alive.value || !auth.token || auth.token !== getToken() || !auth.userInfo || !session ||
      !Number.isSafeInteger(auth.userInfo.id) || auth.userInfo.id <= 0 || auth.userInfo.id > 2147483647 ||
      !Number.isInteger(auth.userInfo.level) || auth.userInfo.level < 0 || auth.userInfo.level > 9 ||
      session.userInfo.id !== auth.userInfo.id || session.userInfo.level !== auth.userInfo.level) return false;
    const grants = (values: string[]) => Array.isArray(values) && values.every(value => typeof value === 'string')
      && (values.includes(permission) || permission === 'extract.view' && values.includes('extract.manage'));
    return auth.userInfo.level === 0 || grants(auth.uniqueAuth) && grants(session.uniqueAuth);
  }
  const identity = computed(() => { void revision.value; return stamp(); });
  const canView = computed(() => { void revision.value; void auth.uniqueAuth.length; void auth.token; void auth.userInfo; return has(); });
  const canManage = computed(() => { void revision.value; void auth.uniqueAuth.length; void auth.token; void auth.userInfo; return has('extract.manage'); });
  const current = (value: string) => has() && stamp() === value;
  function capture(): ExtractDirectoryReadOwner | null {
    if (!has() || !auth.userInfo) return null;
    const value = stamp(), id = auth.userInfo.id, token = auth.token;
    return Object.freeze({ id, token, current: () => current(value) && getToken() === token });
  }
  function sync(event?: Event) {
    const session = getAdminSession();
    const next = JSON.stringify([getToken(), localStorage.getItem('admin_session')]);
    // Auth/storage events are monotonic fences, including A→B→A. An unchanged
    // focus sync alone does not erase the user's accepted filters.
    if (next !== persisted || event && event.type !== 'focus') revision.value++;
    persisted = next;
    auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null,
      menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  }
  function storage(event: StorageEvent) {
    if (event.storageArea === localStorage && [null, 'admin_token', 'admin_session'].includes(event.key)) sync(event);
  }
  onMounted(() => {
    alive.value = true;
    window.addEventListener('admin-session-changed', sync); window.addEventListener('admin-auth-expired', sync);
    window.addEventListener('storage', storage); window.addEventListener('focus', sync); sync();
  });
  onBeforeUnmount(() => {
    alive.value = false; revision.value++;
    window.removeEventListener('admin-session-changed', sync); window.removeEventListener('admin-auth-expired', sync);
    window.removeEventListener('storage', storage); window.removeEventListener('focus', sync);
  });
  return { auth, identity, canView, canManage, stamp, current, has, capture };
}
