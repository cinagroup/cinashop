import request, { getData } from "@/utils/request";

export type WechatReplyType = "text" | "image" | "news" | "voice";

export interface WechatReplyItem {
  id: number;
  type: WechatReplyType;
  data: Record<string, unknown>;
  status: number;
  hide: number;
  key: string;
  keys: string[];
  typeName: string;
}

export interface WechatMediaItem {
  id: number;
  type: "image" | "voice";
  path: string;
  mediaId: string;
  url: string;
  temporary: number;
  addTime: number;
}

export interface WechatNewsArticle {
  id: number;
  title: string;
  author: string;
  content: string;
  synopsis: string;
  image_input: string[];
  imageInput: string;
  url: string;
  sort: number;
  status: number;
}

export interface WechatNewsCategory {
  id: number;
  cateName: string;
  sort: number;
  status: number;
  newId: string;
  addTime: string;
  articleIds: number[];
  articleCount: number;
  firstArticle: WechatNewsArticle | null;
  articles?: WechatNewsArticle[];
}

export interface WechatMessageRecord {
  id: number;
  openidMasked: string;
  type: string;
  result: unknown;
  addTime: number;
}

export interface WechatReplyCodeStatus {
  status: "ready" | "pending";
  url: string;
  qrcodeUrl?: string;
  scan?: number;
  queued?: boolean;
}

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

const previewReplies: WechatReplyItem[] = [
  { id: 1, type: "text", data: { content: "欢迎关注 CinaShop，回复“订单”可查看订单帮助。" }, status: 1, hide: 0, key: "subscribe", keys: ["subscribe"], typeName: "文字消息" },
  { id: 2, type: "text", data: { content: "暂时没有匹配内容，稍后会由客服继续处理。" }, status: 1, hide: 0, key: "default", keys: ["default"], typeName: "文字消息" },
  { id: 3, type: "text", data: { content: "请打开订单详情查看最新物流进度。" }, status: 1, hide: 0, key: "订单,物流", keys: ["订单", "物流"], typeName: "文字消息" },
  { id: 4, type: "news", data: { id: 101, title: "夏日会员指南", synopsis: "会员权益与使用说明", image: "/logo.png", image_input: ["/logo.png"], url: "/pages/extension/news_details/index?id=101" }, status: 0, hide: 0, key: "会员", keys: ["会员"], typeName: "图文消息" },
];

const previewMedia: WechatMediaItem[] = [
  { id: 1, type: "image", path: "/logo.png", mediaId: "preview-image-media-id", url: "", temporary: 0, addTime: 1_800_000_000 },
  { id: 2, type: "voice", path: "/audio/welcome.mp3", mediaId: "preview-voice-media-id", url: "", temporary: 0, addTime: 1_800_000_100 },
];

const previewNews: WechatNewsCategory[] = [
  {
    id: 10,
    cateName: "夏日会员指南",
    sort: 20,
    status: 1,
    newId: "101,102",
    addTime: "1800000000",
    articleIds: [101, 102],
    articleCount: 2,
    firstArticle: null,
    articles: [
      { id: 101, title: "夏日会员指南", author: "CinaShop 运营", content: "会员等级、积分与专属权益使用说明。", synopsis: "会员权益与使用说明", image_input: ["/logo.png"], imageInput: "/logo.png", url: "", sort: 0, status: 1 },
      { id: 102, title: "积分兑换说明", author: "CinaShop 运营", content: "积分可在积分商城兑换指定商品。", synopsis: "积分获取与兑换规则", image_input: ["/logo.png"], imageInput: "/logo.png", url: "", sort: 1, status: 1 },
    ],
  },
  {
    id: 11,
    cateName: "售后服务手册",
    sort: 10,
    status: 1,
    newId: "103",
    addTime: "1799900000",
    articleIds: [103],
    articleCount: 1,
    firstArticle: null,
    articles: [
      { id: 103, title: "售后服务手册", author: "CinaShop 客服", content: "退换货申请、审核与退款到账说明。", synopsis: "售后处理流程", image_input: ["/logo.png"], imageInput: "/logo.png", url: "", sort: 0, status: 1 },
    ],
  },
];
for (const item of previewNews) item.firstArticle = item.articles?.[0] ?? null;

const previewMessages: WechatMessageRecord[] = [
  { id: 301, openidMasked: "o9sA***8K2p", type: "text", result: { MsgType: "text", Content: "订单", FromUserName: "o9sA***8K2p" }, addTime: 1_800_002_000 },
  { id: 300, openidMasked: "o42B***19Lm", type: "subscribe", result: { Event: "subscribe", EventKey: "" }, addTime: 1_800_001_500 },
  { id: 299, openidMasked: "o9sA***8K2p", type: "click", result: { Event: "CLICK", EventKey: "MEMBER_CENTER" }, addTime: 1_800_001_000 },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function apiWechatReservedReply(key: "subscribe" | "default"): Promise<{ info: WechatReplyItem | null; ambiguous: boolean }> {
  if (previewMode) return Promise.resolve({ info: clone(previewReplies.find((item) => item.keys.includes(key)) ?? null), ambiguous: false });
  return getData(request.get<{ info: WechatReplyItem | null; ambiguous: boolean }>("/wechat/reply", { params: { key } }));
}

export function apiWechatReplyList(params: Record<string, unknown> = {}): Promise<{ list: WechatReplyItem[]; count: number }> {
  if (previewMode) {
    const key = String(params.key ?? "").trim();
    const type = String(params.type ?? "").trim();
    const rows = previewReplies.filter((item) => !item.keys.some((value) => ["subscribe", "default"].includes(value)))
      .filter((item) => !key || item.key.includes(key))
      .filter((item) => !type || item.type === type);
    return Promise.resolve({ list: clone(rows), count: rows.length });
  }
  return getData(request.get<{ list: WechatReplyItem[]; count: number }>("/wechat/keyword", { params }));
}

export function apiWechatReplyDetail(id: number): Promise<{ info: WechatReplyItem }> {
  if (previewMode) return Promise.resolve({ info: clone(previewReplies.find((item) => item.id === id)!) });
  return getData(request.get<{ info: WechatReplyItem }>(`/wechat/keyword/${id}`));
}

export function apiWechatReplySave(id: number, data: Record<string, unknown>): Promise<{ id: number }> {
  if (previewMode) {
    const keys = String(data.key ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    const type = String(data.type ?? "text") as WechatReplyType;
    const current = previewReplies.find((item) => item.id === id);
    const nextId = current?.id ?? Math.max(...previewReplies.map((item) => item.id), 0) + 1;
    const row: WechatReplyItem = { id: nextId, type, data: clone(data.data as Record<string, unknown>), status: Number(data.status ?? 1), hide: 0, key: keys.join(","), keys, typeName: ({ text: "文字消息", image: "图片消息", news: "图文消息", voice: "语音消息" })[type] };
    if (current) Object.assign(current, row); else previewReplies.push(row);
    return Promise.resolve({ id: nextId });
  }
  return getData(request.post<{ id: number }>(`/wechat/keyword/${id}`, data));
}

export function apiWechatReplyDelete(id: number): Promise<null> {
  if (previewMode) {
    const index = previewReplies.findIndex((item) => item.id === id);
    if (index >= 0) previewReplies.splice(index, 1);
    return Promise.resolve(null);
  }
  return getData(request.delete<null>(`/wechat/keyword/${id}`));
}

export function apiWechatReplyStatus(id: number, status: number): Promise<null> {
  if (previewMode) {
    const item = previewReplies.find((row) => row.id === id);
    if (item) item.status = status;
    return Promise.resolve(null);
  }
  return getData(request.put<null>(`/wechat/keyword/set_status/${id}/${status}`));
}

export function apiWechatReplyCodeStatus(id: number): Promise<WechatReplyCodeStatus> {
  if (previewMode) return Promise.resolve({ status: "ready", url: "/logo.png", qrcodeUrl: "weixin://preview", scan: id * 3 });
  return getData(request.get<WechatReplyCodeStatus>(`/wechat/code_reply/${id}`));
}

export function apiWechatReplyCodeProvision(id: number): Promise<WechatReplyCodeStatus> {
  if (previewMode) return Promise.resolve({ status: "ready", url: "/logo.png", qrcodeUrl: "weixin://preview", scan: id * 3, queued: false });
  return getData(request.post<WechatReplyCodeStatus>(`/wechat/code_reply/${id}/provision`));
}

export function apiWechatMediaList(type?: "image" | "voice"): Promise<{ list: WechatMediaItem[]; count: number }> {
  if (previewMode) {
    const rows = type ? previewMedia.filter((item) => item.type === type) : previewMedia;
    return Promise.resolve({ list: clone(rows), count: rows.length });
  }
  return getData(request.get<{ list: WechatMediaItem[]; count: number }>("/wechat/media", { params: { type, limit: 100 } }));
}

export function apiWechatNewsList(params: Record<string, unknown> = {}): Promise<{ list: WechatNewsCategory[]; count: number }> {
  if (previewMode) {
    const name = String(params.cate_name ?? "").trim();
    const rows = previewNews.filter((item) => !name || item.cateName.includes(name));
    return Promise.resolve({ list: clone(rows), count: rows.length });
  }
  return getData(request.get<{ list: WechatNewsCategory[]; count: number }>("/wechat/news", { params }));
}

export function apiWechatNewsDetail(id: number): Promise<{ info: WechatNewsCategory }> {
  if (previewMode) return Promise.resolve({ info: clone(previewNews.find((item) => item.id === id)!) });
  return getData(request.get<{ info: WechatNewsCategory }>(`/wechat/news/${id}`));
}

export function apiWechatNewsSave(data: Record<string, unknown>): Promise<{ id: number; articleIds: number[] }> {
  if (previewMode) {
    const id = Number(data.id ?? 0) || Math.max(...previewNews.map((item) => item.id), 0) + 1;
    const list = clone(data.list as WechatNewsArticle[]).map((article, index) => ({
      ...article,
      id: article.id || 1_000 + id * 10 + index,
      imageInput: article.imageInput || article.image_input?.[0] || "",
      image_input: article.image_input?.length ? article.image_input : article.imageInput ? [article.imageInput] : [],
      status: 1,
    }));
    const row: WechatNewsCategory = { id, cateName: list[0].title, sort: Number(data.sort ?? 0), status: Number(data.status ?? 1), newId: list.map((item) => item.id).join(","), addTime: String(Math.floor(Date.now() / 1000)), articleIds: list.map((item) => item.id), articleCount: list.length, firstArticle: list[0], articles: list };
    const index = previewNews.findIndex((item) => item.id === id);
    if (index >= 0) previewNews[index] = row; else previewNews.unshift(row);
    return Promise.resolve({ id, articleIds: row.articleIds });
  }
  return getData(request.post<{ id: number; articleIds: number[] }>("/wechat/news", data));
}

export function apiWechatNewsDelete(id: number): Promise<null> {
  if (previewMode) {
    const index = previewNews.findIndex((item) => item.id === id);
    if (index >= 0) previewNews.splice(index, 1);
    return Promise.resolve(null);
  }
  return getData(request.delete<null>(`/wechat/news/${id}`));
}

export function apiWechatMessageTypes(): Promise<Array<{ value: string; label: string; count: number }>> {
  if (previewMode) {
    const counts = new Map<string, number>();
    for (const item of previewMessages) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
    return Promise.resolve([...counts].map(([value, count]) => ({ value, label: value, count })));
  }
  return getData(request.get<Array<{ value: string; label: string; count: number }>>("/wechat/message/operate"));
}

export function apiWechatMessageList(params: Record<string, unknown> = {}): Promise<{ list: WechatMessageRecord[]; count: number }> {
  if (previewMode) {
    const type = String(params.type ?? "").trim();
    const rows = previewMessages.filter((item) => !type || item.type === type);
    return Promise.resolve({ list: clone(rows), count: rows.length });
  }
  return getData(request.get<{ list: WechatMessageRecord[]; count: number }>("/wechat/message", { params }));
}
