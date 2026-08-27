import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AdminPaidMembershipService } from "@/services/user/AdminPaidMembershipService";
import { MembershipScanService } from "@/services/user/MembershipScanService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

const MAX_BODY_BYTES = 256 * 1024;

async function boundedBody(c: C): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ValidateException("请求数据不能超过256 KiB");
  }
  const stream = c.req.raw.body;
  if (!stream) return {};
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ValidateException("请求数据不能超过256 KiB");
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
  throw new ValidateException("请求数据格式错误");
}

function service(c: C) {
  return new AdminPaidMembershipService(c.get("container"));
}

export async function batches(c: C) {
  return jsonOk(c, await service(c).batches(c.req.query()));
}

export async function saveBatch(c: C) {
  const result = await service(c).saveBatch(c.req.param("id"), await boundedBody(c));
  return jsonOk(c, result, result.issued_count > 0 ? "卡片生成成功；卡密只显示本次" : "批次保存成功");
}

export async function setBatchValue(c: C) {
  const input = c.req.method === "GET" ? c.req.query() : await boundedBody(c);
  return jsonOk(
    c,
    await service(c).setBatchValue(c.req.param("id"), input),
    "修改成功",
  );
}

export async function cards(c: C) {
  return jsonOk(c, await service(c).cards(c.req.param("card_batch_id"), c.req.query()));
}

export async function setCardStatus(c: C) {
  const input = c.req.method === "GET" ? c.req.query() : await boundedBody(c);
  return jsonOk(c, await service(c).setCardStatus(input), "修改成功");
}

export async function plans(c: C) {
  return jsonOk(c, await service(c).plans(c.req.query()));
}

export async function savePlan(c: C) {
  return jsonOk(c, await service(c).savePlan(c.req.param("id"), await boundedBody(c)), "保存成功");
}

export async function deletePlan(c: C) {
  return jsonOk(c, await service(c).setPlanStatus(c.req.param("id"), 1), "删除成功");
}

export async function setPlanStatus(c: C) {
  const input = c.req.method === "GET" ? c.req.query() : await boundedBody(c);
  return jsonOk(
    c,
    await service(c).setPlanStatus(input.id, input.is_del ?? input.isDel),
    "修改成功",
  );
}

export async function planSelect(c: C) {
  const result = await service(c).plans({ page: 1, limit: 100 });
  return jsonOk(
    c,
    result.list.map((plan) => ({ id: plan.id, title: plan.title, type: plan.type })),
  );
}

export async function records(c: C) {
  return jsonOk(c, await service(c).records(c.req.query()));
}

export async function rights(c: C) {
  return jsonOk(c, await service(c).rights());
}

export async function saveRight(c: C) {
  return jsonOk(c, await service(c).saveRight(c.req.param("id"), await boundedBody(c)), "权益保存成功");
}

export async function saveRightContent(c: C) {
  return jsonOk(
    c,
    await service(c).saveRightContent(c.req.param("id"), await boundedBody(c)),
    "权益内容保存成功",
  );
}

export async function membershipAgreement(c: C) {
  return jsonOk(c, await service(c).membershipAgreement());
}

export async function saveAgreement(c: C) {
  return jsonOk(c, await service(c).saveAgreement(await boundedBody(c)), "会员协议保存成功");
}

export async function memberScan(c: C) {
  return jsonOk(
    c,
    await new MembershipScanService(c.get("container"), c.env).memberScan(),
  );
}
