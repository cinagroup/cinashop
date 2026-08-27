import request, { getData } from "@/utils/request";

export type ChannelReplyType = "text" | "image" | "voice" | "news" | "url";

export interface ChannelCategory {
  id: number;
  cate_name: string;
  cateName?: string;
  add_time?: number;
}

export interface ChannelItem {
  id: number;
  uid: number;
  name: string;
  image: string;
  cate_id: number;
  cateName: string;
  labelIds: number[];
  label_name: string[];
  type: ChannelReplyType;
  follow: number;
  scan: number;
  y_follow: number;
  add_time: number;
  continue_time: number;
  end_time: number;
  stop: number;
  status: number;
  nickname: string;
  avatar: string;
  provisioning: "ready" | "pending";
}

export interface ChannelDetail extends ChannelItem {
  content: Record<string, unknown>;
  data: Record<string, unknown>;
  time: number;
}

export interface ChannelUser {
  uid: number;
  isFollow: number;
  lastScanTime: number;
  nickname: string | null;
  avatar: string | null;
  userType: string | null;
}

export interface ChannelStatistics {
  all_follow: number;
  all_scan: number;
  y_follow: number;
  y_scan: number;
  trend: {
    xAxis: string[];
    series: Array<{ name: string; type: "line"; data: number[] }>;
  };
}

export interface ChannelLabel {
  id: number;
  name: string;
  color?: string;
  status: number;
  type?: number;
  relationId?: number;
}

export interface ChannelPromoter {
  uid: number;
  nickname: string;
  avatar?: string;
  status?: number;
}

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

const previewCategories: ChannelCategory[] = [
  { id: 1, cate_name: "线下门店", cateName: "线下门店", add_time: 1_800_000_000 },
  { id: 2, cate_name: "内容投放", cateName: "内容投放", add_time: 1_800_000_100 },
  { id: 3, cate_name: "员工推广", cateName: "员工推广", add_time: 1_800_000_200 },
];

const previewLabels: ChannelLabel[] = [
  { id: 8, name: "线下到店", color: "#16a34a", status: 1, type: 0, relationId: 0 },
  { id: 12, name: "新品关注", color: "#2563eb", status: 1, type: 0, relationId: 0 },
  { id: 16, name: "员工邀请", color: "#9333ea", status: 1, type: 0, relationId: 0 },
];

const previewPromoters: ChannelPromoter[] = [
  { uid: 1001, nickname: "上海旗舰店", avatar: "/logo.png", status: 1 },
  { uid: 1028, nickname: "内容运营小林", avatar: "/logo.png", status: 1 },
  { uid: 1066, nickname: "华南招商主管", avatar: "/logo.png", status: 1 },
];

const previewChannels: ChannelDetail[] = [
  {
    id: 18, uid: 1001, name: "上海旗舰店收银台", image: "/logo.png", cate_id: 1,
    cateName: "线下门店", labelIds: [8, 12], label_name: ["线下到店", "新品关注"], type: "text",
    follow: 128, scan: 365, y_follow: 12, add_time: 1_800_001_000, continue_time: 0,
    end_time: 0, stop: 0, status: 1, nickname: "上海旗舰店", avatar: "/logo.png",
    provisioning: "ready", content: { content: "欢迎到店，回复“会员”领取到店权益。" },
    data: { content: "欢迎到店，回复“会员”领取到店权益。" }, time: 0,
  },
  {
    id: 17, uid: 1028, name: "小红书夏日投放", image: "", cate_id: 2,
    cateName: "内容投放", labelIds: [12], label_name: ["新品关注"], type: "url",
    follow: 64, scan: 207, y_follow: 7, add_time: 1_800_000_700, continue_time: 30,
    end_time: 1_802_592_700, stop: 1, status: 1, nickname: "内容运营小林", avatar: "/logo.png",
    provisioning: "pending", content: { content: "https://shop.example.com/summer" },
    data: { content: "https://shop.example.com/summer" }, time: 30,
  },
  {
    id: 16, uid: 1066, name: "华南招商会", image: "/logo.png", cate_id: 3,
    cateName: "员工推广", labelIds: [16], label_name: ["员工邀请"], type: "image",
    follow: 31, scan: 96, y_follow: 0, add_time: 1_799_000_000, continue_time: 14,
    end_time: 1_800_209_600, stop: -1, status: 0, nickname: "华南招商主管", avatar: "/logo.png",
    provisioning: "ready", content: { src: "/logo.png", media_id: "preview-image-media-id" },
    data: { src: "/logo.png", media_id: "preview-image-media-id" }, time: 14,
  },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function categoryName(id: number): string {
  return previewCategories.find((item) => item.id === id)?.cate_name ?? "";
}

function labelNames(ids: number[]): string[] {
  return ids.map((id) => previewLabels.find((item) => item.id === id)?.name ?? `标签 ${id}`);
}

export function apiChannelCategoryList(): Promise<{ data: ChannelCategory[]; count: number }> {
  if (previewMode) return Promise.resolve({ data: clone(previewCategories), count: previewCategories.length });
  return getData(request.get<{ data: ChannelCategory[]; count: number }>("/wechat_qrcode/cate/list"));
}

export function apiChannelCategorySave(data: { id?: number; cate_name: string }): Promise<{ id: number }> {
  if (previewMode) {
    const id = data.id || Math.max(...previewCategories.map((item) => item.id), 0) + 1;
    const row = { id, cate_name: data.cate_name, cateName: data.cate_name, add_time: Math.floor(Date.now() / 1000) };
    const index = previewCategories.findIndex((item) => item.id === id);
    if (index >= 0) previewCategories[index] = row; else previewCategories.push(row);
    return Promise.resolve({ id });
  }
  return getData(request.post<{ id: number }>("/wechat_qrcode/cate/save", data));
}

export function apiChannelCategoryDelete(id: number): Promise<null> {
  if (previewMode) {
    const index = previewCategories.findIndex((item) => item.id === id);
    if (index >= 0) previewCategories.splice(index, 1);
    return Promise.resolve(null);
  }
  return getData(request.delete<null>(`/wechat_qrcode/cate/del/${id}`));
}

export function apiChannelList(params: Record<string, unknown>): Promise<{ list: ChannelItem[]; count: number }> {
  if (previewMode) {
    const name = String(params.name ?? "").trim();
    const categoryId = Number(params.cate_id ?? 0);
    const requestedStatus = params.status === undefined || params.status === "" ? null : Number(params.status);
    const rows = previewChannels.filter((item) => (!name || item.name.includes(name))
      && (!categoryId || item.cate_id === categoryId)
      && (requestedStatus === null || item.status === requestedStatus));
    return Promise.resolve({ list: clone(rows), count: rows.length });
  }
  return getData(request.get<{ list: ChannelItem[]; count: number }>("/wechat_qrcode/list", { params }));
}

export function apiChannelDetail(id: number): Promise<{ info: ChannelDetail }> {
  if (previewMode) return Promise.resolve({ info: clone(previewChannels.find((item) => item.id === id)!) });
  return getData(request.get<{ info: ChannelDetail }>(`/wechat_qrcode/info/${id}`));
}

export function apiChannelSave(id: number, data: Record<string, unknown>): Promise<{ id: number; provisioning: "ready" | "pending"; queued: boolean }> {
  if (previewMode) {
    const current = previewChannels.find((item) => item.id === id);
    const nextId = current?.id ?? Math.max(...previewChannels.map((item) => item.id), 0) + 1;
    const labelIds = (data.label_id as number[]) ?? [];
    const promoter = previewPromoters.find((item) => item.uid === Number(data.uid));
    const row: ChannelDetail = {
      id: nextId, uid: Number(data.uid), name: String(data.name), image: current?.image ?? "",
      cate_id: Number(data.cate_id), cateName: categoryName(Number(data.cate_id)), labelIds,
      label_name: labelNames(labelIds), type: String(data.type) as ChannelReplyType,
      follow: current?.follow ?? 0, scan: current?.scan ?? 0, y_follow: current?.y_follow ?? 0,
      add_time: current?.add_time ?? Math.floor(Date.now() / 1000), continue_time: Number(data.time ?? 0),
      end_time: Number(data.time) ? Math.floor(Date.now() / 1000) + Number(data.time) * 86_400 : 0,
      stop: Number(data.time) ? 1 : 0, status: Number(data.status ?? current?.status ?? 1),
      nickname: promoter?.nickname ?? `UID ${data.uid}`, avatar: promoter?.avatar ?? "",
      provisioning: current?.provisioning ?? "pending", content: clone(data.content as Record<string, unknown>),
      data: clone(data.content as Record<string, unknown>), time: Number(data.time ?? 0),
    };
    const index = previewChannels.findIndex((item) => item.id === nextId);
    if (index >= 0) previewChannels[index] = row; else previewChannels.unshift(row);
    return Promise.resolve({ id: nextId, provisioning: row.provisioning, queued: !row.image });
  }
  return getData(request.post<{ id: number; provisioning: "ready" | "pending"; queued: boolean }>(`/wechat_qrcode/save/${id}`, data));
}

export function apiChannelDelete(id: number): Promise<null> {
  if (previewMode) {
    const index = previewChannels.findIndex((item) => item.id === id);
    if (index >= 0) previewChannels.splice(index, 1);
    return Promise.resolve(null);
  }
  return getData(request.delete<null>(`/wechat_qrcode/del/${id}`));
}

export function apiChannelStatus(id: number, status: number): Promise<null> {
  if (previewMode) {
    const row = previewChannels.find((item) => item.id === id);
    if (row) row.status = status;
    return Promise.resolve(null);
  }
  return getData(request.put<null>(`/wechat_qrcode/set_status/${id}/${status}`));
}

export function apiChannelProvision(id: number): Promise<{ status: "ready" | "pending"; queued: boolean; url?: string }> {
  if (previewMode) {
    const row = previewChannels.find((item) => item.id === id);
    if (row) row.provisioning = "pending";
    return Promise.resolve({ status: "pending", queued: true, url: "" });
  }
  return getData(request.post<{ status: "ready" | "pending"; queued: boolean; url?: string }>(`/wechat_qrcode/provision/${id}`));
}

export function apiChannelUsers(id: number): Promise<{ list: ChannelUser[]; count: number }> {
  if (previewMode) {
    const rows: ChannelUser[] = [
      { uid: 30021, isFollow: 1, lastScanTime: 1_800_003_600, nickname: "林小满", avatar: "/logo.png", userType: "wechat" },
      { uid: 30008, isFollow: 1, lastScanTime: 1_800_001_200, nickname: "Chen", avatar: "/logo.png", userType: "wechat" },
      { uid: 29982, isFollow: 0, lastScanTime: 1_799_990_000, nickname: "访客 29982", avatar: "", userType: "wechat" },
    ];
    return Promise.resolve({ list: rows.slice(0, id ? rows.length : 0), count: rows.length });
  }
  return getData(request.get<{ list: ChannelUser[]; count: number }>(`/wechat_qrcode/user_list/${id}`, { params: { page: 1, limit: 100 } }));
}

export function apiChannelStatistics(id: number, time = ""): Promise<ChannelStatistics> {
  if (previewMode) {
    return Promise.resolve({
      all_follow: 128 + id, all_scan: 365 + id, y_follow: 12, y_scan: 29,
      trend: {
        xAxis: ["08-04", "08-05", "08-06", "08-07", "08-08", "08-09", "08-10"],
        series: [
          { name: "新增关注", type: "line", data: [8, 12, 9, 17, 11, 15, 12] },
          { name: "新增参与", type: "line", data: [21, 34, 25, 49, 31, 42, 29] },
        ],
      },
    });
  }
  return getData(request.get<ChannelStatistics>(`/wechat_qrcode/statistic/${id}`, { params: { time } }));
}

export function apiChannelLabels(): Promise<ChannelLabel[]> {
  if (previewMode) return Promise.resolve(clone(previewLabels));
  return getData(request.get<ChannelLabel[]>("/user_label/list"));
}

export function apiChannelPromoters(keyword = ""): Promise<ChannelPromoter[]> {
  if (previewMode) {
    const needle = keyword.trim().toLowerCase();
    return Promise.resolve(clone(previewPromoters.filter((item) => !needle || `${item.uid}${item.nickname}`.toLowerCase().includes(needle))));
  }
  const uid = /^\d+$/.test(keyword.trim()) ? Number(keyword.trim()) : undefined;
  return getData<{ list: ChannelPromoter[] }>(request.get("/user/list", { params: { page: 1, limit: 20, uid } }))
    .then((result) => result.list);
}
