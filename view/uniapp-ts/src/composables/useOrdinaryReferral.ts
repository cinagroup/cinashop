import { ref, watch, type Ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { apiBindSpread } from '@/api/finance';

/** Only this ordinary-product visit may consume its incoming referrer, for one actor. */
export function useOrdinaryReferral(productId: Ref<number>, referral: Ref<number>, visible: Ref<boolean>) {
  const auth = useAuthStore(), referralNotice = ref('');
  let generation = 0, disposed = false, queued = false;
  let intent: { id: number; spid: number; owner: { uid: number; token: string; version: number } | null; started: boolean; retired: boolean; guestVersion: number } | null = null;
  const owner = () => ({ uid: auth.uid, token: auth.token, version: auth.sessionVersion });
  function same(value: { uid: number; token: string; version: number }) { return value.uid === auth.uid && value.token === auth.token && value.version === auth.sessionVersion; }
  function queue() {
    if (queued || disposed) return; queued = true;
    Promise.resolve().then(() => { queued = false; void consume(); });
  }
  async function consume() {
    const visit = intent;
    if (!visit || disposed || visit.retired || visit.started) return;
    if (visit.owner && !same(visit.owner)) { visit.retired = true; generation++; referralNotice.value = ''; return; }
    if (!visit.owner) {
      if (auth.isLoggedIn && auth.uid > 0) visit.owner = owner();
      else if (auth.sessionVersion !== visit.guestVersion) { visit.retired = true; referralNotice.value = ''; return; }
      else return;
    }
    if (!visible.value || productId.value !== visit.id || referral.value !== visit.spid) return;
    visit.started = true;
    if (visit.owner.uid === visit.spid) { referralNotice.value = '当前分享来自本人，无需关联推荐关系'; return; }
    const current = generation, actor = visit.owner;
    try {
      await apiBindSpread(visit.spid);
      if (current !== generation || disposed || !visible.value || !same(actor) || intent !== visit) return;
      referralNotice.value = '推荐关系已由系统按账户规则处理';
    } catch {
      if (current !== generation || disposed || !visible.value || !same(actor) || intent !== visit) return;
      // Binding may already exist, be disallowed or have an unknown outcome.
      // A failed attempt is never handed to the next signed-in account.
      referralNotice.value = '推荐关系未能确认，商品仍可正常浏览与结算';
    }
  }
  watch(() => [productId.value, referral.value], () => {
    generation++; referralNotice.value = '';
    intent = productId.value > 0 && referral.value > 0 ? { id: productId.value, spid: referral.value,
      owner: auth.isLoggedIn && auth.uid > 0 ? owner() : null, started: false, retired: false, guestVersion: auth.sessionVersion } : null;
    queue();
  }, { flush: 'sync', immediate: true });
  watch(() => [auth.sessionVersion, auth.token, auth.uid], () => {
    generation++; referralNotice.value = '';
    if (intent && !intent.retired) {
      if (intent.owner && !same(intent.owner)) intent.retired = true;
      // A guest's first coherent login owns this visit immediately, even when
      // a second login happens before the queued request can start.
      else if (!intent.owner && auth.isLoggedIn && auth.uid > 0) intent.owner = owner();
    }
    // Wait for the store's epoch/token/uid assignment to finish before deciding
    // whether a guest has logged in or an owned visit has changed identity.
    queue();
  }, { flush: 'sync' });
  watch(visible, () => { generation++; if (!visible.value) referralNotice.value = ''; queue(); }, { flush: 'sync' });
  function disposeReferral() { disposed = true; generation++; if (intent) intent.retired = true; intent = null; referralNotice.value = ''; }
  return { referralNotice, disposeReferral };
}
