/**
 * 社区 API (逛逛/帖子)
 */
import { http } from "@/utils/request";

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
  status: number;
  addTime: number;
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
  return http.get<CommunityPost[]>("/community/list", { page, limit });
}

/** 帖子详情 (GET /api/community/detail/:id) */
export function apiCommunityDetail(id: number): Promise<CommunityPost> {
  return http.get<CommunityPost>(`/community/detail/${id}`);
}

/** 点赞 (POST /api/community/like/:id) */
export function apiCommunityLike(id: number): Promise<{ likeNum: number }> {
  return http.post<{ likeNum: number }>(`/community/like/${id}`);
}

/** 发布帖子 (POST /api/community_save) */
export function apiCommunitySave(params: {
  title?: string;
  content: string;
  content_type?: number;
  image?: string;
  slider_image?: string[];
}): Promise<{ id: number }> {
  return http.post<{ id: number }>("/community_save", params);
}

/** 删除帖子 (DELETE /api/community_delete/:id) */
export function apiCommunityDelete(id: number): Promise<null> {
  return http.delete<null>(`/community_delete/${id}`);
}

/** 评论列表 (GET /api/community/comment/list?community_id=) */
export function apiCommentList(communityId: number): Promise<CommunityComment[]> {
  return http.get<CommunityComment[]>("/community/comment/list", { community_id: communityId });
}

/** 发表评论 (POST /api/community/comment/save) */
export function apiCommentSave(communityId: number, content: string): Promise<{ id: number }> {
  return http.post<{ id: number }>("/community/comment/save", { community_id: communityId, content });
}
