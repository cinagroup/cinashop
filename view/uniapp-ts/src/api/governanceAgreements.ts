import { http } from "@/utils/request";

/** General legal types use legacy cache keys; payVip uses agreement.type=1. */
export const LEGAL_CONTENT_TITLES = {
  user: "用户协议",
  privacy: "隐私协议",
  cancel: "注销协议",
  supplier: "供应商入驻协议",
  payVip: "会员服务协议",
} as const;

export type LegalContentType = keyof typeof LEGAL_CONTENT_TITLES;

export function legalContentType(value: unknown): LegalContentType | null {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LEGAL_CONTENT_TITLES, value)
    ? value as LegalContentType
    : null;
}

export async function apiGovernanceAgreement(value: unknown): Promise<string> {
  const type = legalContentType(value);
  if (!type) throw new Error("协议类型不支持");

  if (type === "payVip") {
    const result = await http.get<unknown>("/agreement/1", {}, { noAuth: true });
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("协议响应格式错误");
    const body = result as Record<string, unknown>;
    if (Object.keys(body).length !== 1 || !("member_explain" in body)) throw new Error("协议响应格式错误");
    const memberExplain = body.member_explain;
    if (Array.isArray(memberExplain) && memberExplain.length === 0) return "";
    if (!memberExplain || typeof memberExplain !== "object" || Array.isArray(memberExplain)) {
      throw new Error("协议响应格式错误");
    }
    const row = memberExplain as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "add_time,content,id,sort,status,title,type"
      || !Number.isSafeInteger(row.id) || (row.id as number) <= 0
      || row.type !== 1 || (row.status !== 0 && row.status !== 1)
      || typeof row.title !== "string" || row.title.length === 0 || row.title.length > 200
      || typeof row.content !== "string" || row.content.length > 200_000
      || !Number.isSafeInteger(row.sort)
      || !Number.isSafeInteger(row.add_time) || (row.add_time as number) < 0) {
      throw new Error("协议响应格式错误");
    }
    return row.content;
  }

  const result = await http.get<unknown>(`/user_agreement/${type}`, {}, { noAuth: true });
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("协议响应格式错误");
  const body = result as Record<string, unknown>;
  if (body.type !== type || typeof body.content !== "string" || body.content.length > 200_000) {
    throw new Error("协议响应格式错误");
  }
  return body.content;
}
