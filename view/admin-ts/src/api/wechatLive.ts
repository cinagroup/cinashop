import request, { getData } from "@/utils/request";

export interface WechatLiveRoom {
  id: number;
  phone: string;
  room_id: number;
  name: string;
  cover_img: string;
  share_img: string;
  start_time: number;
  end_time: number;
  anchor_name: string;
  anchor_wechat: string;
  live_status: number;
  replay_status: number;
  is_show: number;
  add_time: number;
}

export interface WechatLiveGood {
  id: number;
  goods_id: number;
  product_id: number;
  name: string;
  cover_img: string;
  price_type: number;
  cost_price: string;
  price: string;
  price2: string;
  audit_status: number;
  is_show: number;
  add_time: number;
}

export interface WechatLiveAnchor {
  id: number;
  name: string;
  cover_img: string;
  wechat: string;
  phone: string;
  is_show: number;
  add_time: number;
}

interface PageResult<T> {
  list: T[];
  count: number;
  remote_writes?: "not_migrated_non_idempotent";
  remote_role_sync?: "read_only_queue";
}

export interface WechatLiveAnchorInput {
  id: number;
  name: string;
  wechat: string;
  phone: string;
  cover_img: string;
}

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

const previewRooms: WechatLiveRoom[] = [
  { id: 9, phone: "138****6601", room_id: 300091, name: "夏日家居好物专场", cover_img: "", share_img: "", start_time: 1_786_252_200, end_time: 1_786_255_800, anchor_name: "小雅", anchor_wechat: "xiaoya_live", live_status: 101, replay_status: 0, is_show: 1, add_time: 1_786_240_000 },
  { id: 8, phone: "138****6602", room_id: 300088, name: "新品开箱与使用演示", cover_img: "", share_img: "", start_time: 1_786_160_000, end_time: 1_786_163_600, anchor_name: "阿辰", anchor_wechat: "achen_store", live_status: 103, replay_status: 1, is_show: 1, add_time: 1_786_150_000 },
  { id: 7, phone: "138****6603", room_id: 300081, name: "周末会员福利场", cover_img: "", share_img: "", start_time: 1_786_338_600, end_time: 1_786_342_200, anchor_name: "小雅", anchor_wechat: "xiaoya_live", live_status: 102, replay_status: 0, is_show: 1, add_time: 1_786_230_000 },
];

const previewGoods: WechatLiveGood[] = [
  { id: 21, goods_id: 710021, product_id: 1288, name: "多功能折叠收纳架", cover_img: "", price_type: 1, cost_price: "89.00", price: "59.00", price2: "0.00", audit_status: 2, is_show: 1, add_time: 1_786_235_000 },
  { id: 20, goods_id: 710020, product_id: 1279, name: "便携榨汁杯", cover_img: "", price_type: 2, cost_price: "129.00", price: "79.00", price2: "99.00", audit_status: 1, is_show: 1, add_time: 1_786_225_000 },
  { id: 19, goods_id: 710019, product_id: 1260, name: "轻量晴雨伞", cover_img: "", price_type: 1, cost_price: "49.00", price: "35.00", price2: "0.00", audit_status: 3, is_show: 0, add_time: 1_786_210_000 },
];

const previewAnchors: WechatLiveAnchor[] = [
  { id: 5, name: "小雅", cover_img: "/uploads/live/xiaoya.jpg", wechat: "xiaoya_live", phone: "13800006601", is_show: 1, add_time: 1_786_100_000 },
  { id: 4, name: "阿辰", cover_img: "/uploads/live/achen.jpg", wechat: "achen_store", phone: "13800006602", is_show: 1, add_time: 1_786_090_000 },
  { id: 3, name: "林琳", cover_img: "/uploads/live/linlin.jpg", wechat: "linlin_shop", phone: "13800006604", is_show: 0, add_time: 1_786_080_000 },
];

function previewPage<T>(rows: T[], params: Record<string, unknown>, text: (row: T) => string): PageResult<T> {
  const keyword = String(params.keyword ?? "").trim().toLowerCase();
  const filtered = keyword ? rows.filter((row) => text(row).toLowerCase().includes(keyword)) : rows;
  return { list: structuredClone(filtered), count: filtered.length };
}

export function apiWechatLiveRooms(params: Record<string, unknown> = {}): Promise<PageResult<WechatLiveRoom>> {
  if (previewMode) {
    const status = Number(params.status ?? 0);
    let rows = previewRooms;
    if (status === 1) rows = rows.filter((row) => [101, 105, 106].includes(row.live_status));
    if (status === 2) rows = rows.filter((row) => row.live_status === 102);
    if (status === 3) rows = rows.filter((row) => [103, 104, 107].includes(row.live_status));
    return Promise.resolve(previewPage(rows, params, (row) => `${row.name}${row.anchor_name}${row.anchor_wechat}`));
  }
  return getData(request.get("/live/room/list", { params }));
}

export function apiWechatLiveRoomDetail(id: number): Promise<WechatLiveRoom> {
  if (previewMode) {
    const row = previewRooms.find((item) => item.id === id);
    if (!row) return Promise.reject(new Error("直播间不存在或已删除"));
    return Promise.resolve(structuredClone(row));
  }
  return getData(request.get(`/live/room/detail/${id}`));
}

export function apiWechatLiveRoomShow(id: number, isShow: 0 | 1): Promise<{ room: WechatLiveRoom }> {
  if (previewMode) {
    const row = previewRooms.find((item) => item.id === id);
    if (!row) return Promise.reject(new Error("直播间不存在或已删除"));
    row.is_show = isShow;
    return Promise.resolve({ room: structuredClone(row) });
  }
  return getData(request.get(`/live/room/set_show/${id}/${isShow}`));
}

export function apiWechatLiveRoomDelete(id: number): Promise<{ id: number; deleted: true }> {
  if (previewMode) {
    const index = previewRooms.findIndex((item) => item.id === id);
    if (index < 0) return Promise.reject(new Error("直播间不存在或已删除"));
    previewRooms.splice(index, 1);
    return Promise.resolve({ id, deleted: true });
  }
  return getData(request.delete(`/live/room/del/${id}`));
}

export function apiWechatLiveGoods(params: Record<string, unknown> = {}): Promise<PageResult<WechatLiveGood>> {
  if (previewMode) {
    const status = params.status === undefined || params.status === "" ? 99 : Number(params.status);
    let rows = previewGoods;
    if (status === 1) rows = rows.filter((row) => row.audit_status === 2);
    if (status === 0) rows = rows.filter((row) => [0, 1].includes(row.audit_status));
    if (status === -1) rows = rows.filter((row) => row.audit_status === 3);
    return Promise.resolve(previewPage(rows, params, (row) => `${row.name}${row.product_id}${row.goods_id}`));
  }
  return getData(request.get("/live/goods/list", { params }));
}

export function apiWechatLiveGoodsDetail(id: number): Promise<WechatLiveGood> {
  if (previewMode) {
    const row = previewGoods.find((item) => item.id === id);
    if (!row) return Promise.reject(new Error("直播商品不存在或已删除"));
    return Promise.resolve(structuredClone(row));
  }
  return getData(request.get(`/live/goods/detail/${id}`));
}

export function apiWechatLiveGoodsShow(id: number, isShow: 0 | 1): Promise<{ goods: WechatLiveGood }> {
  if (previewMode) {
    const row = previewGoods.find((item) => item.id === id);
    if (!row) return Promise.reject(new Error("直播商品不存在或已删除"));
    if (row.audit_status !== 2) return Promise.reject(new Error("仅审核通过的直播商品可以切换显示状态"));
    row.is_show = isShow;
    return Promise.resolve({ goods: structuredClone(row) });
  }
  return getData(request.get(`/live/goods/set_show/${id}/${isShow}`));
}

export function apiWechatLiveAnchors(params: Record<string, unknown> = {}): Promise<PageResult<WechatLiveAnchor>> {
  if (previewMode) {
    return Promise.resolve(previewPage(previewAnchors, params, (row) => `${row.name}${row.wechat}${row.phone}`));
  }
  return getData(request.get("/live/anchor/list", { params }));
}

export function apiWechatLiveAnchorForm(id: number): Promise<WechatLiveAnchor> {
  if (previewMode) {
    if (id === 0) return Promise.resolve({ id: 0, name: "", cover_img: "", wechat: "", phone: "", is_show: 1, add_time: 0 });
    const row = previewAnchors.find((item) => item.id === id);
    if (!row) return Promise.reject(new Error("主播不存在或已删除"));
    return Promise.resolve(structuredClone(row));
  }
  return getData(request.get(`/live/anchor/add/${id}`));
}

export function apiWechatLiveAnchorSave(input: WechatLiveAnchorInput): Promise<{ anchor: WechatLiveAnchor }> {
  if (previewMode) {
    const duplicate = previewAnchors.find((item) => item.wechat === input.wechat && item.id !== input.id);
    if (duplicate) return Promise.reject(new Error("该主播已经存在"));
    if (input.id) {
      const row = previewAnchors.find((item) => item.id === input.id);
      if (!row) return Promise.reject(new Error("主播不存在或已删除"));
      Object.assign(row, input);
      return Promise.resolve({ anchor: structuredClone(row) });
    }
    const anchor: WechatLiveAnchor = {
      ...input,
      id: Math.max(0, ...previewAnchors.map((item) => item.id)) + 1,
      is_show: 1,
      add_time: Math.floor(Date.now() / 1000),
    };
    previewAnchors.unshift(anchor);
    return Promise.resolve({ anchor: structuredClone(anchor) });
  }
  return getData(request.post("/live/anchor/save", input));
}

export function apiWechatLiveAnchorShow(id: number, isShow: 0 | 1): Promise<{ anchor: WechatLiveAnchor }> {
  if (previewMode) {
    const row = previewAnchors.find((item) => item.id === id);
    if (!row) return Promise.reject(new Error("主播不存在或已删除"));
    row.is_show = isShow;
    return Promise.resolve({ anchor: structuredClone(row) });
  }
  return getData(request.get(`/live/anchor/set_show/${id}/${isShow}`));
}

export function apiWechatLiveAnchorDelete(id: number): Promise<{ id: number; deleted: true }> {
  if (previewMode) {
    const index = previewAnchors.findIndex((item) => item.id === id);
    if (index < 0) return Promise.reject(new Error("主播不存在或已删除"));
    if (previewRooms.some((room) => room.anchor_wechat === previewAnchors[index].wechat)) {
      return Promise.reject(new Error("该主播仍有关联直播间，请先处理直播间"));
    }
    previewAnchors.splice(index, 1);
    return Promise.resolve({ id, deleted: true });
  }
  return getData(request.delete(`/live/anchor/del/${id}`));
}

export function apiWechatLiveSync(): Promise<{ run_id: string; jobs: string[] }> {
  if (previewMode) {
    return Promise.resolve({ run_id: `preview:${Date.now()}`, jobs: ["live_room_sync", "live_goods_sync", "live_anchor_sync"] });
  }
  return getData(request.post("/live/sync"));
}
