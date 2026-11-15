import { computed, onBeforeUnmount, onMounted, reactive, watch } from 'vue';
import { useRoute } from 'vue-router';
import { captureAuthSession, getUid, isCurrentAuthSession, onAuthChange } from '@/utils/auth';
import { apiPcMessageSummary } from '@/api/pcMessages';
import { createPcMessageBadgeFlow, pcMessageBadgeState } from '../../../common/pcMessageCenter';

export const pcMessageBadge = reactive(pcMessageBadgeState());
export const pcMessageBadgeFlow = createPcMessageBadgeFlow(pcMessageBadge);
export function bindPcMessageBadge() { const auth = captureAuthSession(); pcMessageBadgeFlow.bind({ ...auth, uid: auth.token ? getUid() : 0 }); }
// One application-scoped listener clears private counters even while the inbox
// is not mounted, including a new generation with the same bearer string.
onAuthChange(bindPcMessageBadge);
export async function refreshPcMessageBadge(current: () => boolean, signal?: AbortSignal) {
  bindPcMessageBadge(); const auth = captureAuthSession(), uid = auth.token ? getUid() : 0;
  if (!uid || !auth.token || !current()) return;
  const ticket = pcMessageBadgeFlow.beginSummary(); if (!ticket) return;
  const active = () => current() && isCurrentAuthSession(auth) && getUid() === uid && !signal?.aborted;
  try { const result = await apiPcMessageSummary(uid, signal); pcMessageBadgeFlow.summary(ticket, active() ? result.unread : null); }
  catch (error) { pcMessageBadgeFlow.summary(ticket, null, active() ? error instanceof Error ? error.message : '未读数读取失败，请重试核对' : ''); }
}
export function usePcMessageBadge() {
  const route = useRoute(); let alive = false, visible = typeof document === 'undefined' || document.visibilityState !== 'hidden', epoch = 0, controller: AbortController | undefined;
  const session = reactive({ loggedIn: false });
  function bind() { bindPcMessageBadge(); session.loggedIn = !!captureAuthSession().token && getUid() > 0; }
  function retire(clear = false) { epoch++; controller?.abort(); controller = undefined; pcMessageBadgeFlow.retireSummary(); if (clear) pcMessageBadgeFlow.clear(); }
  async function refresh() {
    bind(); if (!alive || !visible || !session.loggedIn || pcMessageBadge.loading) return;
    const generation = epoch; controller = new AbortController();
    await refreshPcMessageBadge(() => alive && visible && generation === epoch, controller.signal);
  }
  const stop = onAuthChange(() => { retire(); bind(); if (alive && visible) void Promise.resolve().then(refresh); });
  watch(() => route.fullPath, () => { if (alive) { retire(); void refresh(); } }, { flush: 'post' });
  function visibility() { visible = document.visibilityState !== 'hidden'; retire(!visible); if (visible && alive) void refresh(); }
  onMounted(() => { alive = true; bind(); if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility); void refresh(); });
  onBeforeUnmount(() => { alive = false; retire(true); stop(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility); });
  return { badge: pcMessageBadge, loggedIn: computed(() => session.loggedIn), refresh };
}
