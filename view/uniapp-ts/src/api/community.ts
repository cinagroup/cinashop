/**
 * 社区 API (逛逛/帖子)
 */
import { communityHttp as http } from "@/utils/communityAvailability";

export const communityPreviewMode = typeof window !== "undefined"
  && ["127.0.0.1", "localhost"].includes(window.location.hostname)
  && new URLSearchParams(window.location.search).get("preview") === "1";

export interface CommunityPost {
  id: number;
  type: number;
  relationId: number;
  contentType: number;
  videoUrl?: string;
  video_url?: string;
  topic_id?: number[];
  title: string;
  content: string;
  image: string;
  sliderImage: string[] | null;
  is_self?: 0 | 1;
  is_verify?: number;
  refusal?: string;
  image_reference?: string;
  video_reference?: string;
  slider_image_references?: string[];
  product_id?: number[];
  topic?: Array<{ id: number; name: string }>;
  product?: Array<{ id: number; store_name: string; image: string; price: string }>;
  likeNum: number;
  commentNum: number;
  playNum: number;
  isLike: number;
  shareNum?: number;
  share_num?: number;
  site_url?: string;
  status: number;
  addTime: number;
  star?: number;
  author?: string;
  author_image?: string;
  is_follow?: 0 | 1;
}

export interface CommunityTopic {
  id: number;
  name: string;
  isRecommend: number;
}

export interface CommunityProduct {
  product_id: number;
  store_name: string;
  image: string;
  price: string;
}

export type CommunityProductSource = "pay" | "collect" | "visit";
export async function apiCommunityProducts(type: CommunityProductSource, keyword = "", page = 1): Promise<CommunityProduct[]> {
  if (communityPreviewMode) return [];
  const rows = await http.get<CommunityProduct[]>("/community/product_list", { type, keyword, page, limit: 10 });
  if (!Array.isArray(rows) || rows.length > 10 || rows.some(row => !row || !Number.isSafeInteger(row.product_id)
    || row.product_id <= 0 || typeof row.store_name !== "string" || typeof row.image !== "string"
    || typeof row.price !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(row.price))) throw Error("商品列表格式错误");
  return rows;
}

export interface CommunityComment {
  id: number;
  communityId: number;
  uid: number;
  content: string;
  isDel: number;
  addTime: number;
}

export interface CommunityListFilters {
  is_follow?: 0 | 1;
  topic_id?: number;
  keyword?: string;
  content_type?: 2;
  start_id?: number;
  relation_id?: number;
  author_type?: number;
  order?: 1 | 2;
}

/** 帖子列表 (GET /api/community/list) — 对应旧端话题/搜索/视频筛选合同。 */
export function apiCommunityList(page = 1, limit = 10, filters: CommunityListFilters = {}): Promise<CommunityPost[]> {
  if (communityPreviewMode) {
    let rows = previewPosts.filter((item) =>
      (!filters.is_follow || item.is_follow === 1)
      && (!filters.topic_id || item.topic_id?.includes(filters.topic_id))
      && (!filters.keyword || `${item.title} ${item.content}`.toLowerCase().includes(filters.keyword.toLowerCase()))
      && (!filters.content_type || item.contentType === filters.content_type)
      && (!filters.start_id || item.id <= filters.start_id)
      && (!filters.relation_id || item.relationId === filters.relation_id));
    rows = [...rows].sort((a, b) => filters.order === 1
      ? b.addTime - a.addTime || b.id - a.id
      : (b.star ?? 0) - (a.star ?? 0) || b.addTime - a.addTime || b.id - a.id);
    return Promise.resolve(previewPage(rows, page, limit));
  }
  return http.get<CommunityPost[]>("/community/list", { page, limit, ...filters });
}

/** 帖子详情 (GET /api/community/detail/:id) */
export function apiCommunityDetail(id: number): Promise<CommunityPost> {
  if (communityPreviewMode) {
    const post = previewPosts.find((item) => item.id === id);
    return post ? Promise.resolve(structuredClone(post)) : Promise.reject(new Error("帖子不存在"));
  }
  return http.get<CommunityPost>(`/community/detail/${id}`);
}

export interface CommunitySocialUser {
  id: number;
  type: number;
  relation_id: number;
  author: string;
  author_image: string;
  desc: string;
  community_num: number;
  follow_num: number;
  fans_num: number;
  friend_num: number;
  like_num: number;
  is_follow: 0 | 1;
  is_fans: 0 | 1;
  is_new?: 0 | 1;
  community?: CommunityRecommendationPost[];
}

export interface CommunityRecommendationPost {
  id: number;
  type: number;
  relation_id: number;
  content_type: 1 | 2;
  title: string;
  image: string;
}
export interface CommunityRecommendation extends CommunitySocialUser {
  community: CommunityRecommendationPost[];
}

export interface CommunityProfile extends CommunitySocialUser {
  friend_count: number;
  level_name: string;
  vip_status: 0 | 1;
  is_self: 0 | 1;
}

const previewPosts: CommunityPost[] = [
  {
    id: 9_001,
    type: 2,
    relationId: 101,
    contentType: 1,
    title: "把周末过成一场小型旅行",
    content: "沿着河岸慢慢走，路过旧书店和花市，也收集到三家值得再来的小店。",
    image: "",
    sliderImage: null,
    likeNum: 128,
    commentNum: 18,
    playNum: 2_406,
    isLike: 0,
    status: 1,
    addTime: 1_786_700_800,
    topic_id: [1],
  },
  {
    id: 9_002,
    type: 2,
    relationId: 103,
    contentType: 1,
    title: "桌面收纳的三个小改动",
    content: "先按使用频率分区，再给线材留出固定路径，最后只把每天都用的物件放在视线内。",
    image: "",
    sliderImage: null,
    likeNum: 86,
    commentNum: 9,
    playNum: 1_578,
    isLike: 0,
    status: 1,
    addTime: 1_786_614_400,
    topic_id: [],
  },
  {
    id: 9_003,
    type: 2,
    relationId: 101,
    contentType: 2,
    title: "周末花市短片",
    content: "一段周末花市漫游视频。预览数据只验证深链与视频卡片，不包含可播放媒体。",
    image: "",
    sliderImage: null,
    videoUrl: "",
    likeNum: 42,
    commentNum: 3,
    playNum: 321,
    isLike: 0,
    status: 1,
    addTime: 1_786_710_800,
    topic_id: [1],
  },
];

const previewPeople: CommunitySocialUser[] = [
  {
    id: 501, type: 2, relation_id: 101, author: "林野", author_image: "",
    desc: "城市漫游与周末路线", community_num: 26, follow_num: 48, fans_num: 1_284,
    friend_num: 3, like_num: 5_620, is_follow: 1, is_fans: 1, is_new: 1,
  },
  {
    id: 502, type: 2, relation_id: 102, author: "晚风工作室", author_image: "",
    desc: "记录手作与空间改造", community_num: 18, follow_num: 31, fans_num: 932,
    friend_num: 2, like_num: 3_814, is_follow: 0, is_fans: 1, is_new: 0,
  },
  {
    id: 503, type: 2, relation_id: 103, author: "器物志", author_image: "",
    desc: "让日常物件更好用", community_num: 42, follow_num: 76, fans_num: 2_118,
    friend_num: 0, like_num: 9_406, is_follow: 0, is_fans: 0, is_new: 1,
  },
  {
    id: 504, type: 2, relation_id: 104, author: "山茶食记", author_image: "",
    desc: "家常菜和地方风味", community_num: 35, follow_num: 58, fans_num: 1_706,
    friend_num: 0, like_num: 7_223, is_follow: 0, is_fans: 0, is_new: 0,
  },
];

const previewComments: CommunityComment[] = [
  { id: 7_001, communityId: 9_001, uid: 102, content: "路线已收藏，周末去走一遍。", isDel: 0, addTime: 1_786_702_000 },
  { id: 7_002, communityId: 9_001, uid: 103, content: "花市那一段很舒服。", isDel: 0, addTime: 1_786_703_200 },
];

function previewPage<T>(rows: T[], page: number, limit: number): T[] {
  const start = Math.max(0, page - 1) * Math.max(1, limit);
  return structuredClone(rows.slice(start, start + Math.max(1, limit)));
}

/** 可用话题 (GET /api/community/topic) */
export function apiCommunityTopics(): Promise<CommunityTopic[]> {
  if (communityPreviewMode) return Promise.resolve([{ id: 1, name: "生活灵感", isRecommend: 1 }]);
  return http.get<CommunityTopic[]>("/community/topic");
}

/** 点赞 (POST /api/community/like/:id) */
export function apiCommunityLike(
  id: number,
  status: 0 | 1 = 1,
): Promise<{ likeNum: number; status: 0 | 1 }> {
  if (communityPreviewMode) {
    const post = previewPosts.find((item) => item.id === id);
    if (!post) return Promise.reject(new Error("帖子不存在"));
    if (post.isLike !== status) post.likeNum = Math.max(0, post.likeNum + (status === 1 ? 1 : -1));
    post.isLike = status;
    return Promise.resolve({ likeNum: post.likeNum, status });
  }
  return http.post<{ likeNum: number; status: 0 | 1 }>(`/community/like/${id}`, { status });
}

const postId = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
/** Validate a whole exact-post receipt before projecting any fields into the current page. */
export function checkedCommunityPost(value: unknown, id: number): CommunityPost {
  const row = value as CommunityPost;
  if (!row || !postId(id) || row.id !== id || !Number.isSafeInteger(row.type) || row.type < 0
    || !Number.isSafeInteger(row.relationId) || row.relationId < 0 || row.relationId > 2147483647
    || ![1, 2].includes(row.contentType) || ![0, 1].includes(row.isLike) || ![0, 1].includes(row.status)
    || [row.likeNum, row.commentNum, row.playNum, row.shareNum ?? row.share_num ?? 0].some(n => !Number.isSafeInteger(n) || n < 0 || n > 2147483647)
    || [row.title, row.content, row.image].some(text => typeof text !== 'string')
    || row.is_verify !== undefined && ![-2, -1, 0, 1].includes(row.is_verify)
    || row.site_url !== undefined && typeof row.site_url !== 'string') throw Error('帖子响应格式错误');
  return row;
}
/** A deliberate detail visit; the server records one public visit. Never use this for reconciliation. */
export async function apiCommunityVisit(id: number): Promise<CommunityPost> {
  if (!postId(id)) throw Error('帖子地址无效');
  const row = await apiCommunityDetail(id);
  if (communityPreviewMode) row.is_verify = 1;
  return checkedCommunityPost(row, id);
}
/** Exact read-only state, including viewer flags; it does not add an exposure. */
export async function apiCommunityState(id: number): Promise<CommunityPost> {
  if (!postId(id)) throw Error('帖子地址无效');
  const row = communityPreviewMode ? await apiCommunityDetail(id) : await http.get<CommunityPost>(`/community/state/${id}`);
  if (communityPreviewMode) row.is_verify = 1;
  return checkedCommunityPost(row, id);
}
/** PHP-compatible GET that records one explicit share intent. Never preload or retry it automatically. */
export async function apiCommunityTrackShare(id: number): Promise<{ shareNum: number }> {
  if (!postId(id)) throw Error('帖子地址无效');
  if (communityPreviewMode) {
    const post = previewPosts.find(row => row.id === id);
    if (!post) throw Error('帖子不存在');
    post.shareNum = (post.shareNum ?? 0) + 1; return { shareNum: post.shareNum };
  }
  return http.get<{ shareNum: number }>(`/community/share/${id}`, {}, { headers: { 'Cache-Control': 'no-cache' } });
}

/** 发布帖子 (POST /api/community_save) */
export type CommunityPostInput = {
  title?: string;
  content: string;
  content_type?: number;
  image?: string;
  video_url?: string;
  slider_image?: string[];
  topic_id?: number[];
  product_id?: number[];
};
export function apiCommunitySave(params: CommunityPostInput): Promise<{ id: number }> {
  if (communityPreviewMode) {
    const id = Math.max(...previewPosts.map((item) => item.id)) + 1;
    previewPosts.unshift({
      id,
      type: 2,
      relationId: 999,
      contentType: params.content_type ?? 1,
      videoUrl: params.video_url ?? "",
      title: params.title ?? "分享",
      content: params.content,
      image: params.image ?? "",
      sliderImage: params.slider_image ?? null,
      likeNum: 0,
      commentNum: 0,
      playNum: 0,
      isLike: 0,
      status: 1,
      addTime: Math.floor(Date.now() / 1_000),
      topic_id: params.topic_id ?? [],
    });
    return Promise.resolve({ id });
  }
  return http.post<{ id: number }>("/community_save", params);
}

export function apiCommunityUpdate(id: number, params: CommunityPostInput): Promise<{ id: number }> {
  return http.post<{ id: number }>(`/community/community_update/${id}`, params);
}

export async function apiCommunityLikedPosts(page = 1, keyword = ""): Promise<CommunityPost[]> {
  const result = await http.get<{ list: CommunityPost[]; count: number }>("/community/like_list", { page, limit: 10, keyword });
  if (!result || !Array.isArray(result.list)) throw Error("赞过列表格式错误");
  return result.list;
}

/** 删除帖子 (DELETE /api/community_delete/:id) */
export function apiCommunityDelete(id: number): Promise<null> {
  if (communityPreviewMode) {
    const index = previewPosts.findIndex((item) => item.id === id);
    if (index >= 0) previewPosts.splice(index, 1);
    return Promise.resolve(null);
  }
  return http.delete<null>(`/community_delete/${id}`);
}

/** 评论列表 (GET /api/community/comment/list?community_id=) */
export function apiCommentList(communityId: number): Promise<CommunityComment[]> {
  if (communityPreviewMode) {
    return Promise.resolve(structuredClone(previewComments.filter((item) => item.communityId === communityId)));
  }
  return http
    .get<{ list: CommunityComment[]; count: number }>("/community/comment/list", { community_id: communityId })
    .then((result) => result.list);
}

/** 发表评论 (POST /api/community/comment/save) */
export function apiCommentSave(communityId: number, content: string): Promise<{ id: number }> {
  if (communityPreviewMode) {
    const id = Math.max(7_000, ...previewComments.map((item) => item.id)) + 1;
    previewComments.push({
      id,
      communityId,
      uid: 999,
      content,
      isDel: 0,
      addTime: Math.floor(Date.now() / 1_000),
    });
    return Promise.resolve({ id });
  }
  return http.post<{ id: number }>("/community/comment/save", { community_id: communityId, content });
}

export function apiCommunityProfile(authorUid: number): Promise<CommunityProfile> {
  if (communityPreviewMode) {
    const person = previewPeople.find((item) => item.relation_id === authorUid);
    if (!person) return Promise.reject(new Error("用户不存在"));
    return Promise.resolve({
      ...structuredClone(person),
      friend_count: person.friend_num,
      level_name: "灵感会员",
      vip_status: 1,
      is_self: 0,
    });
  }
  return http.get<CommunityProfile>(`/community/user_info/${authorUid}`);
}

export function apiCommunityUpdateDescription(desc: string): Promise<{ desc: string }> {
  if (communityPreviewMode) return Promise.resolve({ desc });
  return http.post<{ desc: string }>("/community/update_desc", { desc });
}

export function apiCommunitySetInterest(
  authorUid: number,
  status: 0 | 1,
): Promise<{ status: 0 | 1; is_follow: 0 | 1; is_fans: 0 | 1 }> {
  if (communityPreviewMode) {
    const person = previewPeople.find((item) => item.relation_id === authorUid);
    if (!person) return Promise.reject(new Error("用户不存在"));
    person.is_follow = status;
    return Promise.resolve({ status, is_follow: status, is_fans: person.is_fans });
  }
  return http.post(`/community/set_interest/${authorUid}`, { status });
}

export function apiCommunityFollowList(
  type: "follow" | "fans",
  page = 1,
  limit = 20,
): Promise<CommunitySocialUser[]> {
  if (communityPreviewMode) {
    const rows = type === "follow"
      ? previewPeople.filter((item) => item.is_follow === 1)
      : previewPeople.filter((item) => item.is_fans === 1);
    return Promise.resolve(previewPage(rows, page, limit));
  }
  return http.get<CommunitySocialUser[]>(`/community/follow_list/${type}`, { page, limit });
}

export function apiCommunityFriendList(page = 1, limit = 20): Promise<CommunitySocialUser[]> {
  if (communityPreviewMode) return Promise.resolve(previewPage(previewPeople.slice(0, 2), page, limit));
  return http.get<CommunitySocialUser[]>("/community/user_friend", { page, limit });
}

export function apiCommunityRecommendations(page = 1, limit = 20): Promise<CommunityRecommendation[]> {
  if (communityPreviewMode) {
    return Promise.resolve(previewPage(previewPeople.filter((item) => item.is_follow === 0), page, limit).map(item => ({ ...item,
      community: previewPosts.filter(post => post.type === item.type && post.relationId === item.relation_id).slice(0, 3)
        .map(post => ({ id: post.id, type: post.type, relation_id: post.relationId, content_type: post.contentType as 1 | 2, title: post.title, image: post.image })) })));
  }
  return http.get<CommunityRecommendation[]>("/community/recommend_list", { page, limit });
}

export function apiCommunityFollowHighlights(): Promise<Array<Pick<
  CommunitySocialUser,
  "author" | "author_image" | "relation_id" | "is_new"
>>> {
  if (communityPreviewMode) {
    return Promise.resolve(previewPeople.slice(0, 3).map((item) => ({
      author: item.author,
      author_image: item.author_image,
      relation_id: item.relation_id,
      is_new: item.is_new,
    })));
  }
  return http.get("/community/follow");
}

export function apiCommunityBrowse(id: number): Promise<null> {
  if (communityPreviewMode) {
    const post = previewPosts.find((item) => item.id === id);
    if (post) post.playNum += 1;
    return Promise.resolve(null);
  }
  return http.put<null>(`/community/browse/${id}`, {});
}

export interface CommunityThreadComment extends CommunityComment {
  type: number;
  replyId: number;
  commentReplyId: number;
  isReply: 0 | 1;
  isShow: 0 | 1;
  isVerify: 1;
  likeNum: number;
  isLike: 0 | 1;
  author: string;
  author_image: string;
  comment_author: string;
  comment_author_type: number | null;
  comment_author_uid: number | null;
  reply_count: number;
}
export interface CommunityCommentPage { list: CommunityThreadComment[]; count: number; post_comment_num: number }
export interface CommunityCommentConfig { community_status: 0 | 1; community_comment_status: 0 | 1; community_comment_add: 0 | 1 }
const commentInteger = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= 2147483647;
const commentFlag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
const previewThreadRows = new Map<number, CommunityThreadComment>();
function previewThread(communityId: number) {
  for (const row of previewComments) if (!previewThreadRows.has(row.id)) previewThreadRows.set(row.id, {
    ...row, type: 2, replyId: 0, commentReplyId: 0, isReply: 1, isShow: 1, isVerify: 1, likeNum: 0, isLike: 0,
    author: `用户 #${row.uid}`, author_image: '', comment_author: '', comment_author_type: null, comment_author_uid: null, reply_count: 0,
  });
  const active = [...previewThreadRows.values()].filter(row => row.communityId === communityId && row.isDel === 0);
  for (const row of active) if (row.isReply === 1) row.reply_count = active.filter(child => child.isReply === 0 && child.replyId === row.id).length;
  return active;
}
export async function apiCommunityCommentConfig(): Promise<CommunityCommentConfig> {
  const data = communityPreviewMode ? { community_status: 1, community_comment_status: 1, community_comment_add: 1 }
    : await http.get<CommunityCommentConfig>('/community/config');
  if (!data || !commentFlag(data.community_status) || !commentFlag(data.community_comment_status) || !commentFlag(data.community_comment_add)) throw Error('评论开关格式错误，请刷新');
  return data as CommunityCommentConfig;
}
export async function apiCommunityCommentPage(communityId: number, page = 1, replyId = 0): Promise<CommunityCommentPage> {
  if (!commentInteger(communityId, 1) || !commentInteger(page, 1) || !commentInteger(replyId)) throw Error('评论分页参数错误');
  let data: CommunityCommentPage;
  if (communityPreviewMode) {
    const all = previewThread(communityId), rows = all.filter(row => replyId ? row.isReply === 0 && row.replyId === replyId : row.isReply === 1)
      .sort((a, b) => replyId ? a.addTime - b.addTime || a.id - b.id : b.addTime - a.addTime || b.id - a.id);
    data = { list: previewPage(rows, page, 10), count: rows.length, post_comment_num: all.length };
  } else data = await http.get<CommunityCommentPage>('/community/comment/list', { community_id: communityId, page, limit: 10, reply_id: replyId });
  if (!data || !Array.isArray(data.list) || data.list.length > 10 || !commentInteger(data.count) || !commentInteger(data.post_comment_num)) throw Error('评论列表格式错误，请重试');
  for (const row of data.list) {
    if (!row || !commentInteger(row.id, 1) || row.communityId !== communityId || !commentInteger(row.uid)
      || ![0, 1, 2, 3].includes(row.type) || typeof row.content !== 'string' || row.isDel !== 0
      || row.isVerify !== 1 || !commentFlag(row.isShow) || !commentFlag(row.isReply) || !commentFlag(row.isLike)
      || !commentInteger(row.likeNum) || !commentInteger(row.addTime) || !commentInteger(row.reply_count)
      || !commentInteger(row.commentReplyId) || !commentInteger(row.replyId)
      || (replyId ? row.isReply !== 0 || row.replyId !== replyId : row.isReply !== 1 || row.replyId !== 0)
      || typeof row.author !== 'string' || typeof row.author_image !== 'string' || typeof row.comment_author !== 'string'
      || row.comment_author_type != null && ![0, 1, 2, 3].includes(row.comment_author_type)
      || row.comment_author_uid != null && !commentInteger(row.comment_author_uid)) throw Error('评论列表格式错误，请重试');
  }
  return data;
}
export async function apiCommunityCommentCreate(communityId: number, content: string, target = 0): Promise<{ id: number; is_verify: 0 | 1; post_comment_num: number }> {
  if (communityPreviewMode) {
    const all = previewThread(communityId), parent = all.find(row => row.id === target);
    if (target && !parent) throw Error('回复目标不存在');
    const { id } = await apiCommentSave(communityId, content);
    previewThread(communityId);
    const row = previewThreadRows.get(id)!;
    if (parent) {
      row.isReply = 0; row.replyId = parent.isReply ? parent.id : parent.replyId;
      row.commentReplyId = parent.isReply ? 0 : parent.id;
      row.comment_author = parent.author; row.comment_author_type = parent.type; row.comment_author_uid = parent.uid;
      const root = previewThreadRows.get(row.replyId); if (root) root.reply_count++;
    }
    return { id, is_verify: 1, post_comment_num: all.length + 1 };
  }
  return http.post('/community/comment/save', { community_id: communityId, content, comment_reply_id: target });
}
export async function apiCommunityCommentLike(id: number, status: 0 | 1): Promise<{ likeNum: number; status: 0 | 1 }> {
  if (communityPreviewMode) {
    const row = previewThreadRows.get(id); if (!row) throw Error('评论不存在');
    row.likeNum = Math.max(0, row.likeNum + status - row.isLike); row.isLike = status;
    return { likeNum: row.likeNum, status };
  }
  return http.post(`/community/comment_like/${id}`, { status });
}
export async function apiCommunityCommentDelete(id: number): Promise<null> {
  if (communityPreviewMode) {
    const row = previewThreadRows.get(id); if (!row) throw Error('评论不存在');
    for (const value of previewThreadRows.values()) if (value.id === id || value.replyId === id) value.isDel = 1;
    return null;
  }
  return http.delete(`/community/comment_delete/${id}`);
}
