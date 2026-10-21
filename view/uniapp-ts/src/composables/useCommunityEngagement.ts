import { computed, onScopeDispose, ref, shallowRef, watch, type ShallowRef } from 'vue';
import { onHide, onShow, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { RequestError } from '@/utils/request';
import { apiCommunityLike, apiCommunityState, apiCommunityTrackShare, checkedCommunityPost,
  communityPreviewMode, type CommunityPost } from '@/api/community';
import { communitySharePath, communityShareUrl, communityTimelineQuery } from '@/utils/communityShare';
import { communityVideoSource } from '@/utils/communityMedia';

type Patch = Pick<CommunityPost, 'isLike' | 'likeNum' | 'playNum' | 'status' | 'is_verify'> & { shareNum: number };
type Fence = { nonce: number; kind: 'like' | 'share'; phase: 'local' | 'server' | 'unknown' };
type Auth = ReturnType<typeof useAuthStore>;
type Registry = { owner: string; sequence: number; fences: ShallowRef<Map<number, Fence>>;
  patches: ShallowRef<Map<number, { ticket: number; patch: Patch }>> };
const stores = new WeakMap<Auth, Registry>();
const actor = (auth: Auth) => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
const boundedCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2147483647;
const publicPost = (post: CommunityPost) => post.status === 1 && (post.is_verify === 1 || communityPreviewMode && post.is_verify === undefined);
const certain = (reason: unknown) => reason instanceof RequestError && reason.status !== undefined
  && ((reason.status >= 400 && reason.status < 500) || [410000, 410001, 410002].includes(reason.status))
  && !(reason.httpStatus && reason.httpStatus >= 500);
const text = (reason: unknown) => reason instanceof Error ? reason.message : '操作失败，请重试';

/** Minimal same-auth-store counters and unresolved nonces; never retains post content, drafts or credentials. */
export function useCommunityEngagement(options: {
  update?: (id: number, patch: Patch) => void;
  liked?: (id: number, status: 0 | 1) => void;
  find?: (id?: number) => CommunityPost | null;
} = {}) {
  const auth = useAuthStore();
  let shared = stores.get(auth);
  if (!shared) {
    shared = { owner: actor(auth), sequence: 0, fences: shallowRef(new Map()), patches: shallowRef(new Map()) };
    stores.set(auth, shared);
  }
  const registry = shared;
  if (registry.owner !== actor(auth)) { registry.owner = actor(auth); registry.fences.value = new Map(); registry.patches.value = new Map(); }
  const notices = ref<Record<number, string>>({}), errors = ref<Record<number, string>>({});
  const reconciling = ref(0), sharePost = ref<CommunityPost | null>(null), shareLoading = ref(false), shareReady = ref(false);
  let visible = true, disposed = false, generation = 0, shareGeneration = 0;
  const sentShares = new Set<number>();
  const nextTicket = () => ++registry.sequence;
  const busy = computed(() => [...registry.fences.value.values()].some(f => f.phase !== 'unknown'));
  const unknown = (id: number) => registry.fences.value.get(id)?.phase === 'unknown';
  const fence = (id: number, value?: Fence) => {
    const copy = new Map(registry.fences.value); if (value) copy.set(id, value); else copy.delete(id); registry.fences.value = copy;
  };
  const view = (post: CommunityPost): CommunityPost => ({ ...post, ...registry.patches.value.get(post.id)?.patch });
  const tell = (id: number, value: string, error = false) => { (error ? errors : notices).value = { ...(error ? errors : notices).value, [id]: value }; };
  function adopt(rows: CommunityPost[], ticket: number): CommunityPost[] {
    const validated = rows.map(row => checkedCommunityPost(row, row.id));
    const copy = new Map(registry.patches.value);
    const result = validated.map(post => {
      const cached = copy.get(post.id);
      if (!cached || ticket >= cached.ticket) copy.set(post.id, { ticket, patch: {
        isLike: post.isLike, likeNum: post.likeNum, playNum: post.playNum, shareNum: post.shareNum ?? post.share_num ?? 0,
        status: post.status, is_verify: post.is_verify,
      } });
      return { ...post, ...copy.get(post.id)!.patch };
    });
    // Resolved counters are a short-lived projection, unlike unresolved operation fences.
    while (copy.size > 256) {
      const removable = [...copy.keys()].find(id => !registry.fences.value.has(id)); if (removable === undefined) break;
      copy.delete(removable);
    }
    registry.patches.value = copy; return result;
  }
  function publish(id: number, patch: Partial<Patch>, ticket = nextTicket()) {
    const old = registry.patches.value.get(id); if (!old || old.ticket > ticket) return;
    const copy = new Map(registry.patches.value); copy.set(id, { ticket, patch: { ...old.patch, ...patch } }); registry.patches.value = copy;
  }
  const stopPatch = watch(registry.patches, map => { if (visible && !disposed) for (const [id, item] of map) options.update?.(id, item.patch); }, { flush: 'sync' });
  const stopOwner = watch(() => actor(auth), owner => {
    generation++; shareGeneration++; sharePost.value = null; shareLoading.value = false; shareReady.value = false; reconciling.value = 0;
    notices.value = {}; errors.value = {};
    if (registry.owner !== owner) { registry.owner = owner; registry.fences.value = new Map(); registry.patches.value = new Map(); }
  }, { flush: 'sync' });
  function login() { if (auth.isLoggedIn || communityPreviewMode) return true; uni.navigateTo({ url: '/pages/auth/login' }); return false; }
  function reserve(post: CommunityPost, kind: Fence['kind'], phase: Fence['phase']) {
    try { checkedCommunityPost(post, post.id); } catch (reason) { tell(post.id, text(reason), true); return null; }
    if (disposed || !visible || kind === 'like' && !login() || !publicPost(post) || busy.value || unknown(post.id) || reconciling.value) return null;
    if (registry.fences.value.size >= 64) { tell(post.id, '尚有操作结果需要核对，请先刷新对应帖子', true); return null; }
    const op = { id: post.id, owner: actor(auth), generation, shareGeneration, value: { nonce: nextTicket(), kind, phase } as Fence };
    fence(post.id, op.value); tell(post.id, ''); tell(post.id, '', true); return op;
  }
  type Operation = NonNullable<ReturnType<typeof reserve>>;
  const owns = (op: Operation) => actor(auth) === op.owner && registry.owner === op.owner && registry.fences.value.get(op.id)?.nonce === op.value.nonce;
  const current = (op: Operation) => owns(op) && !disposed && visible && generation === op.generation
    && (op.value.kind !== 'share' || shareGeneration === op.shareGeneration);
  function settle(op: Operation, reason?: unknown) {
    if (!owns(op)) return;
    const active = current(op);
    if (reason === undefined && active || reason !== undefined && certain(reason)) fence(op.id);
    else fence(op.id, { ...op.value, phase: 'unknown' });
    if (active && reason !== undefined) tell(op.id, text(reason), true);
  }
  async function toggleLike(raw: CommunityPost) {
    const post = view(raw); const op = reserve(post, 'like', 'server'); if (!op) return;
    const desired: 0 | 1 = post.isLike === 1 ? 0 : 1;
    try {
      // Seed only once before awaiting; a fixed receipt never updates a subsequently selected post.
      if (!registry.patches.value.has(post.id)) adopt([post], nextTicket());
      const value = await apiCommunityLike(post.id, desired);
      if (!value || value.status !== desired || !boundedCount(value.likeNum)) throw Error('点赞回执无效，请刷新核对');
      if (current(op)) {
        publish(post.id, { isLike: desired, likeNum: value.likeNum });
        tell(post.id, desired ? '已点赞' : '已取消点赞'); options.liked?.(post.id, desired);
      }
      settle(op);
    } catch (reason) { settle(op, reason); }
  }
  async function reconcile(id: number) {
    if (disposed || !visible || busy.value || reconciling.value) return;
    const owner = actor(auth), revision = generation, prior = registry.fences.value.get(id), ticket = nextTicket();
    reconciling.value = id; tell(id, '', true);
    try {
      const post = await apiCommunityState(id);
      if (disposed || !visible || owner !== actor(auth) || revision !== generation) return;
      adopt([post], ticket);
      if (registry.fences.value.get(id)?.nonce === prior?.nonce) fence(id);
      tell(id, '已刷新互动状态，请核对结果；再次分享将记录新的分享操作');
      options.liked?.(id, post.isLike as 0 | 1);
      if (sharePost.value?.id === id) { sharePost.value = post; shareReady.value = publicPost(post); }
      return post;
    } catch (reason) { if (!disposed && visible && owner === actor(auth) && revision === generation) tell(id, text(reason), true); }
    finally { if (owner === actor(auth) && revision === generation) reconciling.value = 0; }
  }
  async function openShare(raw: CommunityPost) {
    if (disposed || !visible) return;
    const post = view(raw); if (!publicPost(post)) return;
    closeShare(); const revision = shareGeneration, owner = actor(auth), epoch = generation, ticket = nextTicket();
    sharePost.value = post; shareLoading.value = true;
    try { const fresh = await apiCommunityState(post.id);
      if (disposed || !visible || epoch !== generation || owner !== actor(auth) || revision !== shareGeneration) return;
      sharePost.value = adopt([fresh], ticket)[0];
      shareReady.value = publicPost(fresh);
      if (!shareReady.value) tell(post.id, '当前帖子仅供本人预览，不能分享', true);
    } catch (reason) { if (owner === actor(auth) && revision === shareGeneration) tell(post.id, text(reason), true); }
    finally { if (owner === actor(auth) && revision === shareGeneration) shareLoading.value = false; }
  }
  function closeShare() {
    shareGeneration++; sharePost.value = null; shareLoading.value = false; shareReady.value = false;
    for (const [id, op] of registry.fences.value) if (op.kind === 'share' && op.phase === 'local') fence(id);
  }
  const materials = (post: CommunityPost) => ({ title: post.title || '社区分享',
    path: communitySharePath(post.id, post.contentType, auth.isLoggedIn ? auth.uid : 0),
    imageUrl: communityVideoSource(post.image), query: communityTimelineQuery(post.id, post.contentType, auth.isLoggedIn ? auth.uid : 0) });
  async function recordShare(op: Operation, success: string) {
    if (!current(op) || registry.fences.value.get(op.id)?.phase === 'unknown' || sentShares.has(op.value.nonce)) return;
    if (!auth.isLoggedIn && !communityPreviewMode) {
      tell(op.id, success.replace('，分享意图已记录', '；未登录，不记录分享次数')); fence(op.id); return;
    }
    sentShares.add(op.value.nonce);
    op.value = { ...op.value, phase: 'server' }; fence(op.id, op.value);
    try {
      const result = await apiCommunityTrackShare(op.id);
      if (!result || !boundedCount(result.shareNum)) throw Error('分享回执无效，请刷新核对');
      if (current(op)) { publish(op.id, { shareNum: result.shareNum }); tell(op.id, success); }
      settle(op);
    } catch (reason) { settle(op, reason); }
    finally { sentShares.delete(op.value.nonce); }
  }
  async function copyShare() {
    const post = sharePost.value; if (!post || shareLoading.value || !shareReady.value) return;
    const op = reserve(view(post), 'share', 'local'); if (!op) return;
    const url = communityShareUrl(materials(post).path, post.site_url ?? '');
    if (!url || typeof uni.setClipboardData !== 'function') { fence(post.id); tell(post.id, '当前平台没有可复制的帖子网页链接', true); return; }
    await new Promise<void>(resolve => {
      let terminal = false;
      uni.setClipboardData({ data: url,
        success: () => { if (terminal) return; terminal = true;
          if (current(op)) void recordShare(op, '帖子链接已复制，分享意图已记录').finally(resolve); else resolve(); },
        fail: () => { if (terminal) return; terminal = true;
          if (owns(op)) fence(post.id); if (!disposed && visible && actor(auth) === op.owner) tell(post.id, '链接复制失败，请重试', true); resolve(); },
      });
    });
  }
  async function appShare(scene: 'WXSceneSession' | 'WXSceneTimeline') {
    const post = sharePost.value; if (!post || shareLoading.value || !shareReady.value) return;
    const op = reserve(view(post), 'share', 'local'); if (!op) return;
    const data = materials(post), url = communityShareUrl(data.path, post.site_url ?? '');
    const fail = (message: string) => { if (owns(op)) fence(post.id); if (!disposed && visible && actor(auth) === op.owner) tell(post.id, message, true); };
    if (!url || typeof uni.getProvider !== 'function' || typeof uni.share !== 'function') { fail('当前平台没有可用的微信应用分享网页或服务'); return; }
    await new Promise<void>(resolve => {
      let providerTerminal = false, shareTerminal = false;
      uni.getProvider({ service: 'share',
      success: providers => {
        if (providerTerminal) return; providerTerminal = true;
        if (!current(op)) { resolve(); return; }
        if (!Array.isArray(providers.provider) || !providers.provider.some(provider => provider === 'weixin')) { fail('当前设备没有可用的微信分享服务'); resolve(); return; }
        uni.share({ provider: 'weixin', scene, type: 0, href: url, title: data.title, imageUrl: data.imageUrl,
          summary: post.content.slice(0, 200),
          success: () => { if (shareTerminal) return; shareTerminal = true;
            if (current(op)) void recordShare(op, '微信分享服务已返回成功，分享意图已记录').finally(resolve); else resolve(); },
          fail: () => { if (shareTerminal) return; shareTerminal = true; fail('微信分享失败或已取消'); resolve(); },
        });
      }, fail: () => { if (providerTerminal) return; providerTerminal = true; fail('读取分享服务失败，请重试'); resolve(); },
      });
    });
  }
  function miniPost(event?: { from?: string; target?: { dataset?: Record<string, unknown> } }) {
    if (event?.from === 'button') {
      const raw = event.target?.dataset?.postId;
      const id = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[1-9]\d{0,9}$/u.test(raw) ? Number(raw) : 0;
      if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) return null;
      return sharePost.value?.id === id ? sharePost.value : options.find?.(id) ?? null;
    }
    return sharePost.value ?? options.find?.() ?? null;
  }
  function miniMessage(event?: { from?: string; target?: { dataset?: Record<string, unknown> } }) {
    const post = miniPost(event); if (!post || shareLoading.value) return {};
    const op = reserve(view(post), 'share', 'server'); if (!op) return {};
    if (!registry.patches.value.has(post.id)) adopt([post], nextTicket());
    const data = materials(post); void recordShare(op, '小程序分享材料已提供，分享意图已记录');
    return { title: data.title, path: data.path, imageUrl: data.imageUrl };
  }
  function miniTimeline() {
    const post = miniPost(); if (!post || shareLoading.value) return {};
    const op = reserve(view(post), 'share', 'server'); if (!op) return {};
    if (!registry.patches.value.has(post.id)) adopt([post], nextTicket());
    const data = materials(post); void recordShare(op, '朋友圈分享材料已提供，分享意图已记录');
    return { title: data.title, query: data.query, imageUrl: data.imageUrl };
  }
  function hide() {
    visible = false; generation++; closeShare(); reconciling.value = 0; notices.value = {}; errors.value = {};
  }
  function dispose() { if (disposed) return; hide(); disposed = true; stopOwner(); stopPatch(); }
  onHide(hide); onShow(() => { if (!disposed) visible = true; }); onUnload(dispose); onScopeDispose(dispose);
  return { busy, unknown, notices, errors, reconciling, view, nextTicket, adopt, toggleLike, reconcile,
    sharePost, shareLoading, shareReady, openShare, closeShare, copyShare, appShare, miniMessage, miniTimeline, dispose };
}
