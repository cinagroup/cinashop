import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { PaymentReconciliationService } from "@/services/payment/PaymentReconciliationService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

const MAX_DECISION_BODY_BYTES = 4 * 1024;
const CONFIRMATIONS = {
  retry: "RETRY_PAYMENT_RECONCILIATION",
  accept_local: "ACCEPT_LOCAL_PAYMENT_RECONCILIATION",
  close: "CLOSE_PAYMENT_RECONCILIATION",
} as const;

function service(c: C): PaymentReconciliationService {
  return new PaymentReconciliationService(c.get("container"), c.env);
}

function positiveInt(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ValidateException(`${label}无效`);
  return parsed;
}

async function boundedBody(c: C): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_DECISION_BODY_BYTES) {
    throw new ValidateException("处置请求不能超过4 KiB");
  }
  const stream = c.req.raw.body;
  if (!stream) throw new ValidateException("缺少处置请求");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DECISION_BODY_BYTES) {
      await reader.cancel();
      throw new ValidateException("处置请求不能超过4 KiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Normalized below.
  }
  throw new ValidateException("处置请求格式错误");
}

export async function list(c: C) {
  const query = c.req.query();
  return jsonOk(c, await service(c).list({
    status: query.status,
    afterId: query.after_id,
    limit: query.limit,
  }));
}

export async function decide(c: C) {
  const body = await boundedBody(c);
  const action = typeof body.action === "string" ? body.action : "";
  if (!(action in CONFIRMATIONS)) throw new ValidateException("处置动作无效");
  const typedAction = action as keyof typeof CONFIRMATIONS;
  if (body.confirm !== CONFIRMATIONS[typedAction]) throw new ValidateException("缺少处置确认");
  const result = await service(c).decide({
    caseId: positiveInt(c.req.param("id"), "对账案件"),
    adminId: positiveInt(c.get("adminId"), "管理员身份"),
    actionKey: typeof body.action_key === "string" ? body.action_key : "",
    action: typedAction,
    reasonCode: typeof body.reason_code === "string" ? body.reason_code : "",
  });
  return jsonOk(c, result, "对账案件已处置");
}
