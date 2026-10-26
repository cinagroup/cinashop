import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';

/** Authorize every retained handler against both live and persisted level grants. */
export function useLevelDefinitionOwner() {
  const auth = useAuthStore(), revision = ref(0);
  let alive = false;
  function stamp(): string {
    return JSON.stringify([auth.token, auth.userInfo?.id, auth.userInfo?.level, auth.uniqueAuth, localStorage.getItem('admin_session')]);
  }
  function has(permission: 'level.view' | 'level.manage' = 'level.view'): boolean {
    const session = getAdminSession();
    if (!alive || !auth.token || auth.token !== getToken() || !auth.userInfo || !session ||
      session.userInfo.id !== auth.userInfo.id || session.userInfo.level !== auth.userInfo.level) return false;
    const grants = (values: string[]) => values.includes(permission) || permission === 'level.view' && values.includes('level.manage');
    return auth.userInfo.level === 0 || grants(auth.uniqueAuth) && grants(session.uniqueAuth);
  }
  const identity = computed(() => { void revision.value; return stamp(); });
  const canView = computed(() => { void revision.value; void auth.uniqueAuth.length; void auth.token; void auth.userInfo; return has(); });
  const canManage = computed(() => { void revision.value; void auth.uniqueAuth.length; void auth.token; void auth.userInfo; return has('level.manage'); });
  const current = (value: string) => has() && stamp() === value;
  function sync() {
    const session = getAdminSession();
    auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null,
      menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
    revision.value++;
  }
  function storage(event: StorageEvent) {
    if (event.storageArea === localStorage && [null, 'admin_token', 'admin_session'].includes(event.key)) sync();
  }
  onMounted(() => {
    alive = true;
    window.addEventListener('admin-session-changed', sync); window.addEventListener('admin-auth-expired', sync);
    window.addEventListener('storage', storage); window.addEventListener('focus', sync); sync();
  });
  onBeforeUnmount(() => {
    alive = false; revision.value++;
    window.removeEventListener('admin-session-changed', sync); window.removeEventListener('admin-auth-expired', sync);
    window.removeEventListener('storage', storage); window.removeEventListener('focus', sync);
  });
  return { auth, identity, canView, canManage, stamp, current, has };
}
