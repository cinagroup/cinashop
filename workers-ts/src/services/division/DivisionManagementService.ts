import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { hash } from "bcryptjs";
import type { Container, DbClient } from "@/lib/di";
import { divisionApply, storeOrder, systemAdmin, user } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

export type DivisionRoleType = 1 | 2 | 3;

export interface DivisionAdminScope {
  level: number;
  divisionId: number;
}

export interface DivisionParentSnapshot {
  uid: number;
  divisionType: number;
  divisionStatus: number;
  divisionId: number;
  agentId: number;
  divisionPercent: number;
  divisionEndTime: number;
  status: number;
  isDel: number;
}

export interface SaveDivisionRoleInput {
  uid: number;
  roleType: DivisionRoleType;
  parentUid?: number;
  divisionName?: string;
  divisionPercent: number;
  divisionEndTime?: number | string;
  divisionStatus?: number;
  adminAccount?: string;
  adminPhone?: string;
  adminPassword?: string;
  adminPasswordConfirm?: string;
  adminRoles?: number[] | string;
}

export interface DivisionDateRange {
  start: number;
  endExclusive: number;
  bucket: "hour" | "day" | "month";
  xAxis: string[];
}

const ROLE_LOCK_NAMESPACE = 1_147_879_249;
const MAX_PAGE_SIZE = 100;

function assertInteger(value: number, message: string): void {
  if (!Number.isInteger(value)) throw new ValidateException(message);
}

export function normalizeDivisionPercent(value: unknown): number {
  const percent = Number(value);
  assertInteger(percent, "佣金比例必须是整数");
  if (percent < 0 || percent > 100) {
    throw new ValidateException("佣金比例必须在 0 到 100 之间");
  }
  return percent;
}

export function normalizeDivisionEndTime(value: number | string | undefined): number {
  if (value === undefined || value === "" || value === 0) return 0;
  if (typeof value === "number") {
    assertInteger(value, "到期时间格式错误");
    if (value < 0) throw new ValidateException("到期时间格式错误");
    return value;
  }
  if (/^\d+$/.test(value)) return normalizeDivisionEndTime(Number(value));
  const parsed = Date.parse(`${value}T23:59:59+08:00`);
  if (!Number.isFinite(parsed)) throw new ValidateException("到期时间格式错误");
  return Math.floor(parsed / 1000);
}

export function validateDivisionHierarchy(
  roleType: DivisionRoleType,
  percent: number,
  endTime: number,
  parent?: DivisionParentSnapshot,
): void {
  normalizeDivisionPercent(percent);
  if (roleType === 1) return;
  if (!parent || parent.isDel || !parent.status) {
    throw new ValidateException(roleType === 2 ? "上级事业部不存在" : "上级代理商不存在");
  }
  const expectedType = roleType - 1;
  if (parent.divisionType !== expectedType) {
    throw new ValidateException(roleType === 2 ? "上级用户不是事业部" : "上级用户不是代理商");
  }
  if (!parent.divisionStatus) {
    throw new ValidateException(roleType === 2 ? "上级事业部已停用" : "上级代理商已停用");
  }
  if (percent > parent.divisionPercent) {
    throw new ValidateException(
      roleType === 2 ? "代理商比例不能高于上级事业部" : "员工比例不能高于上级代理商",
    );
  }
  if (roleType === 2 && parent.divisionEndTime > 0 && endTime > parent.divisionEndTime) {
    throw new ValidateException("代理商到期时间不能晚于上级事业部");
  }
}

function parseYmd(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new ValidateException("时间格式应为 YYYY-MM-DD");
  const result = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    result.getUTCFullYear() !== Number(match[1]) ||
    result.getUTCMonth() !== Number(match[2]) - 1 ||
    result.getUTCDate() !== Number(match[3])
  ) {
    throw new ValidateException("时间范围无效");
  }
  return result;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseDivisionDateRange(startValue: string, endValue: string): DivisionDateRange {
  const startDate = parseYmd(startValue);
  const endDate = parseYmd(endValue);
  const days = Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  if (days < 1) throw new ValidateException("结束时间不能早于开始时间");
  if (days > 366) throw new ValidateException("统计时间范围不能超过 366 天");

  const start = Math.floor((startDate.getTime() - 8 * 3_600_000) / 1000);
  const endExclusive = Math.floor((endDate.getTime() + 86_400_000 - 8 * 3_600_000) / 1000);
  if (days === 1) {
    return {
      start,
      endExclusive,
      bucket: "hour",
      xAxis: Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0")),
    };
  }
  if (days <= 92) {
    return {
      start,
      endExclusive,
      bucket: "day",
      xAxis: Array.from({ length: days }, (_, index) => {
        const date = new Date(startDate.getTime() + index * 86_400_000);
        return ymd(date);
      }),
    };
  }

  const xAxis: string[] = [];
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  const last = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, "0")}`;
  while (true) {
    const label = cursor.toISOString().slice(0, 7);
    xAxis.push(label);
    if (label === last) break;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return { start, endExclusive, bucket: "month", xAxis };
}

function normalizePage(page: number, limit: number): { page: number; limit: number; offset: number } {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, MAX_PAGE_SIZE)) : 20;
  return { page: safePage, limit: safeLimit, offset: (safePage - 1) * safeLimit };
}

function roleDivisionId(role: Pick<DivisionParentSnapshot, "uid" | "divisionType" | "divisionId">): number {
  return role.divisionType === 1 ? role.uid : role.divisionId;
}

function assertScope(scope: DivisionAdminScope, divisionId: number, allowOwnDivision = true): void {
  if (scope.level === 0) return;
  if (!scope.divisionId || scope.divisionId !== divisionId || !allowOwnDivision) {
    throw new ValidateException("无权操作该事业部数据");
  }
}

function roleReset(now: number) {
  return {
    divisionName: "",
    divisionType: 0,
    divisionStatus: 0,
    divisionId: 0,
    agentId: 0,
    staffId: 0,
    divisionPercent: 0,
    divisionEndTime: 0,
    divisionChangeTime: now,
    divisionInvite: 0,
  } as const;
}

function parseImages(value: string): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function lockUsers(tx: DbClient, uids: number[]): Promise<void> {
  const sorted = [...new Set(uids.filter((uid) => uid > 0))].sort((a, b) => a - b);
  if (!sorted.length) return;
  const values = sql.join(sorted.map((uid) => sql`${uid}`), sql`, `);
  await tx.execute(sql`SELECT "uid" FROM "user" WHERE "uid" IN (${values}) ORDER BY "uid" FOR UPDATE`);
}

export class DivisionManagementService {
  constructor(private readonly container: Container) {}

  async listRoles(input: {
    roleType: DivisionRoleType;
    keyword?: string;
    parentUid?: number;
    page?: number;
    limit?: number;
    scope: DivisionAdminScope;
  }) {
    const { page, limit, offset } = normalizePage(input.page ?? 1, input.limit ?? 20);
    const conditions: SQL[] = [
      eq(user.divisionType, input.roleType),
      eq(user.status, 1),
      eq(user.isDel, 0),
    ];
    if (input.keyword?.trim()) {
      const keyword = `%${input.keyword.trim()}%`;
      conditions.push(
        or(
          ilike(user.divisionName, keyword),
          ilike(user.nickname, keyword),
          sql`${user.uid}::text LIKE ${keyword}`,
        )!,
      );
    }
    if (input.parentUid) {
      if (input.roleType === 2) conditions.push(eq(user.divisionId, input.parentUid));
      if (input.roleType === 3) conditions.push(eq(user.agentId, input.parentUid));
    }
    if (input.scope.level !== 0) {
      if (!input.scope.divisionId) return { list: [], count: 0, page, limit };
      conditions.push(
        input.roleType === 1
          ? eq(user.uid, input.scope.divisionId)
          : eq(user.divisionId, input.scope.divisionId),
      );
    }
    const where = and(...conditions)!;
    const [rows, countRows] = await Promise.all([
      this.container.db
        .select({
          uid: user.uid,
          nickname: user.nickname,
          avatar: user.avatar,
          phone: user.phone,
          divisionName: user.divisionName,
          divisionType: user.divisionType,
          divisionPercent: user.divisionPercent,
          divisionEndTime: user.divisionEndTime,
          divisionChangeTime: user.divisionChangeTime,
          divisionStatus: user.divisionStatus,
          divisionInvite: user.divisionInvite,
          divisionId: user.divisionId,
          agentId: user.agentId,
          staffId: user.staffId,
        })
        .from(user)
        .where(where)
        .orderBy(desc(user.divisionChangeTime), desc(user.uid))
        .limit(limit)
        .offset(offset),
      this.container.db.select({ count: sql<number>`count(*)::int` }).from(user).where(where),
    ]);

    const ids = rows.map((row) => row.uid);
    const childType = input.roleType === 1 ? 2 : input.roleType === 2 ? 3 : 0;
    const childCounts = new Map<number, number>();
    if (childType && ids.length) {
      const parentField = input.roleType === 1 ? user.divisionId : user.agentId;
      const counts = await this.container.db
        .select({ parentId: parentField, count: sql<number>`count(*)::int` })
        .from(user)
        .where(and(eq(user.divisionType, childType), eq(user.isDel, 0), inArray(parentField, ids)))
        .groupBy(parentField);
      for (const row of counts) childCounts.set(row.parentId, row.count);
    }
    return {
      list: rows.map((row) => ({ ...row, downNum: childCounts.get(row.uid) ?? 0 })),
      count: countRows[0]?.count ?? 0,
      page,
      limit,
    };
  }

  async getRole(uid: number, scope: DivisionAdminScope) {
    if (!uid) throw new ValidateException("用户 UID 不能为空");
    const rows = await this.container.db.select().from(user).where(eq(user.uid, uid)).limit(1);
    const role = rows[0];
    if (!role || !role.divisionType) throw new ValidateException("事业部角色不存在");
    assertScope(scope, roleDivisionId(role));
    let admin: typeof systemAdmin.$inferSelect | null = null;
    if (role.divisionType === 1) {
      const admins = await this.container.db
        .select()
        .from(systemAdmin)
        .where(and(eq(systemAdmin.divisionId, uid), eq(systemAdmin.isDel, 0)))
        .limit(1);
      admin = admins[0] ?? null;
    }
    return { role, admin };
  }

  async saveRole(input: SaveDivisionRoleInput, scope: DivisionAdminScope) {
    if (![1, 2, 3].includes(input.roleType)) throw new ValidateException("角色类型错误");
    const uid = Number(input.uid);
    assertInteger(uid, "用户 UID 格式错误");
    if (uid <= 0) throw new ValidateException("请选择用户");
    const parentUid = Number(input.parentUid ?? 0);
    const percent = normalizeDivisionPercent(input.divisionPercent);
    const endTime = normalizeDivisionEndTime(input.divisionEndTime);
    const status = Number(input.divisionStatus ?? 1);
    if (![0, 1].includes(status)) throw new ValidateException("角色状态错误");
    const divisionName = input.divisionName?.trim() ?? "";
    if (input.roleType !== 3 && !divisionName) throw new ValidateException("名称不能为空");
    if (input.roleType !== 1 && parentUid <= 0) throw new ValidateException("请选择上级");
    if (input.adminPassword !== input.adminPasswordConfirm && input.adminPasswordConfirm !== undefined) {
      throw new ValidateException("两次输入的管理员密码不一致");
    }
    const passwordHash = input.adminPassword ? await hash(input.adminPassword, 12) : undefined;
    const now = Math.floor(Date.now() / 1000);

    return this.container.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DbClient;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROLE_LOCK_NAMESPACE}, ${uid})`);
      await lockUsers(tx, [uid, parentUid]);
      const locked = await tx
        .select()
        .from(user)
        .where(inArray(user.uid, [...new Set([uid, parentUid].filter((id) => id > 0))]));
      const target = locked.find((row) => row.uid === uid);
      const parent = locked.find((row) => row.uid === parentUid);
      if (!target || target.isDel || !target.status) throw new ValidateException("用户不存在或已停用");
      if (target.divisionType !== 0 && target.divisionType !== input.roleType) {
        throw new ValidateException("该用户已有其他事业部角色，请先解除原角色");
      }
      if (parentUid === uid) throw new ValidateException("用户不能成为自己的上级");
      validateDivisionHierarchy(input.roleType, percent, endTime, parent);

      const divisionId = input.roleType === 1 ? uid : parent!.divisionType === 1 ? parent!.uid : parent!.divisionId;
      assertScope(scope, divisionId);
      if (scope.level !== 0 && input.roleType === 1 && target.divisionType === 0) {
        throw new ValidateException("事业部管理员不能新建其他事业部");
      }

      let divisionInvite = 0;
      if (input.roleType === 1) {
        divisionInvite = target.divisionInvite;
        if (!divisionInvite) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROLE_LOCK_NAMESPACE}, 0)`);
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const bytes = new Uint32Array(1);
            crypto.getRandomValues(bytes);
            const candidate = 10_000_000 + (bytes[0] % 90_000_000);
            const exists = await tx
              .select({ uid: user.uid })
              .from(user)
              .where(eq(user.divisionInvite, candidate))
              .limit(1);
            if (!exists.length) {
              divisionInvite = candidate;
              break;
            }
          }
          if (!divisionInvite) throw new ValidateException("生成事业部邀请码失败，请重试");
        }
      }

      const update =
        input.roleType === 1
          ? {
              divisionName,
              divisionType: 1,
              divisionStatus: status,
              divisionId: uid,
              agentId: 0,
              staffId: 0,
              divisionPercent: percent,
              divisionEndTime: endTime,
              divisionChangeTime: now,
              divisionInvite,
              spreadUid: 0,
              spreadTime: 0,
              isPromoter: 1,
            }
          : input.roleType === 2
            ? {
                divisionName,
                divisionType: 2,
                divisionStatus: status,
                divisionId: parent!.uid,
                agentId: uid,
                staffId: 0,
                divisionPercent: percent,
                divisionEndTime: endTime,
                divisionChangeTime: now,
                divisionInvite: 0,
                spreadUid: parent!.uid,
                spreadTime: now,
                isPromoter: 1,
              }
            : {
                divisionType: 3,
                divisionStatus: status,
                divisionId: parent!.divisionId,
                agentId: parent!.agentId || parent!.uid,
                staffId: uid,
                divisionPercent: percent,
                divisionEndTime: parent!.divisionEndTime,
                divisionChangeTime: now,
                divisionInvite: 0,
                spreadUid: parent!.uid,
                spreadTime: now,
                isPromoter: 1,
              };
      await tx.update(user).set(update).where(eq(user.uid, uid));

      if (input.roleType === 1) {
        const adminRows = await tx
          .select()
          .from(systemAdmin)
          .where(and(eq(systemAdmin.divisionId, uid), eq(systemAdmin.adminType, 1), eq(systemAdmin.isDel, 0)))
          .limit(1);
        const existingAdmin = adminRows[0];
        const account = input.adminAccount?.trim() || existingAdmin?.account || "";
        if (!existingAdmin && (!account || !passwordHash)) {
          throw new ValidateException("新建事业部必须设置管理员账号和密码");
        }
        if (account) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`division-admin:${account}`}))`);
          const duplicate = await tx
            .select({ id: systemAdmin.id })
            .from(systemAdmin)
            .where(
              and(
                eq(systemAdmin.account, account),
                eq(systemAdmin.adminType, 1),
                eq(systemAdmin.isDel, 0),
                existingAdmin ? ne(systemAdmin.id, existingAdmin.id) : sql`true`,
              ),
            )
            .limit(1);
          if (duplicate.length) throw new ValidateException("管理员账号已存在");
        }
        const roles = Array.isArray(input.adminRoles)
          ? input.adminRoles.map(Number).filter(Number.isInteger).join(",")
          : input.adminRoles ?? existingAdmin?.roles ?? "";
        if (existingAdmin) {
          await tx
            .update(systemAdmin)
            .set({
              account,
              phone: input.adminPhone?.trim() ?? existingAdmin.phone,
              realName: divisionName.slice(0, 16),
              roles,
              status: 1,
              divisionId: uid,
              ...(passwordHash ? { pwd: passwordHash } : {}),
            })
            .where(eq(systemAdmin.id, existingAdmin.id));
        } else {
          await tx.insert(systemAdmin).values({
            account,
            pwd: passwordHash!,
            realName: divisionName.slice(0, 16),
            phone: input.adminPhone?.trim() ?? "",
            roles,
            level: 1,
            status: 1,
            adminType: 1,
            relationId: 0,
            divisionId: uid,
            addTime: now,
          });
        }
      }
      return { uid, roleType: input.roleType, divisionId };
    });
  }

  async deleteRole(uid: number, scope: DivisionAdminScope): Promise<void> {
    if (!uid) throw new ValidateException("用户 UID 不能为空");
    const now = Math.floor(Date.now() / 1000);
    await this.container.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DbClient;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROLE_LOCK_NAMESPACE}, ${uid})`);
      await lockUsers(tx, [uid]);
      const rows = await tx.select().from(user).where(eq(user.uid, uid)).limit(1);
      const role = rows[0];
      if (!role || !role.divisionType) throw new ValidateException("事业部角色不存在");
      assertScope(scope, roleDivisionId(role), !(scope.level !== 0 && role.divisionType === 1));
      const reset = roleReset(now);
      if (role.divisionType === 1) {
        await tx.update(user).set(reset).where(eq(user.divisionId, uid));
        await tx.update(systemAdmin).set({ isDel: 1, status: 0 }).where(eq(systemAdmin.divisionId, uid));
        await tx.update(divisionApply).set({ isDel: 1 }).where(eq(divisionApply.divisionId, uid));
      } else if (role.divisionType === 2) {
        await tx.update(user).set(reset).where(eq(user.agentId, uid));
        await tx.update(divisionApply).set({ isDel: 1 }).where(eq(divisionApply.uid, uid));
      } else {
        await tx.update(user).set(reset).where(eq(user.staffId, uid));
      }
    });
  }

  async setRoleStatus(uid: number, status: number, scope: DivisionAdminScope): Promise<void> {
    if (![0, 1].includes(status)) throw new ValidateException("状态参数错误");
    const rows = await this.container.db.select().from(user).where(eq(user.uid, uid)).limit(1);
    const role = rows[0];
    if (!role || !role.divisionType) throw new ValidateException("事业部角色不存在");
    assertScope(scope, roleDivisionId(role));
    await this.container.db
      .update(user)
      .set({ divisionStatus: status, divisionChangeTime: Math.floor(Date.now() / 1000) })
      .where(eq(user.uid, uid));
  }

  async options(roleType: 1 | 2, parentDivisionId: number | undefined, scope: DivisionAdminScope) {
    const conditions: SQL[] = [
      eq(user.divisionType, roleType),
      eq(user.status, 1),
      eq(user.isDel, 0),
      eq(user.divisionStatus, 1),
    ];
    if (roleType === 2 && parentDivisionId) conditions.push(eq(user.divisionId, parentDivisionId));
    if (scope.level !== 0) {
      if (!scope.divisionId) return [];
      conditions.push(roleType === 1 ? eq(user.uid, scope.divisionId) : eq(user.divisionId, scope.divisionId));
    }
    const rows = await this.container.db
      .select({ uid: user.uid, divisionName: user.divisionName, nickname: user.nickname })
      .from(user)
      .where(and(...conditions))
      .orderBy(asc(user.divisionName), asc(user.uid));
    return rows.map((row) => ({ value: row.uid, label: row.divisionName || row.nickname || `#${row.uid}` }));
  }

  async orderList(input: {
    divisionId?: number;
    agentId?: number;
    keyword?: string;
    start?: number;
    endExclusive?: number;
    page?: number;
    limit?: number;
    scope: DivisionAdminScope;
  }) {
    const { page, limit, offset } = normalizePage(input.page ?? 1, input.limit ?? 20);
    const conditions: SQL[] = [eq(storeOrder.pid, 0), gt(storeOrder.divisionId, 0)];
    if (input.scope.level !== 0) {
      if (!input.scope.divisionId) return { list: [], count: 0, page, limit };
      conditions.push(eq(storeOrder.divisionId, input.scope.divisionId));
    } else if (input.divisionId) {
      conditions.push(eq(storeOrder.divisionId, input.divisionId));
    }
    if (input.agentId) conditions.push(eq(storeOrder.divisionAgentId, input.agentId));
    if (input.keyword?.trim()) {
      const keyword = `%${input.keyword.trim()}%`;
      conditions.push(
        or(
          ilike(storeOrder.orderId, keyword),
          ilike(storeOrder.realName, keyword),
          ilike(storeOrder.userPhone, keyword),
        )!,
      );
    }
    if (input.start) conditions.push(gte(storeOrder.addTime, input.start));
    if (input.endExclusive) conditions.push(lte(storeOrder.addTime, input.endExclusive - 1));
    const where = and(...conditions)!;
    const [list, countRows] = await Promise.all([
      this.container.db
        .select({
          id: storeOrder.id,
          orderId: storeOrder.orderId,
          uid: storeOrder.uid,
          realName: storeOrder.realName,
          userPhone: storeOrder.userPhone,
          payPrice: storeOrder.payPrice,
          paid: storeOrder.paid,
          status: storeOrder.status,
          refundStatus: storeOrder.refundStatus,
          divisionId: storeOrder.divisionId,
          divisionBrokerage: storeOrder.divisionBrokerage,
          divisionAgentId: storeOrder.divisionAgentId,
          divisionAgentBrokerage: storeOrder.divisionAgentBrokerage,
          divisionStaffId: storeOrder.divisionStaffId,
          divisionStaffBrokerage: storeOrder.divisionStaffBrokerage,
          addTime: storeOrder.addTime,
          payTime: storeOrder.payTime,
        })
        .from(storeOrder)
        .where(where)
        .orderBy(desc(storeOrder.id))
        .limit(limit)
        .offset(offset),
      this.container.db.select({ count: sql<number>`count(*)::int` }).from(storeOrder).where(where),
    ]);
    return { list, count: countRows[0]?.count ?? 0, page, limit };
  }

  async statistics(scope: DivisionAdminScope) {
    const roleCondition = (roleType: DivisionRoleType): SQL => {
      if (scope.level === 0) return and(eq(user.divisionType, roleType), eq(user.isDel, 0))!;
      return and(
        eq(user.divisionType, roleType),
        eq(user.isDel, 0),
        roleType === 1 ? eq(user.uid, scope.divisionId) : eq(user.divisionId, scope.divisionId),
      )!;
    };
    const orderConditions: SQL[] = [
      eq(storeOrder.pid, 0),
      eq(storeOrder.paid, 1),
      gt(storeOrder.divisionId, 0),
    ];
    if (scope.level !== 0) orderConditions.push(eq(storeOrder.divisionId, scope.divisionId));
    const orderWhere = and(...orderConditions)!;
    const [division, agent, staff, orderRows] = await Promise.all([
      this.container.db.select({ count: sql<number>`count(*)::int` }).from(user).where(roleCondition(1)),
      this.container.db.select({ count: sql<number>`count(*)::int` }).from(user).where(roleCondition(2)),
      this.container.db.select({ count: sql<number>`count(*)::int` }).from(user).where(roleCondition(3)),
      this.container.db
        .select({
          count: sql<number>`count(*)::int`,
          orderPrice: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::text`,
          brokeragePrice: sql<string>`COALESCE(SUM(${storeOrder.divisionBrokerage} + ${storeOrder.divisionAgentBrokerage} + ${storeOrder.divisionStaffBrokerage}), 0)::text`,
        })
        .from(storeOrder)
        .where(orderWhere),
    ]);
    const orders = orderRows[0] ?? { count: 0, orderPrice: "0", brokeragePrice: "0" };
    return {
      divisionNum: division[0]?.count ?? 0,
      agentNum: agent[0]?.count ?? 0,
      staffNum: staff[0]?.count ?? 0,
      orderNum: orders.count,
      orderPrice: orders.orderPrice,
      brokeragePrice: orders.brokeragePrice,
    };
  }

  async trend(startValue: string, endValue: string, scope: DivisionAdminScope) {
    const range = parseDivisionDateRange(startValue, endValue);
    const conditions: SQL[] = [
      eq(storeOrder.pid, 0),
      eq(storeOrder.paid, 1),
      gt(storeOrder.divisionId, 0),
      gte(storeOrder.addTime, range.start),
      lte(storeOrder.addTime, range.endExclusive - 1),
    ];
    if (scope.level !== 0) conditions.push(eq(storeOrder.divisionId, scope.divisionId));
    const bucket =
      range.bucket === "hour"
        ? sql<string>`to_char(to_timestamp(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'HH24')`
        : range.bucket === "day"
          ? sql<string>`to_char(to_timestamp(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`
          : sql<string>`to_char(to_timestamp(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM')`;
    const rows = await this.container.db
      .select({
        bucket,
        orderPrice: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::text`,
        orderCount: sql<number>`count(*)::int`,
      })
      .from(storeOrder)
      .where(and(...conditions))
      .groupBy(bucket)
      .orderBy(bucket);
    const byBucket = new Map(rows.map((row) => [row.bucket, row]));
    return {
      xAxis: range.xAxis,
      series: [
        {
          name: "订单金额",
          type: "line",
          data: range.xAxis.map((key) => Number(byBucket.get(key)?.orderPrice ?? 0)),
        },
        {
          name: "订单量",
          type: "line",
          data: range.xAxis.map((key) => byBucket.get(key)?.orderCount ?? 0),
        },
      ],
    };
  }

  async ranking(scope: DivisionAdminScope) {
    const roleType: DivisionRoleType = scope.level === 0 ? 1 : 2;
    const roleConditions: SQL[] = [eq(user.divisionType, roleType), eq(user.status, 1), eq(user.isDel, 0)];
    if (scope.level !== 0) roleConditions.push(eq(user.divisionId, scope.divisionId));
    const roles = await this.container.db
      .select({ uid: user.uid, nickname: user.nickname, divisionName: user.divisionName })
      .from(user)
      .where(and(...roleConditions));
    if (!roles.length) return { list: [] };

    const roleIds = roles.map((role) => role.uid);
    const orderRoleField = scope.level === 0 ? storeOrder.divisionId : storeOrder.divisionAgentId;
    const orderRows = await this.container.db
      .select({
        roleId: orderRoleField,
        orderPrice: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::text`,
        brokeragePrice: sql<string>`COALESCE(SUM(${storeOrder.divisionBrokerage} + ${storeOrder.divisionAgentBrokerage} + ${storeOrder.divisionStaffBrokerage}), 0)::text`,
        orderNum: sql<number>`count(*)::int`,
      })
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.pid, 0),
          eq(storeOrder.paid, 1),
          inArray(orderRoleField, roleIds),
          scope.level !== 0 ? eq(storeOrder.divisionId, scope.divisionId) : sql`true`,
        ),
      )
      .groupBy(orderRoleField);
    const orderMap = new Map(orderRows.map((row) => [row.roleId, row]));

    const childField = roleType === 1 ? user.divisionId : user.agentId;
    const childRows = await this.container.db
      .select({ parentId: childField, count: sql<number>`count(*)::int` })
      .from(user)
      .where(and(eq(user.divisionType, roleType + 1), eq(user.isDel, 0), inArray(childField, roleIds)))
      .groupBy(childField);
    const childMap = new Map(childRows.map((row) => [row.parentId, row.count]));

    const list = roles
      .map((role) => {
        const order = orderMap.get(role.uid);
        return {
          uid: role.uid,
          nickname: role.divisionName || role.nickname || `#${role.uid}`,
          downNum: childMap.get(role.uid) ?? 0,
          orderPrice: order?.orderPrice ?? "0",
          brokeragePrice: order?.brokeragePrice ?? "0",
          orderNum: order?.orderNum ?? 0,
        };
      })
      .sort((a, b) => Number(b.orderPrice) - Number(a.orderPrice));
    return { list };
  }

  async listApplications(input: {
    status?: number;
    keyword?: string;
    page?: number;
    limit?: number;
    scope: DivisionAdminScope;
  }) {
    const { page, limit, offset } = normalizePage(input.page ?? 1, input.limit ?? 20);
    const conditions: SQL[] = [eq(divisionApply.isDel, 0)];
    if (input.status !== undefined && input.status !== -1) {
      if (![0, 1, 2].includes(input.status)) throw new ValidateException("申请状态错误");
      conditions.push(eq(divisionApply.status, input.status));
    }
    if (input.scope.level !== 0) {
      if (!input.scope.divisionId) return { list: [], count: 0, page, limit };
      conditions.push(eq(divisionApply.divisionId, input.scope.divisionId));
    }
    if (input.keyword?.trim()) {
      const keyword = `%${input.keyword.trim()}%`;
      conditions.push(
        or(
          ilike(divisionApply.divisionName, keyword),
          ilike(divisionApply.name, keyword),
          ilike(divisionApply.phone, keyword),
          sql`${divisionApply.uid}::text LIKE ${keyword}`,
        )!,
      );
    }
    const where = and(...conditions)!;
    const [list, countRows] = await Promise.all([
      this.container.db
        .select()
        .from(divisionApply)
        .where(where)
        .orderBy(desc(divisionApply.id))
        .limit(limit)
        .offset(offset),
      this.container.db.select({ count: sql<number>`count(*)::int` }).from(divisionApply).where(where),
    ]);
    return {
      list: list.map((row) => ({
        ...row,
        images: parseImages(row.images),
      })),
      count: countRows[0]?.count ?? 0,
      page,
      limit,
    };
  }

  async reviewApplication(input: {
    id: number;
    approved: boolean;
    divisionPercent?: number;
    divisionEndTime?: number | string;
    divisionStatus?: number;
    refusalReason?: string;
    scope: DivisionAdminScope;
  }) {
    if (!input.id) throw new ValidateException("申请 ID 不能为空");
    const percent = input.approved ? normalizeDivisionPercent(input.divisionPercent) : 0;
    const endTime = input.approved ? normalizeDivisionEndTime(input.divisionEndTime) : 0;
    const status = Number(input.divisionStatus ?? 1);
    if (input.approved && ![0, 1].includes(status)) throw new ValidateException("角色状态错误");
    const now = Math.floor(Date.now() / 1000);

    return this.container.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DbClient;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROLE_LOCK_NAMESPACE}, ${input.id})`);
      await tx.execute(sql`SELECT "id" FROM "division_apply" WHERE "id" = ${input.id} FOR UPDATE`);
      const applicationRows = await tx
        .select()
        .from(divisionApply)
        .where(and(eq(divisionApply.id, input.id), eq(divisionApply.isDel, 0)))
        .limit(1);
      const application = applicationRows[0];
      if (!application) throw new ValidateException("代理商申请不存在");
      if (application.status !== 0) throw new ValidateException("该申请已经审核");
      assertScope(input.scope, application.divisionId);

      if (!input.approved) {
        await tx
          .update(divisionApply)
          .set({ status: 2, statusTime: now, refusalReason: input.refusalReason?.slice(0, 1000) ?? "" })
          .where(eq(divisionApply.id, input.id));
        return { id: input.id, status: 2 };
      }

      await lockUsers(tx, [application.uid, application.divisionId]);
      const users = await tx
        .select()
        .from(user)
        .where(inArray(user.uid, [application.uid, application.divisionId]));
      const target = users.find((row) => row.uid === application.uid);
      const parent = users.find((row) => row.uid === application.divisionId);
      if (!target || target.isDel || !target.status) throw new ValidateException("申请用户不存在或已停用");
      if (target.divisionType !== 0 && target.divisionType !== 2) {
        throw new ValidateException("申请用户已有其他事业部角色");
      }
      validateDivisionHierarchy(2, percent, endTime, parent);
      await tx
        .update(user)
        .set({
          spreadUid: application.divisionId,
          spreadTime: now,
          divisionName: application.divisionName,
          divisionId: application.divisionId,
          divisionStatus: status,
          divisionPercent: percent,
          divisionChangeTime: now,
          divisionEndTime: endTime,
          divisionType: 2,
          agentId: application.uid,
          staffId: 0,
          divisionInvite: 0,
          isPromoter: 1,
        })
        .where(eq(user.uid, application.uid));
      await tx
        .update(divisionApply)
        .set({ status: 1, statusTime: now, refusalReason: "" })
        .where(eq(divisionApply.id, input.id));
      return { id: input.id, status: 1, uid: application.uid };
    });
  }

  async deleteApplication(id: number, scope: DivisionAdminScope): Promise<void> {
    const rows = await this.container.db
      .select({ divisionId: divisionApply.divisionId })
      .from(divisionApply)
      .where(and(eq(divisionApply.id, id), eq(divisionApply.isDel, 0)))
      .limit(1);
    if (!rows[0]) throw new ValidateException("代理商申请不存在");
    assertScope(scope, rows[0].divisionId);
    await this.container.db.update(divisionApply).set({ isDel: 1 }).where(eq(divisionApply.id, id));
  }

  async applicationInfo(uid: number) {
    const rows = await this.container.db
      .select()
      .from(divisionApply)
      .where(and(eq(divisionApply.uid, uid), eq(divisionApply.isDel, 0)))
      .limit(1);
    const application = rows[0];
    if (!application) return { status: -1 };
    return {
      ...application,
      images: parseImages(application.images),
    };
  }

  async submitApplication(input: {
    uid: number;
    id?: number;
    divisionName: string;
    name: string;
    phone: string;
    divisionInvite: number;
    images?: unknown[];
  }) {
    if (!input.uid) throw new ValidateException("请先登录");
    if (!input.divisionName.trim()) throw new ValidateException("代理商名称不能为空");
    if (!input.name.trim()) throw new ValidateException("联系人不能为空");
    if (!input.divisionInvite) throw new ValidateException("事业部邀请码错误");
    const images = JSON.stringify(Array.isArray(input.images) ? input.images : []);
    if (images.length > 2000) throw new ValidateException("申请图片数据过长");
    const now = Math.floor(Date.now() / 1000);

    return this.container.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DbClient;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROLE_LOCK_NAMESPACE}, ${input.uid})`);
      await lockUsers(tx, [input.uid]);
      const applicants = await tx.select().from(user).where(eq(user.uid, input.uid)).limit(1);
      const applicant = applicants[0];
      if (!applicant || applicant.isDel || !applicant.status) throw new ValidateException("用户不存在或已停用");
      if (applicant.divisionType !== 0) throw new ValidateException("您已经拥有事业部角色");
      if (!applicant.phone || applicant.phone !== input.phone.trim()) {
        throw new ValidateException("申请手机号必须与当前已绑定手机号一致");
      }
      const divisions = await tx
        .select()
        .from(user)
        .where(
          and(
            eq(user.divisionInvite, input.divisionInvite),
            eq(user.divisionType, 1),
            eq(user.divisionStatus, 1),
            eq(user.status, 1),
            eq(user.isDel, 0),
          ),
        )
        .limit(2);
      const division = divisions[0];
      if (!division) throw new ValidateException("事业部不存在或已停用");
      if (divisions.length > 1) throw new ValidateException("事业部邀请码重复，请联系平台管理员处理");
      if (division.divisionEndTime > 0 && division.divisionEndTime < now) {
        throw new ValidateException("事业部已到期");
      }

      await tx.execute(sql`SELECT "id" FROM "division_apply" WHERE "uid" = ${input.uid} AND "is_del" = 0 FOR UPDATE`);
      const existing = await tx
        .select()
        .from(divisionApply)
        .where(and(eq(divisionApply.uid, input.uid), eq(divisionApply.isDel, 0)))
        .limit(1);
      const values = {
        divisionName: input.divisionName.trim(),
        name: input.name.trim(),
        phone: input.phone.trim(),
        divisionId: division.uid,
        divisionInvite: input.divisionInvite,
        images,
        addTime: now,
        status: 0,
        statusTime: 0,
        refusalReason: "",
      } as const;
      if (existing[0]) {
        if (input.id && existing[0].id !== input.id) throw new ValidateException("申请记录不匹配");
        await tx.update(divisionApply).set(values).where(eq(divisionApply.id, existing[0].id));
        return { id: existing[0].id };
      }
      const inserted = await tx.insert(divisionApply).values({ ...values, uid: input.uid }).returning({ id: divisionApply.id });
      return { id: inserted[0].id };
    });
  }

  async staffList(input: { agentUid: number; keyword?: string; page?: number; limit?: number }) {
    const { page, limit, offset } = normalizePage(input.page ?? 1, input.limit ?? 20);
    const agents = await this.container.db.select().from(user).where(eq(user.uid, input.agentUid)).limit(1);
    const agent = agents[0];
    if (!agent || agent.divisionType !== 2) throw new ValidateException("当前用户不是代理商");
    const conditions: SQL[] = [
      eq(user.agentId, input.agentUid),
      eq(user.divisionType, 3),
      eq(user.isDel, 0),
    ];
    if (input.keyword?.trim()) {
      const keyword = `%${input.keyword.trim()}%`;
      conditions.push(or(ilike(user.nickname, keyword), ilike(user.phone, keyword), sql`${user.uid}::text LIKE ${keyword}`)!);
    }
    const where = and(...conditions)!;
    const [rows, countRows, brokerageRows] = await Promise.all([
      this.container.db
        .select({
          uid: user.uid,
          avatar: user.avatar,
          nickname: user.nickname,
          phone: user.phone,
          spreadTime: user.spreadTime,
          divisionPercent: user.divisionPercent,
          payCount: user.payCount,
        })
        .from(user)
        .where(where)
        .orderBy(desc(user.spreadTime), desc(user.uid))
        .limit(limit)
        .offset(offset),
      this.container.db.select({ count: sql<number>`count(*)::int` }).from(user).where(where),
      this.container.db
        .select({ brokerage: sql<string>`COALESCE(SUM(${storeOrder.divisionAgentBrokerage}), 0)::text` })
        .from(storeOrder)
        .where(eq(storeOrder.divisionAgentId, input.agentUid)),
    ]);
    const ids = rows.map((row) => row.uid);
    const orderMap = new Map<number, { count: number; price: string }>();
    if (ids.length) {
      const orderRows = await this.container.db
        .select({
          uid: storeOrder.uid,
          count: sql<number>`count(*)::int`,
          price: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::text`,
        })
        .from(storeOrder)
        .where(and(inArray(storeOrder.uid, ids), eq(storeOrder.refundStatus, 0)))
        .groupBy(storeOrder.uid);
      for (const order of orderRows) orderMap.set(order.uid, { count: order.count, price: order.price });
    }
    return {
      list: rows.map((row) => ({
        ...row,
        orderCount: orderMap.get(row.uid)?.count ?? 0,
        numberCount: orderMap.get(row.uid)?.price ?? "0",
      })),
      count: countRows[0]?.count ?? 0,
      brokerage: brokerageRows[0]?.brokerage ?? "0",
      page,
      limit,
    };
  }

  async updateStaffPercent(agentUid: number, staffUid: number, value: unknown): Promise<void> {
    const percent = normalizeDivisionPercent(value);
    await this.container.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DbClient;
      await lockUsers(tx, [agentUid, staffUid]);
      const rows = await tx
        .select()
        .from(user)
        .where(inArray(user.uid, [...new Set([agentUid, staffUid])]))
        .orderBy(asc(user.uid));
      const agent = rows.find((row) => row.uid === agentUid);
      const staff = rows.find((row) => row.uid === staffUid);
      if (!agent || agent.divisionType !== 2) throw new ValidateException("当前用户不是代理商");
      if (!staff || staff.divisionType !== 3 || staff.agentId !== agentUid) {
        throw new ValidateException("员工不存在或不属于当前代理商");
      }
      if (percent >= agent.divisionPercent) throw new ValidateException("员工比例必须低于代理商比例");
      await tx
        .update(user)
        .set({ divisionPercent: percent, divisionChangeTime: Math.floor(Date.now() / 1000) })
        .where(and(eq(user.uid, staffUid), eq(user.agentId, agentUid), eq(user.divisionType, 3)));
    });
  }

  async removeStaff(agentUid: number, staffUid: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.container.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DbClient;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROLE_LOCK_NAMESPACE}, ${staffUid})`);
      await lockUsers(tx, [agentUid, staffUid]);
      const rows = await tx.select().from(user).where(eq(user.uid, staffUid)).limit(1);
      const staff = rows[0];
      if (!staff || staff.divisionType !== 3 || staff.agentId !== agentUid) {
        throw new ValidateException("员工不存在或不属于当前代理商");
      }
      await tx.update(user).set(roleReset(now)).where(and(eq(user.staffId, staffUid), eq(user.agentId, agentUid)));
    });
  }

  async bindStaff(uid: number, agentUid: number) {
    if (!uid || !agentUid) throw new ValidateException("上级代理商不存在");
    if (uid === agentUid) throw new ValidateException("自己不能推荐自己");
    const now = Math.floor(Date.now() / 1000);
    return this.container.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DbClient;
      await lockUsers(tx, [uid, agentUid]);
      const rows = await tx.select().from(user).where(inArray(user.uid, [uid, agentUid]));
      const target = rows.find((row) => row.uid === uid);
      const agent = rows.find((row) => row.uid === agentUid);
      if (!target || target.isDel || !target.status) throw new ValidateException("用户不存在或已停用");
      if (target.divisionType !== 0) throw new ValidateException("您已经拥有事业部角色");
      if (!agent || agent.divisionType !== 2 || !agent.divisionStatus || agent.isDel || !agent.status) {
        throw new ValidateException("上级代理商不存在或已停用");
      }
      if (agent.divisionEndTime > 0 && agent.divisionEndTime < now) throw new ValidateException("上级代理商已到期");
      await tx
        .update(user)
        .set({
          spreadUid: agentUid,
          spreadTime: now,
          divisionType: 3,
          divisionStatus: 1,
          divisionId: agent.divisionId,
          agentId: agent.agentId || agent.uid,
          staffId: uid,
          divisionPercent: 0,
          divisionEndTime: agent.divisionEndTime,
          divisionChangeTime: now,
          divisionInvite: 0,
          isPromoter: 1,
        })
        .where(eq(user.uid, uid));
      return { uid, agentId: agentUid, divisionId: agent.divisionId };
    });
  }
}
