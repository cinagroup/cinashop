import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { RateLimitException, ValidateException } from "@/utils/errors";
import { MAX_CUSTOMER_VIDEO_REQUEST_BYTES } from "@/services/system/CustomerVideoPolicy";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

/** Both image aliases and video share one atomic account budget. Attempts count,
 * including malformed requests, so rejection occurs before multipart buffering. */
export async function enforceUserUploadRateLimit(c: C): Promise<void> {
  const uid = c.get("uid");
  if (!uid || !Number.isSafeInteger(uid)) throw new ValidateException("用户身份无效");
  const decision = await c.env.TOKEN_BUCKET.getByName(`user-upload:${uid}`)
    .consumeRateLimit([{ key: "upload", limit: 100 }], 86400);
  c.header("X-RateLimit-Limit", String(decision.limit));
  c.header("X-RateLimit-Remaining", String(decision.remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));
  if (!decision.allowed) throw new RateLimitException("今日上传次数已达上限，请稍后重试",
    Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000)), false);
}

export async function boundedCustomerVideo(c: C): Promise<File> {
  const type = c.req.header("content-type") ?? "";
  const length = Number(c.req.header("content-length") ?? "0");
  if (type.length > 512 || !/^multipart\/form-data\s*;/i.test(type)) {
    throw new ValidateException("请使用multipart/form-data上传视频");
  }
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_CUSTOMER_VIDEO_REQUEST_BYTES) {
    throw new ValidateException("上传请求不能超过50.25 MiB");
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new ValidateException("请选择视频文件");
  let total = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          if (total !== length) throw new ValidateException("上传请求不完整");
          controller.close(); return;
        }
        total += result.value.byteLength;
        if (total > length || total > MAX_CUSTOMER_VIDEO_REQUEST_BYTES) throw new ValidateException("上传请求过大");
        controller.enqueue(result.value);
      } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  let form: FormData;
  try { form = await new Response(stream, { headers: { "content-type": type } }).formData(); }
  catch { throw new ValidateException("视频上传表单不完整或格式错误"); }
  const field = form.get("filename") ?? "file";
  if (typeof field !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field) || field === "filename"
    || form.getAll("filename").length > 1 || form.getAll(field).length !== 1
    || [...form.keys()].some(key => key !== field && key !== "filename")) {
    throw new ValidateException("请选择一个视频文件");
  }
  const file = form.get(field);
  if (!(file instanceof File)) throw new ValidateException("请选择视频文件");
  return file;
}
