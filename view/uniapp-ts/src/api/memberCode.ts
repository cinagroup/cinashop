import { http } from "@/utils/request";
import { parseOperatorScanCode } from "@/utils/operatorScanCode";

/** Preserve valid legacy codes; their identity must not be reformatted as a new code. */
export function memberCodeValue(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || /^[a-z][a-z0-9+.-]*:/iu.test(value)
    || value.includes("/") || value.includes("?") || value.includes("&")) {
    throw Error("会员码响应格式无效，请重试");
  }
  const parsed = parseOperatorScanCode(value);
  if (parsed?.kind !== "member" || parsed.code !== value) {
    throw Error("会员码响应格式无效，请重试");
  }
  return value;
}

/** This authenticated POST allocates once or reads the same account's existing code. */
export async function apiMemberCode(): Promise<string> {
  const result = await http.post<unknown>("user/bar_code", {});
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw Error("会员码响应格式无效，请重试");
  }
  return memberCodeValue((result as Record<string, unknown>).bar_code);
}
