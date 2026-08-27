/**
 * 会员等级 + 社区 API
 */
import request, { getData } from "@/utils/request";

export const communityPreviewMode = typeof window !== "undefined"
  && ["127.0.0.1", "localhost"].includes(window.location.hostname)
  && new URLSearchParams(window.location.search).get("preview") === "1";

// ─── 会员等级 ───────────────────────────────────────────────
export interface LevelGrade {
  id: number;
  name: string;
  discount: number;
  grade: number;
  money: string;
  expNum: number;
  icon: string;
  image: string;
  isForever: number;
}

/** 等级列表 (GET /api/user/level/grade) */
export function apiLevelGrade(): Promise<LevelGrade[]> {
  return getData(request.get("/user/level/grade"));
}

/** 我的等级 (GET /api/user/level/info) */
export function apiLevelInfo(): Promise<{
  level: LevelGrade | null;
  currentExp: number;
  nextLevel: LevelGrade | null;
  nextExpNeed: number;
}> {
  return getData(request.get("/user/level/info"));
}

// ─── 社区 ───────────────────────────────────────────────────
export interface CommunityPost {
  id: number;
  type: number;
  contentType: number;
  title: string;
  image: string;
  content: string;
  sliderImage: unknown[];
  likeNum: number;
  commentNum: number;
  playNum: number;
  isLike: number;
  addTime: number;
}

export interface CommunityTopic {
  id: number;
  name: string;
  isRecommend: number;
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

const previewPosts: CommunityPost[] = [
  {
    id: 9_001,
    type: 2,
    contentType: 1,
    title: "把周末过成一场小型旅行",
    image: "",
    content: "沿着河岸慢慢走，路过旧书店和花市，也收集到三家值得再来的小店。",
    sliderImage: [],
    likeNum: 128,
    commentNum: 18,
    playNum: 2_406,
    isLike: 0,
    addTime: 1_786_700_800,
  },
  {
    id: 9_002,
    type: 2,
    contentType: 1,
    title: "桌面收纳的三个小改动",
    image: "",
    content: "先按使用频率分区，再给线材留出固定路径，最后只把每天都用的物件放在视线内。",
    sliderImage: [],
    likeNum: 86,
    commentNum: 9,
    playNum: 1_578,
    isLike: 0,
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

function previewPage<T>(rows: T[], page: number, limit: number): T[] {
  const start = Math.max(0, page - 1) * Math.max(1, limit);
  return structuredClone(rows.slice(start, start + Math.max(1, limit)));
}

/** 社区列表 (GET /api/community/list) */
export function apiCommunityList(page = 1, limit = 10): Promise<CommunityPost[]> {
  if (communityPreviewMode) return Promise.resolve(previewPage(previewPosts, page, limit));
  return getData(request.get("/community/list", { params: { page, limit } }));
}

/** 帖子详情 (GET /api/community/detail/:id) */
export function apiCommunityDetail(id: number): Promise<CommunityPost> {
  if (communityPreviewMode) {
    const post = previewPosts.find((item) => item.id === id);
    return post ? Promise.resolve(structuredClone(post)) : Promise.reject(new Error("帖子不存在"));
  }
  return getData(request.get(`/community/detail/${id}`));
}

/** 可用话题 (GET /api/community/topic) */
export function apiCommunityTopics(): Promise<CommunityTopic[]> {
  return getData(request.get("/community/topic"));
}

/** 发布帖子 (POST /api/community_save) */
export function apiCommunitySave(params: {
  title: string;
  content: string;
  content_type: number;
  topic_id?: number[];
  product_id?: number[];
}): Promise<{ id: number }> {
  if (communityPreviewMode) {
    const id = Math.max(...previewPosts.map((item) => item.id)) + 1;
    previewPosts.unshift({
      id,
      type: 2,
      contentType: params.content_type,
      title: params.title,
      image: "",
      content: params.content,
      sliderImage: [],
      likeNum: 0,
      commentNum: 0,
      playNum: 0,
      isLike: 0,
      addTime: Math.floor(Date.now() / 1_000),
    });
    return Promise.resolve({ id });
  }
  return getData(request.post("/community_save", params));
}

/** 点赞 (POST /api/community/like/:id) */
export function apiCommunityLike(
  id: number,
  status: 0 | 1 = 1,
): Promise<{ likeNum: number; status: 0 | 1 }> {
  if (communityPreviewMode) {
    const post = previewPosts.find((item) => item.id === id);
    if (!post) return Promise.reject(new Error("帖子不存在"));
    post.likeNum = Math.max(0, post.likeNum + (status === 1 ? 1 : -1));
    post.isLike = status;
    return Promise.resolve({ likeNum: post.likeNum, status });
  }
  return getData(request.post(`/community/like/${id}`, { status }));
}

/** 评论列表 (GET /api/community/comment/list) */
export function apiCommunityComments(communityId: number): Promise<unknown[]> {
  if (communityPreviewMode) return Promise.resolve(communityId === 9_001 ? [
    { id: 1, content: "路线已收藏，周末去走一遍。" },
  ] : []);
  return getData<{ list: unknown[]; count: number }>(
    request.get("/community/comment/list", { params: { community_id: communityId } }),
  ).then((result) => result.list);
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
  return getData(request.post(`/community/set_interest/${authorUid}`, { status }));
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
  return getData(request.get(`/community/follow_list/${type}`, { params: { page, limit } }));
}

export function apiCommunityFriendList(page = 1, limit = 20): Promise<CommunitySocialUser[]> {
  if (communityPreviewMode) return Promise.resolve(previewPage(previewPeople.slice(0, 2), page, limit));
  return getData(request.get("/community/user_friend", { params: { page, limit } }));
}

export function apiCommunityRecommendations(page = 1, limit = 20): Promise<CommunitySocialUser[]> {
  if (communityPreviewMode) {
    return Promise.resolve(previewPage(previewPeople.filter((item) => item.is_follow === 0), page, limit));
  }
  return getData(request.get("/community/recommend_list", { params: { page, limit } }));
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
  return getData(request.get("/community/follow"));
}
