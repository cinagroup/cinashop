import { computed, ref, watch } from "vue";
import { onHide, onShow, onUnload } from "@dcloudio/uni-app";
import { useAuthStore } from "@/stores/auth";
import { RequestError } from "@/utils/request";
import { parseCommunityPeopleTab, type CommunityPeopleTab } from "../../../common/communityRoute";
import { apiCommunityFollowList, apiCommunityFriendList, apiCommunityRecommendations,
  apiCommunitySetInterest, type CommunitySocialUser } from "@/api/community";

const PAGE_SIZE = 20, LAST_PAGE = 1_000_000;
export const communityPeopleTabs: ReadonlyArray<{ key: CommunityPeopleTab; label: string }> = [
  { key: "friend", label: "好友" }, { key: "follow", label: "关注" },
  { key: "fans", label: "粉丝" }, { key: "recommend", label: "推荐" },
];

export function useCommunityPeople() {
  const auth = useAuthStore(), activeTab = ref<CommunityPeopleTab>("friend");
  const users = ref<CommunitySocialUser[]>([]), page = ref(0), loading = ref(false), finished = ref(false);
  const error = ref(""), message = ref(""), unknown = ref(false), confirmUid = ref<number | null>(null);
  const pending = ref<{ id: number; owner: string; nonce: number } | null>(null);
  let generation = 0, writeNonce = 0, visible = true, disposed = false, initialized = false, routeValid = true;
  let confirmation: { id: number; type: number; owner: string; generation: number; until: number } | undefined;
  const identity = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const busyUid = computed(() => pending.value?.owner === identity() ? pending.value.id : null);
  const busy = computed(() => busyUid.value !== null);
  const isLoggedIn = computed(() => auth.isLoggedIn && Number.isSafeInteger(auth.uid) && auth.uid > 0);
  const emptyText = computed(() => ({ friend: "还没有好友", follow: "还没有关注任何人",
    fans: "还没有粉丝", recommend: "暂时没有推荐作者" })[activeTab.value]);
  const current = (revision: number, owner: string) => !disposed && visible && revision === generation && owner === identity();
  function cancelUnfollow() { confirmation = undefined; confirmUid.value = null; }
  function clearView() {
    generation++; users.value = []; page.value = 0; loading.value = false; finished.value = false; cancelUnfollow();
  }
  // Profile and interest APIs address platform 0 or a real user UID only.
  // A virtual/platform record with the same numeric ID is a different author.
  function addressableAuthor(row: CommunitySocialUser) {
    return Number.isSafeInteger(row.relation_id) && row.relation_id >= 0 && row.relation_id <= 2147483647
      && (row.type === 0 && row.relation_id === 0 || row.type === 2 && row.relation_id > 0);
  }
  function validateRows(value: CommunitySocialUser[]) {
    if (!Array.isArray(value) || value.length > PAGE_SIZE || value.some(row => !row
      || !Number.isSafeInteger(row.relation_id) || row.relation_id < 0 || row.relation_id > 2147483647
      || ![0, 1, 2, 3].includes(row.type) || row.type === 2 && row.relation_id === 0
      || typeof row.author !== "string" || typeof row.author_image !== "string"
      || !Number.isSafeInteger(row.community_num) || row.community_num < 0
      || !Number.isSafeInteger(row.fans_num) || row.fans_num < 0
      || ![0, 1].includes(row.is_follow) || ![0, 1].includes(row.is_fans))) throw Error("作者列表格式错误，请重试");
    if (value.some(row => !addressableAuthor(row))) throw Error("列表包含暂不支持的作者身份，请刷新列表");
    return value;
  }
  function read(next: number, tab: CommunityPeopleTab) {
    if (tab === "friend") return apiCommunityFriendList(next, PAGE_SIZE);
    if (tab === "recommend") return apiCommunityRecommendations(next, PAGE_SIZE);
    return apiCommunityFollowList(tab, next, PAGE_SIZE);
  }
  async function readPage(next: number) {
    if (!visible || disposed || !routeValid || loading.value || busy.value) return;
    if (!isLoggedIn.value) { error.value = "请先登录后查看好友与关注"; return; }
    const revision = generation, owner = identity(), requestedTab = activeTab.value;
    loading.value = true; error.value = "";
    try {
      const rows = validateRows(await read(next, requestedTab));
      if (!current(revision, owner)) return;
      // validateRows rejects every noncanonical type before any page is committed.
      // Within this ID-only API contract each numeric ID has exactly one type.
      const ids = new Set(users.value.map(row => row.relation_id));
      for (const row of rows) if (!ids.has(row.relation_id)) { users.value.push(row); ids.add(row.relation_id); }
      page.value = next; finished.value = rows.length < PAGE_SIZE || next >= LAST_PAGE;
      if (unknown.value) message.value = "已刷新，请核对关注状态。";
      unknown.value = false;
    } catch (cause) {
      if (current(revision, owner)) error.value = cause instanceof Error ? cause.message : "作者列表加载失败，请重试";
    } finally { if (current(revision, owner)) loading.value = false; }
  }
  async function refresh() {
    if (!visible || disposed || !routeValid || busy.value) return;
    clearView(); await readPage(1);
  }
  async function loadMore() {
    if (!initialized || unknown.value || loading.value || busy.value || finished.value || page.value >= LAST_PAGE) return;
    await readPage(page.value + 1);
  }
  async function retry() { if (unknown.value) await refresh(); else await loadMore(); }
  async function initialize(query: Readonly<Record<string, unknown>> = {}) {
    clearView(); initialized = true; message.value = ""; error.value = "";
    const tab = parseCommunityPeopleTab(query); routeValid = tab !== null;
    if (!tab) { error.value = "好友与关注链接无效"; return; }
    activeTab.value = tab;
    // Re-entering a route never releases an unresolved write for this session.
    if (unknown.value || busy.value) return;
    await readPage(1);
  }
  async function changeTab(tab: CommunityPeopleTab) {
    if (!communityPeopleTabs.some(item => item.key === tab) || tab === activeTab.value || busy.value || unknown.value) return;
    activeTab.value = tab; routeValid = true; message.value = ""; await refresh();
  }
  const isSelf = (person: CommunitySocialUser) => person.type === 2 && person.relation_id === auth.uid;
  function currentPerson(person: CommunitySocialUser) {
    if (!addressableAuthor(person)) return;
    return users.value.find(row => addressableAuthor(row)
      && row.relation_id === person.relation_id && row.type === person.type);
  }
  function followLabel(person: CommunitySocialUser) {
    if (isSelf(person)) return "你自己";
    return person.is_follow === 1 ? person.is_fans === 1 ? "互相关注" : "已关注"
      : person.is_fans === 1 ? "回关" : "关注";
  }
  function canWrite() { return visible && !disposed && isLoggedIn.value && !loading.value && !busy.value && !unknown.value; }
  async function write(person: CommunitySocialUser, desired: 0 | 1) {
    const row = currentPerson(person);
    if (!canWrite() || !row || isSelf(row) || row.is_follow === desired) return;
    cancelUnfollow(); error.value = ""; message.value = "";
    const revision = generation, owner = identity(), nonce = ++writeNonce;
    pending.value = { id: row.relation_id, owner, nonce };
    try {
      const result = await apiCommunitySetInterest(row.relation_id, desired);
      if (owner !== identity() || disposed) return;
      if (!current(revision, owner)) { unknown.value = true; return; }
      if (!result || result.status !== desired || result.is_follow !== desired || ![0, 1].includes(result.is_fans)) {
        throw Error("关注结果格式错误");
      }
      pending.value = null;
      message.value = desired === 1 ? "关注成功" : "已取消关注";
      // Both follow and recommend membership can change. Restart offset paging
      // from canonical server data rather than skipping a shifted record.
      await refresh();
    } catch (cause) {
      if (owner !== identity() || disposed) return;
      const rejected = cause instanceof RequestError && cause.status !== undefined && cause.status >= 400
        && cause.status < 500 && (cause.httpStatus === undefined || cause.httpStatus < 500);
      if (!current(revision, owner) || !rejected) {
        unknown.value = true; clearView();
        error.value = "";
      } else error.value = cause.message;
    } finally {
      if (pending.value?.nonce === nonce) pending.value = null;
    }
  }
  async function toggleFollow(person: CommunitySocialUser) {
    const row = currentPerson(person);
    if (!canWrite() || !row || isSelf(row)) return;
    if (row.is_follow === 0) { await write(row, 1); return; }
    confirmation = { id: row.relation_id, type: row.type, owner: identity(), generation, until: Date.now() + 60000 };
    confirmUid.value = row.relation_id;
  }
  async function confirmUnfollow() {
    const intent = confirmation, row = users.value.find(person => person.relation_id === intent?.id && person.type === intent?.type);
    if (!canWrite() || !intent || intent.owner !== identity() || intent.generation !== generation || intent.until < Date.now()
      || !row || row.is_follow !== 1 || isSelf(row)) { cancelUnfollow(); return; }
    await write(row, 0);
  }
  function openAuthor(person: CommunitySocialUser) {
    const row = currentPerson(person);
    if (visible && !disposed && row && !busy.value) uni.navigateTo({ url: `/pages/discover/workspace?author_id=${row.relation_id}` });
  }
  function openSelf() {
    if (!visible || disposed) return;
    uni.navigateTo({ url: isLoggedIn.value ? `/pages/discover/workspace?author_id=${auth.uid}` : "/pages/auth/login" });
  }
  function leave() {
    visible = false; if (busy.value) unknown.value = true;
    clearView(); message.value = ""; error.value = "";
  }
  onHide(leave); onUnload(() => { leave(); disposed = true; });
  onShow(() => {
    if (disposed) return;
    const returning = !visible; visible = true;
    if (returning && initialized && !unknown.value && !busy.value) void refresh();
  });
  watch(identity, () => {
    clearView(); unknown.value = false; message.value = "";
    error.value = "登录状态已变化，请刷新列表";
  }, { flush: "sync" });
  return { tabs: communityPeopleTabs, activeTab, users, page, loading, finished, error, message, unknown, confirmUid,
    busyUid, busy, isLoggedIn, emptyText, initialize, refresh, loadMore, retry, changeTab, isSelf, followLabel,
    toggleFollow, confirmUnfollow, cancelUnfollow, openAuthor, openSelf };
}
