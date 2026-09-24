import { useAuthStore } from "@/stores/auth";
import { API_BASE, getFormType, http } from "@/utils/request";

export type AgentApplicationKind = "promoter" | "agent";
export type AgentApplicationStatus = -1 | 0 | 1 | 2;

export interface AgentApplication {
  kind: AgentApplicationKind;
  id: number;
  status: AgentApplicationStatus;
  name: string;
  phone: string;
  addTime: number | string;
  statusTime: number | string;
  refusalReason: string;
  nickname: string;
  uid: number;
  divisionInvite: number;
  images: string[];
  agreement: string;
}

export interface AgentStaff {
  uid: number;
  avatar: string;
  nickname: string;
  phone: string;
  spreadTime: number;
  divisionPercent: number;
  payCount: number;
  orderCount: number;
  numberCount: string;
}

export interface AgentStaffPage {
  list: AgentStaff[];
  count: number;
  page: number;
  limit: number;
  brokerage: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("申请响应格式错误");
  return value as Record<string, unknown>;
}

function status(value: unknown): AgentApplicationStatus {
  if (value === -1 || value === 0 || value === 1 || value === 2) return value;
  throw new Error("申请状态无效");
}

function id(value: unknown): number {
  if (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647) return Number(value);
  throw new Error("申请编号无效");
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function epoch(value: unknown): number | string {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  return typeof value === "string" && value.length <= 32 ? value : "";
}

export function formatAgentApplicationTime(value: number | string): string {
  if (typeof value === "string") return value;
  if (!Number.isSafeInteger(value) || value <= 0) return "";
  const date = new Date((value + 8 * 60 * 60) * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** Promoter and division applications have separate tables and response shapes. */
export function normalizeAgentApplication(kind: AgentApplicationKind, response: unknown): AgentApplication {
  const outer = record(response);
  if (kind === "promoter") {
    const user = record(outer.user);
    const agreement = outer.agreement && typeof outer.agreement === "object" && !Array.isArray(outer.agreement)
      ? text((outer.agreement as Record<string, unknown>).content) : "";
    return {
      kind, id: id(user.id), status: status(user.status), name: text(user.real_name),
      phone: text(user.phone), addTime: epoch(user.add_time), statusTime: epoch(user.status_time),
      refusalReason: text(user.refusal_reason), nickname: text(user.nickname), uid: id(user.uid),
      divisionInvite: 0, images: [], agreement,
    };
  }
  const images = Array.isArray(outer.images) && outer.images.every((value) => typeof value === "string")
    ? outer.images as string[] : [];
  return {
    kind, id: outer.status === -1 ? 0 : id(outer.id), status: status(outer.status),
    name: text(outer.divisionName), phone: text(outer.phone),
    addTime: epoch(outer.addTime), statusTime: epoch(outer.statusTime),
    refusalReason: text(outer.refusalReason), nickname: text(outer.name), uid: 0,
    divisionInvite: id(outer.divisionInvite ?? 0), images, agreement: "",
  };
}

export async function apiAgentApplication(kind: AgentApplicationKind): Promise<AgentApplication> {
  const path = kind === "promoter" ? "/user/promoter/apply/info" : "/division/agent/apply/info";
  return normalizeAgentApplication(kind, await http.get<unknown>(path));
}

export async function apiAgentAgreement(): Promise<string> {
  const response = record(await http.get<unknown>("/agreement/2", {}, { noAuth: true }));
  if (!Object.prototype.hasOwnProperty.call(response, "member_explain")) throw new Error("代理商协议响应无效");
  const value = response.member_explain;
  if (Array.isArray(value) && value.length === 0) return "";
  const agreement = record(value);
  if (agreement.type !== 2 || (agreement.status !== 0 && agreement.status !== 1)
    || typeof agreement.content !== "string" || agreement.content.length > 200_000) {
    throw new Error("代理商协议响应无效");
  }
  return agreement.status === 1 ? agreement.content : "";
}

export function apiSubmitAgentApplication(kind: AgentApplicationKind, applicationId: number, input: {
  nickname?: string; real_name?: string; division_name?: string; name?: string;
  phone: string; code: string; division_invite?: number; images?: string[];
}): Promise<{ id: number }> {
  const path = kind === "promoter" ? "/user/promoter/apply" : "/division/agent/apply";
  return http.post<{ id: number }>(`${path}/${id(applicationId)}`, input);
}

export function apiAgentStaff(page: number, keyword = ""): Promise<AgentStaffPage> {
  return http.get<AgentStaffPage>("/division/agent/staff_list", { page, limit: 20, keyword });
}

export function apiAgentStaffPercent(uid: number, percent: number): Promise<null> {
  return http.post<null>("/division/agent/staff_percent", { uid, division_percent: percent });
}

export function apiRemoveAgentStaff(uid: number): Promise<null> {
  return http.delete<null>(`/division/agent/staff/${id(uid)}`);
}

/** Generic user attachment route; never sends a Supplier account credential. */
export function apiAgentImageUpload(filePath: string): Promise<{ url: string; src: string }> {
  const auth = useAuthStore();
  const owner = { uid: auth.uid, token: auth.token, version: auth.sessionVersion };
  if (!owner.token) return Promise.reject(new Error("请先登录"));
  return new Promise((resolve, reject) => uni.uploadFile({
    url: `${API_BASE}/api/upload/image`, filePath, name: "file", formData: { pid: "0" },
    header: { "Authori-zation": `Bearer ${owner.token}`, "Form-type": getFormType() },
    success: (response) => {
      if (auth.uid !== owner.uid || auth.token !== owner.token || auth.sessionVersion !== owner.version) {
        reject(new Error("登录状态已变化，请重新操作")); return;
      }
      let value: unknown;
      try { value = JSON.parse(response.data) as unknown; } catch { value = null; }
      if (!value || typeof value !== "object" || Array.isArray(value)) { reject(new Error("图片上传响应无效")); return; }
      const body = value as Record<string, unknown>;
      if (response.statusCode < 200 || response.statusCode >= 300 || body.status !== 200) {
        reject(new Error(text(body.msg) || "图片上传失败")); return;
      }
      if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
        reject(new Error("图片上传响应无效")); return;
      }
      const data = body.data as Record<string, unknown>;
      if (typeof data.url !== "string" || !data.url || typeof data.src !== "string") {
        reject(new Error("图片上传响应无效")); return;
      }
      resolve({ url: data.url, src: data.src.startsWith("/") ? `${API_BASE}${data.src}` : data.src });
    },
    fail: (error) => reject(new Error(error.errMsg ?? "图片上传失败")),
  }));
}

export function resolveAgentImage(value: string): string {
  return value.startsWith("/") ? `${API_BASE}${value}` : value;
}
