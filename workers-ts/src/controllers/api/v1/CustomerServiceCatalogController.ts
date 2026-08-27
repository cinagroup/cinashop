import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { CustomerServiceCatalogService } from "@/services/message/CustomerServiceCatalogService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new CustomerServiceCatalogService(c.get("container"));
}

async function body(c: C): Promise<Record<string, unknown>> {
  const value: unknown = await c.req.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

function positiveId(value: string | undefined, label = "ID"): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException(`${label}错误`);
  return id;
}

export async function submitFeedback(c: C) {
  return jsonOk(c, await service(c).submitFeedback(c.get("uid"), await body(c)), "提交成功");
}

export async function feedbackInfo(c: C) {
  const config = new SystemConfigService(c.get("container"), c.env);
  return jsonOk(c, { feedback: await config.get("service_feedback") });
}

export async function adminFeedbackList(c: C) {
  return jsonOk(c, await service(c).feedbackList(c.req.query()));
}

export async function adminFeedbackDetail(c: C) {
  return jsonOk(c, await service(c).feedbackDetail(positiveId(c.req.param("id"))));
}

export async function adminFeedbackUpdate(c: C) {
  await service(c).updateFeedback(positiveId(c.req.param("id")), await body(c));
  return jsonOk(c, null, "修改成功");
}

export async function adminFeedbackDelete(c: C) {
  await service(c).deleteFeedback(positiveId(c.req.param("id")));
  return jsonOk(c, null, "删除成功");
}

export async function adminSpeechcraftList(c: C) {
  return jsonOk(c, await service(c).speechcraftList(0, c.req.query()));
}

export async function adminSpeechcraftCategories(c: C) {
  return jsonOk(c, await service(c).speechcraftCategories(0));
}

export async function adminSpeechcraftDetail(c: C) {
  return jsonOk(c, await service(c).speechcraftDetail(0, positiveId(c.req.param("id"))));
}

export async function adminSpeechcraftCreate(c: C) {
  return jsonOk(c, await service(c).saveSpeechcraft(0, 0, await body(c)), "创建话术成功");
}

export async function adminSpeechcraftUpdate(c: C) {
  return jsonOk(
    c,
    await service(c).saveSpeechcraft(0, positiveId(c.req.param("id")), await body(c)),
    "修改成功",
  );
}

export async function adminSpeechcraftDelete(c: C) {
  await service(c).deleteSpeechcraft(0, positiveId(c.req.param("id")));
  return jsonOk(c, null, "删除成功");
}
