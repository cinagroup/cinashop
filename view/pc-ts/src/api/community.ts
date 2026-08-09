/**
 * 会员等级 + 社区 API
 */
import request, { getData } from "@/utils/request";

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
  addTime: number;
}

/** 社区列表 (GET /api/community/list) */
export function apiCommunityList(page = 1, limit = 10): Promise<CommunityPost[]> {
  return getData(request.get("/community/list", { params: { page, limit } }));
}

/** 帖子详情 (GET /api/community/detail/:id) */
export function apiCommunityDetail(id: number): Promise<CommunityPost> {
  return getData(request.get(`/community/detail/${id}`));
}

/** 发布帖子 (POST /api/community_save) */
export function apiCommunitySave(params: {
  title: string;
  content: string;
  content_type: number;
}): Promise<{ id: number }> {
  return getData(request.post("/community_save", params));
}

/** 点赞 (POST /api/community/like/:id) */
export function apiCommunityLike(id: number): Promise<null> {
  return getData(request.post(`/community/like/${id}`));
}

/** 评论列表 (GET /api/community/comment/list) */
export function apiCommunityComments(communityId: number): Promise<unknown[]> {
  return getData(
    request.get("/community/comment/list", { params: { community_id: communityId } }),
  );
}
