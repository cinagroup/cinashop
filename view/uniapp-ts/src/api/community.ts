/**
 * 社区 API (逛逛/帖子)
 */
import { http } from "@/utils/request";

export const communityPreviewMode = typeof window !== "undefined"
  && ["127.0.0.1", "localhost"].includes(window.location.hostname)
  && new URLSearchParams(window.location.search).get("preview") === "1";

export interface CommunityPost {
  id: number;
  type: number;
  relationId: number;
  contentType: number;
  title: string;
  content: string;
  image: string;
  sliderImage: string[] | null;
  likeNum: number;
  commentNum: number;
  playNum: number;
  isLike: number;
  status: number;
  addTime: number;
}

export interface CommunityTopic {
  id: number;
  name: string;
  isRecommend: number;
}

export interface CommunityComment {
  id: number;
  communityId: number;
  uid: number;
  content: string;
  isDel: number;
  addTime: number;
}

/** 帖子列表 (GET /api/community/list) */
export function apiCommunityList(page = 1, limit = 10): Promise<CommunityPost[]> {
  if (communityPreviewMode) return Promise.resolve(previewPage(previewPosts, page, limit));
  return http.get<CommunityPost[]>("/community/list", { page, limit });
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
    post.isLike = status;
    post.likeNum = Math.max(0, post.likeNum + (status === 1 ? 1 : -1));
    return Promise.resolve({ likeNum: post.likeNum, status });
  }
  return http.post<{ likeNum: number; status: 0 | 1 }>(`/community/like/${id}`, { status });
}

/** 发布帖子 (POST /api/community_save) */
export function apiCommunitySave(params: {
  title?: string;
  content: string;
  content_type?: number;
  image?: string;
  slider_image?: string[];
  topic_id?: number[];
  product_id?: number[];
}): Promise<{ id: number }> {
  if (communityPreviewMode) {
    const id = Math.max(...previewPosts.map((item) => item.id)) + 1;
    previewPosts.unshift({
      id,
      type: 2,
      relationId: 999,
      contentType: params.content_type ?? 1,
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
    });
    return Promise.resolve({ id });
  }
  return http.post<{ id: number }>("/community_save", params);
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

export function apiCommunityRecommendations(page = 1, limit = 20): Promise<CommunitySocialUser[]> {
  if (communityPreviewMode) {
    return Promise.resolve(previewPage(previewPeople.filter((item) => item.is_follow === 0), page, limit));
  }
  return http.get<CommunitySocialUser[]>("/community/recommend_list", { page, limit });
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
