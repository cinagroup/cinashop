import { nextTick, reactive, watch, type App } from 'vue';
import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import type { Router } from 'vue-router';
import { browserLog } from '@/stores/browserLog';
import { browserLogState, BROWSER_LOG_LEVELS, type BrowserLogLevel, type BrowserLogTicket } from './browserLogState';

interface Auth {
  token: string; userInfo: { id: number } | null; menus: unknown; uniqueAuth: unknown;
  $onAction(callback: (context: { name: string; after(callback: () => void): void }) => void, detached?: boolean): () => void;
}
const installations = new WeakMap<App, { dispose(): void }>();

/** An observer only: preserves response/error identity and never performs I/O. */
export function installBrowserLog(app: App, router: Router, auth: Auth, request: AxiosInstance) {
  const existing = installations.get(app); if (existing) return existing;
  function identitySnapshot(): string | null {
    try { return JSON.stringify([auth.token, auth.userInfo, auth.menus, auth.uniqueAuth]); } catch { return null; }
  }
  function valid() {
    try {
      if (identitySnapshot() === null) return false;
      const session = JSON.parse(localStorage.getItem('admin_session') ?? 'null');
      return typeof auth.token === 'string' && !!auth.token && auth.token === localStorage.getItem('admin_token') && Number.isSafeInteger(auth.userInfo?.id) && Number(auth.userInfo?.id) > 0 && session?.userInfo?.id === auth.userInfo?.id;
    } catch { return false; }
  }
  const records = router.getRoutes(), pages = new Map(records.filter(row => row.name && row.path !== '/login').map(row => [row.path, typeof row.meta.title === 'string' ? row.meta.title : '页面']));
  const model = browserLogState({ valid, now: () => Date.now(), pages, route: () => {
    const record = router.currentRoute.value.matched.at(-1); return record ? (record.aliasOf ?? record).path : null;
  } }, value => reactive(value) as typeof value);
  browserLog.value = model;
  let active = true, handling = false;
  const safe = (work: () => void) => { try { if (active) work(); } catch { /* Observation cannot change application outcomes. */ } };
  const reset = () => safe(() => model.reset());
  // Existing pages rehydrate equal JSON into new references on mount. Those
  // copies are the same session; real content changes and explicit session
  // events still retire old observations synchronously.
  const stop = watch(identitySnapshot, reset, { flush: 'sync' });
  const stopActions = auth.$onAction(({ name, after }) => {
    if (name === 'login') after(reset);
    else if (name === 'logout') reset();
  }, true);
  const storage = (event: StorageEvent) => { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') reset(); };
  window.addEventListener('storage', storage); window.addEventListener('admin-session-changed', reset); window.addEventListener('admin-auth-expired', reset);
  const contexts = new WeakMap<InternalAxiosRequestConfig, BrowserLogTicket | null>();
  const requestId = request.interceptors.request.use(config => { safe(() => contexts.set(config, model.begin())); return config; });
  const responseId = request.interceptors.response.use(response => response, error => {
    safe(() => {
      if (!axios.isAxiosError(error) || axios.isCancel(error) || error.config?.signal?.aborted || !error.config) return;
      const ticket = contexts.get(error.config) ?? null, status = error.response?.status;
      const method = String(error.config.method ?? '').toUpperCase();
      if (typeof status === 'number') model.record(ticket, 'error', 'http', status, method);
      else model.record(ticket, 'error', 'network', null, method);
    });
    return Promise.reject(error);
  });
  const previous = app.config.errorHandler;
  const handler: NonNullable<typeof previous> = (error, instance, info) => {
    if (handling) { try { console.error(error); } catch { /* Preserve the app even if a console port fails. */ } return; }
    handling = true;
    try {
      safe(() => { const ticket = model.begin(); void nextTick(() => safe(() => { model.record(ticket, 'error', 'vue'); })); });
      if (previous) return previous(error, instance, info);
      console.error(error);
    } finally { handling = false; }
  };
  app.config.errorHandler = handler;
  const priorLog = app.config.globalProperties.$log;
  const push = (input?: unknown) => safe(() => {
    if (typeof input !== 'string' && (!input || typeof input !== 'object')) return;
    let type: BrowserLogLevel = 'info';
    // PHP push(string) treats every string as an info message, even "error".
    if (input && typeof input === 'object') { const field = Object.getOwnPropertyDescriptor(input, 'type'); if (field && 'value' in field && BROWSER_LOG_LEVELS.includes(field.value)) type = field.value; }
    model.record(model.begin(), type, 'application');
  });
  const publicLog = Object.freeze({ push, info: () => push({ type: 'info' }), success: () => push({ type: 'success' }), warning: () => push({ type: 'warning' }), error: () => push({ type: 'error' }) });
  app.config.globalProperties.$log = publicLog;
  const result = { dispose() {
    if (!active) return; active = false; stop(); stopActions(); model.dispose();
    window.removeEventListener('storage', storage); window.removeEventListener('admin-session-changed', reset); window.removeEventListener('admin-auth-expired', reset);
    request.interceptors.request.eject(requestId); request.interceptors.response.eject(responseId);
    if (app.config.errorHandler === handler) app.config.errorHandler = previous;
    if (app.config.globalProperties.$log === publicLog) app.config.globalProperties.$log = priorLog;
    if (browserLog.value === model) browserLog.value = null; installations.delete(app);
  } };
  installations.set(app, result); app.onUnmount(result.dispose); return result;
}
