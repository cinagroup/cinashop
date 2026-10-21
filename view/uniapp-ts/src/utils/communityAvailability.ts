import { computed, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { http, RequestError, type RequestOptions } from '@/utils/request';
import { communityClosedResponse, communityCertainRejection } from '../../../common/communityAvailability';

type Auth = ReturnType<typeof useAuthStore>;
const identity = (auth: Auth) => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
function makeState(owner: string) {
  return { owner, closed: ref(false), message: ref(''), epoch: ref(0), checking: ref(false), request: 0 };
}
const states = new WeakMap<Auth, ReturnType<typeof makeState>>();
export const isCommunityClosed = (reason: unknown): reason is RequestError => reason instanceof RequestError && communityClosedResponse(reason);
export const isCommunityRejected = (reason: unknown): reason is RequestError => reason instanceof RequestError && communityCertainRejection(reason);

/** Only availability and request generations are shared. No posts or drafts are retained. */
export function communityAvailability() {
  const auth = useAuthStore();
  let shared = states.get(auth);
  if (!shared) { shared = makeState(identity(auth)); states.set(auth, shared); }
  const state = shared;
  function synchronize() {
    if (state.owner === identity(auth)) return;
    state.owner = identity(auth); state.request++; state.epoch.value++;
    state.closed.value = false; state.message.value = ''; state.checking.value = false;
  }
  synchronize();
  function close(message = '社区暂未开放') {
    synchronize();
    state.message.value = message;
    if (!state.closed.value) { state.epoch.value++; state.closed.value = true; }
  }
  const observe = (reason: unknown, owner = identity(auth)) => {
    if (owner === identity(auth) && isCommunityClosed(reason)) close(reason.message);
  };
  const refusal = () => new RequestError(state.message.value || '社区暂未开放', 410010, null, 200);
  async function refresh(preview = false) {
    synchronize(); if (state.checking.value) return false;
    const owner = identity(auth), revision = state.epoch.value, request = ++state.request;
    state.checking.value = true;
    try {
      const config = preview ? { community_status: 1 } : await http.get<{ community_status: number }>('/community/config');
      if (owner !== identity(auth) || revision !== state.epoch.value || request !== state.request) return false;
      if (!config || ![0, 1].includes(config.community_status)) throw Error('社区开关格式错误，请重新检查');
      if (config.community_status === 0) { close(); return false; }
      if (state.closed.value) { state.epoch.value++; state.closed.value = false; }
      state.message.value = ''; return true;
    } catch (reason) {
      if (owner === identity(auth) && revision === state.epoch.value && request === state.request) {
        observe(reason, owner); state.message.value = reason instanceof Error ? reason.message : '社区状态加载失败，请重试';
      }
      return false;
    } finally { if (owner === identity(auth) && request === state.request) state.checking.value = false; }
  }
  return { closed: state.closed, message: state.message, epoch: state.epoch, checking: state.checking,
    allowed: computed(() => !state.closed.value && !state.checking.value), owner: () => identity(auth), synchronize, close, observe, refusal, refresh };
}

export function useCommunityAvailability() {
  const auth = useAuthStore(), availability = communityAvailability();
  watch(() => identity(auth), availability.synchronize, { flush: 'sync' });
  return availability;
}

async function guarded<T>(method: string, url: string, work: () => Promise<T>): Promise<T> {
  const availability = communityAvailability(), owner = availability.owner(), epoch = availability.epoch.value;
  const config = url === '/community/config';
  if (!config && availability.closed.value) throw availability.refusal();
  // detail is a deliberate visit and GET share is a write. Never replace their
  // actual receipt with a synthetic "not executed" rejection after dispatch.
  const write = method !== 'GET' || /^\/community\/(?:detail|share)\//.test(url);
  try {
    const value = await work();
    if (config && owner === availability.owner() && epoch === availability.epoch.value
      && (value as { community_status?: number })?.community_status === 0) availability.close();
    if (!write && !config && (owner !== availability.owner() || epoch !== availability.epoch.value)) throw Error('社区状态已变化，请主动刷新');
    return value;
  } catch (reason) { if (epoch === availability.epoch.value) availability.observe(reason, owner); throw reason; }
}

export const communityHttp = {
  get: <T>(url: string, data?: Record<string, unknown>, options?: RequestOptions) => guarded('GET', url, () => http.get<T>(url, data, options)),
  post: <T>(url: string, data?: Record<string, unknown>, options?: RequestOptions) => guarded('POST', url, () => http.post<T>(url, data, options)),
  put: <T>(url: string, data?: Record<string, unknown>, options?: RequestOptions) => guarded('PUT', url, () => http.put<T>(url, data, options)),
  delete: <T>(url: string, data?: Record<string, unknown>, options?: RequestOptions) => guarded('DELETE', url, () => http.delete<T>(url, data, options)),
};
