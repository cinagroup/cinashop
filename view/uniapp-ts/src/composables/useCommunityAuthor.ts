import { useCommunityAvailability, isCommunityRejected } from '@/utils/communityAvailability';
import { computed, ref, watch } from "vue";
import { onHide, onShow, onUnload } from "@dcloudio/uni-app";
import { useAuthStore } from "@/stores/auth";
import { apiCommunityProfile, apiCommunityList, apiCommunityLikedPosts, apiCommunityDelete,
  apiCommunityUpdateDescription, apiCommunitySetInterest, type CommunityPost, type CommunityProfile } from "@/api/community";
import type { useCommunityEngagement } from '@/composables/useCommunityEngagement';

export function useCommunityAuthor(engagement?: ReturnType<typeof useCommunityEngagement>) {
  const availability = useCommunityAvailability();
  const auth = useAuthStore(), authorId = ref<number | null>(null), profile = ref<CommunityProfile | null>(null);
  const posts = ref<CommunityPost[]>([]), tab = ref<"works" | "liked">("works"), keyword = ref("");
  const description = ref(""), editingDescription = ref(false), loading = ref(false), busy = ref(false);
  const error = ref(""), unknown = ref(false), hasMore = ref(false), deleteId = ref(0), unfollow = ref(false);
  let generation = 0, page = 0, term = "", visible = true, disposed = false, selfRoute = false;
  let deletion: { id: number; owner: string; until: number } | undefined;
  const identity = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const isSelf = computed(() => profile.value?.type === 2 && profile.value.is_self === 1 && authorId.value === auth.uid);
  const current = (revision: number, owner: string) => visible && !disposed && !availability.closed.value && revision === generation && owner === identity();
  const owns = (post: CommunityPost) => isSelf.value && post.type === 2 && post.relationId === auth.uid && post.is_self === 1;
  function cancelDelete() { deletion = undefined; deleteId.value = 0; }
  function clear() {
    generation++; profile.value = null; posts.value = []; loading.value = false; hasMore.value = false;
    editingDescription.value = false; description.value = ""; unfollow.value = false; cancelDelete();
  }
  function validateRows(rows: CommunityPost[]) {
    if (!Array.isArray(rows) || rows.length > 10 || rows.some(row => !row || !Number.isSafeInteger(row.id)
      || row.id <= 0 || typeof row.title !== "string" || typeof row.content !== "string")) throw Error("作品列表格式错误");
    return rows;
  }
  async function readPage(next: number, person: CommunityProfile) {
    return validateRows(tab.value === "liked"
      ? await apiCommunityLikedPosts(next, term)
      : await apiCommunityList(next, 10, { relation_id: person.relation_id, author_type: person.type, keyword: term, order: 1 }));
  }
  async function refresh() {
    if (!availability.allowed.value || !visible || disposed || busy.value || authorId.value === null) return;
    if (selfRoute && auth.isLoggedIn) authorId.value = auth.uid;
    clear(); error.value = ""; term = keyword.value.trim().slice(0, 100); page = 0;
    if (!auth.isLoggedIn) { error.value = "请先登录后查看作者主页"; return; }
    const revision = generation, owner = identity(), id = authorId.value, ticket = engagement?.nextTicket();
    loading.value = true;
    try {
      const person = await apiCommunityProfile(id);
      if (!current(revision, owner)) return;
      if (!person || person.relation_id !== id || ![0,1,2].includes(person.type) || typeof person.desc !== "string"
        || typeof person.author !== "string" || ![0,1].includes(person.is_self)) throw Error("作者资料格式错误");
      if (!(person.type === 2 && person.is_self === 1 && id === auth.uid)) tab.value = "works";
      const rows = await readPage(1, person);
      if (!current(revision, owner)) return;
      profile.value = person; posts.value = engagement ? engagement.adopt(rows, ticket!) : rows;
      page = 1; hasMore.value = rows.length === 10; unknown.value = false;
    } catch (cause) { if (current(revision, owner)) error.value = cause instanceof Error ? cause.message : "作者主页加载失败"; }
    finally { if (revision === generation) loading.value = false; }
  }
  async function initialize(id: unknown) {
    clear(); tab.value = "works"; keyword.value = ""; error.value = ""; authorId.value = null;
    selfRoute = id === "self"; if (selfRoute) id = auth.uid;
    if (!Number.isSafeInteger(id) || Number(id) < 0) { error.value = "作者链接无效"; return; }
    authorId.value = Number(id); await refresh();
  }
  async function loadMore() {
    if (!availability.allowed.value || !visible || disposed || loading.value || busy.value || !hasMore.value || !profile.value || page >= 2147483647) return;
    const revision = generation, owner = identity(), person = profile.value, next = page + 1, ticket = engagement?.nextTicket();
    loading.value = true; error.value = "";
    try {
      const raw = await readPage(next, person); if (!current(revision, owner)) return;
      const rows = engagement ? engagement.adopt(raw, ticket!) : raw;
      const ids = new Set(posts.value.map(row => row.id));
      for (const row of rows) if (!ids.has(row.id)) { posts.value.push(row); ids.add(row.id); }
      page = next; hasMore.value = rows.length === 10 && next < 2147483647;
    } catch (cause) { if (current(revision, owner)) error.value = cause instanceof Error ? cause.message : "加载失败"; }
    finally { if (revision === generation) loading.value = false; }
  }
  async function changeTab(next: "works" | "liked") {
    if (busy.value || !isSelf.value || !["works","liked"].includes(next)) return;
    tab.value = next; await refresh();
  }
  async function mutate(work: () => Promise<unknown>) {
    if (!availability.allowed.value || busy.value || loading.value || unknown.value || !visible || disposed || !auth.isLoggedIn) return;
    const revision = generation, owner = identity(); busy.value = true; error.value = "";
    try {
      await work(); if (!current(revision, owner)) return;
      busy.value = false; await refresh();
    } catch (cause) {
      if (owner === identity() && !disposed) {
        const rejected = isCommunityRejected(cause);
        unknown.value = !rejected;
        if (unknown.value) clear();
        error.value = rejected ? (cause as Error).message : "操作结果未确认，请刷新主页核实，勿重复提交。";
      }
    } finally { busy.value = false; }
  }
  function beginDescription() {
    if (isSelf.value && !busy.value && !unknown.value) { description.value = profile.value!.desc; editingDescription.value = true; }
  }
  async function saveDescription() {
    if (!isSelf.value || !editingDescription.value) return;
    const value = description.value.trim();
    if ([...value].length > 50) { error.value = "简介最多50个字符"; return; }
    await mutate(() => apiCommunityUpdateDescription(value));
  }
  async function toggleFollow() {
    if (!profile.value || isSelf.value || busy.value || unknown.value) return;
    if (profile.value.is_follow === 1 && !unfollow.value) { unfollow.value = true; return; }
    const id = profile.value.relation_id, desired = profile.value.is_follow === 1 ? 0 : 1;
    await mutate(() => apiCommunitySetInterest(id, desired));
  }
  function requestDelete(post: CommunityPost) {
    if (!owns(post) || busy.value || loading.value || unknown.value || !posts.value.some(row => row.id === post.id)) return;
    deletion = { id: post.id, owner: identity(), until: Date.now() + 60000 }; deleteId.value = post.id;
  }
  async function confirmDelete() {
    const intent = deletion, post = posts.value.find(row => row.id === intent?.id);
    if (!intent || intent.until < Date.now() || intent.owner !== identity() || !post || !owns(post)) { cancelDelete(); return; }
    cancelDelete(); await mutate(() => apiCommunityDelete(intent.id));
  }
  watch(availability.closed, closed => { if (closed) { if (busy.value) unknown.value = true; clear(); error.value = availability.message.value; } }, { flush: 'sync' });
  function leave() { visible = false; if (busy.value) unknown.value = true; clear(); }
  onHide(leave); onUnload(() => { leave(); disposed = true; }); onShow(() => { if (!disposed) visible = true; });
  watch(identity, () => { clear(); tab.value = "works"; unknown.value = false; error.value = "登录状态已变化，请刷新主页"; }, { flush: "sync" });
  return { availability, authorId, profile, posts, tab, keyword, description, editingDescription, loading, busy, error, unknown, hasMore,
    isSelf, deleteId, unfollow, initialize, refresh, loadMore, changeTab, owns, beginDescription, saveDescription,
    toggleFollow, requestDelete, confirmDelete, cancelDelete };
}
