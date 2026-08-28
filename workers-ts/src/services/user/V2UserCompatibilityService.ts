import {
  and,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  agreement,
  storeOrderRefund,
  user as userTable,
  userBrokerage,
  userExtract,
  userMoney,
  userRecharge,
  wechatUser,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 1_000;
const MAX_KEYWORD_LENGTH = 64;

const MONEY_TYPE_NAMES: Record<string, string> = {
  pay_product: "商城购物",
  pay_product_refund: "商城购物退款",
  system_add: "系统充值",
  system_sub: "系统扣除",
  recharge: "用户充值",
  recharge_refund: "用户充值退款",
  extract: "佣金提现充值",
  lottery_use: "抽奖使用",
  lottery_add: "抽奖中奖充值",
  newcomer_add: "新人礼赠送充值",
  level_add: "会员卡激活赠送充值",
};

type MoneyRow = typeof userMoney.$inferSelect;
type BrokerageRow = typeof userBrokerage.$inferSelect;

export interface LegacyUserLedgerQuery {
  page: number;
  limit: number;
  start: number;
  stop: number;
  keyword: string;
}

export interface RoutineProfileInput {
  nickname: string;
  avatar: string;
  sex: number;
  language: string;
  city: string;
  province: string;
  country: string;
}

export interface VerifiedOfficialProfile extends RoutineProfileInput {
  openid: string;
}

function phpInteger(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  const match = String(value).trim().match(/^[+-]?\d+/);
  if (!match) return 0;
  const parsed = Number(match[0]);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = phpInteger(value, fallback);
  return parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function boundedText(value: unknown, maximum: number): string {
  return Array.from(String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, ""))
    .slice(0, maximum)
    .join("");
}

/** Parse ThinkPHP's integer-like query values while keeping every query bounded. */
export function parseLegacyUserLedgerQuery(
  query: Record<string, unknown>,
): LegacyUserLedgerQuery {
  return {
    page: boundedPositiveInteger(query.page, 1, MAX_PAGE),
    limit: boundedPositiveInteger(query.limit, 10, MAX_PAGE_SIZE),
    start: Math.max(0, phpInteger(query.start)),
    stop: Math.max(0, phpInteger(query.stop)),
    keyword: boundedText(query.keyword, MAX_KEYWORD_LENGTH),
  };
}

/** Normalize only the fields that the old Mini Program authorization callback supplied. */
export function normalizeRoutineProfile(input: Record<string, unknown>): RoutineProfileInput {
  const sex = phpInteger(input.gender);
  return {
    nickname: boundedText(input.nickName, 60),
    avatar: boundedText(input.avatarUrl, 256),
    sex: sex === 1 || sex === 2 ? sex : 0,
    language: boundedText(input.language, 64),
    city: boundedText(input.city, 64),
    province: boundedText(input.province, 64),
    country: boundedText(input.country, 64),
  };
}

export function normalizeVerifiedOfficialProfile(
  input: Record<string, unknown>,
): VerifiedOfficialProfile {
  const sex = phpInteger(input.sex);
  const openid = boundedText(input.openid, 100);
  if (!openid) throw new ValidateException("更新公众号用户信息失败：没有获取到openid");
  return {
    openid,
    nickname: boundedText(input.nickname, 60),
    avatar: boundedText(input.headimgurl ?? input.avatar, 256),
    sex: sex === 1 || sex === 2 ? sex : 0,
    language: boundedText(input.language, 64),
    city: boundedText(input.city, 64),
    province: boundedText(input.province, 64),
    country: boundedText(input.country, 64),
  };
}

type DateStyle = "month" | "day" | "minute" | "agent";

/** PHP formatted these Unix seconds in China Standard Time. */
export function formatLegacyShanghaiUnix(seconds: number, style: DateStyle): string {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return "";
  const value = new Date((seconds + 8 * 60 * 60) * 1_000).toISOString();
  if (style === "month") return value.slice(0, 7);
  if (style === "day") return value.slice(0, 10);
  if (style === "agent") {
    return value.slice(0, 16).replace("T", " ").replaceAll("-", ".");
  }
  return value.slice(0, 16).replace("T", " ").replaceAll("-", "/");
}

export function legacyMoneyProjection(
  row: MoneyRow,
  refundStatus?: string,
): Record<string, unknown> {
  const month = formatLegacyShanghaiUnix(row.addTime, "month");
  const result: Record<string, unknown> = {
    id: row.id,
    uid: row.uid,
    link_id: row.linkId,
    type: row.type,
    title: row.title,
    number: row.number,
    balance: row.balance,
    pm: row.pm,
    mark: row.mark,
    status: row.status,
    time_key: month,
    time: month,
    day: formatLegacyShanghaiUnix(row.addTime, "day"),
    add_time: formatLegacyShanghaiUnix(row.addTime, "minute"),
    type_name: MONEY_TYPE_NAMES[row.type] ?? "未知类型",
  };
  if (row.type === "pay_product" || row.type === "recharge") {
    result.refund_status = refundStatus ?? "";
  }
  return result;
}

export function legacyBrokerageProjection(
  row: BrokerageRow,
  extract?: { status: number; failMsg: string },
): Record<string, unknown> {
  return {
    id: row.id,
    uid: row.uid,
    link_id: row.linkId,
    pm: row.pm,
    title: row.title,
    category: row.category,
    type: row.type,
    source_type: row.sourceType,
    number: row.number,
    balance: row.balance,
    mark: row.mark,
    status: row.status,
    take: row.take,
    frozen_time: row.frozenTime,
    add_time: formatLegacyShanghaiUnix(row.addTime, "minute"),
    time_key: formatLegacyShanghaiUnix(row.addTime, "month"),
    extract_status: row.type === "extract_money" ? 1 : extract?.status ?? 0,
    extract_msg: extract?.failMsg ?? "",
  };
}

export function legacyExtractProjection(row: BrokerageRow): Record<string, unknown> {
  return {
    id: row.id,
    uid: row.uid,
    link_id: row.linkId,
    pm: row.pm,
    title: row.title,
    category: row.category,
    type: row.type,
    source_type: row.sourceType,
    number: row.number,
    balance: row.balance,
    mark: row.mark,
    status: row.status,
    take: row.take,
    frozen_time: row.frozenTime,
    add_time: formatLegacyShanghaiUnix(row.addTime, "minute"),
    time_key: formatLegacyShanghaiUnix(row.addTime, "month"),
  };
}

function validLinkedIds(rows: Array<{ linkId: string }>): number[] {
  return [...new Set(rows.flatMap((row) => {
    if (!/^\d{1,10}$/.test(row.linkId)) return [];
    const id = Number(row.linkId);
    return Number.isSafeInteger(id) && id > 0 ? [id] : [];
  }))];
}

function ledgerTimeConditions(
  addTime: typeof userMoney.addTime | typeof userBrokerage.addTime,
  query: LegacyUserLedgerQuery,
): SQL[] {
  const conditions: SQL[] = [];
  if (query.start > 0) conditions.push(gte(addTime, query.start));
  if (query.stop > 0) conditions.push(lte(addTime, query.stop));
  return conditions;
}

export class V2UserCompatibilityService {
  constructor(private readonly container: Container) {}

  async updateRoutineProfile(
    uid: number,
    raw: Record<string, unknown>,
    ip = "",
  ): Promise<void> {
    const profile = normalizeRoutineProfile(raw);
    await this.persistProfile(uid, "routine", profile, boundedText(ip, 45));
  }

  /** Persist only a provider-verified official-account identity owned by the caller. */
  async refreshVerifiedOfficialProfile(
    uid: number,
    raw: Record<string, unknown>,
    ip = "",
  ): Promise<{ nickname: string; avatar: string; is_complete: 1 }> {
    const profile = normalizeVerifiedOfficialProfile(raw);
    return this.persistProfile(uid, "wechat", profile, boundedText(ip, 45));
  }

  private async persistProfile(
    uid: number,
    userType: "routine" | "wechat",
    profile: RoutineProfileInput | VerifiedOfficialProfile,
    ip: string,
  ): Promise<{ nickname: string; avatar: string; is_complete: 1 }> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户参数错误");
    return withTx(this.container, async (tx) => {
      const users = await tx.select({
        uid: userTable.uid,
        status: userTable.status,
      }).from(userTable).where(and(
        eq(userTable.uid, uid),
        eq(userTable.isDel, 0),
        isNull(userTable.deleteTime),
      )).limit(1).for("update");
      const account = users[0];
      if (!account) throw new NotFoundException("数据不存在");
      if (account.status !== 1) throw new ValidateException("您已被禁止登录，请联系管理员");

      const identityWhere = and(
        eq(wechatUser.uid, uid),
        eq(wechatUser.userType, userType),
        eq(wechatUser.isDel, 0),
        "openid" in profile ? eq(wechatUser.openid, profile.openid) : undefined,
      );
      const identities = await tx.select({
        id: wechatUser.id,
        nickname: wechatUser.nickname,
        headimgurl: wechatUser.headimgurl,
      }).from(wechatUser).where(identityWhere).orderBy(desc(wechatUser.id)).for("update");
      if (!identities.length) {
        throw new ValidateException(userType === "wechat" ? "没有查到用户信息" : "更新失败");
      }

      const now = Math.floor(Date.now() / 1_000);
      await tx.update(userTable).set({
        ...(profile.nickname ? { nickname: profile.nickname } : {}),
        ...(profile.avatar ? { avatar: profile.avatar } : {}),
        lastTime: now,
        lastIp: ip,
      }).where(eq(userTable.uid, uid));

      if (userType === "routine") {
        await tx.update(wechatUser).set({
          nickname: profile.nickname,
          headimgurl: profile.avatar,
          sex: profile.sex,
          language: profile.language,
          city: profile.city,
          province: profile.province,
          country: profile.country,
          isComplete: 1,
        }).where(identityWhere);
      } else {
        await tx.update(wechatUser).set({
          ...(profile.nickname ? { nickname: profile.nickname } : {}),
          ...(profile.avatar ? { headimgurl: profile.avatar } : {}),
          ...(profile.sex ? { sex: profile.sex } : {}),
          ...(profile.language ? { language: profile.language } : {}),
          ...(profile.city ? { city: profile.city } : {}),
          ...(profile.province ? { province: profile.province } : {}),
          ...(profile.country ? { country: profile.country } : {}),
          isComplete: 1,
        }).where(identityWhere);
      }

      return {
        nickname: profile.nickname || identities[0]!.nickname,
        avatar: profile.avatar || identities[0]!.headimgurl,
        is_complete: 1,
      };
    });
  }

  async moneyList(uid: number, type: 0 | 1 | 2, raw: Record<string, unknown>) {
    const query = parseLegacyUserLedgerQuery(raw);
    const conditions: SQL[] = [eq(userMoney.uid, uid), ...ledgerTimeConditions(userMoney.addTime, query)];
    if (type === 1) conditions.push(eq(userMoney.pm, 0));
    if (type === 2) conditions.push(eq(userMoney.pm, 1));
    const where = and(...conditions);
    const [rows, countRows] = await Promise.all([
      this.container.db.select().from(userMoney).where(where)
        .orderBy(desc(userMoney.id)).limit(query.limit).offset((query.page - 1) * query.limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(userMoney).where(where),
    ]);
    const orderIds = validLinkedIds(rows.filter((row) => row.type === "pay_product"));
    const rechargeIds = validLinkedIds(rows.filter((row) => row.type === "recharge"));
    const [refunds, recharges] = await Promise.all([
      orderIds.length
        ? this.container.db.select({
          storeOrderId: storeOrderRefund.storeOrderId,
          refundType: storeOrderRefund.refundType,
        }).from(storeOrderRefund).where(inArray(storeOrderRefund.storeOrderId, orderIds))
          .orderBy(desc(storeOrderRefund.id))
        : Promise.resolve([]),
      rechargeIds.length
        ? this.container.db.select({ id: userRecharge.id, refundPrice: userRecharge.refundPrice })
          .from(userRecharge).where(inArray(userRecharge.id, rechargeIds))
        : Promise.resolve([]),
    ]);
    const refundByOrder = new Map<number, number>();
    for (const refund of refunds) {
      if (!refundByOrder.has(refund.storeOrderId)) {
        refundByOrder.set(refund.storeOrderId, refund.refundType);
      }
    }
    const refundedRecharge = new Set(
      recharges.filter((row) => Number(row.refundPrice) !== 0).map((row) => row.id),
    );
    const list = rows.map((row) => {
      const linkedId = /^\d+$/.test(row.linkId) ? Number(row.linkId) : 0;
      const refundStatus = row.type === "pay_product"
        ? refundByOrder.has(linkedId)
          ? refundByOrder.get(linkedId) === 6 ? "已退款" : "退款中"
          : ""
        : row.type === "recharge" && refundedRecharge.has(linkedId)
          ? "已退款"
          : "";
      return legacyMoneyProjection(row, refundStatus);
    });
    return {
      count: countRows[0]?.count ?? 0,
      list,
      time: [...new Set(list.map((row) => String(row.time_key ?? "")).filter(Boolean))],
    };
  }

  async brokerageList(uid: number, raw: Record<string, unknown>) {
    const query = parseLegacyUserLedgerQuery(raw);
    const base: SQL[] = [eq(userBrokerage.uid, uid), ...ledgerTimeConditions(userBrokerage.addTime, query)];
    if (query.keyword) {
      const pattern = `%${query.keyword}%`;
      base.push(or(
        ilike(userBrokerage.title, pattern),
        sql`EXISTS (
          SELECT 1 FROM ${userTable} AS account
          WHERE account.uid = ${uid}
            AND account.is_del = 0 AND account.delete_time IS NULL
            AND (
              account.uid::text ILIKE ${pattern} OR account.account ILIKE ${pattern}
              OR account.nickname ILIKE ${pattern} OR account.phone ILIKE ${pattern}
            )
        )`,
      )!);
    }
    const where = and(...base);
    const [rows, incomeRows, expendRows] = await Promise.all([
      this.container.db.select().from(userBrokerage).where(where)
        .orderBy(desc(userBrokerage.id)).limit(query.limit).offset((query.page - 1) * query.limit),
      this.container.db.select({ total: sql<string>`COALESCE(SUM(${userBrokerage.number}), 0)::numeric(14,2)::text` })
        .from(userBrokerage).where(and(...base, eq(userBrokerage.pm, 1), ne(userBrokerage.type, "extract_fail"))),
      this.container.db.select({ total: sql<string>`COALESCE(SUM(${userBrokerage.number}), 0)::numeric(14,2)::text` })
        .from(userBrokerage).where(and(...base, eq(userBrokerage.pm, 0))),
    ]);
    const extractIds = validLinkedIds(rows.filter((row) => ["extract", "extract_fail"].includes(row.type)));
    const extracts = extractIds.length
      ? await this.container.db.select({
        id: userExtract.id,
        status: userExtract.status,
        failMsg: userExtract.failMsg,
      }).from(userExtract).where(inArray(userExtract.id, extractIds))
      : [];
    const extractById = new Map(extracts.map((row) => [row.id, row]));
    const list = rows.map((row) => legacyBrokerageProjection(
      row,
      /^\d+$/.test(row.linkId) ? extractById.get(Number(row.linkId)) : undefined,
    ));
    return {
      list,
      time: [...new Set(list.map((row) => String(row.time_key ?? "")).filter(Boolean))],
      income: incomeRows[0]?.total ?? "0.00",
      expend: expendRows[0]?.total ?? "0.00",
    };
  }

  async extractList(uid: number, raw: Record<string, unknown>) {
    const query = parseLegacyUserLedgerQuery(raw);
    const where = and(
      eq(userBrokerage.uid, uid),
      inArray(userBrokerage.type, ["extract", "extract_money", "extract_fail"]),
      ...ledgerTimeConditions(userBrokerage.addTime, query),
    );
    const rows = await this.container.db.select().from(userBrokerage).where(where)
      .orderBy(desc(userBrokerage.id)).limit(query.limit).offset((query.page - 1) * query.limit);
    const list = rows.map(legacyExtractProjection);
    return {
      list,
      time: [...new Set(list.map((row) => String(row.time_key ?? "")).filter(Boolean))],
    };
  }

  async agentUserList(uid: number, rawType: unknown, raw: Record<string, unknown>) {
    const type = phpInteger(rawType);
    const query = parseLegacyUserLedgerQuery(raw);
    const conditions: SQL[] = [
      eq(userTable.spreadUid, uid),
      eq(userTable.isDel, 0),
      isNull(userTable.deleteTime),
    ];
    if (type === 1) conditions.push(gt(userTable.payCount, 0));
    const where = and(...conditions);
    const [rows, countRows] = await Promise.all([
      this.container.db.select({
        uid: userTable.uid,
        nickname: userTable.nickname,
        avatar: userTable.avatar,
        spreadTime: userTable.spreadTime,
      }).from(userTable).where(where).orderBy(desc(userTable.uid))
        .limit(query.limit).offset((query.page - 1) * query.limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(userTable).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        uid: row.uid,
        nickname: row.nickname,
        avatar: row.avatar,
        spread_time: formatLegacyShanghaiUnix(row.spreadTime, "agent"),
      })),
      count: countRows[0]?.count ?? 0,
    };
  }

  async agentInfo(uid: number) {
    const [agreements, priceRows, carousel] = await Promise.all([
      this.container.db.select({ content: agreement.content }).from(agreement)
        .where(eq(agreement.type, 2)).limit(1),
      this.container.db.select({
        total: sql<string>`COALESCE(SUM(${userBrokerage.number}), 0)::numeric(14,2)::text`,
      }).from(userBrokerage).where(and(
        eq(userBrokerage.uid, uid),
        eq(userBrokerage.pm, 1),
        ne(userBrokerage.type, "extract_fail"),
        ne(userBrokerage.type, "refund"),
      )),
      this.container.db.select({
        nickname: userTable.nickname,
        price: userBrokerage.number,
      }).from(userBrokerage).innerJoin(userTable, and(
        eq(userTable.uid, userBrokerage.uid),
        eq(userTable.status, 1),
        eq(userTable.isDel, 0),
        isNull(userTable.deleteTime),
      )).where(and(
        eq(userBrokerage.pm, 1),
        ne(userBrokerage.type, "extract_fail"),
        ne(userBrokerage.type, "refund"),
      )).orderBy(desc(userBrokerage.id)).limit(10),
    ]);
    return {
      agreement: agreements[0]?.content ?? "",
      price: priceRows[0]?.total ?? "0.00",
      list: carousel.map((row) => ({ nickname: row.nickname, price: row.price })),
    };
  }
}
