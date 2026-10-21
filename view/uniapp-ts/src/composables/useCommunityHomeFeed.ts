import { useCommunityAvailability, isCommunityRejected } from '@/utils/communityAvailability';
import { computed, onScopeDispose, ref, shallowRef, watch, type ShallowRef } from 'vue';
import { onHide, onShow, onUnload } from '@dcloudio/uni-app';
import { apiCommunityFollowHighlights, apiCommunityList, apiCommunityTopics, apiCommunityRecommendations,
  apiCommunitySetInterest, apiCommunityProfile, checkedCommunityPost, communityPreviewMode,
  type CommunityPost, type CommunityTopic, type CommunityRecommendation } from '@/api/community';
import { useAuthStore } from '@/stores/auth';
import { useCommunityEngagement } from '@/composables/useCommunityEngagement';

export type CommunityFeedTab = 'following' | 'discover' | 'featured';
export const communityFeedTabs = [{ key: 'following', label: '关注' }, { key: 'discover', label: '发现' }, { key: 'featured', label: '精选' }] as const;
const PAGE_SIZE = 10, LAST_PAGE = 1001;
type FollowFence = { nonce: number; id: number; inflight: boolean; unknown: boolean };
// Transient operation identity only; no post content, previews or drafts survive a page.
const followStores = new WeakMap<object, { owner: string; sequence: number; fence: ShallowRef<FollowFence | null> }>();
const message = (reason: unknown) => reason instanceof Error ? reason.message : '内容加载失败，请重试';
const canonicalAuthor = (row: { type: number; relation_id: number }) => row.type === 0 && row.relation_id === 0
  || row.type === 2 && Number.isSafeInteger(row.relation_id) && row.relation_id > 0 && row.relation_id <= 2147483647;

/** Main paging, metadata and social receipts share the same owner/view generation. */
export function useCommunityHomeFeed(engagement = useCommunityEngagement(), enabled: () => boolean = () => true) {
  const availability = useCommunityAvailability(), auth = useAuthStore();
  const tab = ref<CommunityFeedTab>('discover'), selectedTopicId = ref<number | null>(null), epoch = ref(0);
  const posts = ref<CommunityPost[]>([]), topics = ref<CommunityTopic[]>([]);
  const highlights = ref<Awaited<ReturnType<typeof apiCommunityFollowHighlights>>>([]), recommendations = ref<CommunityRecommendation[]>([]);
  const page = ref(0), finished = ref(false), capped = ref(false), loading = ref(false), error = ref('');
  const topicsLoading = ref(false), topicsError = ref(''), followingLoading = ref(false), followingError = ref('');
  const followMessage = ref('');
  let visible = true, disposed = false, generation = 0, topicRequest = 0, followingRequest = 0;
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  let shared = followStores.get(auth);
  if (!shared) { shared = { owner: owner(), sequence: 0, fence: shallowRef<FollowFence | null>(null) }; followStores.set(auth, shared); }
  const registry = shared;
  if (registry.owner !== owner()) { registry.owner = owner(); registry.fence.value = null; }
  const followBusy = computed(() => registry.owner === owner() && Boolean(registry.fence.value?.inflight));
  const followUnknown = computed(() => registry.owner === owner() && Boolean(registry.fence.value?.unknown));
  const loggedIn = computed(() => auth.isLoggedIn || communityPreviewMode);
  const ready = () => !disposed && visible && enabled() && availability.allowed.value;
  const current = (revision: number, actor: string) => ready() && revision === generation && actor === owner();
  const canMore = computed(() => ready() && !loading.value && !finished.value && page.value < LAST_PAGE);
  function clear() {
    generation++; epoch.value++; topicRequest++; followingRequest++;
    posts.value = []; topics.value = []; highlights.value = []; recommendations.value = [];
    page.value = 0; finished.value = false; capped.value = false;
    loading.value = false; topicsLoading.value = false; followingLoading.value = false;
    error.value = ''; topicsError.value = ''; followingError.value = ''; followMessage.value = '';
  }
  async function loadMore() {
    if (!ready() || !canMore.value) return;
    if (tab.value === 'following' && !loggedIn.value) { finished.value = true; return; }
    const actor = owner(), revision = generation, next = page.value + 1, requestedTab = tab.value;
    const topic = selectedTopicId.value, ticket = engagement.nextTicket(); loading.value = true; error.value = '';
    try {
      const rows = await apiCommunityList(next, PAGE_SIZE, { is_follow: requestedTab === 'following' ? 1 : 0,
        ...(requestedTab === 'discover' && topic !== null ? { topic_id: topic } : {}) });
      if (!current(revision, actor)) return;
      if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw Error('帖子列表格式错误');
      rows.forEach(row => checkedCommunityPost(row, row.id));
      const adopted = engagement.adopt(rows, ticket), ids = new Set(posts.value.map(row => row.id));
      for (const row of adopted) if (!ids.has(row.id)) { posts.value.push(row); ids.add(row.id); }
      page.value = next; capped.value = next === LAST_PAGE && rows.length === PAGE_SIZE;
      finished.value = rows.length < PAGE_SIZE || next >= LAST_PAGE;
    } catch (reason) { if (current(revision, actor)) error.value = message(reason); }
    finally { if (current(revision, actor)) loading.value = false; }
  }
  async function loadTopics() {
    if (!ready()) return;
    const actor = owner(), revision = generation, request = ++topicRequest; topicsLoading.value = true; topicsError.value = '';
    try {
      const rows = await apiCommunityTopics();
      if (!current(revision, actor) || request !== topicRequest) return;
      if (!Array.isArray(rows) || rows.some(row => !row || !Number.isSafeInteger(row.id) || row.id <= 0
        || typeof row.name !== 'string' || ![0, 1].includes(row.isRecommend))) throw Error('话题列表格式错误');
      topics.value = rows;
    } catch (reason) { if (current(revision, actor) && request === topicRequest) topicsError.value = message(reason); }
    finally { if (current(revision, actor) && request === topicRequest) topicsLoading.value = false; }
  }
  async function loadFollowing() {
    if (!ready() || tab.value !== 'following' || !loggedIn.value) return;
    const actor = owner(), revision = generation, request = ++followingRequest;
    followingLoading.value = true; followingError.value = '';
    const results = await Promise.allSettled([apiCommunityFollowHighlights(), apiCommunityRecommendations(1, 20)]);
    if (!current(revision, actor) || request !== followingRequest) return;
    const failures: string[] = [];
    try {
      if (results[0].status === 'rejected') throw results[0].reason;
      const rows = results[0].value;
      if (!Array.isArray(rows) || rows.length > 10 || rows.some(row => !row || !Number.isSafeInteger(row.relation_id)
        || row.relation_id < 0 || typeof row.author !== 'string' || typeof row.author_image !== 'string' || row.is_new !== 0 && row.is_new !== 1)) throw Error('关注摘要格式错误');
      highlights.value = rows;
    } catch (reason) { highlights.value = []; failures.push(message(reason)); }
    try {
      if (results[1].status === 'rejected') throw results[1].reason;
      const rows = results[1].value;
      if (!Array.isArray(rows) || rows.length > 20 || rows.some(row => !row || !canonicalAuthor(row) || typeof row.author !== 'string'
        || typeof row.author_image !== 'string' || ![0, 1].includes(row.is_follow) || !Array.isArray(row.community)
        || row.community.length > 3 || row.community.some(post => !post || !Number.isSafeInteger(post.id) || post.id <= 0
          || post.type !== row.type || post.relation_id !== row.relation_id || ![1, 2].includes(post.content_type)
          || typeof post.title !== 'string' || typeof post.image !== 'string'))) throw Error('推荐作者格式错误');
      recommendations.value = rows;
    } catch (reason) { recommendations.value = []; failures.push(message(reason)); }
    followingError.value = failures.join('；'); followingLoading.value = false;
  }
  async function load() {
    if (!ready()) return;
    clear();
    await Promise.all([loadMore(), loadTopics(), loadFollowing()]);
  }
  async function refresh() { if (!ready()) return; selectedTopicId.value = null; await load(); }
  async function changeTab(next: CommunityFeedTab) {
    if (!ready() || !communityFeedTabs.some(item => item.key === next) || tab.value === next) return;
    tab.value = next; selectedTopicId.value = null; await load();
  }
  async function selectTopic(id: number | null) {
    if (!ready() || tab.value !== 'discover' || selectedTopicId.value === id || id !== null && !topics.value.some(row => row.id === id)) return;
    selectedTopicId.value = id;
    generation++; epoch.value++; topicsLoading.value = false; followingLoading.value = false; posts.value = []; page.value = 0; finished.value = false; capped.value = false; error.value = ''; loading.value = false;
    await loadMore();
  }
  async function follow(person: CommunityRecommendation) {
    const live = recommendations.value.find(row => row.type === person.type && row.relation_id === person.relation_id);
    if (!ready() || tab.value !== 'following' || !loggedIn.value || !live || !canonicalAuthor(live)
      || live.relation_id === auth.uid || live.is_follow || followBusy.value || followUnknown.value) return;
    const actor = owner(), revision = generation, nonce = ++registry.sequence;
    registry.fence.value = { nonce, id: live.relation_id, inflight: true, unknown: false }; followMessage.value = '';
    try {
      const result = await apiCommunitySetInterest(live.relation_id, 1);
      if (actor !== owner() || registry.owner !== actor || registry.fence.value?.nonce !== nonce) return;
      if (!result || result.status !== 1 || result.is_follow !== 1 || ![0, 1].includes(result.is_fans)) throw Error('关注回执无效');
      if (!current(revision, actor)) { registry.fence.value = { nonce, id: live.relation_id, inflight: false, unknown: true }; return; }
      registry.fence.value = null; const reload = load(), refreshed = generation; await reload;
      if (current(refreshed, actor) && tab.value === 'following') followMessage.value = '已关注，列表已刷新';
    } catch (reason) {
      if (actor !== owner() || registry.owner !== actor || registry.fence.value?.nonce !== nonce) return;
      if (isCommunityRejected(reason)) { registry.fence.value = null; if (current(revision, actor)) followingError.value = message(reason); }
      else registry.fence.value = { nonce, id: live.relation_id, inflight: false, unknown: true };
    }
  }
  async function reconcileFollow() {
    const prior = registry.fence.value;
    if (!ready() || !loggedIn.value || !prior?.unknown || prior.inflight) return;
    const actor = owner(), revision = generation; followingError.value = '';
    try {
      const row = await apiCommunityProfile(prior.id);
      if (!current(revision, actor) || registry.fence.value?.nonce !== prior.nonce) return;
      if (!row || !canonicalAuthor(row) || row.relation_id !== prior.id || ![0, 1].includes(row.is_follow)) throw Error('关注状态回执无效');
      registry.fence.value = null; const restoredTab = tab.value, reload = load(), refreshed = generation; await reload;
      if (current(refreshed, actor) && tab.value === restoredTab) followMessage.value = row.is_follow ? '已核对：已经关注' : '已核对：尚未关注';
    } catch (reason) { if (current(revision, actor)) followingError.value = message(reason); }
  }
  function uncertain() { const value = registry.fence.value; if (registry.owner === owner() && value) registry.fence.value = { ...value, unknown: true }; }
  watch(availability.closed, closed => { if (closed) { uncertain(); clear(); } }, { flush: 'sync' });
  const stopOwner = watch(owner, () => {
    registry.owner = owner(); registry.fence.value = null; clear(); if (ready()) void load();
  }, { flush: 'sync' });
  function hide() { uncertain(); visible = false; clear(); }
  function show() { if (!disposed) visible = true; }
  function dispose() { if (disposed) return; hide(); disposed = true; stopOwner(); }
  onHide(hide); onShow(show); onUnload(dispose); onScopeDispose(dispose);
  return { availability, tabs: communityFeedTabs, tab, selectedTopicId, epoch, posts, topics, highlights, recommendations,
    page, finished, capped, canMore, loading, error, topicsLoading, topicsError, followingLoading, followingError,
    followBusy, followUnknown, followMessage, loggedIn, load, refresh, loadMore, loadTopics, loadFollowing,
    changeTab, selectTopic, follow, reconcileFollow, show, hide, dispose };
}
