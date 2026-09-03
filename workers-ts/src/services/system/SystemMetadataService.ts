import { and, asc, desc, eq, gte, ilike, lte, ne, sql, type SQL } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  storeBargain,
  storeCombination,
  storeIntegral,
  storeProduct,
  storeSeckill,
  systemConfig,
  systemConfigTab,
  systemForm,
  systemFormData,
  systemLog,
  user as userTable,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const CONFIG_TAB_LOCK_NAMESPACE = 731_622;
const SYSTEM_FORM_LOCK_NAMESPACE = 731_623;
const MAX_PAGE_SIZE = 100;
const MAX_FORM_COMPONENTS = 100;
const MAX_FORM_JSON_BYTES = 1_000_000;
const MAX_FORM_TITLE_LENGTH = 100;
const MAX_FORM_TIP_LENGTH = 200;
const MAX_FORM_CHOICE_LENGTH = 100;
const MAX_FORM_CHOICES = 50;
const MAX_FORM_DEFAULT_LENGTH = 10_000;

const SYSTEM_FORM_COMPONENT_NAMES = new Set([
  "checkboxs",
  "citys",
  "dates",
  "dateranges",
  "radios",
  "selects",
  "texts",
  "times",
  "timeranges",
  "uploadPicture",
]);

type JsonRecord = Record<string, unknown>;

export interface SystemFormAdminActor {
  id: number;
  name: string;
  ip: string;
  method: string;
}

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
    return systemFormComponentArray(JSON.parse(value));
  } catch {
    return [];
  }
}

function systemFormComponentArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as JsonRecord)
    .sort(([leftKey, left], [rightKey, right]) => {
      const leftOrder = Number(nestedRecord(left).timestamp ?? leftKey);
      const rightOrder = Number(nestedRecord(right).timestamp ?? rightKey);
      if (!Number.isFinite(leftOrder) || !Number.isFinite(rightOrder)) return 0;
      return leftOrder - rightOrder;
    })
    .map(([, component]) => component);
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
  const components = systemFormComponentArray(parsed);
  if (!components.length) {
    throw new ValidateException("请添加表单组件");
  }
  if (components.length > MAX_FORM_COMPONENTS) {
    throw new ValidateException(`表单组件不能超过${MAX_FORM_COMPONENTS}项`);
  }
  const ids = new Set<string>();
  for (const [index, component] of components.entries()) {
    if (!component || typeof component !== "object" || Array.isArray(component)) {
      throw new ValidateException("表单组件格式错误");
    }
    validateSystemFormComponent(component as JsonRecord, index, ids);
  }
  const json = JSON.stringify(components);
  if (new TextEncoder().encode(json).byteLength > MAX_FORM_JSON_BYTES) {
    throw new ValidateException("表单组件数据过大");
  }
  return json;
}

function nestedRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function boundedComponentText(value: unknown, field: string, max: number, required = false): string {
  if (typeof value !== "string" && typeof value !== "number") {
    if (!required && (value === undefined || value === null)) return "";
    throw new ValidateException(`${field}格式错误`);
  }
  const result = String(value).trim();
  if (required && !result) throw new ValidateException(`${field}不能为空`);
  if (result.length > max) throw new ValidateException(`${field}不能超过${max}个字符`);
  return result;
}

function componentChoiceText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  const record = nestedRecord(value);
  return boundedComponentText(record.val ?? record.value ?? record.label, "表单选项", MAX_FORM_CHOICE_LENGTH, true);
}

function validateDefaultValue(value: string, subtype: number, title: string): void {
  if (!value) return;
  if (subtype === 1 && !/^1[3-9]\d{9}$/.test(value)) throw new ValidateException(`${title}默认手机号格式错误`);
  if (subtype === 2 && !/^[1-9]\d{14}(?:\d{2}[\dXx])?$/.test(value)) {
    throw new ValidateException(`${title}默认身份证号格式错误`);
  }
  if (subtype === 3 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new ValidateException(`${title}默认邮箱格式错误`);
  }
  if (subtype === 4 && (!Number.isFinite(Number(value)) || Number(value) <= 0)) {
    throw new ValidateException(`${title}默认数字必须大于0`);
  }
}

function validateSystemFormComponent(component: JsonRecord, index: number, ids: Set<string>): void {
  const name = boundedComponentText(component.name, `第${index + 1}项组件类型`, 32, true);
  if (!SYSTEM_FORM_COMPONENT_NAMES.has(name)) throw new ValidateException("系统表单包含不支持的组件");
  const rawId = component.id ?? component.timestamp;
  const id = boundedComponentText(rawId, `第${index + 1}项组件ID`, 100, true);
  if (ids.has(id)) throw new ValidateException("系统表单包含重复组件ID");
  ids.add(id);

  const title = boundedComponentText(
    nestedRecord(component.titleConfig).value,
    `第${index + 1}项标题`,
    MAX_FORM_TITLE_LENGTH,
    true,
  );
  boundedComponentText(nestedRecord(component.tipConfig).value, `${title}提示语`, MAX_FORM_TIP_LENGTH);
  const required = nestedRecord(component.titleShow).val;
  if (![true, false, 0, 1, "0", "1", undefined].includes(required as never)) {
    throw new ValidateException(`${title}必填状态格式错误`);
  }

  if (["checkboxs", "radios", "selects"].includes(name)) {
    const choices = nestedRecord(component.wordsConfig).list;
    if (!Array.isArray(choices) || choices.length < 1 || choices.length > MAX_FORM_CHOICES) {
      throw new ValidateException(`${title}选项必须为1到${MAX_FORM_CHOICES}项`);
    }
    const normalized = choices.map(componentChoiceText);
    if (new Set(normalized).size !== normalized.length) throw new ValidateException(`${title}包含重复选项`);
  }

  if (name === "texts") {
    const rawSubtype = nestedRecord(component.valConfig).tabVal ?? 0;
    const subtype = Number(rawSubtype);
    if (!Number.isSafeInteger(subtype) || subtype < 0 || subtype > 4) {
      throw new ValidateException(`${title}文本类型格式错误`);
    }
    const defaultValue = boundedComponentText(
      nestedRecord(component.defaultValConfig).value,
      `${title}默认值`,
      MAX_FORM_DEFAULT_LENGTH,
    );
    validateDefaultValue(defaultValue, subtype, title);
  }

  if (name === "uploadPicture") {
    const limit = Number(nestedRecord(component.numConfig).val ?? 9);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 9) {
      throw new ValidateException(`${title}上传数量必须为1到9`);
    }
  }
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
      require: item.titleShow?.val === true || item.titleShow?.val === 1 || item.titleShow?.val === "1",
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

function formListProjection() {
  return {
    id: systemForm.id,
    version: systemForm.version,
    name: systemForm.name,
    cover_image: systemForm.coverImage,
    status: systemForm.status,
    update_time: systemForm.updateTime,
    add_time: systemForm.addTime,
  };
}

async function configureSystemFormWrite(tx: DbClient): Promise<void> {
  await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
  await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SYSTEM_FORM_LOCK_NAMESPACE}, 0)`);
}

function assertSystemFormActor(actor: SystemFormAdminActor): void {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0) throw new ValidateException("系统表单操作身份无效");
}

async function writeSystemFormAudit(
  tx: DbClient,
  actor: SystemFormAdminActor,
  formId: number,
  action: "create" | "update" | "rename" | "enable" | "disable" | "delete",
): Promise<void> {
  assertSystemFormActor(actor);
  await tx.insert(systemLog).values({
    adminId: actor.id,
    adminName: actor.name.slice(0, 64),
    path: `/adminapi/form/${action}/${formId}`,
    page: "/config/forms",
    method: actor.method.slice(0, 10).toUpperCase(),
    action: `system_form.${action};id=${formId}`,
    ip: actor.ip.slice(0, 45),
    type: "admin_config",
    addTime: Math.floor(Date.now() / 1_000),
  });
}

async function activeSystemFormReferences(tx: DbClient, id: number): Promise<string[]> {
  const [products, seckill, combination, bargain, integral] = await Promise.all([
    tx.select({ id: storeProduct.id }).from(storeProduct)
      .where(and(eq(storeProduct.systemFormId, id), eq(storeProduct.isDel, 0))).limit(1),
    tx.select({ id: storeSeckill.id }).from(storeSeckill)
      .where(and(eq(storeSeckill.systemFormId, id), eq(storeSeckill.isDel, 0), eq(storeSeckill.status, 1))).limit(1),
    tx.select({ id: storeCombination.id }).from(storeCombination)
      .where(and(eq(storeCombination.systemFormId, id), eq(storeCombination.isDel, 0), eq(storeCombination.status, 1))).limit(1),
    tx.select({ id: storeBargain.id }).from(storeBargain)
      .where(and(eq(storeBargain.systemFormId, id), eq(storeBargain.isDel, 0), eq(storeBargain.status, 1))).limit(1),
    tx.select({ id: storeIntegral.id }).from(storeIntegral)
      .where(and(eq(storeIntegral.systemFormId, id), eq(storeIntegral.isDel, 0), eq(storeIntegral.status, 1))).limit(1),
  ]);
  return [
    products[0] ? "商品" : "",
    seckill[0] ? "秒杀" : "",
    combination[0] ? "拼团" : "",
    bargain[0] ? "砍价" : "",
    integral[0] ? "积分商品" : "",
  ].filter(Boolean);
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
    const page = Math.max(1, Math.min(10_000, integer(query.page, "页码", 1)));
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
        .select(formListProjection())
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

  async saveForm(id: number, input: unknown, actor: SystemFormAdminActor) {
    assertSystemFormActor(actor);
    const body = inputRecord(input);
    const name = textValue(body.name, "表单模版名称", 255, true);
    const value = normalizeSystemFormDefinition(body.value);
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      await configureSystemFormWrite(tx);
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
        const readback = await tx.select({ name: systemForm.name, value: systemForm.value })
          .from(systemForm).where(and(eq(systemForm.id, id), eq(systemForm.isDel, 0))).limit(1);
        if (readback[0]?.name !== name || readback[0]?.value !== value) {
          throw new Error("系统表单保存回读不一致");
        }
        await writeSystemFormAudit(tx, actor, id, "update");
        return { id };
      }
      const inserted = await tx
        .insert(systemForm)
        .values({ name, value, addTime: now, updateTime: now })
        .returning({ id: systemForm.id });
      const insertedId = inserted[0]?.id;
      if (!insertedId) throw new Error("系统表单新增回读失败");
      const readback = await tx.select({ name: systemForm.name, value: systemForm.value })
        .from(systemForm).where(and(eq(systemForm.id, insertedId), eq(systemForm.isDel, 0))).limit(1);
      if (readback[0]?.name !== name || readback[0]?.value !== value) {
        throw new Error("系统表单新增回读不一致");
      }
      await writeSystemFormAudit(tx, actor, insertedId, "create");
      return { id: insertedId };
    });
  }

  async renameForm(id: number, input: unknown, actor: SystemFormAdminActor) {
    assertSystemFormActor(actor);
    const body = inputRecord(input);
    const name = textValue(body.name, "表单模版名称", 255, true);
    return withTx(this.container, async (tx) => {
      await configureSystemFormWrite(tx);
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
      const readback = await tx.select({ name: systemForm.name }).from(systemForm)
        .where(and(eq(systemForm.id, id), eq(systemForm.isDel, 0))).limit(1);
      if (readback[0]?.name !== name) throw new Error("系统表单改名回读不一致");
      await writeSystemFormAudit(tx, actor, id, "rename");
    });
  }

  async deleteForm(id: number, actor: SystemFormAdminActor) {
    assertSystemFormActor(actor);
    await withTx(this.container, async (tx) => {
      await configureSystemFormWrite(tx);
      const rows = await tx.select({ id: systemForm.id }).from(systemForm)
        .where(and(eq(systemForm.id, id), eq(systemForm.isDel, 0))).limit(1).for("update");
      if (!rows[0]) throw new NotFoundException("系统表单不存在");
      const references = await activeSystemFormReferences(tx, id);
      if (references.length) throw new ValidateException(`系统表单仍被${references.join("、")}使用，不能删除`);
      await tx.update(systemForm).set({ isDel: 1, status: 0, updateTime: Math.floor(Date.now() / 1000) })
        .where(and(eq(systemForm.id, id), eq(systemForm.isDel, 0)));
      const readback = await tx.select({ isDel: systemForm.isDel, status: systemForm.status })
        .from(systemForm).where(eq(systemForm.id, id)).limit(1);
      if (readback[0]?.isDel !== 1 || readback[0]?.status !== 0) throw new Error("系统表单删除回读不一致");
      await writeSystemFormAudit(tx, actor, id, "delete");
    });
  }

  async setFormStatus(id: number, statusValue: unknown, actor: SystemFormAdminActor) {
    assertSystemFormActor(actor);
    const status = integer(statusValue, "状态", 0, 1);
    await withTx(this.container, async (tx) => {
      await configureSystemFormWrite(tx);
      const rows = await tx.select({ id: systemForm.id, status: systemForm.status }).from(systemForm)
        .where(and(eq(systemForm.id, id), eq(systemForm.isDel, 0))).limit(1).for("update");
      if (!rows[0]) throw new NotFoundException("系统表单不存在");
      if (rows[0].status === status) throw new ValidateException("系统表单状态未修改");
      if (status === 0) {
        const references = await activeSystemFormReferences(tx, id);
        if (references.length) throw new ValidateException(`系统表单仍被${references.join("、")}使用，不能停用`);
      }
      await tx.update(systemForm).set({ status, updateTime: Math.floor(Date.now() / 1000) })
        .where(and(eq(systemForm.id, id), eq(systemForm.isDel, 0)));
      const readback = await tx.select({ status: systemForm.status }).from(systemForm)
        .where(and(eq(systemForm.id, id), eq(systemForm.isDel, 0))).limit(1);
      if (readback[0]?.status !== status) throw new Error("系统表单状态回读不一致");
      await writeSystemFormAudit(tx, actor, id, status === 1 ? "enable" : "disable");
    });
  }

  async formDataList(formId: number, query: Record<string, string>) {
    if (!Number.isSafeInteger(formId) || formId <= 0) throw new ValidateException("系统表单ID错误");
    const page = Math.max(1, Math.min(10_000, integer(query.page, "页码", 1)));
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
    if (query.start_time) conditions.push(gte(systemFormData.addTime, integer(query.start_time, "开始时间", 0)));
    if (query.end_time) conditions.push(lte(systemFormData.addTime, integer(query.end_time, "结束时间", 0)));
    if (query.start_time && query.end_time && Number(query.start_time) > Number(query.end_time)) {
      throw new ValidateException("开始时间不能晚于结束时间");
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
