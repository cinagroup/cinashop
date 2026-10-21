import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { onHide, onShow, onUnload } from '@dcloudio/uni-app';
import { apiCommunityVisit, apiCommunityState, communityPreviewMode, type CommunityPost } from '@/api/community';
import { useAuthStore } from '@/stores/auth';
import { useCommunityAvailability, isCommunityRejected } from '@/utils/communityAvailability';
import type { useCommunityEngagement } from '@/composables/useCommunityEngagement';

type Visit = { nonce: number; inflight: boolean };
const visits = new WeakMap<object, { owner: string; sequence: number; rows: Map<number, Visit> }>();
/** Only explicit activation records an exposure. Failed/hidden visits must be read back before another intent. */
export function useCommunityFeatured(posts: Ref<CommunityPost[]>, enabled: () => boolean,
  engagement: ReturnType<typeof useCommunityEngagement>, more: () => Promise<void>) {
  const auth = useAuthStore(), availability = useCommunityAvailability();
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  let shared = visits.get(auth);
  if (!shared) { shared = { owner: owner(), sequence: 0, rows: new Map() }; visits.set(auth, shared); }
  const registry = shared;
  if (registry.owner !== owner()) { registry.owner = owner(); registry.rows.clear(); }
  const active = ref<CommunityPost | null>(null), requestedId = ref(0), loading = ref(false), error = ref(''), commentsOpen = ref(false);
  let generation = 0, visible = true, disposed = false;
  const index = computed(() => posts.value.findIndex(row => row.id === requestedId.value));
  const detached = computed(() => Boolean(active.value && index.value < 0));
  const items = computed(() => detached.value && active.value ? [active.value] : posts.value);
  const ready = () => !disposed && visible && enabled() && availability.allowed.value;
  const current = (revision: number, actor: string) => ready() && revision === generation && actor === owner();
  function invalidate(clearSelection = false) {
    generation++; active.value = null; loading.value = false; error.value = ''; commentsOpen.value = false;
    if (clearSelection) requestedId.value = 0;
  }
  function accept(post: CommunityPost, ticket: number) {
    if (post.status !== 1 || post.is_verify !== 1 && !communityPreviewMode) throw Error('这条精选内容已不可公开查看');
    active.value = engagement.adopt([post], ticket)[0];
  }
  async function refreshState() {
    const id = requestedId.value;
    if (!ready() || !id || registry.rows.get(id)?.inflight) return;
    const revision = ++generation, actor = owner(), ticket = engagement.nextTicket(); loading.value = true; error.value = '';
    try {
      const post = await apiCommunityState(id);
      if (!current(revision, actor)) return;
      accept(post, ticket); registry.rows.delete(id);
    } catch (reason) { if (current(revision, actor)) error.value = reason instanceof Error ? reason.message : '精选状态加载失败'; }
    finally { if (current(revision, actor)) loading.value = false; }
  }
  async function activate(next: number) {
    if (!ready() || !Number.isSafeInteger(next) || next < 0 || next >= posts.value.length) return;
    const id = posts.value[next].id;
    if (requestedId.value === id && (active.value || loading.value || error.value)) return;
    invalidate(); requestedId.value = id;
    if (registry.rows.has(id)) { await refreshState(); return; }
    if (registry.rows.size >= 64) { error.value = '尚有访问结果需要核对，请先核对状态'; return; }
    const actor = owner(), revision = generation, nonce = ++registry.sequence, ticket = engagement.nextTicket();
    registry.rows.set(id, { nonce, inflight: true }); loading.value = true;
    try {
      const post = await apiCommunityVisit(id);
      if (registry.owner !== actor || actor !== owner() || registry.rows.get(id)?.nonce !== nonce) return;
      if (!current(revision, actor)) { registry.rows.set(id, { nonce, inflight: false }); return; }
      accept(post, ticket); registry.rows.delete(id);
      // Paging is a read, and appending it never reactivates the previous post.
      if (next === posts.value.length - 1) await more();
    } catch (reason) {
      if (registry.owner !== actor || actor !== owner() || registry.rows.get(id)?.nonce !== nonce) return;
      if (isCommunityRejected(reason)) registry.rows.delete(id); else registry.rows.set(id, { nonce, inflight: false });
      if (current(revision, actor)) error.value = '精选访问结果未确认，请核对状态；不会自动重复访问。' + (reason instanceof Error ? reason.message : '');
    } finally { if (current(revision, actor)) loading.value = false; }
  }
  async function step(direction: -1 | 1) {
    if (!ready() || loading.value) return;
    const next = index.value + direction;
    if (next >= posts.value.length) {
      const revision = generation, actor = owner(), selected = requestedId.value;
      loading.value = true;
      try { await more(); } finally { if (current(revision, actor)) loading.value = false; }
      if (!current(revision, actor) || requestedId.value !== selected || next >= posts.value.length) return;
    }
    await activate(next);
  }
  function openComments() { if (ready() && active.value && !loading.value && !error.value) commentsOpen.value = true; }
  function updateCount(value: { postId: number; count: number }) {
    if (active.value?.id === value.postId) active.value.commentNum = value.count;
    for (const post of posts.value) if (post.id === value.postId) post.commentNum = value.count;
  }
  watch(availability.closed, closed => { if (closed) invalidate(); }, { flush: 'sync' });
  watch(owner, () => { registry.owner = owner(); registry.rows.clear(); invalidate(true); }, { flush: 'sync' });
  function hide() { visible = false; invalidate(); }
  onHide(hide); onShow(() => { if (!disposed) visible = true; });
  function dispose() { if (disposed) return; hide(); disposed = true; }
  onUnload(dispose); onScopeDispose(dispose);
  return { active, requestedId, index, detached, items, loading, error, commentsOpen, activate, step, refreshState, invalidate, openComments, updateCount };
}
