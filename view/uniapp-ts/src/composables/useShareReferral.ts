import { ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { apiBindSpread } from '@/api/finance';
import { ShareReferralIntent } from '@/utils/shareReferral';
import { communityInbound, communityPageQuery } from '@/utils/communityShare';
const KEY = 'signed_share_referral_v1';
export const shareReferralNotice = ref('');
let engine: ShareReferralIntent | null = null;
export function useShareReferral() {
  const auth = useAuthStore();
  if (!engine) {
    try { engine = new ShareReferralIntent({ get: () => uni.getStorageSync(KEY), set: value => uni.setStorageSync(KEY, value) }, apiBindSpread); }
    catch(e) { const message = e instanceof Error ? e.message : '原推荐关系暂不可读取'; shareReferralNotice.value = message; return { notice: shareReferralNotice, capture() { throw Error(message); }, captureInbound() {} }; }
  }
  const currentEngine = engine;
  let queued = false, captureError = '';
  function queue() { if (queued) return; queued = true; Promise.resolve().then(async () => { queued = false; try { await currentEngine.consume(); if (!captureError) shareReferralNotice.value = currentEngine.notice; } catch(e) { if (!captureError) shareReferralNotice.value = e instanceof Error ? e.message : '推荐关系尚未确认'; } }); }
  watch(() => [auth.uid, auth.token, auth.sessionVersion], () => {
    try { captureError = ''; currentEngine.update({ uid: auth.uid, token: auth.token, version: auth.sessionVersion }); shareReferralNotice.value = ''; queue(); }
    catch(e) { shareReferralNotice.value = e instanceof Error ? e.message : '推荐关系尚未确认'; }
  }, { flush: 'sync', immediate: true });
  function capture(source: string, spid: number) { captureError = ''; currentEngine.capture(source, spid); queue(); }
  function captureInbound(options: unknown) {
    if (!options || typeof options !== 'object') return;
    const row = options as { path?: unknown; query?: unknown }, path = typeof row.path === 'string' ? row.path.replace(/^\//u, '') : '';
    if (path.startsWith('pages/discover/') && row.query && typeof row.query === 'object') {
      try {
        const post = communityInbound(path, communityPageQuery(row.query));
        if (post?.spid) capture(`community:${post.contentType}:${post.id}:${post.spid}`, post.spid);
      } catch (reason) { captureError = reason instanceof Error ? reason.message : '社区推荐链接无效'; shareReferralNotice.value = captureError; }
      return;
    }
    // Existing ordinary/integral visits own their referral flow; do not consume it twice.
    if (!/^pages\/(?:index\/index|activity\/(?:seckillDetail|bargainDetail|detail|presaleDetail|newcomerDetail))$/u.test(path) || !row.query || typeof row.query !== 'object') return;
    const value = (row.query as Record<string, unknown>).spid; if (value === undefined) return;
    try { if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/u.test(value) || Number(value) > 2147483647) throw Error('推荐人链接无效'); capture(`legacy:${path}:${value}`, Number(value)); }
    catch(e) { captureError = e instanceof Error ? e.message : '推荐人链接无效'; shareReferralNotice.value = captureError; }
  }
  return { notice: shareReferralNotice, capture, captureInbound };
}
