import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  luckLottery,
  luckLotteryRecord,
  luckPrize,
  storeCouponIssue,
  storeProduct,
  user as userTable,
} from "@/models/schema";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { NotFoundException, ValidateException } from "@/utils/errors";

const ACTIVITY_TYPES = new Set([1, 2, 3, 4]);
const FACTORS = new Set([1, 2, 3, 4, 5]);
const PRIZE_TYPES = new Set([1, 2, 3, 5, 6, 7, 9]);
const LOTTERY_CATALOG_LOCK_NAMESPACE = 47_071;

type NormalizedPrize = typeof luckPrize.$inferInsert;

export interface NormalizedLotteryInput {
  activity: typeof luckLottery.$inferInsert;
  prizes: NormalizedPrize[];
}

function pick(input: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (input[key] !== undefined) return input[key];
  return undefined;
}

function integer(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; fallback?: number } = {},
): number {
  if (value === undefined && options.fallback !== undefined) return options.fallback;
  const parsed = Number(value);
  const min = options.min ?? 0;
  const max = options.max ?? 32_767;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidateException(`${label}格式错误`);
  }
  return parsed;
}

function boundedString(value: unknown, label: string, max: number, required = false): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new ValidateException(`请填写${label}`);
  if (text.length > max) throw new ValidateException(`${label}不能超过${max}个字符`);
  return text;
}

function epoch(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  if (typeof value === "string") {
    const millis = Date.parse(value);
    if (Number.isFinite(millis) && millis > 0) return Math.floor(millis / 1000);
  }
  throw new ValidateException(`${label}格式错误`);
}

function idArray(value: unknown, label: string): number[] {
  if (value === undefined || value === null || value === "") return [];
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value.split(",");
    }
  }
  if (!Array.isArray(parsed)) throw new ValidateException(`${label}格式错误`);
  const ids = parsed.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ValidateException(`${label}格式错误`);
  }
  return [...new Set(ids)];
}

function decimal(value: unknown, label: string): string {
  const text = String(value ?? "0").trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) throw new ValidateException(`${label}格式错误`);
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number >= 10_000_000_000) {
    throw new ValidateException(`${label}超出支持范围`);
  }
  return number.toFixed(2);
}

function parseStoredIds(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function queryInteger(value: string | undefined, label: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^-?\d+$/u.test(value)) throw new ValidateException(`${label}无效`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new ValidateException(`${label}无效`);
  return parsed;
}

function optionalQueryInteger(value: string | undefined, label: string, minimum: number, maximum: number): number | undefined {
  return value === undefined || value === "" ? undefined : queryInteger(value, label, 0, minimum, maximum);
}

function searchPattern(value: string | undefined, label: string): string | undefined {
  const term = value?.trim() ?? "";
  if (!term) return undefined;
  if (term.length > 100 || /[\u0000-\u001f\u007f]/u.test(term)) throw new ValidateException(`${label}无效`);
  return `%${term.replace(/[\\%_]/gu, "\\$&")}%`;
}

function recordView(row: {
  record: typeof luckLotteryRecord.$inferSelect;
  activity: typeof luckLottery.$inferSelect | null;
  prize: typeof luckPrize.$inferSelect | null;
  userUid: number | null;
  userNickname: string | null;
  userDeleted: Date | null;
}, includeDelivery = false) {
  const { record, activity, prize } = row;
  const snapshot = parseObject(record.prizeInfo);
  const delivery = parseObject(record.deliverInfo);
  const historicalPrize = Object.keys(snapshot).length ? snapshot : prize;
  const displayPrize = historicalPrize ? {
    id: typeof historicalPrize.id === "number" ? historicalPrize.id : record.prizeId,
    type: typeof historicalPrize.type === "number" ? historicalPrize.type : record.type,
    name: typeof historicalPrize.name === "string" ? historicalPrize.name : "",
    image: typeof historicalPrize.image === "string" ? historicalPrize.image : "",
    prompt: typeof historicalPrize.prompt === "string" ? historicalPrize.prompt : "",
    type_name: typeof snapshot.type_name === "string" ? snapshot.type_name : "",
  } : null;
  return {
    id: record.id,
    uid: record.uid,
    lotteryId: record.lotteryId,
    prizeId: record.prizeId,
    type: record.type,
    isReceive: record.isReceive,
    isDeliver: record.isDeliver,
    receiveTime: record.receiveTime,
    deliverTime: record.deliverTime,
    addTime: record.addTime,
    lottery: activity ? { id: activity.id, name: activity.name, factor: activity.factor } : null,
    prize: displayPrize,
    user: row.userUid === null
      ? { uid: record.uid, nickname: "用户已注销", is_deleted: true }
      : { uid: row.userUid, nickname: row.userNickname ?? "", is_deleted: row.userDeleted !== null },
    deliver_info: {
      mark: typeof delivery.mark === "string" ? delivery.mark : "",
      ...(includeDelivery ? {
        deliver_name: typeof delivery.deliver_name === "string" ? delivery.deliver_name : "",
        deliver_number: typeof delivery.deliver_number === "string" ? delivery.deliver_number : "",
      } : {}),
    },
  };
}

export function normalizeLotteryInput(input: Record<string, unknown>): NormalizedLotteryInput {
  const name = boundedString(pick(input, "name"), "活动名称", 255, true);
  const content = boundedString(pick(input, "content"), "活动规则", 200_000);
  const isContent = integer(pick(input, "is_content", "isContent"), "规则开关", { min: 0, max: 1, fallback: 1 });
  if (isContent === 1 && !content) throw new ValidateException("请填写活动规则");
  const type = integer(pick(input, "type"), "活动样式", { min: 1, max: 4, fallback: 1 });
  if (!ACTIVITY_TYPES.has(type)) throw new ValidateException("活动样式错误");
  const factor = integer(pick(input, "factor"), "抽奖类型", { min: 1, max: 5, fallback: 1 });
  if (!FACTORS.has(factor)) throw new ValidateException("抽奖类型错误");
  const factorNum = integer(pick(input, "factor_num", "factorNum"), "抽奖条件数量", { min: 1, fallback: 1 });
  const attendsUser = integer(pick(input, "attends_user", "attendsUser"), "参与用户范围", { min: 1, max: 2, fallback: 1 });
  const userLevel = idArray(pick(input, "user_level", "userLevel"), "用户等级");
  const userLabel = idArray(pick(input, "user_label", "userLabel"), "用户标签");
  const isSvip = integer(pick(input, "is_svip", "isSvip"), "付费会员限制", { min: -1, max: 1, fallback: -1 });
  if (attendsUser === 2 && !userLevel.length && !userLabel.length && isSvip === -1) {
    throw new ValidateException("部分用户参与时至少选择一个限制条件");
  }

  const period = pick(input, "period");
  const startTime = Array.isArray(period)
    ? epoch(period[0], "活动开始时间")
    : epoch(pick(input, "start_time", "startTime"), "活动开始时间");
  const endTime = Array.isArray(period)
    ? epoch(period[1], "活动结束时间")
    : epoch(pick(input, "end_time", "endTime"), "活动结束时间");
  if (endTime <= startTime) throw new ValidateException("活动结束时间必须晚于开始时间");

  const lotteryNumTerm = integer(pick(input, "lottery_num_term", "lotteryNumTerm"), "次数限制方式", { min: 1, max: 2, fallback: 1 });
  const lotteryNum = integer(pick(input, "lottery_num", "lotteryNum"), "每日抽奖次数", { min: 1, fallback: 1 });
  const totalLotteryNum = integer(pick(input, "total_lottery_num", "totalLotteryNum"), "总抽奖次数", { min: 1, fallback: 1 });
  if (factor === 1 && lotteryNum > totalLotteryNum) {
    throw new ValidateException("每日抽奖次数不能大于总抽奖次数");
  }
  const spreadNum = integer(pick(input, "spread_num", "spreadNum"), "邀请奖励次数", { min: 1, fallback: 1 });
  const rawPrizes = pick(input, "prize");
  if (!Array.isArray(rawPrizes) || rawPrizes.length !== 8) {
    throw new ValidateException("请配置8个抽奖奖品");
  }
  const now = Math.floor(Date.now() / 1000);
  const prizes = rawPrizes.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidateException(`第${index + 1}个奖品格式错误`);
    }
    const prize = raw as Record<string, unknown>;
    const prizeType = integer(pick(prize, "type"), `第${index + 1}个奖品类型`, { min: 1, max: 9, fallback: 1 });
    if (!PRIZE_TYPES.has(prizeType)) {
      if (prizeType === 4) throw new ValidateException("微信红包奖品尚未接入可靠付款通道，不能新建");
      if (prizeType === 8) throw new ValidateException("用户等级奖品缺少明确等级配置，不能新建");
      throw new ValidateException(`第${index + 1}个奖品类型不支持`);
    }
    const num = decimal(pick(prize, "num"), `第${index + 1}个奖品数量`);
    if ([2, 3, 7, 9].includes(prizeType) && Number(num) <= 0) {
      throw new ValidateException(`第${index + 1}个奖品数量必须大于0`);
    }
    if ([2, 9].includes(prizeType) && !Number.isInteger(Number(num))) {
      throw new ValidateException(`第${index + 1}个奖品数量必须为整数`);
    }
    const couponId = integer(pick(prize, "coupon_id", "couponId"), `第${index + 1}个优惠券`, { min: 0, max: 2_147_483_647, fallback: 0 });
    const productId = integer(pick(prize, "product_id", "productId"), `第${index + 1}个商品`, { min: 0, max: 2_147_483_647, fallback: 0 });
    if (prizeType === 5 && couponId <= 0) throw new ValidateException(`第${index + 1}个奖品请选择优惠券`);
    if (prizeType === 6 && productId <= 0) throw new ValidateException(`第${index + 1}个奖品请选择商品`);
    return {
      type: prizeType,
      lotteryId: 0,
      name: boundedString(pick(prize, "name"), `第${index + 1}个奖品名称`, 255, true),
      prompt: boundedString(pick(prize, "prompt"), `第${index + 1}个奖品提示`, 255),
      image: boundedString(pick(prize, "image"), `第${index + 1}个奖品图片`, 255, true),
      chance: integer(pick(prize, "chance"), `第${index + 1}个中奖权重`, { min: 0, fallback: 10 }),
      total: integer(pick(prize, "total"), `第${index + 1}个奖品库存`, { min: -1, fallback: 1 }),
      couponId,
      productId,
      unique: boundedString(pick(prize, "unique"), `第${index + 1}个商品规格`, 20),
      num,
      sort: integer(pick(prize, "sort"), `第${index + 1}个奖品排序`, { min: -32_768, fallback: index }),
      status: integer(pick(prize, "status"), `第${index + 1}个奖品状态`, { min: 0, max: 1, fallback: 1 }),
      isDel: 0,
      addTime: now,
    } satisfies NormalizedPrize;
  });
  if (!prizes.some((prize) => prize.type === 1 && prize.status === 1 && prize.chance > 0)) {
    throw new ValidateException("必须配置一个有权重的未中奖奖项作为库存兜底");
  }
  if (prizes.reduce((sum, prize) => sum + Number(prize.chance), 0) <= 0) {
    throw new ValidateException("奖品中奖权重之和必须大于0");
  }

  return {
    activity: {
      type,
      name,
      desc: boundedString(pick(input, "desc"), "活动描述", 255),
      image: boundedString(pick(input, "image"), "活动背景图", 255, true),
      factor,
      factorNum,
      attendsUser,
      userLevel: JSON.stringify(userLevel),
      userLabel: JSON.stringify(userLabel),
      isSvip,
      prizeNum: prizes.filter((prize) => prize.type !== 1).length,
      startTime,
      endTime,
      lotteryNumTerm,
      lotteryNum,
      totalLotteryNum,
      spreadNum,
      isAllRecord: integer(pick(input, "is_all_record", "isAllRecord"), "全部记录开关", { min: 0, max: 1, fallback: 1 }),
      isPersonalRecord: integer(pick(input, "is_personal_record", "isPersonalRecord"), "个人记录开关", { min: 0, max: 1, fallback: 1 }),
      isContent,
      content,
      status: integer(pick(input, "status"), "活动状态", { min: 0, max: 1, fallback: 1 }),
      sort: integer(pick(input, "sort"), "活动排序", { min: -32_768, fallback: 0 }),
      isDel: 0,
      addTime: now,
    },
    prizes,
  };
}

function activityView(activity: typeof luckLottery.$inferSelect) {
  const userLevel = parseStoredIds(activity.userLevel);
  const userLabel = parseStoredIds(activity.userLabel);
  return {
    ...activity,
    factor_num: activity.factorNum,
    attends_user: activity.attendsUser,
    userLevel,
    userLabel,
    user_level: userLevel,
    user_label: userLabel,
    is_svip: activity.isSvip,
    prize_num: activity.prizeNum,
    start_time: activity.startTime,
    end_time: activity.endTime,
    period: [activity.startTime, activity.endTime],
    lottery_num_term: activity.lotteryNumTerm,
    lottery_num: activity.lotteryNum,
    total_lottery_num: activity.totalLotteryNum,
    spread_num: activity.spreadNum,
    is_all_record: activity.isAllRecord,
    is_personal_record: activity.isPersonalRecord,
    is_content: activity.isContent,
    is_del: activity.isDel,
    add_time: activity.addTime,
  };
}

async function validateReferences(tx: DbClient, prizes: NormalizedPrize[]): Promise<void> {
  const couponIds = [...new Set(prizes.filter((prize) => prize.type === 5).map((prize) => prize.couponId ?? 0))];
  const productIds = [...new Set(prizes.filter((prize) => prize.type === 6).map((prize) => prize.productId ?? 0))];
  if (couponIds.length) {
    const rows = await tx
      .select({ id: storeCouponIssue.id })
      .from(storeCouponIssue)
      .where(and(inArray(storeCouponIssue.id, couponIds), eq(storeCouponIssue.isDel, 0)));
    if (rows.length !== couponIds.length) throw new ValidateException("部分优惠券不存在或已删除");
  }
  if (productIds.length) {
    const rows = await tx
      .select({ id: storeProduct.id })
      .from(storeProduct)
      .where(and(inArray(storeProduct.id, productIds), eq(storeProduct.isDel, 0)));
    if (rows.length !== productIds.length) throw new ValidateException("部分商品不存在或已删除");
  }
}

export class LotteryAdminService {
  constructor(private readonly container: Container) {}

  async list(query: Record<string, string | undefined>) {
    const page = queryInteger(query.page, "页码", 1, 1, 10_000);
    const limit = queryInteger(query.limit, "每页数量", 15, 1, 100);
    const phase = optionalQueryInteger(query.start_status, "活动阶段", -1, 1);
    const factor = optionalQueryInteger(query.factor, "抽奖类型", 1, 5);
    const status = optionalQueryInteger(query.status, "上架状态", 0, 1);
    const pattern = searchPattern(query.name ?? query.store_name, "抽奖搜索词");
    const now = Math.floor(Date.now() / 1000);
    const conditions: SQL[] = [eq(luckLottery.isDel, 0)];
    if (pattern) conditions.push(or(
      sql`${luckLottery.id}::text ILIKE ${pattern} ESCAPE '\\'`,
      ilike(luckLottery.name, pattern),
      ilike(luckLottery.desc, pattern),
      ilike(luckLottery.content, pattern),
    )!);
    if (factor !== undefined) conditions.push(eq(luckLottery.factor, factor));
    if (status !== undefined) conditions.push(eq(luckLottery.status, status));
    if (phase === 0) conditions.push(and(eq(luckLottery.status, 1), sql`${luckLottery.startTime} > ${now}`)!);
    if (phase === 1) conditions.push(and(
      eq(luckLottery.status, 1),
      lte(luckLottery.startTime, now),
      or(eq(luckLottery.endTime, 0), gte(luckLottery.endTime, now)),
    )!);
    // The PHP condition also counted 0/0 timeless campaigns as ended. Keep
    // these campaigns in the running stage only, matching their displayed state.
    if (phase === -1) conditions.push(or(
      eq(luckLottery.status, 0),
      and(sql`${luckLottery.endTime} > 0`, sql`${luckLottery.endTime} < ${now}`),
    )!);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const rows = await tx
        .select()
        .from(luckLottery)
        .where(and(...conditions))
        .orderBy(desc(luckLottery.addTime), desc(luckLottery.id))
        .limit(limit)
        .offset((page - 1) * limit);
      const counts = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(luckLottery)
        .where(and(...conditions));
      const activityIds = rows.map((row) => row.id);
      const metrics = activityIds.length ? await tx.select({
        lotteryId: luckLotteryRecord.lotteryId,
        lottery_all: sql<number>`COUNT(*)::int`,
        lottery_people: sql<number>`COUNT(DISTINCT ${luckLotteryRecord.uid})::int`,
        lottery_win: sql<number>`COUNT(DISTINCT ${luckLotteryRecord.uid}) FILTER (WHERE ${luckLotteryRecord.type} > 1)::int`,
      }).from(luckLotteryRecord).where(inArray(luckLotteryRecord.lotteryId, activityIds)).groupBy(luckLotteryRecord.lotteryId) : [];
      const metricsById = new Map(metrics.map((metric) => [metric.lotteryId, metric]));
      const labels: Record<number, string> = { 1: "积分", 2: "余额", 3: "下单支付成功", 4: "订单评价", 5: "关注公众号" };
      return {
        list: rows.map((row) => {
          const stage = row.status === 0 || (row.endTime !== 0 && now > row.endTime)
            ? 2 : row.startTime !== 0 && now < row.startTime ? 0 : 1;
          const metric = metricsById.get(row.id);
          return {
            ...activityView(row),
            time_status: stage,
            lottery_status: stage === 0 ? "未开始" : stage === 1 ? "进行中" : "已结束",
            lottery_type: labels[row.factor] ?? "",
            lottery_all: metric?.lottery_all ?? 0,
            lottery_people: metric?.lottery_people ?? 0,
            lottery_win: metric?.lottery_win ?? 0,
          };
        }),
        count: counts[0]?.count ?? 0,
        page,
        limit,
      };
    });
  }

  async detail(idValue: unknown) {
    const id = integer(idValue, "活动", { min: 1, max: 2_147_483_647 });
    const rows = await this.container.db.select().from(luckLottery).where(eq(luckLottery.id, id)).limit(1);
    const activity = rows[0];
    if (!activity || activity.isDel !== 0) throw new NotFoundException("抽奖活动不存在");
    const prizes = await this.container.db
      .select()
      .from(luckPrize)
      .where(and(eq(luckPrize.lotteryId, id), eq(luckPrize.isDel, 0)))
      .orderBy(asc(luckPrize.sort), asc(luckPrize.id));
    return { ...activityView(activity), prize: prizes };
  }

  async factorInfo(factorValue: unknown) {
    const factor = integer(factorValue, "抽奖类型", { min: 1, max: 5 });
    const rows = await this.container.db
      .select({ id: luckLottery.id })
      .from(luckLottery)
      .where(and(eq(luckLottery.factor, factor), eq(luckLottery.isDel, 0)))
      .orderBy(desc(luckLottery.status), desc(luckLottery.id))
      .limit(1);
    return rows[0] ? this.detail(rows[0].id) : null;
  }

  async save(idValue: unknown, raw: Record<string, unknown>): Promise<{ id: number }> {
    const id = idValue === undefined || idValue === null || idValue === ""
      ? 0
      : integer(idValue, "活动", { min: 1, max: 2_147_483_647 });
    const normalized = normalizeLotteryInput(raw);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOTTERY_CATALOG_LOCK_NAMESPACE}, 0)`);
      await validateReferences(tx, normalized.prizes);
      let activityId = id;
      if (activityId) {
        const locked = await tx
          .select({ id: luckLottery.id })
          .from(luckLottery)
          .where(and(eq(luckLottery.id, activityId), eq(luckLottery.isDel, 0)))
          .limit(1)
          .for("update");
        if (!locked[0]) throw new NotFoundException("抽奖活动不存在");
        await tx.update(luckLottery).set(normalized.activity).where(eq(luckLottery.id, activityId));
        await tx.update(luckPrize).set({ isDel: 1, status: 0 }).where(eq(luckPrize.lotteryId, activityId));
      } else {
        const inserted = await tx.insert(luckLottery).values(normalized.activity).returning({ id: luckLottery.id });
        activityId = inserted[0]?.id ?? 0;
        if (!activityId) throw new Error("抽奖活动创建失败");
      }
      if (normalized.activity.status === 1) {
        await tx
          .update(luckLottery)
          .set({ status: 0 })
          .where(and(eq(luckLottery.factor, normalized.activity.factor!), ne(luckLottery.id, activityId), eq(luckLottery.isDel, 0)));
      }
      await tx.insert(luckPrize).values(normalized.prizes.map((prize) => ({ ...prize, lotteryId: activityId })));
      return { id: activityId };
    });
  }

  async delete(idValue: unknown): Promise<void> {
    const id = integer(idValue, "活动", { min: 1, max: 2_147_483_647 });
    const updated = await this.container.db
      .update(luckLottery)
      .set({ isDel: 1, status: 0 })
      .where(and(eq(luckLottery.id, id), eq(luckLottery.isDel, 0)))
      .returning({ id: luckLottery.id });
    if (!updated[0]) throw new NotFoundException("抽奖活动不存在");
  }

  async setStatus(idValue: unknown, statusValue: unknown): Promise<void> {
    const id = integer(idValue, "活动", { min: 1, max: 2_147_483_647 });
    const status = integer(statusValue, "活动状态", { min: 0, max: 1 });
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOTTERY_CATALOG_LOCK_NAMESPACE}, 0)`);
      const rows = await tx
        .select()
        .from(luckLottery)
        .where(and(eq(luckLottery.id, id), eq(luckLottery.isDel, 0)))
        .limit(1)
        .for("update");
      const activity = rows[0];
      if (!activity) throw new NotFoundException("抽奖活动不存在");
      if (status === 1) {
        await tx
          .update(luckLottery)
          .set({ status: 0 })
          .where(and(eq(luckLottery.factor, activity.factor), ne(luckLottery.id, id), eq(luckLottery.isDel, 0)));
      }
      await tx.update(luckLottery).set({ status }).where(eq(luckLottery.id, id));
    });
  }

  async records(query: Record<string, string | undefined>, lotteryIdValue?: unknown) {
    const page = queryInteger(query.page, "页码", 1, 1, 10_000);
    const limit = queryInteger(query.limit, "每页数量", 15, 1, 100);
    const pathId = lotteryIdValue === undefined ? undefined : integer(lotteryIdValue, "活动", { min: 1, max: 2_147_483_647 });
    const queryId = optionalQueryInteger(query.lottery_id, "活动ID", 0, 2_147_483_647);
    if (pathId !== undefined && queryId !== undefined && queryId !== 0 && pathId !== queryId) {
      throw new ValidateException("活动ID与路径不一致");
    }
    const lotteryId = pathId ?? queryId;
    const uid = optionalQueryInteger(query.uid, "用户ID", 0, 2_147_483_647);
    const factor = optionalQueryInteger(query.factor, "活动类型", 0, 5);
    const prizeType = optionalQueryInteger(query.type, "奖品类型", 0, 9);
    const isReceive = optionalQueryInteger(query.is_receive, "领取状态", 0, 1);
    const isDeliver = optionalQueryInteger(query.is_deliver, "处理状态", 0, 1);
    const startTime = optionalQueryInteger(query.start_time, "开始时间", 0, 2_147_483_647);
    const endTime = optionalQueryInteger(query.end_time, "结束时间", 0, 2_147_483_647);
    if (startTime !== undefined && endTime !== undefined && startTime > endTime) throw new ValidateException("时间范围无效");
    const keyword = searchPattern(query.keyword, "搜索词");
    const conditions: SQL[] = [ne(luckLotteryRecord.type, 1)];
    if (lotteryId) conditions.push(eq(luckLotteryRecord.lotteryId, lotteryId));
    if (uid) conditions.push(eq(luckLotteryRecord.uid, uid));
    if (factor) conditions.push(eq(luckLottery.factor, factor));
    if (prizeType) conditions.push(eq(luckLotteryRecord.type, prizeType));
    if (isReceive !== undefined) conditions.push(eq(luckLotteryRecord.isReceive, isReceive));
    if (isDeliver !== undefined) conditions.push(eq(luckLotteryRecord.isDeliver, isDeliver));
    if (startTime) conditions.push(gte(luckLotteryRecord.addTime, startTime));
    if (endTime) conditions.push(lte(luckLotteryRecord.addTime, endTime));
    if (keyword) conditions.push(or(
      sql`${luckLotteryRecord.id}::text ILIKE ${keyword} ESCAPE '\\'`,
      sql`${luckLotteryRecord.uid}::text ILIKE ${keyword} ESCAPE '\\'`,
      sql`${luckLotteryRecord.lotteryId}::text ILIKE ${keyword} ESCAPE '\\'`,
      sql`${luckLotteryRecord.prizeId}::text ILIKE ${keyword} ESCAPE '\\'`,
      ilike(userTable.account, keyword),
      ilike(userTable.nickname, keyword),
      ilike(userTable.realName, keyword),
      ilike(userTable.phone, keyword),
      ilike(luckLottery.name, keyword),
      ilike(luckLottery.desc, keyword),
      ilike(luckLottery.content, keyword),
      ilike(luckPrize.name, keyword),
      ilike(luckPrize.prompt, keyword),
    )!);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const rows = await tx
        .select({
          record: luckLotteryRecord,
          activity: luckLottery,
          prize: luckPrize,
          userUid: userTable.uid,
          userNickname: userTable.nickname,
          userDeleted: userTable.deleteTime,
        })
        .from(luckLotteryRecord)
        .leftJoin(luckLottery, eq(luckLottery.id, luckLotteryRecord.lotteryId))
        .leftJoin(luckPrize, eq(luckPrize.id, luckLotteryRecord.prizeId))
        .leftJoin(userTable, eq(userTable.uid, luckLotteryRecord.uid))
        .where(and(...conditions))
        .orderBy(desc(luckLotteryRecord.addTime), desc(luckLotteryRecord.id))
        .limit(limit)
        .offset((page - 1) * limit);
      const counts = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(luckLotteryRecord)
        .leftJoin(luckLottery, eq(luckLottery.id, luckLotteryRecord.lotteryId))
        .leftJoin(luckPrize, eq(luckPrize.id, luckLotteryRecord.prizeId))
        .leftJoin(userTable, eq(userTable.uid, luckLotteryRecord.uid))
        .where(and(...conditions));
      return { list: rows.map((row) => recordView(row)), count: counts[0]?.count ?? 0, page, limit };
    });
  }

  async recordDetail(idValue: unknown) {
    const id = integer(idValue, "中奖记录", { min: 1, max: 2_147_483_647 });
    const rows = await this.container.db
      .select({
        record: luckLotteryRecord,
        activity: luckLottery,
        prize: luckPrize,
        userUid: userTable.uid,
        userNickname: userTable.nickname,
        userDeleted: userTable.deleteTime,
      })
      .from(luckLotteryRecord)
      .leftJoin(luckLottery, eq(luckLottery.id, luckLotteryRecord.lotteryId))
      .leftJoin(luckPrize, eq(luckPrize.id, luckLotteryRecord.prizeId))
      .leftJoin(userTable, eq(userTable.uid, luckLotteryRecord.uid))
      .where(eq(luckLotteryRecord.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("中奖记录不存在");
    return recordView(row, true);
  }

  async deliver(input: Record<string, unknown>, idValue?: unknown): Promise<void> {
    const id = integer(idValue ?? pick(input, "id"), "中奖记录", { min: 1, max: 2_147_483_647 });
    const mark = boundedString(pick(input, "mark"), "备注", 255);
    const deliverName = boundedString(pick(input, "deliver_name", "deliverName"), "快递公司", 64);
    const deliverNumber = boundedString(pick(input, "deliver_number", "deliverNumber"), "快递单号", 64);
    await withTx(this.container, async (tx) => {
      const rows = await tx
        .select()
        .from(luckLotteryRecord)
        .where(eq(luckLotteryRecord.id, id))
        .limit(1)
        .for("update");
      const record = rows[0];
      if (!record) throw new NotFoundException("中奖记录不存在");
      const info = parseObject(record.deliverInfo);
      if (deliverName || deliverNumber) {
        if (record.type !== 6) throw new ValidateException("该奖品不需要发货");
        if (!deliverName || !deliverNumber) throw new ValidateException("请选择快递公司并输入快递单号");
        info.deliver_name = deliverName;
        info.deliver_number = deliverNumber;
      }
      if (mark) info.mark = mark;
      if (!mark && !deliverName && !deliverNumber) throw new ValidateException("请输入发货信息或备注");
      const now = Math.floor(Date.now() / 1000);
      await tx
        .update(luckLotteryRecord)
        .set({
          deliverInfo: JSON.stringify(info),
          isDeliver: deliverName && deliverNumber ? 1 : record.isDeliver,
          deliverTime: deliverName && deliverNumber ? now : record.deliverTime,
        })
        .where(eq(luckLotteryRecord.id, id));
    });
  }
}
