import { and, desc, asc, eq, getTableColumns, sql } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import { systemLog, systemMenus, systemRole } from "@/models/schema";
import {
  SUPPLIER_PERMISSION_GROUPS,
  requiredSupplierPermissions,
} from "@/services/supplier/SupplierPermissionService";
import { HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from "@/utils/errors";
import { supplierapiRoutes } from "@/routes/supplierapi";
import { inspectAdminSupplierMenuWriteCapability } from "@/migrations/adminSupplierMenuWriteCapability";

const TYPE = 4;
const MAX_ID = 2_147_483_647;
const MAX_NODES = 5_000;
const ROLE_LOCK_NAMESPACE = 731_606;
const SUPPLIER_ROLE_TYPE = 4;
const FORM_KEYS = ["pid", "auth_type", "menu_name", "menu_path", "unique_auth", "api_url",
  "methods", "icon", "sort", "is_show", "is_show_path", "access"] as const;
type FormKey = typeof FORM_KEYS[number];

export interface SupplierMenuRuleActor { id: number; name: string; ip: string }

function exactKeys(input: Record<string, unknown>, required: readonly string[]): void {
  if (Object.keys(input).length !== required.length ||
    Object.keys(input).some((key) => !required.includes(key)) || required.some((key) => !(key in input))) {
    throw new ValidateException("菜单规则请求字段无效");
  }
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ValidateException(`${label}无效`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number, required = false): string {
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const text = value.trim();
  if ((required && !text) || [...text].length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ValidateException(`${label}无效或超过 ${maximum} 字`);
  }
  return text;
}

function expectedRevision(input: Record<string, unknown>): string {
  const revision = input.expected_revision;
  if (typeof revision !== "string" || !/^\d{1,10}$/.test(revision)) {
    throw new ValidateException("请重新读取菜单规则后操作");
  }
  return revision;
}

function registeredApi(method: string, path: string): boolean {
  const normalized = path.replace(/^\/?supplierapi\/?/i, "").replace(/^\/+/, "");
  if (!normalized || !requiredSupplierPermissions(method, normalized)?.length) return false;
  return supplierapiRoutes.routes.some((route) => route.method === method && route.path === `/${normalized}`);
}

function form(input: Record<string, unknown>) {
  exactKeys(input, FORM_KEYS);
  const result: Record<FormKey, string | number> = {
    pid: integer(input.pid, "父级 ID", 0, MAX_ID),
    auth_type: integer(input.auth_type, "规则类型", 1, 2),
    menu_name: boundedText(input.menu_name, "规则名称", 64, true),
    menu_path: boundedText(input.menu_path, "菜单路径", 255),
    unique_auth: boundedText(input.unique_auth, "权限标识", 150),
    api_url: boundedText(input.api_url, "接口路径", 255),
    methods: boundedText(input.methods, "请求方式", 32),
    icon: boundedText(input.icon, "图标", 50),
    sort: integer(input.sort, "排序", 0, 100_000),
    is_show: integer(input.is_show, "显示状态", 0, 1),
    is_show_path: integer(input.is_show_path, "隐藏路径状态", 0, 1),
    access: integer(input.access, "规则启用状态", 0, 1),
  };
  if (result.auth_type === 1) {
    if (result.api_url || result.methods || !result.menu_path ||
      !/^\/supplier(?:\/|$)/.test(String(result.menu_path)) || !result.unique_auth ||
      !/^[A-Za-z0-9_.-]+$/.test(String(result.unique_auth))) {
      throw new ValidateException("菜单节点须使用供应商页面路径且不能填写接口");
    }
  } else {
    if (result.menu_path || result.unique_auth || result.is_show !== 1 ||
      result.is_show_path !== 0 || !result.api_url || !result.methods) {
      throw new ValidateException("接口规则路径、方法或显示状态无效");
    }
    const methods = [...new Set(String(result.methods).toUpperCase().split(/[\s,|]+/).filter(Boolean))];
    if (methods.length !== 1 || !["GET", "POST", "PUT", "DELETE"].includes(methods[0])) {
      throw new ValidateException("接口请求方式无效");
    }
    result.methods = methods[0];
    result.api_url = String(result.api_url).replace(/^\/?supplierapi\/?/i, "").replace(/^\/+/, "");
  }
  return result;
}

function sqlState(error: unknown): string | undefined {
  let current = error;
  for (let i = 0; i < 8 && current && typeof current === "object"; i++) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function writeError(error: unknown): never {
  const code = sqlState(error);
  if (code === "P0002") throw new NotFoundException("供应商菜单规则不存在");
  if (code === "40001") throw new HttpApiException("菜单规则已被其他管理员修改，请刷新后重试", 409, 409);
  if (code === "23514" || code === "23503" || code === "23505" || code === "P0001" || code === "22023") {
    throw new ValidateException("菜单规则违反类型、父级或角色引用约束");
  }
  if (code === "42883" || code === "42501") {
    throw new ServiceUnavailableException("菜单规则受控写入能力尚未就绪");
  }
  throw error;
}

type MenuRow = typeof systemMenus.$inferSelect & { rowVersion: string };
interface RuleNode {
  id: number;
  pid: number;
  type: number;
  auth_type: number;
  menu_name: string;
  menu_path: string;
  unique_auth: string;
  api_url: string;
  methods: string;
  icon: string;
  sort: number;
  is_show: number;
  is_show_path: number;
  access: number;
  is_del: number;
  revision: string;
  role_reference_count: number;
  role_reference_ids: number[];
  effective_permissions: string[];
  children: RuleNode[];
}
const projection = {
  ...getTableColumns(systemMenus),
  rowVersion: sql<string>`${systemMenus}.xmin::text`,
};

function positiveId(raw: unknown): number {
  if (typeof raw !== "number" && typeof raw !== "string") throw new ValidateException("菜单规则 ID 无效");
  const text = String(raw);
  if (!/^[1-9]\d*$/.test(text)) throw new ValidateException("菜单规则 ID 无效");
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id > MAX_ID) throw new ValidateException("菜单规则 ID 无效");
  return id;
}

function roleReferences(roles: ReadonlyArray<{ id: number; rules: string }>): Map<number, number[]> {
  const byMenu = new Map<number, number[]>();
  for (const role of roles) {
    const ids = new Set(role.rules.split(",").map((token) => token.trim())
      .filter((token) => /^[1-9]\d*$/.test(token)).map(Number)
      .filter((id) => Number.isSafeInteger(id) && id <= MAX_ID));
    for (const id of ids) {
      const references = byMenu.get(id) ?? [];
      references.push(role.id);
      byMenu.set(id, references);
    }
  }
  return byMenu;
}

function effectivePermissions(row: MenuRow): string[] {
  if (row.authType !== 2 || row.access !== 1 || row.isDel !== 0) return [];
  const methods = row.methods.split(/[\s,|]+/).filter(Boolean);
  const result = new Set<string>();
  for (const method of methods.length ? methods : ["GET"]) {
    for (const key of requiredSupplierPermissions(method, row.apiUrl) ?? []) result.add(key);
  }
  return [...result];
}

function present(row: MenuRow, referencedBy: readonly number[]): RuleNode {
  return {
    id: row.id,
    pid: row.pid,
    type: row.type,
    auth_type: row.authType,
    menu_name: row.menuName,
    menu_path: row.menuPath,
    unique_auth: row.uniqueAuth,
    api_url: row.apiUrl,
    methods: row.methods,
    icon: row.icon,
    sort: row.sort,
    is_show: row.isShow,
    is_show_path: row.isShowPath,
    access: row.access,
    is_del: row.isDel,
    revision: row.rowVersion,
    role_reference_count: referencedBy.length,
    role_reference_ids: [...referencedBy],
    effective_permissions: effectivePermissions(row),
    children: [] as RuleNode[],
  };
}

export class AdminSupplierMenuRuleService {
  constructor(private readonly container: Container) {}

  private async writeReady(db: DbClient = this.container.db): Promise<boolean> {
    try {
      return (await inspectAdminSupplierMenuWriteCapability(db)).ready;
    } catch {
      // Missing catalog prerequisites and unavailable routines are closed.
      return false;
    }
  }

  private async assertWriteReady(db: DbClient = this.container.db): Promise<void> {
    if (!(await this.writeReady(db))) {
      throw new ServiceUnavailableException("菜单规则受控写入能力尚未就绪");
    }
  }

  /** Legacy type=4 records are an audit surface. Worker Supplier navigation is
   * built from the fixed catalog and is deliberately reported separately. */
  async catalog() {
    return {
      write_ready: await this.writeReady(),
      permissions: SUPPLIER_PERMISSION_GROUPS.map((group) => ({
        key: group.key, label: group.label, manage: group.manage,
      })),
      navigation: SUPPLIER_PERMISSION_GROUPS.filter((group) => group.path).map((group) => ({
        path: group.path!, name: group.label, permission: `supplier.${group.key}.view`,
      })),
    };
  }

  async list(params: URLSearchParams) {
    for (const key of params.keys()) {
      if (!["is_show", "keyword"].includes(key) || params.getAll(key).length !== 1) {
        throw new ValidateException("菜单规则查询参数未知或重复");
      }
    }
    const isShow = params.get("is_show") ?? "";
    if (isShow !== "" && isShow !== "0" && isShow !== "1") {
      throw new ValidateException("显示状态无效");
    }
    const keyword = (params.get("keyword") ?? "").trim();
    if ([...keyword].length > 80 || /[\u0000-\u001f\u007f]/.test(keyword)) {
      throw new ValidateException("关键词无效或超过 80 字");
    }
    const where = and(eq(systemMenus.type, TYPE), eq(systemMenus.isDel, 0),
      isShow !== "" ? eq(systemMenus.isShow, Number(isShow)) : sql`true`,
      keyword ? sql`(${systemMenus.menuName} ILIKE ${`%${keyword}%`} OR
        ${systemMenus.menuPath} ILIKE ${`%${keyword}%`} OR
        ${systemMenus.uniqueAuth} ILIKE ${`%${keyword}%`} OR
        ${systemMenus.apiUrl} ILIKE ${`%${keyword}%`} OR
        ${systemMenus.id}::text LIKE ${`%${keyword}%`} OR
        ${systemMenus.pid}::text LIKE ${`%${keyword}%`})` : sql`true`);
    const rows = await this.container.db.select(projection).from(systemMenus).where(where)
      .orderBy(desc(systemMenus.sort), asc(systemMenus.id)).limit(MAX_NODES + 1);
    if (rows.length > MAX_NODES) throw new ValidateException("菜单规则数量超过单次清点上限");
    const roles = await this.container.db.select({ id: systemRole.id, rules: systemRole.rules })
      .from(systemRole).where(eq(systemRole.type, TYPE));
    const references = roleReferences(roles);
    const nodes = rows.map((row) => present(row, references.get(row.id) ?? []));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const list: RuleNode[] = [];
    for (const node of nodes) {
      // Corrupt legacy cycles should remain visible in an audit, never recurse.
      const parent = byId.get(node.pid);
      if (node.pid !== node.id && parent && !wouldCycle(node, parent, byId)) parent.children.push(node);
      else list.push(node);
    }
    return { list, count: rows.length };
  }

  async detail(rawId: unknown) {
    const id = positiveId(rawId);
    const [row] = await this.container.db.select(projection).from(systemMenus).where(and(
      eq(systemMenus.id, id), eq(systemMenus.type, TYPE), eq(systemMenus.isDel, 0),
    )).limit(1);
    if (!row) throw new NotFoundException("供应商菜单规则不存在");
    const roles = await this.container.db.select({ id: systemRole.id, rules: systemRole.rules })
      .from(systemRole).where(eq(systemRole.type, TYPE));
    return present(row, roleReferences(roles).get(id) ?? []);
  }

  private async write(tx: DbClient, operation: "create" | "update" | "visibility" | "delete",
    id: number, expected: string | null, payload: Record<string, unknown>): Promise<number> {
    try {
      const [result] = await tx.execute(sql`SELECT public.cinashop_admin_supplier_menu_write_v1(
        ${operation}, ${id}, ${expected}, ${JSON.stringify(payload)}::jsonb) AS id`);
      const written = Number(result?.id);
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new ServiceUnavailableException("菜单规则写入结果无效");
      }
      return written;
    } catch (error) {
      writeError(error);
    }
  }

  private async audit(tx: DbClient, actor: SupplierMenuRuleActor,
    operation: "create" | "update" | "visibility" | "delete", id: number): Promise<void> {
    await tx.insert(systemLog).values({
      adminId: positiveId(actor.id),
      adminName: boundedText(actor.name, "管理员名称", 64),
      path: `/supplier/menu-rules/${id}`,
      page: "supplier_menu_rules",
      method: operation === "create" ? "POST" : operation === "delete" ? "DELETE" : "PUT",
      action: `supplier_menu_rules.${operation}:${id}`,
      ip: actor.ip.slice(0, 45),
      type: "supplier_menu_rules",
      addTime: Math.floor(Date.now() / 1000),
    });
  }

  async create(input: Record<string, unknown>, actor: SupplierMenuRuleActor) {
    const payload = form(input);
    if (payload.auth_type === 2 && !registeredApi(String(payload.methods), String(payload.api_url))) {
      throw new ValidateException("接口规则必须对应已注册的供应商受保护路由");
    }
    return withTx(this.container, async (tx) => {
      await this.assertWriteReady(tx);
      const id = await this.write(tx, "create", 0, null, payload);
      await this.audit(tx, actor, "create", id);
      const [row] = await tx.select(projection).from(systemMenus).where(and(
        eq(systemMenus.id, id), eq(systemMenus.type, TYPE), eq(systemMenus.isDel, 0),
      )).limit(1);
      if (!row) throw new ServiceUnavailableException("菜单规则创建结果不可读");
      return present(row, []);
    });
  }

  async update(rawId: unknown, input: Record<string, unknown>, actor: SupplierMenuRuleActor) {
    const id = positiveId(rawId);
    const expected = expectedRevision(input);
    const payloadInput = { ...input };
    delete payloadInput.expected_revision;
    const payload = form(payloadInput);
    return withTx(this.container, async (tx) => {
      await this.assertWriteReady(tx);
      await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${ROLE_LOCK_NAMESPACE}, ${SUPPLIER_ROLE_TYPE})`);
      const [old] = await tx.select(projection).from(systemMenus).where(and(
        eq(systemMenus.id, id), eq(systemMenus.type, TYPE), eq(systemMenus.isDel, 0),
      )).for("update").limit(1);
      if (!old) throw new NotFoundException("供应商菜单规则不存在");
      if (old.rowVersion !== expected) throw new HttpApiException("菜单规则已被其他管理员修改，请刷新后重试", 409, 409);
      if (payload.auth_type === 2 &&
        (old.authType !== 2 || old.methods !== payload.methods || old.apiUrl !== payload.api_url) &&
        !registeredApi(String(payload.methods), String(payload.api_url))) {
        throw new ValidateException("接口规则必须对应已注册的供应商受保护路由");
      }
      await this.write(tx, "update", id, expected, payload);
      await this.audit(tx, actor, "update", id);
      const [row] = await tx.select(projection).from(systemMenus).where(eq(systemMenus.id, id)).limit(1);
      if (!row) throw new ServiceUnavailableException("菜单规则更新结果不可读");
      const roles = await tx.select({ id: systemRole.id, rules: systemRole.rules })
        .from(systemRole).where(eq(systemRole.type, TYPE));
      return present(row, roleReferences(roles).get(id) ?? []);
    });
  }

  async visibility(rawId: unknown, input: Record<string, unknown>, actor: SupplierMenuRuleActor) {
    const id = positiveId(rawId);
    exactKeys(input, ["is_show", "expected_revision"]);
    const expected = expectedRevision(input);
    const isShow = integer(input.is_show, "显示状态", 0, 1);
    return withTx(this.container, async (tx) => {
      await this.assertWriteReady(tx);
      await this.write(tx, "visibility", id, expected, { is_show: isShow });
      await this.audit(tx, actor, "visibility", id);
      const [row] = await tx.select(projection).from(systemMenus).where(eq(systemMenus.id, id)).limit(1);
      if (!row) throw new ServiceUnavailableException("菜单规则显隐结果不可读");
      return { id, is_show: row.isShow, revision: row.rowVersion };
    });
  }

  async delete(rawId: unknown, input: Record<string, unknown>, actor: SupplierMenuRuleActor) {
    const id = positiveId(rawId);
    exactKeys(input, ["expected_revision"]);
    const expected = expectedRevision(input);
    return withTx(this.container, async (tx) => {
      await this.assertWriteReady(tx);
      await this.write(tx, "delete", id, expected, {});
      await this.audit(tx, actor, "delete", id);
      return { id, is_del: 1 };
    });
  }
}

function wouldCycle(node: RuleNode, parent: RuleNode, byId: ReadonlyMap<number, RuleNode>): boolean {
  let current: RuleNode | undefined = parent;
  const visited = new Set<number>([node.id]);
  while (current) {
    if (visited.has(current.id)) return true;
    visited.add(current.id);
    current = byId.get(current.pid);
  }
  return false;
}
