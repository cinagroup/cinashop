import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export interface MembershipBatch {
  id: number;
  title: string;
  total_num: number;
  use_day: number;
  use_num: number;
  status: number;
  sort: number;
  remark: string;
  add_time: number;
  update_time: number;
  actual_card_count: number;
  actual_used_count: number;
  counter_drift: boolean;
}

export interface IssuedMembershipCard {
  card_number: string;
  card_password: string;
}

export interface MembershipBatchSaveResult {
  id: number;
  issued_count: number;
  cards: IssuedMembershipCard[];
}

export interface MembershipCard {
  id: number;
  card_batch_id: number;
  card_number: string;
  password_configured: boolean;
  use_uid: number;
  use_time: number;
  status: number;
  add_time: number;
  update_time: number;
  username: string;
  phone: string;
}

export interface MembershipPlan {
  id: number;
  type: "free" | "month" | "quarter" | "year" | "ever";
  title: string;
  vip_day: number;
  price: string;
  pre_price: string;
  is_label: number;
  sort: number;
  is_del: number;
  add_time: number;
}

export interface MembershipRight {
  id: number;
  right_type: string;
  title: string;
  show_title: string;
  image: string;
  explain: string;
  content: string;
  number: number;
  sort: number;
  status: number;
  add_time: number;
}

export interface MembershipRecord {
  id: number;
  uid: number;
  order_id: string;
  member_type: string;
  member_title: string;
  member_plan_type: string;
  pay_type: string;
  pay_price: string;
  member_price: string;
  paid: number;
  pay_time: number;
  channel_type: string;
  is_free: number;
  is_permanent: number;
  overdue_time: number;
  vip_day: number;
  add_time: number;
  code_masked: string;
  username: string;
  phone: string;
}

export interface MembershipAgreement {
  id: number;
  type: number;
  title: string;
  content: string | null;
  sort: number;
  status: number;
  addTime: number;
}

export interface MembershipScan {
  wechat_img: string;
  wechat_url: string;
  routine: string;
  routine_status: "ready" | "not_configured" | "unavailable";
}

const now = Math.floor(Date.now() / 1_000);
const previewPlans: MembershipPlan[] = [
  { id: 1, type: "month", title: "月度会员", vip_day: 30, price: "29.90", pre_price: "19.90", is_label: 0, sort: 20, is_del: 0, add_time: now - 86_400 * 30 },
  { id: 2, type: "year", title: "年度会员", vip_day: 365, price: "238.00", pre_price: "168.00", is_label: 1, sort: 30, is_del: 0, add_time: now - 86_400 * 30 },
  { id: 3, type: "free", title: "7 天体验会员", vip_day: 7, price: "0.00", pre_price: "0.00", is_label: 0, sort: 10, is_del: 0, add_time: now - 86_400 * 20 },
];
const previewBatches: MembershipBatch[] = [
  { id: 21, title: "2026 夏季渠道体验卡", total_num: 200, use_day: 30, use_num: 48, status: 1, sort: 20, remark: "线下展会渠道", add_time: now - 86_400 * 10, update_time: now - 600, actual_card_count: 200, actual_used_count: 48, counter_drift: false },
  { id: 20, title: "合作伙伴体验卡", total_num: 80, use_day: 14, use_num: 12, status: 0, sort: 10, remark: "当前冻结", add_time: now - 86_400 * 45, update_time: now - 86_400, actual_card_count: 80, actual_used_count: 12, counter_drift: false },
];
const previewCards: MembershipCard[] = Array.from({ length: 12 }, (_, index) => ({
  id: 5000 + index,
  card_batch_id: 21,
  card_number: `MC0000000L0000${String(index + 1).padStart(2, "0")}ABCD`,
  password_configured: true,
  use_uid: index < 3 ? 8100 + index : 0,
  use_time: index < 3 ? now - index * 3_600 : 0,
  status: 1,
  add_time: now - 86_400 * 10,
  update_time: now - 600,
  username: index < 3 ? ["林夏", "周屿", "陈默"][index] : "",
  phone: index < 3 ? `1380000800${index}` : "",
}));
const previewRights: MembershipRight[] = [
  { id: 1, right_type: "discount", title: "会员专享价", show_title: "专享折扣", image: "", explain: "会员商品与活动享受专属价格", content: "以商品页实际会员价为准", number: 1, sort: 30, status: 1, add_time: now - 86_400 * 60 },
  { id: 2, right_type: "integral", title: "积分倍率", show_title: "双倍积分", image: "", explain: "确认收货后按权益倍率发放积分", content: "退款时按累计目标冲正积分", number: 2, sort: 20, status: 1, add_time: now - 86_400 * 60 },
];
const previewRecords: MembershipRecord[] = [
  { id: 101, uid: 8100, order_id: "hy202608130001", member_type: "2", member_title: "年度会员", member_plan_type: "year", pay_type: "weixin", pay_price: "168.00", member_price: "168.00", paid: 1, pay_time: now - 3_600, channel_type: "routine", is_free: 0, is_permanent: 0, overdue_time: now + 365 * 86_400, vip_day: 365, add_time: now - 3_800, code_masked: "", username: "林夏", phone: "13800008000" },
  { id: 100, uid: 8101, order_id: "hy202608120009", member_type: "free", member_title: "卡密激活", member_plan_type: "free", pay_type: "", pay_price: "0.00", member_price: "0.00", paid: 1, pay_time: now - 86_400, channel_type: "h5", is_free: 0, is_permanent: 0, overdue_time: now + 30 * 86_400, vip_day: 30, add_time: now - 86_400, code_masked: "MC00********ABCD", username: "周屿", phone: "13800008001" },
];
let previewAgreement: MembershipAgreement = {
  id: 1,
  type: 1,
  title: "付费会员服务协议",
  content: "开通前请确认套餐有效期、权益范围与退款规则。",
  sort: 0,
  status: 1,
  addTime: now - 86_400 * 90,
};

function pageResult<T>(rows: T[], params: Record<string, unknown>) {
  const page = Math.max(1, Number(params.page ?? 1));
  const limit = Math.max(1, Number(params.limit ?? 20));
  return { list: rows.slice((page - 1) * limit, page * limit), count: rows.length };
}

export async function apiMembershipBatches(params: Record<string, unknown> = {}): Promise<{ list: MembershipBatch[]; count: number }> {
  if (previewMode) return pageResult(previewBatches.map((row) => ({ ...row })), params);
  return getData(request.get<{ list: MembershipBatch[]; count: number }>("/member_batch/index", { params }));
}

export async function apiSaveMembershipBatch(id: number, data: Record<string, unknown>): Promise<MembershipBatchSaveResult> {
  if (previewMode) {
    const existing = previewBatches.find((row) => row.id === id);
    if (existing) {
      Object.assign(existing, { title: data.title, use_day: data.use_day, status: data.status, sort: data.sort, remark: data.remark, update_time: now });
      return { id, issued_count: 0, cards: [] };
    }
    const nextId = Math.max(...previewBatches.map((row) => row.id)) + 1;
    const total = Math.min(50, Number(data.total_num ?? 1));
    const cards = Array.from({ length: total }, (_, index) => ({
      card_number: `MC000000${nextId.toString(36).toUpperCase().padStart(2, "0")}0000${String(index + 1).padStart(2, "0")}QA`,
      card_password: `DEMO${String(index + 1).padStart(8, "0")}`,
    }));
    previewBatches.unshift({ id: nextId, title: String(data.title), total_num: total, use_day: Number(data.use_day), use_num: 0, status: Number(data.status ?? 0), sort: Number(data.sort ?? 0), remark: String(data.remark ?? ""), add_time: now, update_time: now, actual_card_count: total, actual_used_count: 0, counter_drift: false });
    return { id: nextId, issued_count: total, cards };
  }
  return getData(request.post<MembershipBatchSaveResult>(`/member_batch/save/${id}`, data));
}

export async function apiSetMembershipBatchStatus(id: number, status: number) {
  if (previewMode) {
    const row = previewBatches.find((item) => item.id === id);
    if (row) row.status = status;
    return { id };
  }
  return getData(request.post<{ id: number }>(`/member_batch/set_value/${id}`, { field: "status", value: status }));
}

export async function apiMembershipCards(batchId: number, params: Record<string, unknown> = {}): Promise<{ list: MembershipCard[]; count: number }> {
  if (previewMode) {
    const filtered = previewCards.filter((row) => row.card_batch_id === batchId || batchId === 21);
    return pageResult(filtered.map((row) => ({ ...row })), params);
  }
  return getData(request.get<{ list: MembershipCard[]; count: number }>(`/member_card/index/${batchId}`, { params }));
}

export async function apiSetMembershipCardStatus(card: Pick<MembershipCard, "id" | "card_batch_id">, status: number) {
  if (previewMode) {
    const row = previewCards.find((item) => item.id === card.id && item.card_batch_id === card.card_batch_id);
    if (row) row.status = status;
    return { id: card.id, card_batch_id: card.card_batch_id };
  }
  return getData(request.post<{ id: number; card_batch_id: number }>("/member_card/set_status", {
    card_id: card.id, card_batch_id: card.card_batch_id, status,
  }));
}

export async function apiMembershipPlans(params: Record<string, unknown> = {}): Promise<{ list: MembershipPlan[]; count: number }> {
  if (previewMode) return pageResult(previewPlans.filter((row) => !row.is_del).map((row) => ({ ...row })), params);
  return getData(request.get<{ list: MembershipPlan[]; count: number }>("/member/ship", { params }));
}

export async function apiSaveMembershipPlan(id: number, data: Record<string, unknown>) {
  if (previewMode) {
    const existing = previewPlans.find((row) => row.id === id);
    if (existing) Object.assign(existing, data);
    else previewPlans.push({ id: Math.max(...previewPlans.map((row) => row.id)) + 1, is_del: 0, add_time: now, ...(data as Omit<MembershipPlan, "id" | "is_del" | "add_time">) });
    return { id: existing?.id ?? previewPlans.at(-1)!.id };
  }
  return getData(request.post<{ id: number }>(`/member_ship/save/${id}`, data));
}

export async function apiSetMembershipPlanStatus(id: number, isDel: number) {
  if (previewMode) {
    const row = previewPlans.find((item) => item.id === id);
    if (row) row.is_del = isDel;
    return { id };
  }
  return getData(request.post<{ id: number }>("/member_ship/set_ship_status", { id, is_del: isDel }));
}

export async function apiMembershipRights(): Promise<{ list: MembershipRight[]; count: number }> {
  if (previewMode) return { list: previewRights.map((row) => ({ ...row })), count: previewRights.length };
  return getData(request.get<{ list: MembershipRight[]; count: number }>("/member/right"));
}

export async function apiSaveMembershipRight(id: number, data: Record<string, unknown>) {
  if (previewMode) {
    const existing = previewRights.find((row) => row.id === id);
    if (existing) Object.assign(existing, data);
    else previewRights.push({ id: Math.max(...previewRights.map((row) => row.id)) + 1, add_time: now, ...(data as Omit<MembershipRight, "id" | "add_time">) });
    return { id: existing?.id ?? previewRights.at(-1)!.id };
  }
  return getData(request.post<{ id: number }>(`/member_right/save/${id}`, data));
}

export async function apiMembershipRecords(params: Record<string, unknown> = {}): Promise<{ list: MembershipRecord[]; count: number }> {
  if (previewMode) return pageResult(previewRecords.map((row) => ({ ...row })), params);
  return getData(request.get<{ list: MembershipRecord[]; count: number }>("/member/record", { params }));
}

export async function apiMembershipAgreement(): Promise<MembershipAgreement | null> {
  if (previewMode) return { ...previewAgreement };
  return getData(request.get<MembershipAgreement | null>("/member/agreement"));
}

export async function apiSaveMembershipAgreement(data: Record<string, unknown>) {
  if (previewMode) {
    previewAgreement = { ...previewAgreement, ...data } as MembershipAgreement;
    return { id: previewAgreement.id };
  }
  return getData(request.post<{ id: number }>(`/member_agreement/save/${previewAgreement.id}`, data));
}

export async function apiMembershipScan(): Promise<MembershipScan> {
  if (previewMode) {
    return {
      wechat_img: "",
      wechat_url: "https://cinashop-pc.pages.dev/pages/annex/vip_active/index",
      routine: "",
      routine_status: "not_configured",
    };
  }
  return getData(request.get<MembershipScan>("/member_scan"));
}
