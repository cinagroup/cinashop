import request, { getData } from "@/utils/request";

const previewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export type DivisionRoleType = 1 | 2 | 3;

export interface DivisionRoleItem {
  uid: number;
  nickname: string;
  avatar: string;
  phone: string;
  divisionName: string;
  divisionType: DivisionRoleType;
  divisionPercent: number;
  divisionEndTime: number;
  divisionChangeTime: number;
  divisionStatus: number;
  divisionInvite: number;
  divisionId: number;
  agentId: number;
  staffId: number;
  downNum: number;
}

export interface DivisionOption { value: number; label: string }
export interface DivisionStatistics {
  divisionNum: number; agentNum: number; staffNum: number; orderNum: number;
  orderPrice: string; brokeragePrice: string;
}
export interface DivisionRankingItem {
  uid: number; nickname: string; downNum: number; orderPrice: string;
  brokeragePrice: string; orderNum: number;
}
export interface DivisionApplication {
  id: number; uid: number; divisionName: string; name: string; phone: string;
  divisionId: number; divisionInvite: number; images: unknown[]; addTime: number;
  status: number; statusTime: number; refusalReason: string;
}
export interface DivisionOrderItem {
  id: number; orderId: string; uid: number; realName: string; userPhone: string;
  payPrice: string; paid: number; status: number; refundStatus: number;
  divisionId: number; divisionBrokerage: string; divisionAgentId: number;
  divisionAgentBrokerage: string; divisionStaffId: number;
  divisionStaffBrokerage: string; addTime: number;
}

const previewRoles: DivisionRoleItem[] = [
  { uid: 1001, nickname: "华东运营中心", avatar: "", phone: "13800001001", divisionName: "华东事业部", divisionType: 1, divisionPercent: 60, divisionEndTime: 1819727999, divisionChangeTime: 1786237200, divisionStatus: 1, divisionInvite: 83642017, divisionId: 1001, agentId: 0, staffId: 0, downNum: 8 },
  { uid: 1002, nickname: "华南运营中心", avatar: "", phone: "13800001002", divisionName: "华南事业部", divisionType: 1, divisionPercent: 55, divisionEndTime: 1819727999, divisionChangeTime: 1786150800, divisionStatus: 1, divisionInvite: 72531904, divisionId: 1002, agentId: 0, staffId: 0, downNum: 5 },
  { uid: 2101, nickname: "杭州渠道一部", avatar: "", phone: "13800002101", divisionName: "杭州核心代理", divisionType: 2, divisionPercent: 42, divisionEndTime: 1819727999, divisionChangeTime: 1786064400, divisionStatus: 1, divisionInvite: 0, divisionId: 1001, agentId: 2101, staffId: 0, downNum: 12 },
  { uid: 3101, nickname: "陈晨", avatar: "", phone: "13800003101", divisionName: "", divisionType: 3, divisionPercent: 18, divisionEndTime: 1819727999, divisionChangeTime: 1785978000, divisionStatus: 1, divisionInvite: 0, divisionId: 1001, agentId: 2101, staffId: 3101, downNum: 0 },
];
const previewApplications: DivisionApplication[] = [
  { id: 41, uid: 2288, divisionName: "宁波优选代理", name: "林晓", phone: "13800002288", divisionId: 1001, divisionInvite: 83642017, images: [], addTime: 1786233600, status: 0, statusTime: 0, refusalReason: "" },
  { id: 40, uid: 2276, divisionName: "苏州新零售", name: "周明", phone: "13800002276", divisionId: 1001, divisionInvite: 83642017, images: [], addTime: 1786147200, status: 1, statusTime: 1786154400, refusalReason: "" },
];

export function apiDivisionRoleList(params: Record<string, unknown>) {
  if (previewMode) {
    const roleType = Number(params.division_type ?? 1);
    const keyword = String(params.keyword ?? "").toLowerCase();
    const list = previewRoles.filter((row) => row.divisionType === roleType && (!keyword || `${row.uid}${row.divisionName}${row.nickname}`.toLowerCase().includes(keyword)));
    return Promise.resolve({ list, count: list.length, page: Number(params.page ?? 1), limit: 20 });
  }
  return getData<{ list: DivisionRoleItem[]; count: number; page: number; limit: number }>(
    request.get("/agent/division/list", { params }),
  );
}
export function apiDivisionRoleDetail(uid: number) {
  if (previewMode) return Promise.resolve({ role: previewRoles.find((row) => row.uid === uid)!, admin: uid === 1001 ? { account: "east_admin", phone: "13800001001", roles: "2,5" } : null });
  return getData<{ role: DivisionRoleItem; admin: { account: string; phone: string; roles: string } | null }>(
    request.get(`/agent/division/detail/${uid}`),
  );
}
export function apiDivisionRoleSave(roleType: DivisionRoleType, body: Record<string, unknown>) {
  if (previewMode) return Promise.resolve({ uid: Number(body.uid ?? 0), roleType, divisionId: Number(body.division_id ?? body.uid ?? 0) });
  const path = roleType === 1 ? "/agent/division/save" : roleType === 2 ? "/agent/division_agent/save" : "/agent/division_staff/save";
  return getData<{ uid: number; roleType: number; divisionId: number }>(request.post(path, body));
}
export function apiDivisionRoleStatus(uid: number, status: number) {
  if (previewMode) { const row = previewRoles.find((item) => item.uid === uid); if (row) row.divisionStatus = status; return Promise.resolve(null); }
  return getData<null>(request.put(`/agent/division/status/${uid}/${status}`));
}
export function apiDivisionRoleDelete(uid: number) {
  if (previewMode) { const index = previewRoles.findIndex((item) => item.uid === uid); if (index >= 0) previewRoles.splice(index, 1); return Promise.resolve(null); }
  return getData<null>(request.delete(`/agent/division/del/${uid}`));
}
export function apiDivisionOptions() {
  if (previewMode) return Promise.resolve(previewRoles.filter((row) => row.divisionType === 1).map((row) => ({ value: row.uid, label: row.divisionName })));
  return getData<DivisionOption[]>(request.get("/agent/division/option"));
}
export function apiAgentOptions(divisionId: number) {
  if (previewMode) return Promise.resolve(previewRoles.filter((row) => row.divisionType === 2 && row.divisionId === divisionId).map((row) => ({ value: row.uid, label: row.divisionName })));
  return getData<DivisionOption[]>(request.get(`/agent/division/agent_option/${divisionId}`));
}
export function apiDivisionStatistics() {
  if (previewMode) return Promise.resolve({ divisionNum: 2, agentNum: 13, staffNum: 48, orderNum: 1268, orderPrice: "386420.80", brokeragePrice: "28416.35" });
  return getData<DivisionStatistics>(request.get("/agent/division/statistics"));
}
export function apiDivisionRanking() {
  if (previewMode) return Promise.resolve({ list: [{ uid: 1001, nickname: "华东事业部", downNum: 8, orderPrice: "248650.30", brokeragePrice: "18320.45", orderNum: 786 }, { uid: 1002, nickname: "华南事业部", downNum: 5, orderPrice: "137770.50", brokeragePrice: "10095.90", orderNum: 482 }] });
  return getData<{ list: DivisionRankingItem[] }>(request.get("/agent/division/ranking"));
}
export function apiDivisionApplications(params: Record<string, unknown>) {
  if (previewMode) {
    const requested = params.status === undefined || params.status === "" ? undefined : Number(params.status);
    const list = previewApplications.filter((row) => requested === undefined || row.status === requested);
    return Promise.resolve({ list, count: list.length, page: Number(params.page ?? 1), limit: 20 });
  }
  return getData<{ list: DivisionApplication[]; count: number; page: number; limit: number }>(
    request.get("/agent/division/apply/list", { params }),
  );
}
export function apiDivisionApplicationReview(body: Record<string, unknown>) {
  if (previewMode) { const row = previewApplications.find((item) => item.id === Number(body.id)); if (row) row.status = Number(body.type) === 1 ? 1 : 2; return Promise.resolve({ id: Number(body.id), status: row?.status ?? 0 }); }
  return getData<{ id: number; status: number; uid?: number }>(request.post("/agent/division/apply/examine/save", body));
}
export function apiDivisionApplicationDelete(id: number) {
  if (previewMode) { const index = previewApplications.findIndex((item) => item.id === id); if (index >= 0) previewApplications.splice(index, 1); return Promise.resolve(null); }
  return getData<null>(request.delete(`/agent/division/apply/del/${id}`));
}
export function apiDivisionOrders(params: Record<string, unknown>) {
  if (previewMode) {
    const list: DivisionOrderItem[] = [{ id: 8016, orderId: "wx202608090016", uid: 6612, realName: "王女士", userPhone: "13800006612", payPrice: "699.00", paid: 1, status: 1, refundStatus: 0, divisionId: 1001, divisionBrokerage: "41.94", divisionAgentId: 2101, divisionAgentBrokerage: "29.35", divisionStaffId: 3101, divisionStaffBrokerage: "12.58", addTime: 1786235400 }];
    return Promise.resolve({ list, count: list.length, page: Number(params.page ?? 1), limit: 20 });
  }
  return getData<{ list: DivisionOrderItem[]; count: number; page: number; limit: number }>(
    request.get("/agent/division/order/list", { params }),
  );
}
