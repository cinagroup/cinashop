import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export interface CommunityPost {
  id: number;
  type: number;
  relation_id: number;
  content_type: number;
  title: string;
  content: string;
  image: string;
  video_url: string;
  slider_image: string[];
  topic_id: number[];
  product_id: number[];
  like_num: number;
  play_num: number;
  comment_num: number;
  share_num: number;
  star: number;
  status: number;
  is_recommend: number;
  is_verify: number;
  refusal: string;
  sort: number;
  add_time: number;
  author: string;
  author_image: string;
}

export interface CommunityTopic {
  id: number;
  name: string;
  sort: number;
  is_recommend: number;
  status: number;
  community_num: number;
  add_time: number;
}

export interface CommunityComment {
  id: number;
  type: number;
  uid: number;
  reply_id: number;
  community_id: number;
  content: string;
  like_num: number;
  comment_num: number;
  is_verify: number;
  is_show: number;
  is_reply: number;
  add_time: number;
  author: string;
  author_image: string;
  community_title: string;
  comment_reply_content: string;
  verify_count: number;
}

export interface PageResult<T> {
  list: T[];
  count: number;
}

export interface CommunitySettings {
  community_status: 0 | 1;
  community_verify: 0 | 1;
  community_video_verify: 0 | 1;
  community_comment_status: 0 | 1;
  community_comment_add: 0 | 1;
  community_comment_verify: 0 | 1;
}

export interface CommunitySettingsResult {
  settings: CommunitySettings;
  missing_keys: Array<keyof CommunitySettings>;
  duplicate_keys: Array<keyof CommunitySettings>;
  verified?: true;
}

const now = Math.floor(Date.now() / 1000);
const previewSettings: CommunitySettings = {
  community_status: 1,
  community_verify: 1,
  community_video_verify: 1,
  community_comment_status: 1,
  community_comment_add: 1,
  community_comment_verify: 0,
};
const previewPosts: CommunityPost[] = [
  {
    id: 2103,
    type: 2,
    relation_id: 103,
    content_type: 1,
    title: "周末咖啡角：三种手冲风味记录",
    content: "从浅烘花香到深烘坚果，记录本周最喜欢的三杯咖啡。",
    image: "/logo.png",
    video_url: "",
    slider_image: ["/logo.png"],
    topic_id: [12, 18],
    product_id: [301],
    like_num: 86,
    play_num: 1298,
    comment_num: 14,
    share_num: 21,
    star: 5,
    status: 1,
    is_recommend: 1,
    is_verify: 0,
    refusal: "",
    sort: 20,
    add_time: now - 960,
    author: "林川",
    author_image: "/logo.png",
  },
  {
    id: 2102,
    type: 0,
    relation_id: 0,
    content_type: 2,
    title: "新品开箱：便携随行杯",
    content: "一分钟看完容量、保温和清洁细节。",
    image: "/logo.png",
    video_url: "https://example.com/community-preview.mp4",
    slider_image: ["/logo.png"],
    topic_id: [12],
    product_id: [302],
    like_num: 142,
    play_num: 3604,
    comment_num: 27,
    share_num: 58,
    star: 4,
    status: 1,
    is_recommend: 1,
    is_verify: 1,
    refusal: "",
    sort: 30,
    add_time: now - 7200,
    author: "平台",
    author_image: "/logo.png",
  },
  {
    id: 2101,
    type: 2,
    relation_id: 101,
    content_type: 1,
    title: "露营装备清单复盘",
    content: "这次实际使用后，重新整理了轻量化清单。",
    image: "/logo.png",
    video_url: "",
    slider_image: ["/logo.png"],
    topic_id: [18],
    product_id: [],
    like_num: 35,
    play_num: 640,
    comment_num: 6,
    share_num: 8,
    star: 2,
    status: 0,
    is_recommend: 0,
    is_verify: -2,
    refusal: "图片包含失效外链，请更换后重新提交",
    sort: 0,
    add_time: now - 86_400,
    author: "周野",
    author_image: "/logo.png",
  },
];

const previewTopics: CommunityTopic[] = [
  { id: 12, name: "好物体验", sort: 50, is_recommend: 1, status: 1, community_num: 128, add_time: now - 900_000 },
  { id: 18, name: "生活灵感", sort: 40, is_recommend: 1, status: 1, community_num: 96, add_time: now - 800_000 },
  { id: 25, name: "门店日常", sort: 20, is_recommend: 0, status: 0, community_num: 17, add_time: now - 500_000 },
];

const previewComments: CommunityComment[] = [
  {
    id: 5103,
    type: 2,
    uid: 106,
    reply_id: 0,
    community_id: 2103,
    content: "第二种豆子的酸甜平衡看起来很棒，想试试。",
    like_num: 12,
    comment_num: 2,
    is_verify: 0,
    is_show: 1,
    is_reply: 1,
    add_time: now - 600,
    author: "夏禾",
    author_image: "/logo.png",
    community_title: "周末咖啡角：三种手冲风味记录",
    comment_reply_content: "-",
    verify_count: 2,
  },
  {
    id: 5102,
    type: 3,
    uid: 0,
    reply_id: 0,
    community_id: 2102,
    content: "杯盖拆洗方便，通勤使用很友好。",
    like_num: 5,
    comment_num: 0,
    is_verify: 1,
    is_show: 1,
    is_reply: 1,
    add_time: now - 5400,
    author: "体验官小青",
    author_image: "/logo.png",
    community_title: "新品开箱：便携随行杯",
    comment_reply_content: "-",
    verify_count: 0,
  },
  {
    id: 5101,
    type: 2,
    uid: 104,
    reply_id: 0,
    community_id: 2101,
    content: "外链打不开了。",
    like_num: 0,
    comment_num: 0,
    is_verify: -1,
    is_show: 0,
    is_reply: 1,
    add_time: now - 82_000,
    author: "阿言",
    author_image: "/logo.png",
    community_title: "露营装备清单复盘",
    comment_reply_content: "-",
    verify_count: 0,
  },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function page<T>(rows: T[], params: Record<string, unknown>): PageResult<T> {
  const current = Math.max(1, Number(params.page ?? 1));
  const limit = Math.min(100, Math.max(1, Number(params.limit ?? 20)));
  return { list: clone(rows.slice((current - 1) * limit, current * limit)), count: rows.length };
}

export async function apiCommunityPostHeader(params: Record<string, unknown> = {}) {
  if (previewMode) {
    return [1, 0, -1, -2].map((status) => ({
      is_verify: status,
      name: status === 1 ? "已发布" : status === 0 ? "待审核" : status === -1 ? "审核未通过" : "强制下架",
      count: previewPosts.filter((row) => row.is_verify === status).length,
    }));
  }
  return getData<Array<{ is_verify: number; name: string; count: number }>>(
    request.get("/community/community/header", { params }),
  );
}

export async function apiCommunityPosts(params: Record<string, unknown> = {}) {
  if (previewMode) {
    const keyword = String(params.keyword ?? "").trim();
    const verify = params.is_verify === "" || params.is_verify === undefined ? undefined : Number(params.is_verify);
    const contentType = params.content_type === "" || params.content_type === undefined ? undefined : Number(params.content_type);
    return page(previewPosts.filter((row) =>
      (!keyword || row.title.includes(keyword) || String(row.id).includes(keyword))
      && (verify === undefined || row.is_verify === verify)
      && (contentType === undefined || row.content_type === contentType)
    ), params);
  }
  return getData<PageResult<CommunityPost>>(request.get("/community/community/list", { params }));
}

export async function apiCommunityPostInfo(id: number) {
  if (previewMode) return clone(previewPosts.find((row) => row.id === id)!);
  return getData<CommunityPost>(request.get(`/community/community/info/${id}`));
}

export async function apiCommunityPostSave(id: number, body: Record<string, unknown>) {
  if (previewMode) {
    const existing = previewPosts.find((row) => row.id === id);
    if (existing) Object.assign(existing, body);
    else previewPosts.unshift({
      ...clone(previewPosts[1]),
      ...body,
      id: Math.max(...previewPosts.map((row) => row.id)) + 1,
      type: 0,
      relation_id: 0,
      author: "平台",
      add_time: now,
    } as CommunityPost);
    return { id: existing?.id ?? previewPosts[0].id };
  }
  return getData<{ id: number }>(request.post(`/community/community/save/${id}`, body));
}

export async function apiCommunityPostStatus(id: number, status: number) {
  if (previewMode) { const row = previewPosts.find((item) => item.id === id); if (row) row.status = status; return null; }
  return getData<null>(request.post(`/community/community/set_status/${id}/${status}`));
}

export async function apiCommunityPostRecommend(id: number, recommend: number) {
  if (previewMode) { const row = previewPosts.find((item) => item.id === id); if (row) row.is_recommend = recommend; return null; }
  return getData<null>(request.post(`/community/community/set_recommend/${id}/${recommend}`));
}

export async function apiCommunityPostStar(id: number, star: number) {
  if (previewMode) { const row = previewPosts.find((item) => item.id === id); if (row) row.star = star; return null; }
  return getData<null>(request.post(`/community/community/star/${id}`, { star }));
}

export async function apiCommunityPostVerify(id: number, isVerify: number, refusal = "") {
  if (previewMode) { const row = previewPosts.find((item) => item.id === id); if (row) { row.is_verify = isVerify; row.refusal = refusal; } return null; }
  return getData<null>(request.post(`/community/community/set_verify/${id}`, { is_verify: isVerify, refusal }));
}

export async function apiCommunityPostDelete(id: number) {
  if (previewMode) { const index = previewPosts.findIndex((item) => item.id === id); if (index >= 0) previewPosts.splice(index, 1); return null; }
  return getData<null>(request.delete(`/community/community/del/${id}`));
}

export async function apiCommunityTopics(params: Record<string, unknown> = {}) {
  if (previewMode) {
    const name = String(params.name ?? "").trim();
    return page(previewTopics.filter((row) => !name || row.name.includes(name)), params);
  }
  return getData<PageResult<CommunityTopic>>(request.get("/community/topic/list", { params }));
}

export async function apiCommunityAllTopics() {
  if (previewMode) return clone(previewTopics.filter((row) => row.status === 1).map(({ id, name, is_recommend }) => ({ id, name, is_recommend })));
  return getData<Array<{ id: number; name: string; is_recommend: number }>>(request.get("/community/all_topic"));
}

export async function apiCommunityTopicSave(id: number, body: Record<string, unknown>) {
  if (previewMode) {
    const existing = previewTopics.find((row) => row.id === id);
    if (existing) Object.assign(existing, body);
    else previewTopics.unshift({ id: Math.max(...previewTopics.map((row) => row.id)) + 1, name: "新话题", sort: 0, is_recommend: 0, status: 1, community_num: 0, add_time: now, ...body } as CommunityTopic);
    return { id: existing?.id ?? previewTopics[0].id };
  }
  return getData<{ id: number }>(request.post(`/community/topic/save/${id}`, body));
}

export async function apiCommunityTopicStatus(id: number, status: number) {
  if (previewMode) { const row = previewTopics.find((item) => item.id === id); if (row) row.status = status; return null; }
  return getData<null>(request.get(`/community/topic/set_status/${id}/${status}`));
}

export async function apiCommunityTopicRecommend(id: number, status: number) {
  if (previewMode) { const row = previewTopics.find((item) => item.id === id); if (row) row.is_recommend = status; return null; }
  return getData<null>(request.get(`/community/topic/set_hot/${id}/${status}`));
}

export async function apiCommunityTopicDelete(id: number) {
  if (previewMode) { const index = previewTopics.findIndex((item) => item.id === id); if (index >= 0) previewTopics.splice(index, 1); return null; }
  return getData<null>(request.delete(`/community/topic/del/${id}`));
}

export async function apiCommunityComments(params: Record<string, unknown> = {}) {
  if (previewMode) {
    const verify = params.is_verify === "" || params.is_verify === undefined ? undefined : Number(params.is_verify);
    const keyword = String(params.keyword ?? "").trim();
    return page(previewComments.filter((row) =>
      (verify === undefined || row.is_verify === verify)
      && (!keyword || row.content.includes(keyword) || row.author.includes(keyword))
    ), params);
  }
  return getData<PageResult<CommunityComment>>(request.get("/community/comment/list", { params }));
}

export async function apiCommunityCommentReplies(id: number) {
  if (previewMode) return { list: clone(previewComments.filter((row) => row.reply_id === id)), count: previewComments.filter((row) => row.reply_id === id).length };
  return getData<PageResult<CommunityComment>>(request.get(`/community/comment/reply/${id}`));
}

export async function apiCommunityCommentReply(id: number, content: string) {
  if (previewMode) {
    const target = previewComments.find((row) => row.id === id)!;
    previewComments.push({ ...clone(target), id: Math.max(...previewComments.map((row) => row.id)) + 1, type: 0, uid: 0, reply_id: target.reply_id || target.id, content, author: "平台", is_reply: 0, add_time: now });
    target.comment_num += 1;
    return { id: previewComments[previewComments.length - 1].id };
  }
  return getData<{ id: number }>(request.post(`/community/comment/reply/${id}`, { content }));
}

export async function apiCommunityCommentStatus(id: number, status: number) {
  if (previewMode) { const row = previewComments.find((item) => item.id === id); if (row) row.is_show = status; return null; }
  return getData<null>(request.put(`/community/comment/set_status/${id}/${status}`));
}

export async function apiCommunityCommentVerify(id: number, status: number) {
  if (previewMode) { const row = previewComments.find((item) => item.id === id); if (row) row.is_verify = status; return null; }
  return getData<null>(request.post(`/community/comment/set_verify/${id}`, { is_verify: status }));
}

export async function apiCommunityCommentDelete(id: number) {
  if (previewMode) { const index = previewComments.findIndex((item) => item.id === id); if (index >= 0) previewComments.splice(index, 1); return null; }
  return getData<null>(request.delete(`/community/comment/del/${id}`));
}

export async function apiCommunityFictitiousComment(body: Record<string, unknown>) {
  if (previewMode) {
    const post = previewPosts.find((row) => row.id === Number(body.community_id));
    const id = Math.max(...previewComments.map((row) => row.id)) + 1;
    previewComments.unshift({
      id,
      type: Number(body.type ?? 3),
      uid: 0,
      reply_id: 0,
      community_id: Number(body.community_id),
      content: String(body.content ?? ""),
      like_num: 0,
      comment_num: 0,
      is_verify: 1,
      is_show: 1,
      is_reply: 1,
      add_time: now,
      author: String(body.nickname ?? "平台"),
      author_image: String(body.avatar ?? "/logo.png"),
      community_title: post?.title ?? "",
      comment_reply_content: "-",
      verify_count: 0,
    });
    return { id };
  }
  return getData<{ id: number }>(request.post("/community/comment/save_fictitious", body));
}

export async function apiCommunitySettings() {
  if (previewMode) return { settings: clone(previewSettings), missing_keys: [], duplicate_keys: [] } satisfies CommunitySettingsResult;
  return getData<CommunitySettingsResult>(request.get("/community/settings"));
}

export async function apiCommunitySettingsSave(settings: CommunitySettings) {
  if (previewMode) {
    Object.assign(previewSettings, settings);
    return { settings: clone(previewSettings), missing_keys: [], duplicate_keys: [], verified: true } satisfies CommunitySettingsResult;
  }
  return getData<CommunitySettingsResult>(request.post("/community/settings", { settings }));
}
