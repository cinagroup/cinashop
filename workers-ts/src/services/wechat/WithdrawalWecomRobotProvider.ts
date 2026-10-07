import type { WecomRobotNotificationPayload } from "@/models/schema";
import { WechatProviderConfigurationError, WechatProviderRejectedError } from "./WechatNotificationProvider";

/** A logical ledger target. The credential and destination never enter PostgreSQL or Queue. */
export const WECOM_WITHDRAWAL_TARGET = "withdrawal_admin_group";
const WEBHOOK_PATTERN = /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/;
const MAX_RESPONSE_BYTES = 2048;
const TIMEOUT_MS = 5000;
const RETRYABLE_CODES = new Set([-1, 45009, 45011]);

export function validWithdrawalWecomWebhook(value: unknown): value is string {
  return typeof value === "string" && WEBHOOK_PATTERN.test(value);
}

async function boundedResponse(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    throw new Error("企业微信机器人响应结果未知");
  }
  if (!response.body) throw new Error("企业微信机器人响应结果未知");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("企业微信机器人响应结果未知");
      chunks.push(value);
    }
  } finally {
    if (size > MAX_RESPONSE_BYTES) await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new Error("企业微信机器人响应结果未知"); }
}

/** Only an explicit, bounded provider errcode is retryable; transport ambiguity stays UNKNOWN. */
export async function sendWithdrawalWecomRobot(
  secret: unknown,
  payload: WecomRobotNotificationPayload,
  fetcher: typeof fetch = fetch,
): Promise<{ providerReference: string; requestId: string; responseCode: string }> {
  if (!validWithdrawalWecomWebhook(secret)) {
    throw new WechatProviderConfigurationError("企业微信机器人 Secret 未配置或目标无效");
  }
  if (payload.kind !== "wecom_robot" || !Number.isSafeInteger(payload.withdrawalId)
    || payload.withdrawalId <= 0 || Object.keys(payload).sort().join(",") !== "kind,withdrawalId") {
    throw new WechatProviderConfigurationError("企业微信机器人载荷无效");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("企业微信机器人投递结果未知"));
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetcher(secret, {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
        signal: controller.signal,
        body: JSON.stringify({ msgtype: "text", text: { content: `收到一笔提现申请，请在后台查看。申请编号：${payload.withdrawalId}` } }),
      });
      if (!response.ok) throw new Error("企业微信机器人 HTTP 响应结果未知");
      const data = await boundedResponse(response);
      if (!data || typeof data !== "object" || Array.isArray(data) || !("errcode" in data)
        || !Number.isSafeInteger((data as { errcode: unknown }).errcode)) {
        throw new Error("企业微信机器人响应结果未知");
      }
      const code = (data as { errcode: number }).errcode;
      if (code !== 0) throw new WechatProviderRejectedError(code, RETRYABLE_CODES.has(code));
      return { providerReference: "", requestId: "", responseCode: "0" };
    })()]);
  } catch (error) {
    if (error instanceof WechatProviderRejectedError) throw error;
    // Do not persist fetch/URL/response error text: it may contain the webhook key.
    throw new Error("企业微信机器人投递结果未知");
  } finally {
    clearTimeout(timer!);
  }
}
