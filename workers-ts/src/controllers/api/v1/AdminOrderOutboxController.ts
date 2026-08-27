import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { OrderOutboxService } from "@/services/order/OrderOutboxService";
import { OrderQueueDeadLetterService } from "@/services/order/OrderQueueDeadLetterService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new OrderOutboxService(c.get("container"), c.env);
}

function deadLetterService(c: C) {
  return new OrderQueueDeadLetterService(c.get("container"), c.env.ORDER_QUEUE);
}

function positiveInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ValidateException(`${label}无效`);
  return parsed;
}

export async function orderOutboxList(c: C) {
  const query = c.req.query();
  return jsonOk(
    c,
    await service(c).list({
      status: query.status,
      afterId: positiveInt(query.after_id, "游标"),
      limit: positiveInt(query.limit, "每页数量"),
    }),
  );
}

export async function orderOutboxReplay(c: C) {
  const id = positiveInt(c.req.param("id"), "outbox ID");
  if (!id) throw new ValidateException("outbox ID 无效");
  const outbox = service(c);
  await outbox.replay(id);
  try {
    const dispatched = await outbox.dispatchById(id);
    return jsonOk(c, dispatched, "事件已重放");
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "admin_payment_outbox_replay_dispatch_failed",
        outboxId: id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return jsonOk(c, { claimed: 0, enqueued: 0 }, "事件已进入补偿队列");
  }
}

const MAX_OPERATION_BODY_BYTES = 4 * 1024;

async function operationBody(c: C): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_OPERATION_BODY_BYTES) {
    throw new ValidateException("操作说明不能超过4 KiB");
  }
  const stream = c.req.raw.body;
  if (!stream) throw new ValidateException("缺少操作确认");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_OPERATION_BODY_BYTES) {
      await reader.cancel();
      throw new ValidateException("操作说明不能超过4 KiB");
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
  throw new ValidateException("操作确认格式错误");
}

function adminId(c: C): number {
  const id = Number(c.get("adminId"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("管理员身份无效");
  return id;
}

export async function orderQueueDeadLetterList(c: C) {
  const query = c.req.query();
  return jsonOk(c, await deadLetterService(c).list({
    status: query.status,
    messageType: query.message_type,
    afterId: positiveInt(query.after_id, "游标"),
    limit: positiveInt(query.limit, "每页数量"),
  }));
}

export async function orderQueueDeadLetterReplay(c: C) {
  const body = await operationBody(c);
  if (body.confirm !== "REPLAY_DEAD_LETTER") throw new ValidateException("缺少死信重放确认");
  const result = await deadLetterService(c).replay(
    c.req.param("id"),
    adminId(c),
    body.reason,
  );
  return jsonOk(c, result, "死信已受控重放");
}

export async function orderQueueDeadLetterResolve(c: C) {
  const body = await operationBody(c);
  if (body.confirm !== "RESOLVE_DEAD_LETTER") throw new ValidateException("缺少死信解决确认");
  const result = await deadLetterService(c).resolve(
    c.req.param("id"),
    adminId(c),
    body.reason,
  );
  return jsonOk(c, result, "死信已标记解决");
}
