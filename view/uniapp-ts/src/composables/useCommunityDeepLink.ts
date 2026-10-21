import { computed, onScopeDispose, ref, watch } from "vue";
import {
  apiCommunityVisit,
  apiCommunityState,
  apiCommunityList,
  apiCommunityTopics,
  type CommunityListFilters,
  type CommunityPost,
  type CommunityTopic,
} from "@/api/community";
import { useAuthStore } from "@/stores/auth";
import { onHide, onShow, onUnload } from '@dcloudio/uni-app';
import type { useCommunityEngagement } from '@/composables/useCommunityEngagement';
import { communityEmbeddedVideo, communityPageQuery } from '@/utils/communityShare';

export type CommunityDeepLinkMode = "topic" | "search" | "video";
export type CommunityRouteQuery = Record<string, string | undefined>;

const PAGE_SIZE = 20;
const VIDEO_PAGE_SIZE = 10;

function positiveId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id <= 2147483647 ? id : null;
}

/** Old APP-PLUS links wrapped an H5 page in web-view. Extract state only; never load its host or token. */
export function parseLegacyAppVideoUrl(raw: string): CommunityRouteQuery | null { return communityEmbeddedVideo(raw); }

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "内容加载失败，请重试";
}

function postContentType(post: CommunityPost): number {
  return Number(post.contentType ?? (post as CommunityPost & { content_type?: number }).content_type);
}

function postRelationId(post: CommunityPost): number {
  return Number(post.relationId ?? (post as CommunityPost & { relation_id?: number }).relation_id);
}

/** Route state is authoritative; a late response from another filter or login cannot repaint it. */
export function useCommunityDeepLink(
  mode: CommunityDeepLinkMode = "topic",
  videoRoute = "/pages/discover/discoverVideo/index",
  engagement?: ReturnType<typeof useCommunityEngagement>,
) {
  const auth = useAuthStore();
  const posts = ref<CommunityPost[]>([]);
  const topics = ref<CommunityTopic[]>([]);
  const selectedTopicId = ref<number | null>(null);
  const topicName = ref("");
  const keywordInput = ref("");
  const keyword = ref("");
  const order = ref<1 | 2>(2);
  const anchorId = ref<number | null>(null);
  const relationId = ref<number | null>(null);
  const mixedVideo = ref(false);
  const loading = ref(false);
  const finished = ref(false);
  const error = ref("");
  const routeError = ref("");
  const initialized = ref(false);
  const page = ref(1), videoReady = ref(false);
  let firstVisitAttempted = false;
  let generation = 0;
  let disposed = false, visible = true;
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  let routeQuery: CommunityRouteQuery = {};

  const activeVideo = computed(() => mode === 'video' && !videoReady.value ? null : posts.value[0] ?? null);
  const pageSize = mode === "video" ? VIDEO_PAGE_SIZE : PAGE_SIZE;

  function filters(): CommunityListFilters {
    const result: CommunityListFilters = {};
    if (selectedTopicId.value) result.topic_id = selectedTopicId.value;
    if (keyword.value) result.keyword = keyword.value;
    if (mode === "topic") result.order = order.value;
    if (mode === "video") {
      if (!mixedVideo.value) result.content_type = 2;
      if (anchorId.value) result.start_id = anchorId.value;
      if (relationId.value) result.relation_id = relationId.value;
    }
    return result;
  }

  async function loadMore() {
    if (disposed || !visible || !initialized.value || routeError.value || loading.value || finished.value) return;
    const requestGeneration = generation;
    const requestedPage = page.value;
    const requestOwner = owner(), ticket = engagement?.nextTicket();
    loading.value = true;
    error.value = "";
    try {
      const rows = await apiCommunityList(requestedPage, pageSize, filters());
      if (disposed || !visible || requestGeneration !== generation || requestOwner !== owner()) return;
      if (!Array.isArray(rows)) throw new Error("内容响应格式错误");
      const currentRows = engagement ? engagement.adopt(rows, ticket!) : rows;
      const known = new Set(posts.value.map((post) => post.id));
      posts.value.push(...currentRows.filter((post) => Number.isSafeInteger(post.id) && post.id > 0 && !known.has(post.id)));
      finished.value = rows.length < pageSize || requestedPage >= 2147483647;
      if (!finished.value) page.value = requestedPage + 1;
      if (mode === 'video' && !anchorId.value && posts.value[0] && !firstVisitAttempted) {
        firstVisitAttempted = true;
        const id = posts.value[0].id, visitTicket = engagement?.nextTicket(), visited = await apiCommunityVisit(id);
        if (disposed || !visible || requestGeneration !== generation || requestOwner !== owner()) return;
        if ((!mixedVideo.value && postContentType(visited) !== 2) || (relationId.value && postRelationId(visited) !== relationId.value)) throw Error('视频已变化，请重新打开');
        posts.value[0] = engagement ? engagement.adopt([visited], visitTicket!)[0] : visited;
        videoReady.value = true;
      }
    } catch (cause) {
      if (!disposed && visible && requestGeneration === generation && requestOwner === owner()) {
        if (mode === 'video' && firstVisitAttempted && !videoReady.value) routeError.value = '视频访问结果未确认，请重新打开；不会自动重试访问';
        else error.value = message(cause);
      }
    } finally {
      if (!disposed && visible && requestGeneration === generation && requestOwner === owner()) loading.value = false;
    }
  }

  async function initialize(query: CommunityRouteQuery = {}) {
    if (disposed || !visible) return;
    try { query = communityPageQuery(query); }
    catch (reason) { generation++; posts.value = []; routeError.value = message(reason); initialized.value = false; loading.value = false; return; }
    routeQuery = { ...query };
    const requestOwner = owner();
    const embedded = mode === "video" && query.url ? parseLegacyAppVideoUrl(query.url) : null;
    const effectiveQuery = mode === "video" && query.url
      ? embedded && {
        id: embedded.id ?? query.id,
        relation_id: embedded.relation_id ?? query.relation_id,
        content_type: embedded.content_type ?? query.content_type,
        spid: embedded.spid ?? query.spid,
      }
      : query;
    const requestGeneration = ++generation;
    posts.value = [];
    topics.value = [];
    selectedTopicId.value = null;
    topicName.value = "";
    keywordInput.value = "";
    keyword.value = "";
    order.value = effectiveQuery?.order === "1" ? 1 : 2;
    anchorId.value = null;
    relationId.value = null;
    mixedVideo.value = effectiveQuery?.content_type === "0";
    loading.value = false;
    finished.value = false;
    error.value = "";
    routeError.value = "";
    initialized.value = false;
    page.value = 1; videoReady.value = false; firstVisitAttempted = false;

    if (!effectiveQuery || (embedded?.id && query.id && query.id !== embedded.id)
      || (embedded?.relation_id && query.relation_id && query.relation_id !== embedded.relation_id)
      || (embedded?.content_type && query.content_type && query.content_type !== embedded.content_type)
      || (embedded?.spid && query.spid && query.spid !== embedded.spid)) {
      routeError.value = "旧版视频链接无法安全打开";
      return;
    }

    if (effectiveQuery.id !== undefined && effectiveQuery.topic_id !== undefined && mode !== 'video') {
      routeError.value = '话题参数重复'; return;
    }
    if (mode === "topic") {
      const id = positiveId(effectiveQuery.id ?? effectiveQuery.topic_id);
      if (!id) routeError.value = "话题地址无效";
      else selectedTopicId.value = id;
    } else if (mode === "search") {
      const suppliedTopic = effectiveQuery.topic_id ?? effectiveQuery.id;
      if (suppliedTopic) {
        const id = positiveId(suppliedTopic);
        if (!id) routeError.value = "话题地址无效";
        else selectedTopicId.value = id;
      }
      keyword.value = String(effectiveQuery.keyword ?? effectiveQuery.searchVal ?? "").trim().slice(0, 100);
      keywordInput.value = keyword.value;
    } else {
      if (effectiveQuery.content_type !== undefined && !['0', '2'].includes(effectiveQuery.content_type)) { routeError.value = '视频类型无效'; return; }
      if (effectiveQuery.id !== undefined) {
        const id = positiveId(effectiveQuery.id);
        if (!id) routeError.value = "视频地址无效";
        else anchorId.value = id;
      }
      if (effectiveQuery.relation_id !== undefined) {
        const id = positiveId(effectiveQuery.relation_id);
        if (!id) routeError.value = "作者地址无效";
        else relationId.value = id;
      }
    }
    if (routeError.value) return;

    try {
      if (mode === "topic" || mode === "search") {
        const available = await apiCommunityTopics();
        if (disposed || !visible || requestGeneration !== generation || requestOwner !== owner()) return;
        if (!Array.isArray(available)) throw new Error("话题响应格式错误");
        topics.value = available;
        if (selectedTopicId.value) {
          const selected = available.find((item) => item.id === selectedTopicId.value);
          if (!selected) { routeError.value = "话题不存在或已下架"; return; }
          topicName.value = selected.name;
        }
      }
      if (mode === "video" && anchorId.value) {
        const selected = await apiCommunityState(anchorId.value);
        if (disposed || !visible || requestGeneration !== generation || requestOwner !== owner()) return;
        if ((!mixedVideo.value && postContentType(selected) !== 2)
          || (relationId.value && postRelationId(selected) !== relationId.value)) {
          routeError.value = "视频与分享地址不匹配";
          return;
        }
        const ticket = engagement?.nextTicket(), visited = await apiCommunityVisit(selected.id);
        if (disposed || !visible || requestGeneration !== generation || requestOwner !== owner()) return;
        if ((!mixedVideo.value && postContentType(visited) !== 2) || (relationId.value && postRelationId(visited) !== relationId.value)) throw Error('视频已变化，请重新打开');
        posts.value = engagement ? engagement.adopt([visited], ticket!) : [visited]; videoReady.value = true;
      }
      initialized.value = true;
      await loadMore();
    } catch (cause) {
      if (!disposed && visible && requestGeneration === generation && requestOwner === owner()) routeError.value = message(cause);
    }
  }

  function routeTo(query: CommunityRouteQuery) {
    const base = mode === "topic" ? "/pages/discover/discoverTopic/index"
      : mode === "search" ? "/pages/discover/discoverSearch/index"
      : videoRoute;
    const pairs = Object.entries(query).filter(([, value]) => value !== undefined && value !== "");
    const suffix = pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value!)}`).join("&");
    uni.redirectTo({
      url: suffix ? `${base}?${suffix}` : base,
      success() {},
      fail() { uni.showToast({ title: "打开页面失败，请重试", icon: "none" }); },
    });
  }

  function changeOrder(next: 1 | 2) {
    if (mode !== "topic" || next === order.value) return;
    routeTo({ id: String(selectedTopicId.value ?? ""), order: String(next) });
  }

  function submitSearch() {
    if (mode !== "search") return;
    routeTo({ keyword: keywordInput.value.trim().slice(0, 100), topic_id: selectedTopicId.value ? String(selectedTopicId.value) : undefined });
  }

  function selectTopic(id: number | null) {
    if (mode !== "search" || id === selectedTopicId.value) return;
    routeTo({ keyword: keyword.value, topic_id: id ? String(id) : undefined });
  }

  function selectVideo(post: CommunityPost) {
    if (disposed || !visible || mode !== "video" || post.id === activeVideo.value?.id || !posts.value.some(row => row.id === post.id)) return;
    routeTo({ id: String(post.id), relation_id: relationId.value ? String(relationId.value) : undefined,
      content_type: mixedVideo.value ? "0" : undefined });
  }

  const stopOwnerWatch = watch(() => [auth.uid, auth.token, auth.sessionVersion], () => {
    if (disposed) return;
    generation++; posts.value = []; topics.value = []; loading.value = false; initialized.value = false;
    if (visible) void initialize(routeQuery);
  }, { flush: 'sync' });

  function hide() { visible = false; generation++; posts.value = []; topics.value = []; loading.value = false; initialized.value = false; videoReady.value = false; }
  function dispose() {
    hide(); disposed = true;
    generation++;
    posts.value = [];
    stopOwnerWatch();
  }

  onHide(hide); onUnload(dispose); onScopeDispose(dispose);
  onShow(() => { if (!disposed && !visible) { visible = true; if (generation) void initialize(routeQuery); } });
  return { posts, topics, selectedTopicId, topicName, keywordInput, keyword, order, activeVideo, mixedVideo,
    loading, finished, error, routeError, initialized, initialize, loadMore, changeOrder,
    submitSearch, selectTopic, selectVideo, dispose };
}
