import { and, asc, desc, eq, ilike, ne, sql, type SQL } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  systemConfig,
  systemConfigTab,
  systemForm,
  systemFormData,
  user as userTable,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const CONFIG_TAB_LOCK_NAMESPACE = 731_622;
const SYSTEM_FORM_LOCK_NAMESPACE = 731_623;
const MAX_PAGE_SIZE = 100;
const MAX_FORM_COMPONENTS = 100;
const MAX_FORM_JSON_BYTES = 1_000_000;

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, field: string, fallback: number, max = 2_147_483_647) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new ValidateException(`${field}必须是非负整数`);
  }
  return parsed;
}

function textValue(value: unknown, field: string, maxLength: number, required = false) {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new ValidateException(`请输入${field}`);
  if (result.length > maxLength) throw new ValidateException(`${field}不能超过${maxLength}个字符`);
  return result;
}

export function parseSystemFormDefinition(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeSystemFormDefinition(value: unknown): string {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new ValidateException("表单组件必须是有效 JSON");
    }
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new ValidateException("请添加表单组件");
  }
  if (parsed.length > MAX_FORM_COMPONENTS) {
    throw new ValidateException(`表单组件不能超过${MAX_FORM_COMPONENTS}项`);
  }
  for (const component of parsed) {
    if (!component || typeof component !== "object" || Array.isArray(component)) {
      throw new ValidateException("表单组件格式错误");
    }
  }
  const json = JSON.stringify(parsed);
  if (new TextEncoder().encode(json).byteLength > MAX_FORM_JSON_BYTES) {
    throw new ValidateException("表单组件数据过大");
  }
  return json;
}

export function handleSystemFormDefinition(value: string | null | undefined) {
  return parseSystemFormDefinition(value).map((raw) => {
    const item = raw as Record<string, any>;
    const type = typeof item.name === "string" ? item.name : "";
    const choices = ["checkboxs", "radios", "selects"].includes(type)
      ? Array.isArray(item.wordsConfig?.list) ? item.wordsConfig.list : []
      : [];
    return {
      id: typeof item.id === "string" || typeof item.id === "number" ? item.id : "",
      type,
      name: ({
        checkboxs: "多选框",
        citys: "城市",
        dates: "日期",
        dateranges: "日期范围",
        radios: "单选框",
        selects: "下拉框",
        texts: "文本框",
        times: "时间",
        timeranges: "时间范围",
        uploadPicture: "图片",
      } as Record<string, string>)[type] ?? "",
      title: typeof item.titleConfig?.value === "string" ? item.titleConfig.value : "",
      tip: typeof item.tipConfig?.value === "string" ? item.tipConfig.value : "",
      list: choices,
      require: Boolean(item.titleShow?.val),
      value: item.value ?? "",
    };
  });
}

type ConfigTabTreeNode = {
  id: number;
  pid: number;
  [key: string]: unknown;
  children?: ConfigTabTreeNode[];
};

export function buildConfigTabTree(rows: ConfigTabTreeNode[]): ConfigTabTreeNode[] {
  const nodes = new Map(rows.map((row) => [row.id, { ...row, children: [] as ConfigTabTreeNode[] }]));
  const roots: ConfigTabTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.pid > 0 ? nodes.get(node.pid) : undefined;
    if (parent) parent.children!.push(node);
    else roots.push(node);
  }
  return roots;
}

function formProjection() {
  return {
    id: systemForm.id,
    version: systemForm.version,
    name: systemForm.name,
    cover_image: systemForm.coverImage,
    value: systemForm.value,
    default_value: systemForm.defaultValue,
    status: systemForm.status,
    is_del: systemForm.isDel,
    update_time: systemForm.updateTime,
    add_time: systemForm.addTime,
  };
}

export class SystemMetadataService {
  constructor(private readonly container: Container) {}

  async configTabList(query: Record<string, string>) {
    const page = Math.max(1, integer(query.page, "页码", 1));
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, integer(query.limit, "每页数量", 20)));
    const conditions: SQL[] = [];
    if (query.status !== undefined && query.status !== "") {
      conditions.push(eq(systemConfigTab.status, integer(query.status, "状态", 0, 255)));
    }
    if (query.is_store !== undefined && query.is_store !== "") {
      conditions.push(eq(systemConfigTab.isStore, integer(query.is_store, "配置类型", 0, 1)));
    }
    if (query.title?.trim()) conditions.push(ilike(systemConfigTab.title, `%${query.title.trim()}%`));
    const where = conditions.length ? and(...conditions) : undefined;
    const [list, countRows] = await Promise.all([
      this.container.db
        .select({
          id: systemConfigTab.id,
          is_store: systemConfigTab.isStore,
          pid: systemConfigTab.pid,
          title: systemConfigTab.title,
          eng_title: systemConfigTab.engTitle,
          status: systemConfigTab.status,
          info: systemConfigTab.info,
          icon: systemConfigTab.icon,
          type: systemConfigTab.type,
          sort: systemConfigTab.sort,
        })
        .from(systemConfigTab)
        .where(where)
        .orderBy(desc(systemConfigTab.sort), asc(systemConfigTab.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(systemConfigTab)
        .where(where),
    ]);
    return { list: buildConfigTabTree(list), count: countRows[0]?.count ?? 0, page, limit };
  }

  async saveConfigTab(id: number, input: unknown) {
    const body = inputRecord(input);
    const isStore = integer(body.is_store, "配置类型", 0, 1);
    const rawPid = Array.isArray(body.pid) ? body.pid.at(-1) : body.pid;
    const pid = integer(rawPid, "父级分类", 0);
    const title = textValue(body.title, "分类名称", 255, true);
    const engTitle = textValue(body.eng_title, "分类字段", 255, true);
    const status = integer(body.status, "状态", 1, 255);
    const info = integer(body.info, "显示设置", 0, 255);
    const icon = textValue(body.icon, "图标", 30);
    const type = integer(body.type, "分类类型", 0);
    const sort = integer(body.sort, "排序", 0);
    if (id < 0 || !Number.isSafeInteger(id)) throw new ValidateException("配置分类ID错误");
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CONFIG_TAB_LOCK_NAMESPACE}, 0)`);
      if (id > 0) {
        const existing = await tx
          .select({ id: systemConfigTab.id })
          .from(systemConfigTab)
          .where(eq(systemConfigTab.id, id))
          .limit(1)
          .for("update");
        if (!existing[0]) throw new NotFoundException("配置分类不存在");
      }
      const allTabs = await tx
        .select({ id: systemConfigTab.id, pid: systemConfigTab.pid, isStore: systemConfigTab.isStore })
        .from(systemConfigTab)
        .where(eq(systemConfigTab.isStore, isStore));
      const byId = new Map(allTabs.map((row) => [row.id, row]));
      if (pid > 0 && !byId.has(pid)) throw new NotFoundException("父级配置分类不存在");
      let ancestor = pid;
      const visited = new Set<number>();
      while (ancestor > 0) {
        if (ancestor === id || visited.has(ancestor)) throw new ValidateException("配置分类层级形成循环");
        visited.add(ancestor);
        ancestor = byId.get(ancestor)?.pid ?? 0;
      }
      const duplicateConditions = [
        eq(systemConfigTab.isStore, isStore),
        eq(systemConfigTab.engTitle, engTitle),
      ];
      if (id > 0) duplicateConditions.push(ne(systemConfigTab.id, id));
      const duplicate = await tx
        .select({ id: systemConfigTab.id })
        .from(systemConfigTab)
        .where(and(...duplicateConditions))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("该分类字段已经存在");
      const values = { isStore, pid, title, engTitle, status, info, icon, type, sort };
      if (id > 0) {
        await tx.update(systemConfigTab).set(values).where(eq(systemConfigTab.id, id));
        return { id };
      }
      const inserted = await tx.insert(systemConfigTab).values(values).returning({ id: systemConfigTab.id });
      return { id: inserted[0].id };
    });
  }

  async deleteConfigTab(id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("配置分类ID错误");
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CONFIG_TAB_LOCK_NAMESPACE}, 0)`);
      const rows = await tx
        .select({ id: systemConfigTab.id })
        .from(systemConfigTab)
        .where(eq(systemConfigTab.id, id))
        .limit(1)
        .for("update");
      if (!rows[0]) throw new NotFoundException("配置分类不存在");
      const [child, config] = await Promise.all([
        tx.select({ id: systemConfigTab.id }).from(systemConfigTab).where(eq(systemConfigTab.pid, id)).limit(1),
        tx.select({ id: systemConfig.id }).from(systemConfig).where(eq(systemConfig.configTabId, id)).limit(1),
      ]);
      if (child[0] || config[0]) throw new ValidateException("配置分类仍有下级分类或配置项，不能删除");
      await tx.delete(systemConfigTab).where(eq(systemConfigTab.id, id));
    });
  }

  async setConfigTabStatus(id: number, statusValue: unknown) {
    const status = integer(statusValue, "状态", 0, 1);
    const updated = await this.container.db
      .update(systemConfigTab)
      .set({ status })
      .where(eq(systemConfigTab.id, id))
      .returning({ id: systemConfigTab.id });
    if (!updated[0]) throw new NotFoundException("配置分类不存在");
  }

  async formList(query: Record<string, string>, activeOnly = false) {
    const page = Math.max(1, integer(query.page, "页码", 1));
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, integer(query.limit, "每页数量", 20)));
    const conditions: SQL[] = [eq(systemForm.isDel, 0)];
    if (activeOnly) conditions.push(eq(systemForm.status, 1));
    else if (query.status !== undefined && query.status !== "") {
      conditions.push(eq(systemForm.status, integer(query.status, "状态", 0, 255)));
    }
    if (query.name?.trim()) conditions.push(ilike(systemForm.name, `%${query.name.trim()}%`));
    const where = and(...conditions);
    const [list, countRows] = await Promise.all([
      this.container.db
        .select(formProjection())
        .from(systemForm)
        .where(where)
        .orderBy(desc(systemForm.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(systemForm).where(where),
    ]);
    return { list, count: countRows[0]?.count ?? 0, page, limit };
  }

  async allSystemForms(activeOnly = false) {
    const conditions: SQL[] = [eq(systemForm.isDel, 0)];
    if (activeOnly) conditions.push(eq(systemForm.status, 1));
    return this.container.db
      .select({ id: systemForm.id, name: systemForm.name })
      .from(systemForm)
      .where(and(...conditions))
      .orderBy(desc(systemForm.id))
      .limit(500);
  }

  async formInfo(id: number, normalized = false, activeOnly = false) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("系统表单ID错误");
    const conditions: SQL[] = [eq(systemForm.id, id), eq(systemForm.isDel, 0)];
    if (activeOnly) conditions.push(eq(systemForm.status, 1));
    const rows = await this.container.db
      .select(formProjection())
      .from(systemForm)
      .where(and(...conditions))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("系统表单不存在");
    return {
      ...rows[0],
      value: normalized
        ? handleSystemFormDefinition(rows[0].value)
        : parseSystemFormDefinition(rows[0].value),
    };
  }

  async saveForm(id: number, input: unknown) {
    const body = inputRecord(input);
    const name = textValue(body.name, "表单模版名称", 255, true);
    const value = normalizeSystemFormDefinition(body.value);
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SYSTEM_FORM_LOCK_NAMESPACE}, 0)`);
      if (id > 0) {
        const existing = await tx
          .select({ id: systemForm.id })
          .from(systemForm)
          .where(and(eq(systemForm.id, id), eq(systemForm.isDel, 0)))
          .limit(1)
          .for("update");
        if (!existing[0]) throw new NotFoundException("系统表单不存在");
      }
      const duplicateConditions = [eq(systemForm.name, name), eq(systemForm.isDel, 0)];
      if (id > 0) duplicateConditions.push(ne(systemForm.id, id));
      const duplicate = await tx
        .select({ id: systemForm.id })
        .from(systemForm)
        .where(and(...duplicateConditions))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("模版名称已经存在");
      if (id > 0) {
        await tx.update(systemForm).set({ name, value, updateTime: now }).where(eq(systemForm.id, id));
        return { id };
      }
      const inserted = await tx
        .insert(systemForm)
        .values({ name, value, addTime: now, updateTime: now })
        .returning({ id: systemForm.id });
      return { id: inserted[0].id };
    });
  }

  async renameForm(id: number, input: unknown) {
    const body = inputRecord(input);
    const name = textValue(body.name, "表单模版名称", 255, true);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SYSTEM_FORM_LOCK_NAMESPACE}, 0)`);
      const rows = await tx
        .select({ id: systemForm.id, name: systemForm.name })
        .from(systemForm)
        .where(and(eq(systemForm.id, id), eq(systemForm.isDel, 0)))
        .limit(1)
        .for("update");
      if (!rows[0]) throw new NotFoundException("系统表单不存在");
      if (rows[0].name === name) throw new ValidateException("模版名称未修改");
      const duplicate = await tx
        .select({ id: systemForm.id })
        .from(systemForm)
        .where(and(eq(systemForm.name, name), eq(systemForm.isDel, 0), ne(systemForm.id, id)))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("模版名称已经存在");
      await tx.update(systemForm).set({ name, updateTime: Math.floor(Date.now() / 1000) }).where(eq(systemForm.id, id));
    });
  }

  async deleteForm(id: number) {
    const updated = await this.container.db
      .update(systemForm)
      .set({ isDel: 1, updateTime: Math.floor(Date.now() / 1000) })
      .where(and(eq(systemForm.id, id), eq(systemForm.isDel, 0)))
      .returning({ id: systemForm.id });
    if (!updated[0]) throw new NotFoundException("系统表单不存在");
  }

  async setFormStatus(id: number, statusValue: unknown) {
    const status = integer(statusValue, "状态", 0, 1);
    const updated = await this.container.db
      .update(systemForm)
      .set({ status, updateTime: Math.floor(Date.now() / 1000) })
      .where(and(eq(systemForm.id, id), eq(systemForm.isDel, 0)))
      .returning({ id: systemForm.id });
    if (!updated[0]) throw new NotFoundException("系统表单不存在");
  }

  async formDataList(formId: number, query: Record<string, string>) {
    if (!Number.isSafeInteger(formId) || formId <= 0) throw new ValidateException("系统表单ID错误");
    const page = Math.max(1, integer(query.page, "页码", 1));
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, integer(query.limit, "每页数量", 20)));
    const conditions: SQL[] = [
      eq(systemFormData.systemFormId, String(formId)),
      eq(systemFormData.isDel, 0),
    ];
    if (query.uid) conditions.push(eq(systemFormData.uid, integer(query.uid, "用户ID", 0)));
    if (query.type) conditions.push(eq(systemFormData.type, integer(query.type, "来源类型", 0, 255)));
    if (query.relation_id) {
      conditions.push(eq(systemFormData.relationId, integer(query.relation_id, "关联ID", 0)));
    }
    const where = and(...conditions);
    const [list, countRows] = await Promise.all([
      this.container.db
        .select({
          id: systemFormData.id,
          uid: systemFormData.uid,
          system_form_id: systemFormData.systemFormId,
          type: systemFormData.type,
          relation_id: systemFormData.relationId,
          value: systemFormData.value,
          is_del: systemFormData.isDel,
          add_time: systemFormData.addTime,
          nickname: userTable.nickname,
          avatar: userTable.avatar,
          phone: userTable.phone,
          system_form_name: systemForm.name,
        })
        .from(systemFormData)
        .leftJoin(userTable, eq(userTable.uid, systemFormData.uid))
        .leftJoin(systemForm, eq(sql`${systemForm.id}::text`, systemFormData.systemFormId))
        .where(where)
        .orderBy(desc(systemFormData.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(systemFormData)
        .where(where),
    ]);
    return {
      list: list.map((row) => ({ ...row, value: parseSystemFormDefinition(row.value) })),
      count: countRows[0]?.count ?? 0,
      page,
      limit,
    };
  }
}
