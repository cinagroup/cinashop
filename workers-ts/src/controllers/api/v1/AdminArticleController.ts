import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import {
  AdminArticleService,
  type AdminArticleActor,
} from "@/services/content/AdminArticleService";
import {
  adminAttachmentScope,
  AttachmentService,
} from "@/services/system/AttachmentService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

const MAX_ARTICLE_BODY_BYTES = 1024 * 1024;
const MAX_CATEGORY_BODY_BYTES = 16 * 1024;

function service(c: C): AdminArticleService {
  return new AdminArticleService(c.get("container"), c.env);
}

function actor(c: C): AdminArticleActor {
  const admin = c.get("adminInfo");
  if (!admin) throw new ValidateException("管理员身份不存在");
  const ip = (c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0] ?? "")
    .trim().slice(0, 45);
  return { id: admin.id, name: admin.realName || admin.account, ip };
}

function noStore(c: C): void {
  c.header("Cache-Control", "private, no-store");
}

export async function list(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).list(c.req.query()));
}

export async function detail(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).detail(c.req.param("id")));
}

export async function save(c: C) {
  noStore(c);
  const result = await service(c).save(
    await readBoundedJsonObject(c.req.raw, MAX_ARTICLE_BODY_BYTES),
    actor(c),
  );
  return jsonOk(c, result, result.article.id ? "文章已保存并核验" : "文章保存失败");
}

export async function remove(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).remove(c.req.param("id"), actor(c)), "文章已删除并核验");
}

export async function categoryList(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).categories(c.req.query()));
}

export async function createCategory(c: C) {
  noStore(c);
  const result = await service(c).saveCategory(
    await readBoundedJsonObject(c.req.raw, MAX_CATEGORY_BODY_BYTES),
    actor(c),
  );
  return jsonOk(c, result, "分类已创建并核验");
}

export async function updateCategory(c: C) {
  noStore(c);
  const result = await service(c).saveCategory(
    await readBoundedJsonObject(c.req.raw, MAX_CATEGORY_BODY_BYTES),
    actor(c),
    c.req.param("id"),
  );
  return jsonOk(c, result, "分类已更新并核验");
}

export async function categoryStatus(c: C) {
  noStore(c);
  const body = await readBoundedJsonObject(c.req.raw, MAX_CATEGORY_BODY_BYTES);
  return jsonOk(
    c,
    await service(c).setCategoryStatus(c.req.param("id"), body.status, actor(c)),
    Number(body.status) === 1 ? "分类已启用" : "分类已停用",
  );
}

export async function removeCategory(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).removeCategory(c.req.param("id"), actor(c)), "分类已删除并核验");
}

export async function productOptions(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).productOptions(c.req.query()));
}

/** Article editors can read existing platform assets without acquiring attachment mutation rights. */
export async function attachmentOptions(c: C) {
  noStore(c);
  const attachments = new AttachmentService(c.get("container"), c.env);
  return jsonOk(c, await attachments.list(adminAttachmentScope(), {
    page: c.req.query("page") ?? "1",
    limit: c.req.query("limit") ?? "20",
    pid: c.req.query("pid") ?? "0",
    name: c.req.query("name") ?? "",
    file_type: "1",
  }));
}

/** Keep the editor read-only while exposing the same image folders as the attachment center. */
export async function attachmentCategories(c: C) {
  noStore(c);
  const attachments = new AttachmentService(c.get("container"), c.env);
  return jsonOk(c, await attachments.listCategories(adminAttachmentScope(), {
    pid: c.req.query("pid") ?? "0",
    all: "1",
    file_type: "1",
  }));
}
