import type { LoginResult } from '@/types';

const keys = ['supplier-token', 'supplier-user', 'supplier-permissions'] as const;
export function setSupplierSession(result: LoginResult) {
  localStorage.setItem(keys[0], result.token);
  localStorage.setItem(keys[1], JSON.stringify(result.user_info));
  localStorage.setItem(keys[2], JSON.stringify(result.unique_auth));
  window.dispatchEvent(new Event('supplier-session-changed'));
}
export function clearSupplierSession() {
  for (const key of keys) localStorage.removeItem(key);
  window.dispatchEvent(new Event('supplier-session-changed'));
}
export function isSupplierStorageEvent(event: StorageEvent) {
  return event.storageArea === localStorage && (event.key === null || keys.some(key => key === event.key));
}

/** One mounted surface/request: identity and permissions invalidation cannot resurrect A -> B -> A. */
export function createSupplierSessionScope(onInvalidate: () => void = () => {}, allowAnonymous = false) {
  const snapshot = keys.map(key => localStorage.getItem(key));
  const controller = new AbortController();
  let active = true;
  function detach() {
    window.removeEventListener('supplier-session-changed', invalidate);
    window.removeEventListener('storage', storage);
  }
  function invalidate() {
    if (!active) return;
    active = false; detach(); controller.abort(); onInvalidate();
  }
  function storage(event: StorageEvent) { if (isSupplierStorageEvent(event)) invalidate(); }
  window.addEventListener('supplier-session-changed', invalidate);
  window.addEventListener('storage', storage);
  return {
    signal: controller.signal,
    isCurrent() {
      if (active && ((!allowAnonymous && !snapshot[0]) || keys.some((key, index) => localStorage.getItem(key) !== snapshot[index]))) invalidate();
      return active;
    },
    dispose() { active = false; detach(); controller.abort(); },
  };
}
