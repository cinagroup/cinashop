import { computed, onBeforeUnmount, reactive, watch } from 'vue';
import { useRoute } from 'vue-router';
import { captureAuthSession, getUid, isCurrentAuthSession, onAuthChange } from '@/utils/auth';
import { apiPcMessagePage, apiPcMessageDetail } from '@/api/pcMessages';
import { createPcMessagePageFlow, pcMessagePageState, pcMessagePageNumber } from '../../../common/pcMessageCenter';
import { bindPcMessageBadge, pcMessageBadge, pcMessageBadgeFlow, refreshPcMessageBadge } from './usePcMessageBadge';

const failure = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;
export function usePcMessages() {
  const route = useRoute(), state = reactive(pcMessagePageState()), flow = createPcMessagePageFlow(state), session = reactive({ loggedIn: false });
  let disposed = false, visible = typeof document === 'undefined' || document.visibilityState !== 'hidden', epoch = 0, controller: AbortController | undefined;
  let pendingConsumption: ReturnType<typeof pcMessageBadgeFlow.beginConsume> | undefined;
  function bind() { bindPcMessageBadge(); session.loggedIn = !!captureAuthSession().token && getUid() > 0; }
  function capture() {
    const auth = captureAuthSession(), uid = auth.token ? getUid() : 0, path = route.fullPath, generation = epoch;
    return { uid, active: () => !disposed && visible && generation === epoch && route.fullPath === path && isCurrentAuthSession(auth) && (auth.token ? getUid() : 0) === uid };
  }
  function clear() { epoch++; controller?.abort(); controller = undefined; if (pendingConsumption) pcMessageBadgeFlow.consumed(pendingConsumption, null); pendingConsumption = undefined; flow.clear(); }
  function beginConsumption() { bind(); const ticket = pcMessageBadgeFlow.beginConsume(); pendingConsumption = ticket; return ticket; }
  function settled(ticket: ReturnType<typeof beginConsumption>, unread: number | null) { pcMessageBadgeFlow.consumed(ticket, unread); if (pendingConsumption === ticket) pendingConsumption = undefined; }
  async function load(page = 1) {
    bind(); if (disposed || !visible || !session.loggedIn) return;
    try { pcMessagePageNumber(page); } catch { return; }
    const ticket = flow.beginPage(page); if (!ticket) return;
    const owner = capture(), consume = beginConsumption(); controller = new AbortController();
    try {
      const result = await apiPcMessagePage(owner.uid, page, controller.signal);
      if (!owner.active() || !flow.pageCurrent(ticket)) { settled(consume, null); return; }
      flow.pageSuccess(ticket, result); settled(consume, result.unread_after);
    } catch (error) {
      settled(consume, null);
      if (owner.active()) flow.pageFailure(ticket, failure(error, '站内信读取失败，请重试目标页'));
    }
  }
  async function open(id: number, retry = false) {
    if (disposed || !visible || !session.loggedIn) return;
    if (state.detailId === id && !state.detailLoading && !retry) { flow.closeDetail(); return; }
    const ticket = flow.beginDetail(id); if (!ticket) return;
    const owner = capture(), consume = beginConsumption(); controller = new AbortController();
    try {
      const result = await apiPcMessageDetail(owner.uid, id, controller.signal);
      if (!owner.active() || !flow.detailCurrent(ticket)) { settled(consume, null); return; }
      flow.detailSuccess(ticket, result.message); settled(consume, result.service_num);
    } catch (error) { settled(consume, null); if (owner.active()) flow.detailFailure(ticket, failure(error, '消息详情读取失败，请重试')); }
  }
  async function checkUnread() {
    if (!visible || disposed || !session.loggedIn || state.loading || state.detailLoading) return;
    const owner = capture(); await refreshPcMessageBadge(owner.active);
  }
  function page(target: number) {
    if (!state.result || state.error || target < 1 || target > state.result.page_count) return;
    void load(target);
  }
  watch(() => route.fullPath, () => { clear(); bind(); if (visible && session.loggedIn) void load(); }, { immediate: true, flush: 'sync' });
  const stopAuth = onAuthChange(() => { clear(); bind(); if (!disposed && visible && session.loggedIn) void load(); });
  function visibility() { visible = document.visibilityState !== 'hidden'; clear(); bind(); if (visible && !disposed && session.loggedIn) void load(); }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
  onBeforeUnmount(() => { disposed = true; visible = false; clear(); stopAuth(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility); });
  return { state, badge: pcMessageBadge, loggedIn: computed(() => session.loggedIn), loginPath: computed(() => '/login?redirect=' + encodeURIComponent(route.fullPath)),
    load, page, retry: () => load(state.failedPage || state.result?.query.page || 1), open, retryDetail: () => open(state.detailId, true), checkUnread };
}
