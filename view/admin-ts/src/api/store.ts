import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export interface PageResult<T> {
  list: T[];
  count: number;
  page: number;
  limit: number;
}

export interface StoreItem {
  id: number;
  erp_shop_id: number;
  name: string;
  introduction: string;
  phone: string;
  address: string;
  province: number;
  city: number;
  area: number;
  street: number;
  detailed_address: string;
  image: string;
  oblong_image: string;
  latitude: string;
  longitude: string;
  valid_time: string;
  valid_range: number;
  day_time: string;
  day_start: string;
  day_end: string;
  add_time: number;
  is_show: number;
  is_del: number;
  is_store: number;
  latlng: string;
  status_name: string;
}

export interface StoreHeader {
  count: {
    show: { name: string; num: number };
    hide: { name: string; num: number };
    recycle: { name: string; num: number };
  };
}

export interface StoreOption { id: number; name: string }

export interface StaffItem {
  id: number;
  store_id: number;
  uid: number;
  account: string;
  avatar: string;
  staff_name: string;
  phone: string;
  roles: string;
  verify_status: number;
  status: number;
  is_admin: number;
  is_manager: number;
  is_cashier: number;
  add_time: number;
  name: string | null;
  nickname: string | null;
}

export interface DeliveryItem {
  id: number;
  uid: number;
  avatar: string;
  wx_name: string;
  nickname: string;
  phone: string;
  status: number;
  add_time: number;
}

const previewStores: StoreItem[] = [
  {
    id: 3, erp_shop_id: 0, name: "深圳科技园店", introduction: "工作日自提与同城配送",
    phone: "13800138000", address: "广东省,深圳市,南山区", province: 0, city: 0, area: 0,
    street: 0, detailed_address: "科苑路 15 号", image: "", oblong_image: "",
    latitude: "22.5404", longitude: "113.9468", valid_time: "", valid_range: 5000,
    day_time: "09:00 - 20:00", day_start: "09:00", day_end: "20:00", add_time: 1_785_000_000,
    is_show: 1, is_del: 0, is_store: 1, latlng: "22.5404,113.9468", status_name: "营业中",
  },
  {
    id: 2, erp_shop_id: 0, name: "新加坡体验店", introduction: "线下体验点",
    phone: "13900139000", address: "Singapore,Central Area", province: 0, city: 0, area: 0,
    street: 0, detailed_address: "1 Raffles Place", image: "", oblong_image: "",
    latitude: "1.2847", longitude: "103.8510", valid_time: "", valid_range: 3000,
    day_time: "10:00 - 19:00", day_start: "10:00", day_end: "19:00", add_time: 1_784_000_000,
    is_show: 0, is_del: 0, is_store: 1, latlng: "1.2847,103.8510", status_name: "已停业",
  },
];

const previewStaff: StaffItem[] = [
  { id: 8, store_id: 3, uid: 1024, account: "", avatar: "", staff_name: "陈店长", phone: "13800138001", roles: "", verify_status: 1, status: 1, is_admin: 0, is_manager: 1, is_cashier: 1, add_time: 1_785_000_000, name: "深圳科技园店", nickname: "Cina" },
  { id: 7, store_id: 3, uid: 1025, account: "", avatar: "", staff_name: "核销员 A", phone: "13800138002", roles: "", verify_status: 1, status: 0, is_admin: 0, is_manager: 0, is_cashier: 0, add_time: 1_784_000_000, name: "深圳科技园店", nickname: "Operator" },
];

const previewDelivery: DeliveryItem[] = [
  { id: 6, uid: 1030, avatar: "", wx_name: "配送员周师傅", nickname: "周师傅", phone: "13800138003", status: 1, add_time: 1_785_000_000 },
  { id: 5, uid: 1031, avatar: "", wx_name: "配送员林师傅", nickname: "林师傅", phone: "13800138004", status: 0, add_time: 1_784_000_000 },
];

function page<T>(list: T[], pageNo = 1, limit = 20): PageResult<T> {
  return { list: list.slice((pageNo - 1) * limit, pageNo * limit), count: list.length, page: pageNo, limit };
}

export async function apiStoreList(params: Record<string, unknown>): Promise<PageResult<StoreItem>> {
  if (previewMode) {
    const keyword = String(params.keywords ?? "").toLowerCase();
    const type = String(params.type ?? "");
    const list = previewStores.filter((row) =>
      (!keyword || `${row.name}${row.phone}${row.address}${row.detailed_address}`.toLowerCase().includes(keyword))
      && (type === "1" ? row.is_show === 1 && row.is_del === 0 : type === "-1" ? row.is_show === 0 && row.is_del === 0 : type === "2" ? row.is_del === 1 : row.is_del === 0),
    );
    return page(list, Number(params.page ?? 1), Number(params.limit ?? 20));
  }
  return getData(request.get<PageResult<StoreItem>>("/merchant/store", { params }));
}

export async function apiStoreHeader(): Promise<StoreHeader> {
  if (previewMode) return {
    count: {
      show: { name: "显示中的提货点", num: previewStores.filter((row) => !row.is_del && row.is_show).length },
      hide: { name: "隐藏中的提货点", num: previewStores.filter((row) => !row.is_del && !row.is_show).length },
      recycle: { name: "回收站的提货点", num: previewStores.filter((row) => row.is_del).length },
    },
  };
  return getData(request.get<StoreHeader>("/merchant/store/get_header"));
}

export async function apiStoreOptions(): Promise<StoreOption[]> {
  if (previewMode) return previewStores.filter((row) => !row.is_del).map(({ id, name }) => ({ id, name }));
  return getData(request.get<StoreOption[]>("/merchant/store_list"));
}

export async function apiStoreSave(id: number, data: Record<string, unknown>): Promise<{ id: number }> {
  if (previewMode) {
    const existing = previewStores.find((row) => row.id === id);
    const target = existing ?? ({ id: Math.max(...previewStores.map((row) => row.id)) + 1 } as StoreItem);
    Object.assign(target, data, {
      address: Array.isArray(data.address) ? data.address.join(",") : data.address,
      latitude: String(data.latitude ?? ""), longitude: String(data.longitude ?? ""),
      latlng: `${data.latitude ?? ""},${data.longitude ?? ""}`,
      day_time: data.day_time, is_del: target.is_del ?? 0,
      status_name: Number(data.is_show) === 1 ? "营业中" : "已停业",
    });
    if (!existing) previewStores.unshift(target);
    return { id: target.id };
  }
  return getData(request.post<{ id: number }>(`/merchant/store/${id}`, data));
}

export async function apiStoreVisibility(id: number, status: number) {
  if (previewMode) { const row = previewStores.find((item) => item.id === id); if (row) row.is_show = status; return { id, is_show: status }; }
  return getData(request.put<{ id: number; is_show: number }>(`/merchant/store/set_show/${id}/${status}`));
}

export async function apiStoreDelete(id: number) {
  if (previewMode) { const row = previewStores.find((item) => item.id === id); if (row) row.is_del = row.is_del ? 0 : 1; return { id, is_del: row?.is_del ?? 0 }; }
  return getData(request.delete<{ id: number; is_del: number }>(`/merchant/store/del/${id}`));
}

export async function apiStaffList(params: Record<string, unknown>): Promise<PageResult<StaffItem>> {
  if (previewMode) {
    const storeId = Number(params.store_id ?? 0); const keyword = String(params.keyword ?? "").toLowerCase();
    return page(previewStaff.filter((row) => (!storeId || row.store_id === storeId) && (!keyword || `${row.staff_name}${row.phone}${row.uid}`.toLowerCase().includes(keyword))), Number(params.page ?? 1), Number(params.limit ?? 20));
  }
  return getData(request.get<PageResult<StaffItem>>("/merchant/store_staff", { params }));
}

export async function apiStaffSave(id: number, data: Record<string, unknown>) {
  if (previewMode) {
    const row = previewStaff.find((item) => item.id === id);
    if (row) {
      Object.assign(row, data);
      row.name = previewStores.find((item) => item.id === Number(data.store_id ?? row.store_id))?.name ?? row.name;
      return { id: row.id };
    }
    const storeId = Number(data.store_id ?? 0);
    const target: StaffItem = {
      id: Math.max(0, ...previewStaff.map((item) => item.id)) + 1,
      store_id: storeId,
      uid: Number(data.uid ?? 0),
      account: "",
      avatar: String(data.avatar ?? ""),
      staff_name: String(data.staff_name ?? ""),
      phone: String(data.phone ?? ""),
      roles: "",
      verify_status: Number(data.verify_status ?? 1),
      status: Number(data.status ?? 1),
      is_admin: 0,
      is_manager: 0,
      is_cashier: 0,
      add_time: Math.floor(Date.now() / 1000),
      name: previewStores.find((item) => item.id === storeId)?.name ?? null,
      nickname: null,
    };
    previewStaff.unshift(target);
    return { id: target.id };
  }
  return getData(request.post<{ id: number }>(`/merchant/store_staff/save/${id}`, data));
}

export async function apiStaffStatus(id: number, status: number) {
  if (previewMode) { const row = previewStaff.find((item) => item.id === id); if (row) row.status = status; return { id, status }; }
  return getData(request.put<{ id: number; status: number }>(`/merchant/store_staff/set_show/${id}/${status}`));
}

export async function apiStaffDelete(id: number) {
  if (previewMode) { const index = previewStaff.findIndex((item) => item.id === id); if (index >= 0) previewStaff.splice(index, 1); return null; }
  return getData(request.delete<null>(`/merchant/store_staff/del/${id}`));
}

export async function apiDeliveryList(params: Record<string, unknown>): Promise<PageResult<DeliveryItem>> {
  if (previewMode) {
    const keyword = String(params.keyword ?? "").toLowerCase();
    return page(previewDelivery.filter((row) => !keyword || `${row.nickname}${row.phone}${row.uid}`.toLowerCase().includes(keyword)), Number(params.page ?? 1), Number(params.limit ?? 20));
  }
  return getData(request.get<PageResult<DeliveryItem>>("/order/delivery/index", { params }));
}

export async function apiDeliverySave(id: number, data: Record<string, unknown>) {
  if (previewMode) {
    const row = previewDelivery.find((item) => item.id === id);
    if (row) {
      Object.assign(row, data);
      row.wx_name = String(data.nickname ?? row.wx_name);
      return { id: row.id };
    }
    const uid = Number(data.uid ?? 0);
    const nickname = String(data.nickname ?? `UID ${uid}`);
    const target: DeliveryItem = {
      id: Math.max(0, ...previewDelivery.map((item) => item.id)) + 1,
      uid,
      avatar: String(data.avatar ?? ""),
      wx_name: nickname,
      nickname,
      phone: String(data.phone ?? ""),
      status: Number(data.status ?? 1),
      add_time: Math.floor(Date.now() / 1000),
    };
    previewDelivery.unshift(target);
    return { id: target.id };
  }
  return getData(id > 0
    ? request.put<{ id: number }>(`/order/delivery/update/${id}`, data)
    : request.post<{ id: number }>("/order/delivery/save", data));
}

export async function apiDeliveryStatus(id: number, status: number) {
  if (previewMode) { const row = previewDelivery.find((item) => item.id === id); if (row) row.status = status; return { id, status }; }
  return getData(request.put<{ id: number; status: number }>(`/order/delivery/set_status/${id}/${status}`));
}

export async function apiDeliveryDelete(id: number) {
  if (previewMode) { const index = previewDelivery.findIndex((item) => item.id === id); if (index >= 0) previewDelivery.splice(index, 1); return null; }
  return getData(request.delete<null>(`/order/delivery/del/${id}`));
}
