import { getToken } from './auth';

/** One mounted operation surface. Invalidations are sticky, including A -> B -> A. */
export function createAdminSessionScope(onInvalidate: () => void = () => {}, allowAnonymous = false) {
  const token = getToken(), session = localStorage.getItem('admin_session');
  const controller = new AbortController();
  let active = true;
  const detach = () => {
    window.removeEventListener('admin-session-changed', invalidate);
    window.removeEventListener('admin-auth-expired', invalidate);
    window.removeEventListener('storage', storage);
  };
  function invalidate() {
    if (!active) return;
    active = false; detach(); controller.abort(); onInvalidate();
  }
  function storage(event: StorageEvent) {
    if (event.storageArea !== localStorage) return;
    if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') invalidate();
  }
  window.addEventListener('admin-session-changed', invalidate);
  window.addEventListener('admin-auth-expired', invalidate);
  window.addEventListener('storage', storage);
  return {
    signal: controller.signal,
    isCurrent() {
      if (active && ((!token && !allowAnonymous) || getToken() !== token || localStorage.getItem('admin_session') !== session)) invalidate();
      return active;
    },
    dispose() { active = false; detach(); controller.abort(); },
  };
}
