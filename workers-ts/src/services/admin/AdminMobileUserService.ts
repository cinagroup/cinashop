import {
  and,
  asc,
  desc,
  eq,
  ilike,
  isNull,
  sql,
} from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  adminUserWriteReplay,
  legacyCategory,
  storeCouponIssue,
  storeCouponUser,
  systemLog,
  systemUserLevel,
  user,
  userAddress,
  userGroup,
  userLabel,
  userLabelRelation,
} from "@/models/schema";
import { normalizeOutRequestKey, outRequestHash } from "@/services/out/OutIdempotency";
import {applyMobileUserState,applyMobileUserFinance,applyMobileUserMembership,applyMobileUserCoupons} from '@/services/user/MobileUserManagementCore';
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
      const linkId = (await outRequestHash({ actor: actor.id, operation: "finance", key })).slice(0,32);
      return applyMobileUserFinance(tx,input,linkId,async event => recordReplay(tx,actor,"finance",key,hash,subject,event.evidence,event.now));
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
      return applyMobileUserState(tx,input,async event => recordStateAudit(tx,actor,event.operation,input.uids,event.now));
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
      const orderHash = await outRequestHash({actor:actor.id,operation:"membership",key});
      const result = await applyMobileUserMembership(tx,input,`ad${orderHash.slice(0,30)}`,async event => recordReplay(tx,actor,"membership",key,hash,subject,event.evidence,event.now));
      return {uid:result.uid,overdue_time:result.overdue_time,order_id:result.order_id,idempotent:false};
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
      return applyMobileUserCoupons(tx,input,async event => recordReplay(tx,actor,"coupon_grant",key,hash,subject,event.evidence,event.now));
    });
  }
}
