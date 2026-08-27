import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { SmsVerificationService } from "@/services/message/SmsVerificationService";
import { SupplierApplicationService } from "@/services/supplier/SupplierApplicationService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C): SupplierApplicationService {
  return new SupplierApplicationService(c.get("container"), c.env);
}

async function body(c: C): Promise<Record<string, unknown>> {
  const maximum = 16 * 1024;
  const length = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(length) && length > maximum) {
    throw new ValidateException("请求数据不能超过16 KiB");
  }
  const stream = c.req.raw.body;
  if (!stream) throw new ValidateException("请求数据格式错误");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new ValidateException("请求数据不能超过16 KiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    value = null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

function clientIp(c: C): string {
  return c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    c.req.header("X-Real-IP") ??
    "unknown";
}

export async function userList(c: C) {
  return jsonOk(c, await service(c).userList(c.get("uid"), c.req.query()));
}

export async function userDetail(c: C) {
  return jsonOk(c, await service(c).userDetail(c.get("uid"), c.req.param("id")));
}

export async function submit(c: C) {
  return jsonOk(
    c,
    await service(c).submit(c.get("uid"), c.req.param("id"), await body(c)),
    "申请已提交",
  );
}

export async function activate(c: C) {
  return jsonOk(
    c,
    await service(c).activate(c.get("uid"), c.req.param("id"), await body(c)),
    "供应商账号已激活",
  );
}

export async function requestCode(c: C) {
  const input = await body(c);
  const phone = await service(c).assertCanRequestCode(
    c.get("uid"),
    input.phone,
    input.purpose,
    input.application_id ?? input.id,
  );
  return jsonOk(
    c,
    await new SmsVerificationService(c.get("container"), c.env)
      .requestSupplierCode(c.get("uid"), phone, clientIp(c)),
    "验证码任务已提交",
  );
}

export async function adminList(c: C) {
  return jsonOk(c, await service(c).adminList(c.req.query()));
}

export async function adminDetail(c: C) {
  return jsonOk(c, await service(c).adminDetail(c.req.param("id")));
}

export async function adminReview(c: C) {
  const result = await service(c).review(c.req.param("id"), await body(c));
  return jsonOk(
    c,
    result,
    result.status === 1 ? "审核通过，申请人需通过短信设置密码" : "申请已拒绝",
  );
}

export async function adminMark(c: C) {
  const input = await body(c);
  return jsonOk(
    c,
    await service(c).mark(c.req.param("id"), input.mark),
    "备注已保存",
  );
}

export async function adminDelete(c: C) {
  return jsonOk(c, await service(c).delete(c.req.param("id")), "申请已删除");
}

export async function adminReviewForm(c: C) {
  const info = await service(c).adminDetail(c.req.param("id"));
  return jsonOk(c, {
    title: "供应商入驻审核",
    method: "POST",
    action: `/adminapi/supplier/apply/verify/${info.id}`,
    rules: [
      { field: "status", title: "审核结果", type: "radio", options: [
        { value: 1, label: "通过（申请人短信激活）" },
        { value: 2, label: "拒绝" },
      ] },
      { field: "fail_msg", title: "拒绝原因", type: "textarea" },
    ],
    info,
  });
}

export async function adminMarkForm(c: C) {
  const info = await service(c).adminDetail(c.req.param("id"));
  return jsonOk(c, {
    title: "供应商申请备注",
    method: "POST",
    action: `/adminapi/supplier/apply/mark/${info.id}`,
    rules: [{ field: "mark", title: "备注", type: "textarea", maxlength: 255 }],
    info,
  });
}
