import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  adminUserWriteReplay,
  legacyCategory,
  otherOrder,
  otherOrderStatus,
  storeCouponIssue,
  storeCouponIssueUser,
  storeCouponUser,
  systemLog,
  systemUserLevel,
  user,
  userAddress,
  userBill,
  userGroup,
  userLabel,
  userLabelRelation,
  userLevel,
  userMoney,
} from "@/models/schema";
import { normalizeOutRequestKey, outRequestHash } from "@/services/out/OutIdempotency";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_PAGE = 1_000_000;
const MAX_LIMIT = 100;
const MAX_USERS = 100;
const MAX_LABELS = 100;
const MAX_INTEGER = 2_147_483_647;
const MAX_MONEY_CENTS = 999_999_999_999;
const REPLAY_LOCK_NAMESPACE = 744_250_001;
const AUDIT_TYPE = "admin_user_write";
const PLATFORM_TYPE = 0;
const PLATFORM_RELATION_ID = 0;

type UnknownRecord = Record<string, unknown>;
type UserRow = typeof user.$inferSelect;
type CouponIssueRow = typeof storeCouponIssue.$inferSelect;
type CouponUserRow = typeof storeCouponUser.$inferSelect;

export interface AdminMobileUserActor {
  id: number;
  name: string;
  ip: string;
}

export interface AdminUserFinanceInput {
  uid: number;
  status: 1 | 2;
  kind: "money" | "integral";
  moneyCents: number;
  integral: number;
}

export type AdminUserBatchInput =
  | { type: 1; uids: number[]; levelId: number }
  | { type: 2; uids: number[]; daysStatus: 1 | 2; days: number }
  | { type: 3; uids: number[]; couponId: number }
  | { type: 4; uids: number[]; groupId: number }
  | { type: 5; uids: number[]; labelIds: number[] };

interface ReplayEvidence {
  userId: number;
  targetCount: number;
  moneyLedgerId?: number;
  integralLedgerId?: number;
  otherOrderId?: number;
  couponIssueId?: number;
}

function object(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as UnknownRecord;
}

function integer(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ValidateException(`${label}错误`);
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) throw new ValidateException(`${label}错误`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed;
}

function positiveId(value: unknown, label: string): number {
  return integer(value, label, 0, 1, MAX_INTEGER);
}

function ids(value: unknown, label: string, maximum: number, allowEmpty = false): number[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string" && value.includes(",")
      ? value.split(",")
      : value === undefined || value === null || value === ""
        ? []
        : [value];
  if (source.length > maximum) throw new ValidateException(`${label}不能超过${maximum}项`);
  const result = [...new Set(source.map((item) => positiveId(item, label)))].sort((a, b) => a - b);
  if (!allowEmpty && !result.length) throw new ValidateException(`请选择${label}`);
  return result;
}

function moneyCents(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ValidateException("余额数量错误");
  }
  const text = String(value).trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) throw new ValidateException("余额数量错误");
  const [whole, fraction = ""] = text.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result <= 0 || result > MAX_MONEY_CENTS) {
    throw new ValidateException("余额数量错误");
  }
  return result;
}

function centsFromStored(value: string): number {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) {
    throw new ValidateException("用户当前余额异常，请先修复账户数据");
  }
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_MONEY_CENTS) {
    throw new ValidateException("用户当前余额异常，请先修复账户数据");
  }
  return result;
}

function formatMoney(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function boundedQueryText(value: unknown, label: string, maximum: number): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new ValidateException(`${label}错误`);
  const result = value.trim().normalize("NFC");
  if ([...result].length > maximum) throw new ValidateException(`${label}过长`);
  return result;
}

export function parseAdminUserFinanceInput(rawUid: unknown, value: unknown): AdminUserFinanceInput {
  const body = object(value);
  const unsupported = Object.keys(body).filter((key) => !["status", "number", "type"].includes(key));
  if (unsupported.length) throw new ValidateException(`不支持的字段: ${unsupported.sort().join(",")}`);
  const uid = positiveId(rawUid, "用户ID");
  const status = integer(body.status, "修改类型", 0, 1, 2) as 1 | 2;
  const rawType = integer(body.type, "账户类型", 1, 0, 2);
  if (rawType === 1) {
    return { uid, status, kind: "money", moneyCents: moneyCents(body.number), integral: 0 };
  }
  const integral = integer(body.number, "积分数量", 0, 1, MAX_INTEGER);
  return { uid, status, kind: "integral", moneyCents: 0, integral };
}

export function parseAdminUserBatchInput(value: unknown): AdminUserBatchInput {
  const body = object(value);
  const allowed = new Set([
    "uid",
    "type",
    "level",
    "days_status",
    "days",
    "coupon_id",
    "group_id",
    "label_id",
  ]);
  const unsupported = Object.keys(body).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new ValidateException(`不支持的字段: ${unsupported.sort().join(",")}`);
  const uids = ids(body.uid, "用户", MAX_USERS);
  const type = integer(body.type, "处理类型", 1, 1, 5);
  if ((type === 1 || type === 2) && uids.length !== 1) {
    throw new ValidateException(type === 1 ? "等级修改只支持单个用户" : "会员时长修改只支持单个用户");
  }
  switch (type) {
    case 1:
      return { type, uids, levelId: positiveId(body.level, "会员等级") };
    case 2:
      return {
        type,
        uids,
        daysStatus: integer(body.days_status, "会员时长修改类型", 0, 1, 2) as 1 | 2,
        days: integer(body.days, "会员天数", 0, 1, 999_999),
      };
    case 3:
      return { type, uids, couponId: positiveId(body.coupon_id, "优惠券") };
    case 4:
      return { type, uids, groupId: positiveId(body.group_id, "用户分组") };
    case 5:
      return { type, uids, labelIds: ids(body.label_id, "用户标签", MAX_LABELS, true) };
    default:
      throw new ValidateException("处理类型错误");
  }
}

export function parseAdminUserCouponQuery(query: Record<string, string | undefined>): {
  uid: number;
  page: number;
  limit: number;
  title: string;
} {
  return {
    uid: integer(query.uid, "用户ID", 0, 0, MAX_INTEGER),
    page: integer(query.page, "页码", 1, 1, MAX_PAGE),
    limit: integer(query.limit, "每页数量", 20, 1, MAX_LIMIT),
    title: boundedQueryText(query.coupon_title, "优惠券名称", 100),
  };
}

function activeUserWhere(uid: number) {
  return and(eq(user.uid, uid), eq(user.isDel, 0), isNull(user.deleteTime));
}

function shanghaiDateTime(seconds: number): string {
  if (!seconds) return "";
  const shifted = new Date((seconds + 8 * 3_600) * 1_000);
  return shifted.toISOString().slice(0, 19).replace("T", " ");
}

function couponIssueProjection(row: CouponIssueRow) {
  const couponDays = row.day > 0
    ? row.day
    : row.useEndTime && row.useStartTime
      ? Math.max(0, Math.ceil((row.useEndTime.getTime() - row.useStartTime.getTime()) / 86_400_000))
      : 0;
  return {
    id: row.id,
    cid: row.cid,
    category: row.category,
    coupon_type: row.couponType,
    coupon_title: row.couponTitle,
    title: row.title,
    type: row.type,
    coupon_price: row.couponPrice,
    use_min_price: row.useMinPrice,
    total_count: row.totalCount,
    remain_count: row.remainCount,
    receive_limit: row.receiveLimit,
    receive_type: row.receiveType,
    start_time: row.startTime,
    end_time: row.endTime,
    coupon_time: `${couponDays}天`,
    is_permanent: row.isPermanent,
    start_use_time: row.useStartTime,
    end_use_time: row.useEndTime,
    status: row.status,
    sort: row.sort,
    add_time: row.addTime,
  };
}

function couponUserProjection(row: CouponUserRow, issue: CouponIssueRow | null) {
  const couponDays = row.startTime && row.endTime
    ? Math.max(0, Math.ceil((row.endTime.getTime() - row.startTime.getTime()) / 86_400_000))
    : 0;
  return {
    id: row.id,
    uid: row.uid,
    cid: row.issueCouponId,
    issue_coupon_id: row.issueCouponId,
    coupon_title: row.couponTitle,
    coupon_price: row.couponPrice,
    use_min_price: row.useMinPrice,
    status: row.status,
    start_time: row.startTime,
    end_time: row.endTime,
    use_time: row.useTime,
    type: row.type,
    receive_source: row.receiveSource,
    add_time: row.receiveTime,
    receive_time: row.receiveTime,
    is_fail: row.isFail,
    coupon_time: couponDays,
    _add_time: shanghaiDateTime(row.receiveTime),
    _end_time: row.endTime ? shanghaiDateTime(Math.floor(row.endTime.getTime() / 1_000)) : "",
    issue: issue ? couponIssueProjection(issue) : null,
  };
}

async function transactionLimits(tx: DbClient): Promise<void> {
  await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
  await tx.execute(sql.raw("SET LOCAL statement_timeout = '8s'"));
}

function auditPath(operation: string, key: string): string {
  return `/api/admin/user/write/${operation}/${key}`;
}

async function replayed(
  tx: DbClient,
  actor: AdminMobileUserActor,
  operation: string,
  key: string,
  hash: string,
): Promise<boolean> {
  const scope = `${actor.id}:${operation}:${key}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${REPLAY_LOCK_NAMESPACE}, hashtext(${scope}))`);
  const rows = await tx.select({ requestHash: adminUserWriteReplay.requestHash })
    .from(adminUserWriteReplay).where(and(
    eq(adminUserWriteReplay.adminId, actor.id),
    eq(adminUserWriteReplay.operation, operation),
    eq(adminUserWriteReplay.requestKey, key),
  )).limit(2);
  if (!rows.length) return false;
  if (rows.some((row) => row.requestHash !== hash)) {
    throw new ValidateException("Idempotency-Key 已用于不同请求");
  }
  return true;
}

async function recordReplay(
  tx: DbClient,
  actor: AdminMobileUserActor,
  operation: string,
  key: string,
  hash: string,
  subject: string,
  evidence: ReplayEvidence,
  now: number,
): Promise<void> {
  await tx.insert(adminUserWriteReplay).values({
    adminId: actor.id,
    operation,
    requestKey: key,
    requestHash: hash,
    userId: evidence.userId,
    targetCount: evidence.targetCount,
    moneyLedgerId: evidence.moneyLedgerId ?? 0,
    integralLedgerId: evidence.integralLedgerId ?? 0,
    otherOrderId: evidence.otherOrderId ?? 0,
    couponIssueId: evidence.couponIssueId ?? 0,
    addTime: now,
  });
  await tx.insert(systemLog).values({
    adminId: actor.id,
    adminName: actor.name.slice(0, 64),
    path: auditPath(operation, key),
    page: "/user",
    method: "POST",
    action: `${subject};request_sha256=${hash}`,
    ip: actor.ip.slice(0, 45),
    type: AUDIT_TYPE,
    addTime: now,
  });
}

async function recordStateAudit(
  tx: DbClient,
  actor: AdminMobileUserActor,
  operation: string,
  uids: readonly number[],
  now: number,
): Promise<void> {
  const digest = await outRequestHash({ operation, uids: [...uids].sort((a, b) => a - b) });
  await tx.insert(systemLog).values({
    adminId: actor.id,
    adminName: actor.name.slice(0, 64),
    path: "/api/admin/user/update",
    page: "/user",
    method: "POST",
    action: `${operation};count=${uids.length};targets_sha256=${digest}`.slice(0, 255),
    ip: actor.ip.slice(0, 45),
    type: AUDIT_TYPE,
    addTime: now,
  });
}

async function lockedUsers(tx: DbClient, uids: number[]): Promise<UserRow[]> {
  const rows = await tx.select().from(user).where(and(
    inArray(user.uid, uids),
    eq(user.isDel, 0),
    isNull(user.deleteTime),
  )).orderBy(asc(user.uid)).for("update");
  if (rows.length !== uids.length) throw new NotFoundException("部分用户不存在或已删除");
  return rows;
}

export class AdminMobileUserService {
  constructor(private readonly container: Container) {}

  async labels(rawUid: unknown) {
    const uid = integer(rawUid, "用户ID", 0, 0, MAX_INTEGER);
    if (uid > 0) {
      const existing = await this.container.db.select({ uid: user.uid }).from(user)
        .where(activeUserWhere(uid)).limit(1);
      if (!existing[0]) throw new NotFoundException("用户不存在");
    }
    const [categories, labels, selected] = await Promise.all([
      this.container.db.select({
        id: legacyCategory.id,
        name: legacyCategory.name,
        sort: legacyCategory.sort,
      }).from(legacyCategory).where(and(
        eq(legacyCategory.ownerId, 0),
        eq(legacyCategory.type, PLATFORM_TYPE),
        eq(legacyCategory.relationId, PLATFORM_RELATION_ID),
        eq(legacyCategory.group, 0),
        eq(legacyCategory.isShow, 1),
      )).orderBy(desc(legacyCategory.sort), asc(legacyCategory.id)),
      this.container.db.select({
        id: userLabel.id,
        labelCate: userLabel.labelCate,
        labelName: userLabel.name,
        color: userLabel.color,
        sort: userLabel.sort,
      }).from(userLabel).where(and(
        eq(userLabel.type, PLATFORM_TYPE),
        eq(userLabel.relationId, PLATFORM_RELATION_ID),
        eq(userLabel.status, 1),
      )).orderBy(desc(userLabel.sort), asc(userLabel.id)),
      uid > 0
        ? this.container.db.select({ labelId: userLabelRelation.labelId })
          .from(userLabelRelation).where(and(
            eq(userLabelRelation.uid, uid),
            eq(userLabelRelation.type, PLATFORM_TYPE),
            eq(userLabelRelation.relationId, PLATFORM_RELATION_ID),
          ))
        : Promise.resolve([]),
    ]);
    const selectedIds = new Set(selected.map((item) => item.labelId));
    const labelsByCategory = new Map<number, Array<Record<string, unknown>>>();
    for (const label of labels) {
      const group = labelsByCategory.get(label.labelCate) ?? [];
      group.push({
        id: label.id,
        label_cate: label.labelCate,
        label_name: label.labelName,
        name: label.labelName,
        color: label.color,
        disabled: selectedIds.has(label.id),
      });
      labelsByCategory.set(label.labelCate, group);
    }
    return categories.flatMap((category) => {
      const label = labelsByCategory.get(category.id) ?? [];
      return label.length ? [{ id: category.id, name: category.name, sort: category.sort, label }] : [];
    });
  }

  async couponGrant(rawQuery: Record<string, string | undefined>) {
    const query = parseAdminUserCouponQuery(rawQuery);
    const offset = (query.page - 1) * query.limit;
    if (query.uid > 0) {
      const existing = await this.container.db.select({ uid: user.uid }).from(user)
        .where(activeUserWhere(query.uid)).limit(1);
      if (!existing[0]) throw new NotFoundException("用户不存在");
      const where = and(eq(storeCouponUser.uid, query.uid), eq(storeCouponUser.status, 0));
      const [rows, counts] = await Promise.all([
        this.container.db.select({ coupon: storeCouponUser, issue: storeCouponIssue })
          .from(storeCouponUser)
          .leftJoin(storeCouponIssue, eq(storeCouponIssue.id, storeCouponUser.issueCouponId))
          .where(where)
          .orderBy(desc(storeCouponUser.id))
          .limit(query.limit)
          .offset(offset),
        this.container.db.select({ count: sql<number>`COUNT(*)::int` })
          .from(storeCouponUser).where(where),
      ]);
      return {
        list: rows.map((row) => couponUserProjection(row.coupon, row.issue)),
        count: counts[0]?.count ?? 0,
      };
    }

    const now = new Date();
    const conditions = [
      eq(storeCouponIssue.receiveType, 3),
      eq(storeCouponIssue.status, 1),
      eq(storeCouponIssue.isDel, 0),
      sql`(${storeCouponIssue.remainCount} > 0 OR ${storeCouponIssue.isPermanent} = 1)`,
      sql`(${storeCouponIssue.startTime} IS NULL OR ${storeCouponIssue.startTime} <= ${now})`,
      sql`(${storeCouponIssue.endTime} IS NULL OR ${storeCouponIssue.endTime} >= ${now})`,
      sql`(${storeCouponIssue.day} > 0 OR ${storeCouponIssue.useEndTime} >= ${now})`,
    ];
    if (query.title) conditions.push(ilike(storeCouponIssue.couponTitle, `%${query.title}%`));
    const where = and(...conditions);
    const [rows, counts] = await Promise.all([
      this.container.db.select().from(storeCouponIssue).where(where)
        .orderBy(desc(storeCouponIssue.id)).limit(query.limit).offset(offset),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` })
        .from(storeCouponIssue).where(where),
    ]);
    return { list: rows.map(couponIssueProjection), count: counts[0]?.count ?? 0 };
  }

  async groups() {
    const rows = await this.container.db.select().from(userGroup).orderBy(desc(userGroup.id));
    return rows.map((row) => ({ id: row.id, group_name: row.groupName }));
  }

  async levels() {
    const where = and(eq(systemUserLevel.isShow, 1), eq(systemUserLevel.isDel, 0));
    const [rows, counts] = await Promise.all([
      this.container.db.select({
        id: systemUserLevel.id,
        name: systemUserLevel.name,
        grade: systemUserLevel.grade,
        image: systemUserLevel.image,
        icon: systemUserLevel.icon,
      }).from(systemUserLevel).where(where).orderBy(asc(systemUserLevel.grade), asc(systemUserLevel.id)),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` })
        .from(systemUserLevel).where(where),
    ]);
    return { list: rows, count: counts[0]?.count ?? 0 };
  }

  async addresses(rawUid: unknown) {
    const uid = positiveId(rawUid, "用户ID");
    const rows = await this.container.db.select().from(userAddress).where(and(
      eq(userAddress.uid, uid),
      eq(userAddress.isDel, 0),
    )).orderBy(desc(userAddress.isDefault), desc(userAddress.id));
    return rows.map((row) => ({
      id: row.id,
      uid: row.uid,
      real_name: row.realName,
      phone: row.phone,
      province: row.province,
      city: row.city,
      district: row.district,
      street: row.street,
      city_id: row.cityId,
      detail: row.detail,
      post_code: row.postCode,
      longitude: row.longitude,
      latitude: row.latitude,
      is_default: row.isDefault,
      is_del: row.isDel,
      add_time: row.addTime,
    }));
  }

  async defaultAddress(rawUid: unknown) {
    const uid = positiveId(rawUid, "用户ID");
    return (await this.addresses(uid)).find((address) => address.is_default === 1) ?? null;
  }

  async adjustFinance(
    actor: AdminMobileUserActor,
    rawUid: unknown,
    value: unknown,
    requestKeyValue: unknown,
  ) {
    const input = parseAdminUserFinanceInput(rawUid, value);
    const key = normalizeOutRequestKey(requestKeyValue);
    const hash = await outRequestHash({ operation: "finance", input });
    const subject = `uid=${input.uid}`;
    return withTx(this.container, async (tx) => {
      await transactionLimits(tx);
      if (await replayed(tx, actor, "finance", key, hash)) {
        return { uid: input.uid, idempotent: true };
      }
      const account = (await lockedUsers(tx, [input.uid]))[0];
      const now = Math.floor(Date.now() / 1_000);
      const linkId = (await outRequestHash({ actor: actor.id, operation: "finance", key })).slice(0, 32);
      if (input.kind === "money") {
        const current = centsFromStored(account.nowMoney);
        const applied = input.status === 1 ? input.moneyCents : Math.min(input.moneyCents, current);
        const next = input.status === 1 ? current + applied : current - applied;
        if (!Number.isSafeInteger(next) || next < 0 || next > MAX_MONEY_CENTS) {
          throw new ValidateException("余额变更后超出数据库范围");
        }
        let ledgerId = 0;
        if (applied > 0) {
          await tx.update(user).set({ nowMoney: formatMoney(next) }).where(eq(user.uid, input.uid));
          const ledgers = await tx.insert(userMoney).values({
            uid: input.uid,
            linkId,
            type: input.status === 1 ? "system_add" : "system_sub",
            title: input.status === 1 ? "系统增加余额" : "系统减少余额",
            number: formatMoney(applied),
            balance: formatMoney(next),
            pm: input.status === 1 ? 1 : 0,
            mark: `${input.status === 1 ? "系统增加" : "系统减少"}${formatMoney(applied)}余额`,
            status: 1,
            addTime: now,
          }).returning({ id: userMoney.id });
          ledgerId = ledgers[0]?.id ?? 0;
        }
        await recordReplay(tx, actor, "finance", key, hash, subject, {
          userId: input.uid,
          targetCount: 1,
          moneyLedgerId: ledgerId,
        }, now);
        return {
          uid: input.uid,
          kind: input.kind,
          applied: `${input.status === 1 ? "" : "-"}${formatMoney(applied)}`,
          balance: formatMoney(next),
          ledger_id: ledgerId,
          idempotent: false,
        };
      }

      if (!Number.isSafeInteger(account.integral) || account.integral < 0) {
        throw new ValidateException("用户当前积分异常，请先修复账户数据");
      }
      const applied = input.status === 1 ? input.integral : Math.min(input.integral, account.integral);
      const next = input.status === 1 ? account.integral + applied : account.integral - applied;
      if (!Number.isSafeInteger(next) || next < 0 || next > MAX_INTEGER) {
        throw new ValidateException("积分变更后超出数据库范围");
      }
      let ledgerId = 0;
      if (applied > 0) {
        await tx.update(user).set({ integral: next }).where(eq(user.uid, input.uid));
        const ledgers = await tx.insert(userBill).values({
          uid: input.uid,
          linkId,
          pm: input.status === 1 ? 1 : 0,
          title: input.status === 1 ? "系统增加积分" : "系统减少积分",
          category: "integral",
          type: input.status === 1 ? "system_add" : "system_sub",
          eventKey: input.status === 1 ? "admin_system_add_integral" : "admin_system_sub_integral",
          number: applied.toFixed(2),
          balance: next.toFixed(2),
          mark: `${input.status === 1 ? "系统增加" : "系统减少"}${applied}积分`,
          addTime: now,
          status: 1,
        }).returning({ id: userBill.id });
        ledgerId = ledgers[0]?.id ?? 0;
      }
      await recordReplay(tx, actor, "finance", key, hash, subject, {
        userId: input.uid,
        targetCount: 1,
        integralLedgerId: ledgerId,
      }, now);
      return {
        uid: input.uid,
        kind: input.kind,
        applied: input.status === 1 ? applied : -applied,
        balance: next,
        ledger_id: ledgerId,
        idempotent: false,
      };
    });
  }

  async update(
    actor: AdminMobileUserActor,
    value: unknown,
    requestKeyValue: unknown,
  ) {
    const input = parseAdminUserBatchInput(value);
    if (input.type === 2) return this.adjustMembership(actor, input, requestKeyValue);
    if (input.type === 3) return this.grantCoupon(actor, input, requestKeyValue);
    return withTx(this.container, async (tx) => {
      await transactionLimits(tx);
      const accounts = await lockedUsers(tx, input.uids);
      const now = Math.floor(Date.now() / 1_000);
      if (input.type === 1) {
        const level = (await tx.select().from(systemUserLevel).where(and(
          eq(systemUserLevel.id, input.levelId),
          eq(systemUserLevel.isShow, 1),
          eq(systemUserLevel.isDel, 0),
        )).limit(1).for("share"))[0];
        if (!level) throw new NotFoundException("会员等级不存在或已停用");
        const account = accounts[0];
        if (account.level !== input.levelId) {
          await tx.update(userLevel).set({ status: 0, isDel: 1 }).where(eq(userLevel.uid, account.uid));
          const existing = await tx.select({ id: userLevel.id }).from(userLevel).where(and(
            eq(userLevel.uid, account.uid),
            eq(userLevel.levelId, input.levelId),
          )).orderBy(asc(userLevel.id)).for("update");
          const levelData = {
            grade: level.grade,
            validTime: 0,
            isForever: level.isForever,
            merId: level.merId,
            status: 1,
            mark: `管理员设置会员等级：${level.name}`.slice(0, 255),
            remind: 0,
            isDel: 0,
            addTime: now,
            discount: Math.round(Number(level.discount)),
          };
          if (existing[0]) await tx.update(userLevel).set(levelData).where(eq(userLevel.id, existing[0].id));
          else await tx.insert(userLevel).values({ uid: account.uid, levelId: input.levelId, ...levelData });
          await tx.update(user).set({
            level: input.levelId,
            exp: level.expNum.toFixed(2),
            levelStatus: 1,
          }).where(eq(user.uid, account.uid));
        }
        await recordStateAudit(tx, actor, "level_replace", input.uids, now);
        return { changed: account.level === input.levelId ? 0 : 1, idempotent: account.level === input.levelId };
      }
      if (input.type === 4) {
        const group = await tx.select({ id: userGroup.id }).from(userGroup)
          .where(eq(userGroup.id, input.groupId)).limit(1).for("share");
        if (!group[0]) throw new NotFoundException("用户分组不存在");
        await tx.update(user).set({ groupId: input.groupId }).where(inArray(user.uid, input.uids));
        await recordStateAudit(tx, actor, "group_replace", input.uids, now);
        return { changed: input.uids.length };
      }

      if (input.labelIds.length) {
        const labels = await tx.select({ id: userLabel.id }).from(userLabel).where(and(
          inArray(userLabel.id, input.labelIds),
          eq(userLabel.type, PLATFORM_TYPE),
          eq(userLabel.relationId, PLATFORM_RELATION_ID),
          eq(userLabel.status, 1),
        )).orderBy(asc(userLabel.id)).for("share");
        if (labels.length !== input.labelIds.length) throw new NotFoundException("部分用户标签不存在或已停用");
      }
      await tx.delete(userLabelRelation).where(and(
        inArray(userLabelRelation.uid, input.uids),
        eq(userLabelRelation.type, PLATFORM_TYPE),
        eq(userLabelRelation.relationId, PLATFORM_RELATION_ID),
      ));
      if (input.labelIds.length) {
        await tx.insert(userLabelRelation).values(input.uids.flatMap((uid) => input.labelIds.map((labelId) => ({
          uid,
          type: PLATFORM_TYPE,
          relationId: PLATFORM_RELATION_ID,
          labelId,
        }))));
      }
      await recordStateAudit(tx, actor, "label_replace", input.uids, now);
      return { changed: input.uids.length, labels: input.labelIds.length };
    });
  }

  private async adjustMembership(
    actor: AdminMobileUserActor,
    input: Extract<AdminUserBatchInput, { type: 2 }>,
    requestKeyValue: unknown,
  ) {
    const key = normalizeOutRequestKey(requestKeyValue);
    const hash = await outRequestHash({ operation: "membership", input });
    const subject = `uid=${input.uids[0]}`;
    return withTx(this.container, async (tx) => {
      await transactionLimits(tx);
      if (await replayed(tx, actor, "membership", key, hash)) {
        return { uid: input.uids[0], idempotent: true };
      }
      const account = (await lockedUsers(tx, input.uids))[0];
      if (account.isEverLevel === 1) throw new ValidateException("永久会员无需调整会员时长");
      const now = Math.floor(Date.now() / 1_000);
      const seconds = input.days * 86_400;
      if (!Number.isSafeInteger(seconds)) throw new ValidateException("会员天数超出支持范围");
      const base = Math.max(now, account.overdueTime);
      const overdueTime = input.daysStatus === 1 ? base + seconds : Math.max(now, base - seconds);
      if (!Number.isSafeInteger(overdueTime) || overdueTime > MAX_INTEGER) {
        throw new ValidateException("会员有效期超出支持范围");
      }
      const isMoneyLevel = overdueTime <= now ? 0 : account.isMoneyLevel > 0 ? account.isMoneyLevel : 3;
      await tx.update(user).set({ isMoneyLevel, isEverLevel: 0, overdueTime })
        .where(eq(user.uid, account.uid));
      const orderHash = await outRequestHash({ actor: actor.id, operation: "membership", key });
      const orders = await tx.insert(otherOrder).values({
        uid: account.uid,
        type: 4,
        orderId: `ad${orderHash.slice(0, 30)}`,
        memberType: "0",
        payType: "admin",
        paid: 1,
        payTime: now,
        isFree: 1,
        overdueTime,
        vipDay: input.daysStatus === 1 ? input.days : -input.days,
        addTime: now,
        remarks: "管理员调整付费会员时长",
      }).returning({ id: otherOrder.id });
      if (!orders[0]) throw new Error("会员调整记录创建失败");
      await tx.insert(otherOrderStatus).values({
        oid: orders[0].id,
        changeType: "admin_adjust",
        changeMessage: "管理员调整付费会员时长",
        shopType: 1,
        changeTime: now,
      });
      await recordReplay(tx, actor, "membership", key, hash, subject, {
        userId: account.uid,
        targetCount: 1,
        otherOrderId: orders[0].id,
      }, now);
      return {
        uid: account.uid,
        overdue_time: overdueTime,
        order_id: `ad${orderHash.slice(0, 30)}`,
        idempotent: false,
      };
    });
  }

  private async grantCoupon(
    actor: AdminMobileUserActor,
    input: Extract<AdminUserBatchInput, { type: 3 }>,
    requestKeyValue: unknown,
  ) {
    const key = normalizeOutRequestKey(requestKeyValue);
    const hash = await outRequestHash({ operation: "coupon_grant", input });
    const targetsHash = await outRequestHash(input.uids);
    const subject = `count=${input.uids.length};targets_sha256=${targetsHash}`;
    return withTx(this.container, async (tx) => {
      await transactionLimits(tx);
      if (await replayed(tx, actor, "coupon_grant", key, hash)) {
        return { changed: input.uids.length, coupon_id: input.couponId, idempotent: true };
      }
      await lockedUsers(tx, input.uids);
      const issue = (await tx.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, input.couponId))
        .limit(1).for("update"))[0];
      if (!issue || issue.isDel !== 0 || issue.status !== 1 || issue.receiveType !== 3) {
        throw new NotFoundException("可赠送优惠券不存在或已停用");
      }
      const now = new Date();
      if (issue.startTime && issue.startTime > now) throw new ValidateException("优惠券尚未开始发放");
      if (issue.endTime && issue.endTime < now) throw new ValidateException("优惠券发放已结束");
      if (issue.day <= 0 && (!issue.useEndTime || issue.useEndTime < now)) {
        throw new ValidateException("优惠券使用有效期已结束或未配置");
      }
      if (!issue.isPermanent && issue.remainCount < input.uids.length) {
        throw new ValidateException("优惠券库存不足，整批未发放");
      }
      const title = issue.couponTitle || issue.title;
      if (!title || [...title].length > 64) throw new ValidateException("优惠券标题为空或过长，无法发放");
      const receiveTime = Math.floor(now.getTime() / 1_000);
      const startTime = issue.day > 0 ? now : issue.useStartTime ?? now;
      const endTime = issue.day > 0
        ? new Date(now.getTime() + issue.day * 86_400_000)
        : issue.useEndTime!;
      await tx.insert(storeCouponUser).values(input.uids.map((uid) => ({
        uid,
        issueCouponId: issue.id,
        couponTitle: title,
        couponPrice: issue.couponPrice,
        useMinPrice: issue.useMinPrice,
        status: 0,
        startTime,
        endTime,
        type: issue.type,
        receiveTime,
        receiveSource: "send",
        isFail: 0,
      })));
      await tx.insert(storeCouponIssueUser).values(input.uids.map((uid) => ({
        uid,
        issueCouponId: issue.id,
        addTime: receiveTime,
      })));
      if (!issue.isPermanent) {
        const updated = await tx.update(storeCouponIssue)
          .set({ remainCount: sql`${storeCouponIssue.remainCount} - ${input.uids.length}` })
          .where(and(
            eq(storeCouponIssue.id, issue.id),
            sql`${storeCouponIssue.remainCount} >= ${input.uids.length}`,
          )).returning({ id: storeCouponIssue.id });
        if (!updated[0]) throw new ValidateException("优惠券库存不足，整批未发放");
      }
      await recordReplay(tx, actor, "coupon_grant", key, hash, subject, {
        userId: input.uids.length === 1 ? input.uids[0] : 0,
        targetCount: input.uids.length,
        couponIssueId: issue.id,
      }, receiveTime);
      return { changed: input.uids.length, coupon_id: issue.id, idempotent: false };
    });
  }
}
