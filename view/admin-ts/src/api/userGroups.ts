/** 商城会员分组（区别于公众号粉丝分组）。 */
import request, { getData } from "@/utils/request";

export interface UserGroup {
  id: number;
  group_name: string;
}

export interface UserGroupPage {
  list: UserGroup[];
  count: number;
  page: number;
  limit: number;
}

function safeInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/** Refuse malformed pages instead of displaying stale or silently truncated data. */
export function parseUserGroupPage(value: unknown): UserGroupPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("分组列表格式错误");
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.list) || !safeInteger(page.count, 0)
    || !safeInteger(page.page, 1) || !safeInteger(page.limit, 1)
    || page.list.length > page.limit || page.list.length > page.count) {
    throw new Error("分组列表格式错误");
  }
  const seen = new Set<number>();
  const list = page.list.map((entry): UserGroup => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("分组记录格式错误");
    const row = entry as Record<string, unknown>;
    if (!safeInteger(row.id, 1) || typeof row.group_name !== "string" || !row.group_name.trim()
      || seen.has(row.id)) throw new Error("分组记录格式错误");
    seen.add(row.id);
    return { id: row.id, group_name: row.group_name };
  });
  return { list, count: page.count, page: page.page, limit: page.limit };
}

export function normalizedUserGroupName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("请输入分组名称");
  if (name.length > 64) throw new Error("分组名称不能超过64个字符");
  return name;
}

export async function apiAdminUserGroups(params: { page: number; limit: number; group_name?: string }, signal?: AbortSignal): Promise<UserGroupPage> {
  const data = await getData<unknown>(request.get("/user_group/list", { params, signal }));
  return parseUserGroupPage(data);
}

export async function apiAdminSaveUserGroup(input: { id: number; group_name: string }): Promise<{ id: number }> {
  const group_name = normalizedUserGroupName(input.group_name);
  if (!safeInteger(input.id, 0)) throw new Error("分组ID错误");
  const result = await getData<unknown>(request.post("/user_group/save", { id: input.id, group_name }));
  if (!result || typeof result !== "object" || Array.isArray(result)
    || !safeInteger((result as Record<string, unknown>).id, 1)) throw new Error("分组保存结果格式错误，请刷新列表核对");
  return { id: (result as { id: number }).id };
}

export function apiAdminDeleteUserGroup(id: number): Promise<null> {
  if (!safeInteger(id, 1)) throw new Error("分组ID错误");
  return getData<null>(request.delete(`/user_group/del/${id}`));
}
