import { computed, ref, watch } from "vue";
import {
  apiCommunityDetail,
  apiCommunityList,
  apiCommunityTopics,
  type CommunityListFilters,
  type CommunityPost,
  type CommunityTopic,
} from "@/api/community";
import { useAuthStore } from "@/stores/auth";

export type CommunityDeepLinkMode = "topic" | "search" | "video";
export type CommunityRouteQuery = Record<string, string | undefined>;

const PAGE_SIZE = 20;
const VIDEO_PAGE_SIZE = 10;

function positiveId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/** Old APP-PLUS links wrapped an H5 page in web-view. Extract state only; never load its host or token. */
export function parseLegacyAppVideoUrl(raw: string): CommunityRouteQuery | null {
  if (!raw || raw.length > 2048) return null;
  let value = raw;
  try {
    if (!value.includes("/pages/discover/discoverVideo/index")) value = decodeURIComponent(value);
  } catch { return null; }
  if (/^https?:\/\//i.test(value)) value = value.replace(/^https?:\/\/[^/]+/i, "");
  if (!value.startsWith("/")) return null;
  const hashless = value.split("#", 1)[0];
  const separator = hashless.indexOf("?");
  if (separator < 0 || hashless.slice(0, separator) !== "/pages/discover/discoverVideo/index") return null;
  const fields = new Map<string, string>();
  try {
    for (const part of hashless.slice(separator + 1).split("&")) {
      const at = part.indexOf("=");
      const key = decodeURIComponent((at < 0 ? part : part.slice(0, at)).replace(/\+/g, " "));
      const item = decodeURIComponent((at < 0 ? "" : part.slice(at + 1)).replace(/\+/g, " "));
      if (["id", "relation_id", "content_type"].includes(key)) {
        if (fields.has(key)) return null;
        fields.set(key, item);
      }
    }
  } catch { return null; }
  const id = fields.get("id");
  const relation = fields.get("relation_id");
  const contentType = fields.get("content_type");
  if ((id && !positiveId(id)) || (relation && !positiveId(relation))
    || (contentType !== undefined && !["0", "2"].includes(contentType))) return null;
  return { id, relation_id: relation, content_type: contentType };
}

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
  const page = ref(1);
  let generation = 0;
  let disposed = false;
  let routeQuery: CommunityRouteQuery = {};

  const activeVideo = computed(() => posts.value[0] ?? null);
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
    if (disposed || !initialized.value || routeError.value || loading.value || finished.value) return;
    const requestGeneration = generation;
    const requestedPage = page.value;
    const owner = `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
    loading.value = true;
    error.value = "";
    try {
      const rows = await apiCommunityList(requestedPage, pageSize, filters());
      if (disposed || requestGeneration !== generation || owner !== `${auth.uid}:${auth.token}:${auth.sessionVersion}`) return;
      if (!Array.isArray(rows)) throw new Error("内容响应格式错误");
      const known = new Set(posts.value.map((post) => post.id));
      posts.value.push(...rows.filter((post) => Number.isSafeInteger(post.id) && post.id > 0 && !known.has(post.id)));
      finished.value = rows.length < pageSize;
      if (!finished.value) page.value = requestedPage + 1;
    } catch (cause) {
      if (!disposed && requestGeneration === generation) error.value = message(cause);
    } finally {
      if (!disposed && requestGeneration === generation) loading.value = false;
    }
  }

  async function initialize(query: CommunityRouteQuery = {}) {
    if (disposed) return;
    routeQuery = { ...query };
    const embedded = mode === "video" && query.url ? parseLegacyAppVideoUrl(query.url) : null;
    const effectiveQuery = mode === "video" && query.url
      ? embedded && {
        id: embedded.id ?? query.id,
        relation_id: embedded.relation_id ?? query.relation_id,
        content_type: embedded.content_type ?? query.content_type,
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
    page.value = 1;

    if (!effectiveQuery || (embedded?.id && query.id && query.id !== embedded.id)
      || (embedded?.relation_id && query.relation_id && query.relation_id !== embedded.relation_id)
      || (embedded?.content_type && query.content_type && query.content_type !== embedded.content_type)) {
      routeError.value = "旧版视频链接无法安全打开";
      return;
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
      if (effectiveQuery.id) {
        const id = positiveId(effectiveQuery.id);
        if (!id) routeError.value = "视频地址无效";
        else anchorId.value = id;
      }
      if (effectiveQuery.relation_id) {
        const id = positiveId(effectiveQuery.relation_id);
        if (!id) routeError.value = "作者地址无效";
        else relationId.value = id;
      }
    }
    if (routeError.value) return;

    try {
      if (mode === "topic" || mode === "search") {
        const available = await apiCommunityTopics();
        if (disposed || requestGeneration !== generation) return;
        if (!Array.isArray(available)) throw new Error("话题响应格式错误");
        topics.value = available;
        if (selectedTopicId.value) {
          const selected = available.find((item) => item.id === selectedTopicId.value);
          if (!selected) { routeError.value = "话题不存在或已下架"; return; }
          topicName.value = selected.name;
        }
      }
      if (mode === "video" && anchorId.value) {
        const selected = await apiCommunityDetail(anchorId.value);
        if (disposed || requestGeneration !== generation) return;
        if ((!mixedVideo.value && postContentType(selected) !== 2)
          || (relationId.value && postRelationId(selected) !== relationId.value)) {
          routeError.value = "视频与分享地址不匹配";
          return;
        }
        posts.value = [selected];
      }
      initialized.value = true;
      await loadMore();
    } catch (cause) {
      if (!disposed && requestGeneration === generation) routeError.value = message(cause);
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
    if (mode !== "video" || post.id === activeVideo.value?.id) return;
    routeTo({ id: String(post.id), relation_id: relationId.value ? String(relationId.value) : undefined,
      content_type: mixedVideo.value ? "0" : undefined });
  }

  const stopOwnerWatch = watch(() => [auth.uid, auth.token, auth.sessionVersion], () => {
    if (!disposed && generation) void initialize(routeQuery);
  });

  function dispose() {
    disposed = true;
    generation++;
    posts.value = [];
    stopOwnerWatch();
  }

  return { posts, topics, selectedTopicId, topicName, keywordInput, keyword, order, activeVideo, mixedVideo,
    loading, finished, error, routeError, initialized, initialize, loadMore, changeOrder,
    submitSearch, selectTopic, selectVideo, dispose };
}
