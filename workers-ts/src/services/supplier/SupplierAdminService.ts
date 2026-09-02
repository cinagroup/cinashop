import bcrypt from "bcryptjs";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { systemAdmin, systemLog, systemRole, systemSupplier } from "@/models/schema";
import { ApiErrorCode, AuthException, NotFoundException, ValidateException } from "@/utils/errors";
import {
  allSupplierPermissionKeys,
  assertSupplierDelegablePermissions,
  normalizeSupplierRoleRules,
  resolveSupplierRoleAssignment,
  SupplierPermissionService,
} from "@/services/supplier/SupplierPermissionService";

const SUPPLIER_ADMIN_TYPE = 4;
const SUPPLIER_ROLE_TYPE = 4;
const SUPPLIER_CHILD_LEVEL = 1;
const ADMIN_LOCK_NAMESPACE = 731_606;
const MAX_ROLES = 32;

export interface SupplierAdminActor {
  id: number;
  name: string;
  ip: string;
}

export interface SupplierAdminInput {
  account: string;
  realName: string;
  phone: string;
  password?: string;
  roles: number[];
  status: 0 | 1;
  headPic: string;
}

export interface SupplierRoleInput {
  name: string;
  rules: string;
  status: 0 | 1;
}

type SupplierAdminRow = typeof systemAdmin.$inferSelect;

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 0,
): string {
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ValidateException(`${label}长度应为${minimum}-${maximum}个字符`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) throw new ValidateException(`${label}包含非法字符`);
  return normalized;
}

function roleIds(value: unknown): number[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const ids = [...new Set(source.map(Number))];
  if (!ids.length || ids.length > MAX_ROLES || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ValidateException("请选择1-32个有效供应商角色");
  }
  return ids.sort((left, right) => left - right);
}

function statusValue(value: unknown): 0 | 1 {
  const parsed = Number(value ?? 1);
  if (parsed !== 0 && parsed !== 1) throw new ValidateException("管理员状态错误");
  return parsed;
}

export function normalizeSupplierAdminInput(
  input: Record<string, unknown>,
  creating: boolean,
): SupplierAdminInput {
  const account = boundedString(input.account, "管理员账号", 32, 3);
  if (/\s/u.test(account)) throw new ValidateException("管理员账号不能包含空白字符");
  const realName = boundedString(input.real_name, "管理员姓名", 16, 1);
  const phone = boundedString(input.phone, "管理员电话", 32, 3);
  const headPic = input.head_pic === undefined ? "" : boundedString(input.head_pic, "管理员头像", 255);
  if (/^(?:data|javascript):/iu.test(headPic)) throw new ValidateException("管理员头像地址不安全");
  const rawPassword = input.pwd === undefined ? "" : boundedString(input.pwd, "管理员密码", 72);
  const confirmation = input.conf_pwd === undefined
    ? ""
    : boundedString(input.conf_pwd, "确认密码", 72);
  if (creating && rawPassword.length < 12) throw new ValidateException("管理员密码至少需要12位");
  if (rawPassword && rawPassword.length < 12) throw new ValidateException("管理员密码至少需要12位");
  if (rawPassword !== confirmation) throw new ValidateException("两次输入的密码不一致");
  return {
    account,
    realName,
    phone,
    password: rawPassword || undefined,
    roles: roleIds(input.roles),
    status: statusValue(input.status),
    headPic,
  };
}

export function normalizeSupplierRoleInput(input: Record<string, unknown>): SupplierRoleInput {
  const name = boundedString(input.role_name, "角色名称", 32, 1);
  const rawRules = Array.isArray(input.rules)
    ? input.rules.map(String)
    : typeof input.rules === "string"
      ? input.rules
      : "";
  const rules = normalizeSupplierRoleRules(rawRules);
  const keys = rules.split(",").filter((token) => token.startsWith("supplier."));
  if (!keys.length) throw new ValidateException("请至少选择一项供应商权限");
  return { name, rules, status: statusValue(input.status) };
}

function validId(value: number, label = "管理员ID"): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValidateException(`${label}错误`);
  return value;
}

function utc8Time(value: number): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value * 1_000));
}

function roleIdArray(value: string): number[] {
  return [...new Set(value.split(",").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
    .slice(0, MAX_ROLES)
    .sort((left, right) => left - right);
}

async function scopedRoleNames(db: DbClient, rows: readonly SupplierAdminRow[], supplierId: number) {
  const ids = [...new Set(rows.flatMap((row) => roleIdArray(row.roles)))];
  if (!ids.length) return new Map<number, string>();
  const roles = await db
    .select({ id: systemRole.id, name: systemRole.roleName })
    .from(systemRole)
    .where(and(
      inArray(systemRole.id, ids),
      eq(systemRole.type, SUPPLIER_ROLE_TYPE),
      eq(systemRole.relationId, supplierId),
      eq(systemRole.status, 1),
    ));
  return new Map(roles.map((role) => [role.id, role.name]));
}

function present(row: SupplierAdminRow, names: ReadonlyMap<number, string>) {
  const ids = roleIdArray(row.roles);
  return {
    id: row.id,
    account: row.account,
    real_name: row.realName,
    phone: row.phone,
    head_pic: row.headPic,
    roles: ids,
    role_names: ids.map((id) => names.get(id)).filter((name): name is string => Boolean(name)),
    status: row.status,
    level: row.level,
    add_time: row.addTime,
    last_time: row.lastTime,
    login_count: row.loginCount,
    _add_time: utc8Time(row.addTime),
    _last_time: utc8Time(row.lastTime),
  };
}

async function activeRoles(db: DbClient, supplierId: number) {
  const rows = await db
    .select({ id: systemRole.id, name: systemRole.roleName, rules: systemRole.rules })
    .from(systemRole)
    .where(and(
      eq(systemRole.type, SUPPLIER_ROLE_TYPE),
      eq(systemRole.relationId, supplierId),
      eq(systemRole.status, 1),
    ))
    .orderBy(asc(systemRole.level), asc(systemRole.id))
    .limit(101);
  if (rows.length > 100) throw new ValidateException("供应商角色数量异常");
  return rows.map((role) => ({ value: role.id, label: role.name }));
}

async function scopedTarget(db: DbClient, supplierId: number, id: number, lock = false) {
  const query = db
    .select()
    .from(systemAdmin)
    .where(and(
      eq(systemAdmin.id, validId(id)),
      eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
      eq(systemAdmin.relationId, supplierId),
      eq(systemAdmin.level, SUPPLIER_CHILD_LEVEL),
      eq(systemAdmin.isDel, 0),
    ))
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  if (!rows[0]) throw new NotFoundException("管理员不存在或不属于当前供应商");
  return rows[0];
}

async function mutationAuthority(
  db: DbClient,
  supplierId: number,
  actor: SupplierAdminActor,
): Promise<Set<string>> {
  const suppliers = await db
    .select({ adminId: systemSupplier.adminId })
    .from(systemSupplier)
    .where(and(
      eq(systemSupplier.id, supplierId),
      eq(systemSupplier.isShow, 1),
      eq(systemSupplier.isDel, 0),
    ))
    .limit(1)
    .for("key share");
  const supplier = suppliers[0];
  if (!supplier) throw new NotFoundException("供应商不存在");
  const actors = await db
    .select({ id: systemAdmin.id, roles: systemAdmin.roles })
    .from(systemAdmin)
    .where(and(
      eq(systemAdmin.id, actor.id),
      eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
      eq(systemAdmin.relationId, supplierId),
      eq(systemAdmin.status, 1),
      eq(systemAdmin.isDel, 0),
    ))
    .limit(1)
    .for("key share");
  const current = actors[0];
  if (!current) throw new AuthException("供应商管理员已失效", ApiErrorCode.ERR_AUTH);
  if (supplier.adminId === actor.id) return allSupplierPermissionKeys();
  const keys = (await resolveSupplierRoleAssignment(db, current.roles, supplierId)).keys;
  if (!keys.has("supplier.admin.manage")) {
    throw new AuthException("暂时没有权限管理子账号", ApiErrorCode.ERR_AUTH);
  }
  return keys;
}

async function validateAssignedRoles(
  db: DbClient,
  supplierId: number,
  ids: readonly number[],
  granted: ReadonlySet<string>,
): Promise<void> {
  const roles = await db
    .select({ id: systemRole.id })
    .from(systemRole)
    .where(and(
      inArray(systemRole.id, ids),
      eq(systemRole.type, SUPPLIER_ROLE_TYPE),
      eq(systemRole.relationId, supplierId),
      eq(systemRole.status, 1),
    ))
    .for("key share");
  if (roles.length !== ids.length) throw new ValidateException("包含无效或其他供应商的角色");
  const requested = (await resolveSupplierRoleAssignment(db, ids.map(String), supplierId)).keys;
  if (!requested.size) throw new ValidateException("所选角色没有可执行权限");
  assertSupplierDelegablePermissions(granted, requested);
}

async function scopedRole(db: DbClient, supplierId: number, id: number, lock = false) {
  const query = db
    .select()
    .from(systemRole)
    .where(and(
      eq(systemRole.id, validId(id, "角色ID")),
      eq(systemRole.type, SUPPLIER_ROLE_TYPE),
      eq(systemRole.relationId, supplierId),
      sql`${systemRole.status} >= 0`,
    ))
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  if (!rows[0]) throw new NotFoundException("角色不存在或不属于当前供应商");
  return rows[0];
}

async function ensureUnique(db: DbClient, input: SupplierAdminInput, excluding = 0): Promise<void> {
  const accounts = await db
    .select({ id: systemAdmin.id })
    .from(systemAdmin)
    .where(and(
      eq(systemAdmin.account, input.account),
      eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
      eq(systemAdmin.isDel, 0),
      excluding > 0 ? ne(systemAdmin.id, excluding) : sql`true`,
    ))
    .limit(1);
  if (accounts[0]) throw new ValidateException("管理员账号已存在");
  const phones = await db
    .select({ id: systemAdmin.id })
    .from(systemAdmin)
    .where(and(
      eq(systemAdmin.phone, input.phone),
      eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
      eq(systemAdmin.isDel, 0),
      excluding > 0 ? ne(systemAdmin.id, excluding) : sql`true`,
    ))
    .limit(1);
  if (phones[0]) throw new ValidateException("管理员电话已存在");
}

async function audit(
  db: DbClient,
  actor: SupplierAdminActor,
  supplierId: number,
  action: string,
  targetId: number,
  method: string,
): Promise<void> {
  await db.insert(systemLog).values({
    adminId: actor.id,
    adminName: actor.name.slice(0, 64),
    path: `/supplierapi/admin/${targetId}`,
    page: "/administrators",
    method,
    action: `${action};supplier=${supplierId};target=${targetId}`.slice(0, 255),
    ip: actor.ip.slice(0, 45),
    type: "supplier_admin",
    addTime: Math.floor(Date.now() / 1_000),
    merchantId: supplierId,
  });
}

function formDefinition(
  roles: Awaited<ReturnType<typeof activeRoles>>,
  info?: ReturnType<typeof present>,
) {
  return {
    title: info ? "管理员修改" : "管理员添加",
    action: `/supplierapi/admin${info ? `/${info.id}` : ""}`,
    method: info ? "PUT" : "POST",
    rules: [
      { field: "account", title: "管理员账号", type: "input", value: info?.account ?? "", maxlength: 32, required: true },
      { field: "pwd", title: "管理员密码", type: "password", value: "", minlength: 12, maxlength: 72, required: !info },
      { field: "conf_pwd", title: "确认密码", type: "password", value: "", minlength: 12, maxlength: 72, required: !info },
      { field: "real_name", title: "管理员姓名", type: "input", value: info?.real_name ?? "", maxlength: 16, required: true },
      { field: "phone", title: "管理员电话", type: "input", value: info?.phone ?? "", maxlength: 32, required: true },
      { field: "head_pic", title: "头像", type: "input", value: info?.head_pic ?? "", maxlength: 255 },
      { field: "roles", title: "管理员角色", type: "select", value: info?.roles ?? [], options: roles, multiple: true, required: true },
      { field: "status", title: "状态", type: "radio", value: info?.status ?? 1, options: [{ label: "开启", value: 1 }, { label: "关闭", value: 0 }] },
    ],
    role_options: roles,
    info: info ?? null,
  };
}

export class SupplierAdminService {
  constructor(private readonly container: Container) {}

  async list(supplierId: number, query: Record<string, string>) {
    const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? "20", 10) || 20));
    const where = and(
      eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
      eq(systemAdmin.relationId, supplierId),
      eq(systemAdmin.level, SUPPLIER_CHILD_LEVEL),
      eq(systemAdmin.isDel, 0),
    );
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(systemAdmin).where(where).orderBy(desc(systemAdmin.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(systemAdmin).where(where),
    ]);
    const names = await scopedRoleNames(this.container.db, rows, supplierId);
    return { list: rows.map((row) => present(row, names)), count: totals[0]?.count ?? 0, page, limit };
  }

  async detail(supplierId: number, id: number) {
    const row = await scopedTarget(this.container.db, supplierId, id);
    return present(row, await scopedRoleNames(this.container.db, [row], supplierId));
  }

  async createForm(supplierId: number) {
    return formDefinition(await activeRoles(this.container.db, supplierId));
  }

  async editForm(supplierId: number, id: number) {
    const info = await this.detail(supplierId, id);
    return formDefinition(await activeRoles(this.container.db, supplierId), info);
  }

  async roles(supplierId: number) {
    const rows = await this.container.db
      .select()
      .from(systemRole)
      .where(and(
        eq(systemRole.type, SUPPLIER_ROLE_TYPE),
        eq(systemRole.relationId, supplierId),
        sql`${systemRole.status} >= 0`,
      ))
      .orderBy(asc(systemRole.level), asc(systemRole.id))
      .limit(101);
    if (rows.length > 100) throw new ValidateException("供应商角色数量异常");
    const permissionService = new SupplierPermissionService(this.container.db);
    const permissionSets = await permissionService.resolveManyRulePermissionKeys(
      rows.map((row) => row.rules),
    );
    const list = rows.map((row, index) => ({
        id: row.id,
        role_name: row.roleName,
        rules: permissionSets[index] ?? [],
        level: row.level,
        status: row.status,
      }));
    return {
      list,
      permission_tree: permissionService.permissionTree(),
    };
  }

  async saveRole(
    supplierId: number,
    actor: SupplierAdminActor,
    id: number,
    input: SupplierRoleInput,
  ) {
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_LOCK_NAMESPACE}, ${SUPPLIER_ADMIN_TYPE})`);
      const granted = await mutationAuthority(tx, supplierId, actor);
      const resolved = await new SupplierPermissionService(tx).resolveManyRulePermissionKeys([input.rules]);
      const requested = new Set(resolved[0] ?? []);
      assertSupplierDelegablePermissions(granted, requested);
      const duplicate = await tx
        .select({ id: systemRole.id })
        .from(systemRole)
        .where(and(
          eq(systemRole.type, SUPPLIER_ROLE_TYPE),
          eq(systemRole.relationId, supplierId),
          eq(systemRole.roleName, input.name),
          sql`${systemRole.status} >= 0`,
          id > 0 ? ne(systemRole.id, id) : sql`true`,
        ))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("角色名称已存在");
      if (id > 0) {
        const current = await scopedRole(tx, supplierId, id, true);
        await tx.update(systemRole).set({
          roleName: input.name,
          rules: input.rules,
          status: input.status,
        }).where(and(
          eq(systemRole.id, current.id),
          eq(systemRole.type, SUPPLIER_ROLE_TYPE),
          eq(systemRole.relationId, supplierId),
        ));
        await audit(tx, actor, supplierId, "role_update", current.id, "PUT");
        return { id: current.id };
      }
      const inserted = await tx.insert(systemRole).values({
        type: SUPPLIER_ROLE_TYPE,
        relationId: supplierId,
        roleName: input.name,
        rules: input.rules,
        level: SUPPLIER_CHILD_LEVEL,
        status: input.status,
      }).returning({ id: systemRole.id });
      const roleId = inserted[0]?.id;
      if (!roleId) throw new ValidateException("角色创建失败");
      await audit(tx, actor, supplierId, "role_create", roleId, "POST");
      return { id: roleId };
    });
  }

  async deleteRole(supplierId: number, actor: SupplierAdminActor, id: number) {
    await withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_LOCK_NAMESPACE}, ${SUPPLIER_ADMIN_TYPE})`);
      await mutationAuthority(tx, supplierId, actor);
      const role = await scopedRole(tx, supplierId, id, true);
      const used = await tx
        .select({ id: systemAdmin.id })
        .from(systemAdmin)
        .where(and(
          eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
          eq(systemAdmin.relationId, supplierId),
          eq(systemAdmin.level, SUPPLIER_CHILD_LEVEL),
          eq(systemAdmin.isDel, 0),
          sql`${String(role.id)} = ANY(string_to_array(${systemAdmin.roles}, ','))`,
        ))
        .limit(1)
        .for("key share");
      if (used[0]) throw new ValidateException("角色仍被子账号使用，不能删除");
      await tx.update(systemRole).set({ status: -1 }).where(and(
        eq(systemRole.id, role.id),
        eq(systemRole.type, SUPPLIER_ROLE_TYPE),
        eq(systemRole.relationId, supplierId),
      ));
      await audit(tx, actor, supplierId, "role_delete", role.id, "DELETE");
    });
  }

  async create(supplierId: number, actor: SupplierAdminActor, input: SupplierAdminInput) {
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_LOCK_NAMESPACE}, ${SUPPLIER_ADMIN_TYPE})`);
      const granted = await mutationAuthority(tx, supplierId, actor);
      await validateAssignedRoles(tx, supplierId, input.roles, granted);
      await ensureUnique(tx, input);
      const inserted = await tx.insert(systemAdmin).values({
        account: input.account,
        adminType: SUPPLIER_ADMIN_TYPE,
        relationId: supplierId,
        headPic: input.headPic,
        pwd: await bcrypt.hash(input.password!, 12),
        realName: input.realName,
        phone: input.phone,
        roles: input.roles.join(","),
        addTime: Math.floor(Date.now() / 1_000),
        level: SUPPLIER_CHILD_LEVEL,
        status: input.status,
        isDel: 0,
      }).returning({ id: systemAdmin.id });
      const id = inserted[0]?.id;
      if (!id) throw new ValidateException("管理员创建失败");
      await audit(tx, actor, supplierId, "create", id, "POST");
      return { id };
    });
  }

  async update(supplierId: number, actor: SupplierAdminActor, id: number, input: SupplierAdminInput) {
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_LOCK_NAMESPACE}, ${SUPPLIER_ADMIN_TYPE})`);
      const granted = await mutationAuthority(tx, supplierId, actor);
      const target = await scopedTarget(tx, supplierId, id, true);
      if (target.id === actor.id) throw new ValidateException("请通过个人设置修改当前账号");
      await validateAssignedRoles(tx, supplierId, input.roles, granted);
      await ensureUnique(tx, input, target.id);
      await tx.update(systemAdmin).set({
        account: input.account,
        headPic: input.headPic,
        realName: input.realName,
        phone: input.phone,
        roles: input.roles.join(","),
        status: input.status,
        ...(input.password ? { pwd: await bcrypt.hash(input.password, 12) } : {}),
      }).where(and(
        eq(systemAdmin.id, target.id),
        eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
        eq(systemAdmin.relationId, supplierId),
        eq(systemAdmin.level, SUPPLIER_CHILD_LEVEL),
        eq(systemAdmin.isDel, 0),
      ));
      await audit(tx, actor, supplierId, "update", target.id, "PUT");
      return { id: target.id };
    });
  }

  async delete(supplierId: number, actor: SupplierAdminActor, id: number) {
    await withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_LOCK_NAMESPACE}, ${SUPPLIER_ADMIN_TYPE})`);
      await mutationAuthority(tx, supplierId, actor);
      const target = await scopedTarget(tx, supplierId, id, true);
      if (target.id === actor.id) throw new ValidateException("不能删除当前登录账号");
      await tx.update(systemAdmin).set({ isDel: 1, status: 0 }).where(and(
        eq(systemAdmin.id, target.id),
        eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
        eq(systemAdmin.relationId, supplierId),
        eq(systemAdmin.level, SUPPLIER_CHILD_LEVEL),
        eq(systemAdmin.isDel, 0),
      ));
      await audit(tx, actor, supplierId, "delete", target.id, "DELETE");
    });
  }

  async setStatus(supplierId: number, actor: SupplierAdminActor, id: number, status: number) {
    if (status !== 0 && status !== 1) throw new ValidateException("管理员状态错误");
    await withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_LOCK_NAMESPACE}, ${SUPPLIER_ADMIN_TYPE})`);
      await mutationAuthority(tx, supplierId, actor);
      const target = await scopedTarget(tx, supplierId, id, true);
      if (target.id === actor.id) throw new ValidateException("不能修改当前登录账号状态");
      await tx.update(systemAdmin).set({ status }).where(and(
        eq(systemAdmin.id, target.id),
        eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
        eq(systemAdmin.relationId, supplierId),
        eq(systemAdmin.level, SUPPLIER_CHILD_LEVEL),
        eq(systemAdmin.isDel, 0),
      ));
      await audit(tx, actor, supplierId, status ? "enable" : "disable", target.id, "PUT");
    });
  }
}
