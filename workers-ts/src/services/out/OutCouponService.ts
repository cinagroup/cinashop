import { and, count, eq, gte, inArray, or, sql } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import {
  luckLottery,
  luckPrize,
  outCouponWriteReplay,
  storeBrand,
  storeCouponIssue,
  storeCouponIssueUser,
  storeCouponProduct,
  storeCouponUser,
  storeProduct,
  storeProductCategory,
  storeProductCoupon,
  storePromotions,
  storePromotionsAuxiliary,
  systemConfig,
} from "@/models/schema";
import { configFlag, parseConfigIds } from "@/services/activity/StoreNewcomerService";
import { normalizeOutRequestKey, outRequestHash } from "@/services/out/OutIdempotency";
import { NotFoundException, ValidateException } from "@/utils/errors";

type UnknownRecord = Record<string, unknown>;
type CouponWriteOperation = "coupon_create" | "coupon_status" | "coupon_delete";

const REPLAY_LOCK_NAMESPACE = 744_230_001;
const COUPON_WRITE_LOCK_NAMESPACE = 744_230_002;
const PLATFORM_TYPE = 0;
const PHYSICAL_PRODUCT_TYPE = 0;
const MAX_SCOPE_IDS = 100;
const MAX_DAY = 36_500;
const ALLOWED_CREATE_FIELDS = new Set([
  "coupon_title",
  "coupon_price",
  "use_min_price",
  "coupon_time",
  "start_use_time",
  "end_use_time",
  "start_time",
  "end_time",
  "receive_type",
  "is_permanent",
  "total_count",
  "product_id",
  "category_id",
  "type",
  "sort",
  "status",
  "coupon_type",
]);

export interface NormalizedOutCouponInput {
  couponTitle: string;
  couponPrice: string;
  useMinPrice: string;
  day: number;
  useStartTime: Date | null;
  useEndTime: Date | null;
  startTime: Date | null;
  endTime: Date | null;
  receiveType: 1 | 2 | 3;
  isPermanent: 0 | 1;
  totalCount: number;
  productIds: number[];
  categoryId: number;
  scopeType: 0 | 1 | 2;
  sort: number;
  status: 0 | 1;
  discountType: 1 | 2;
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
    throw new ValidateException(`${label}参数错误`);
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) throw new ValidateException(`${label}参数错误`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidateException(`${label}参数错误`);
  }
  return parsed;
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ValidateException(`${label}格式错误`);
  }
  const text = String(value).trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) {
    throw new ValidateException(`${label}格式错误`);
  }
  const [whole, fraction = ""] = text.split(".");
  return `${BigInt(whole).toString()}.${fraction.padEnd(2, "0")}`;
}

function decimalHundredths(value: string): number {
  const [whole, fraction] = value.split(".");
  return Number(whole) * 100 + Number(fraction);
}

function dateValue(value: unknown, label: string): Date | null {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0") return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new ValidateException(`${label}格式错误`);
    return new Date(value.getTime());
  }
  if (typeof value === "number" || (typeof value === "string" && /^\d{10,13}$/.test(value.trim()))) {
    const raw = Number(value);
    const millis = String(value).trim().length === 13 ? raw : raw * 1_000;
    const parsed = new Date(millis);
    if (!Number.isSafeInteger(raw) || raw <= 0 || !Number.isFinite(parsed.getTime())) {
      throw new ValidateException(`${label}格式错误`);
    }
    return parsed;
  }
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const text = value.trim();
  const structured = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?)?$/,
  );
  if (!structured) throw new ValidateException(`${label}格式错误`);
  const year = Number(structured[1]);
  const month = Number(structured[2]);
  const day = Number(structured[3]);
  const hour = Number(structured[4] ?? 0);
  const minute = Number(structured[5] ?? 0);
  const second = Number(structured[6] ?? 0);
  const zone = structured[7] ?? "+08:00";
  const zoneParts = zone === "Z" ? null : zone.slice(1).split(":").map(Number);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (year < 1970 || year > 9999 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59
    || (zoneParts && (zoneParts[0] > 14 || zoneParts[1] > 59))) {
    throw new ValidateException(`${label}格式错误`);
  }
  const normalized = `${structured[1]}-${structured[2]}-${structured[3]}T${String(hour).padStart(2, "0")}`
    + `:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${zone}`;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) throw new ValidateException(`${label}格式错误`);
  return parsed;
}

function ids(value: unknown, label: string): number[] {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  if (raw.length > MAX_SCOPE_IDS) throw new ValidateException(`${label}数量超限`);
  const result = [...new Set(raw.map((item) => integer(item, label, 0, 1, 2_147_483_647)))].sort(
    (left, right) => left - right,
  );
  if (!result.length) throw new ValidateException(`${label}参数错误`);
  return result;
}

function lastCategoryId(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  if (!raw.length || raw.length > MAX_SCOPE_IDS) throw new ValidateException("适用分类参数错误");
  return integer(raw.at(-1), "适用分类", 0, 1, 2_147_483_647);
}

export function normalizeOutCouponRequestKey(value: unknown): string {
  return normalizeOutRequestKey(value);
}

export function normalizeOutCouponInput(input: UnknownRecord): NormalizedOutCouponInput {
  const unsupported = Object.keys(input).filter((key) => !ALLOWED_CREATE_FIELDS.has(key));
  if (unsupported.length) {
    throw new ValidateException(`优惠券字段 ${unsupported.sort().join(",")} 尚未迁移，不能静默丢弃`);
  }
  if (typeof input.coupon_title !== "string") throw new ValidateException("请输入优惠券名称");
  const couponTitle = input.coupon_title.trim().normalize("NFC");
  if (!couponTitle || couponTitle.length > 64) throw new ValidateException("优惠券名称长度必须为1至64个字符");
  const couponPrice = decimal(input.coupon_price ?? 0, "优惠券金额或折扣");
  const useMinPrice = decimal(input.use_min_price ?? 0, "优惠券使用门槛");
  const discountType = integer(input.coupon_type, "优惠券优惠类型", 1, 1, 2) as 1 | 2;
  const priceHundredths = decimalHundredths(couponPrice);
  if (priceHundredths <= 0) {
    throw new ValidateException(discountType === 1 ? "请输入优惠券金额" : "请输入优惠券折扣");
  }
  if (discountType === 2 && priceHundredths > 10_000) {
    throw new ValidateException("优惠券折扣必须大于0且不超过100");
  }

  const scopeType = integer(input.type, "优惠券适用范围", 0, 0, 2) as 0 | 1 | 2;
  const productIds = scopeType === 2 ? ids(input.product_id, "适用商品") : [];
  const categoryId = scopeType === 1 ? lastCategoryId(input.category_id) : 0;
  if (scopeType === 1 && !categoryId) throw new ValidateException("请选择优惠券适用分类");
  if (scopeType === 2 && !productIds.length) throw new ValidateException("请选择优惠券适用商品");
  if (productIds.join(",").length > 500) throw new ValidateException("优惠券适用商品数量过多");

  const receiveType = integer(input.receive_type, "优惠券领取方式", 0, 1, 3) as 1 | 2 | 3;
  let isPermanent = integer(input.is_permanent, "不限量状态", 0, 0, 1) as 0 | 1;
  let totalCount = integer(input.total_count, "优惠券发行量", 0, 0, 2_147_483_647);
  if (receiveType === 2 || receiveType === 3) {
    isPermanent = 1;
    totalCount = 0;
  } else if (isPermanent === 1) {
    totalCount = 0;
  } else if (totalCount <= 0) {
    throw new ValidateException("限量优惠券发行量必须大于0");
  }

  const day = integer(input.coupon_time, "领取后有效天数", 0, 0, MAX_DAY);
  const startTime = dateValue(input.start_time, "领取开始时间");
  const endTime = dateValue(input.end_time, "领取结束时间");
  if (Boolean(startTime) !== Boolean(endTime)) throw new ValidateException("领取开始和结束时间必须同时填写");
  if (startTime && endTime && startTime.getTime() > endTime.getTime()) {
    throw new ValidateException("领取结束时间不能小于领取开始时间");
  }
  const useStartTime = dateValue(input.start_use_time, "使用开始时间");
  const useEndTime = dateValue(input.end_use_time, "使用结束时间");
  if (day > 0 && (useStartTime || useEndTime)) {
    throw new ValidateException("领取后有效天数与固定使用时间不能同时填写");
  }
  if (day === 0 && (!useStartTime || !useEndTime)) {
    throw new ValidateException("固定有效期优惠券必须填写使用开始和结束时间");
  }
  if (useStartTime && useEndTime && useStartTime.getTime() > useEndTime.getTime()) {
    throw new ValidateException("使用结束时间不能小于使用开始时间");
  }
  if (startTime && useStartTime && useStartTime.getTime() < startTime.getTime()) {
    throw new ValidateException("使用开始时间不能小于领取开始时间");
  }
  if (endTime && useEndTime && useEndTime.getTime() < endTime.getTime()) {
    throw new ValidateException("使用结束时间不能小于领取结束时间");
  }

  const status = integer(input.status, "优惠券状态", 0, 0, 1) as 0 | 1;
  const now = Date.now();
  if (status === 1 && ((endTime && endTime.getTime() < now)
    || (day === 0 && useEndTime && useEndTime.getTime() < now))) {
    throw new ValidateException("启用优惠券的领取或使用时间已经结束");
  }

  return {
    couponTitle,
    couponPrice,
    useMinPrice,
    day,
    useStartTime,
    useEndTime,
    startTime,
    endTime,
    receiveType,
    isPermanent,
    totalCount,
    productIds,
    categoryId,
    scopeType,
    sort: integer(input.sort, "排序", 0, -1_000_000, 1_000_000),
    status,
    discountType,
  };
}

async function replayResult(
  tx: DbClient,
  accountId: number,
  operation: CouponWriteOperation,
  key: string,
  hash: string,
) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${REPLAY_LOCK_NAMESPACE}, ${accountId})`);
  const rows = await tx.select().from(outCouponWriteReplay).where(and(
    eq(outCouponWriteReplay.outAccountId, accountId),
    eq(outCouponWriteReplay.operation, operation),
    eq(outCouponWriteReplay.requestKey, key),
  )).limit(1);
  const replay = rows[0];
  if (!replay) return undefined;
  if (replay.requestHash !== hash) throw new ValidateException("Idempotency-Key 已用于不同请求");
  return replay;
}

async function recordReplay(
  tx: DbClient,
  accountId: number,
  operation: CouponWriteOperation,
  key: string,
  hash: string,
  couponId: number,
  resultStatus: number,
) {
  await tx.insert(outCouponWriteReplay).values({
    outAccountId: accountId,
    operation,
    requestKey: key,
    requestHash: hash,
    couponId,
    resultStatus,
    addTime: Math.floor(Date.now() / 1_000),
  });
}

async function lockCouponCatalog(tx: DbClient): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${COUPON_WRITE_LOCK_NAMESPACE}, 0)`);
}

async function assertCreateScope(tx: DbClient, input: NormalizedOutCouponInput): Promise<void> {
  if (input.scopeType === 1) {
    const rows = await tx.select({ id: storeProductCategory.id }).from(storeProductCategory).where(and(
      eq(storeProductCategory.id, input.categoryId),
      eq(storeProductCategory.type, PLATFORM_TYPE),
      eq(storeProductCategory.relationId, 0),
    )).limit(1).for("share");
    if (!rows[0]) throw new NotFoundException("适用分类不存在或不属于平台");
  }
  if (input.scopeType === 2) {
    const rows = await tx.select({ id: storeProduct.id }).from(storeProduct).where(and(
      inArray(storeProduct.id, input.productIds),
      eq(storeProduct.type, PLATFORM_TYPE),
      eq(storeProduct.relationId, 0),
      eq(storeProduct.productType, PHYSICAL_PRODUCT_TYPE),
      eq(storeProduct.isDel, 0),
    )).orderBy(storeProduct.id).for("share");
    if (rows.length !== input.productIds.length) {
      throw new NotFoundException("部分适用商品不存在、已删除或不属于平台实物商品");
    }
  }
}

function positiveStoredId(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(String(value ?? "").split(",").at(-1));
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

async function assertIssueCanEnable(
  tx: DbClient,
  issue: typeof storeCouponIssue.$inferSelect,
): Promise<void> {
  const price = Number(issue.couponPrice);
  if (!issue.couponTitle.trim() || issue.couponTitle.length > 64 || ![1, 2].includes(issue.type)
    || !Number.isFinite(price) || price <= 0 || (issue.type === 2 && price > 100)) {
    throw new ValidateException("优惠券金额、折扣或名称配置无效，不能启用");
  }
  if (![1, 2, 3].includes(issue.receiveType)) {
    throw new ValidateException("优惠券领取方式无效，不能启用");
  }
  if (issue.isPermanent !== 1
    && (issue.totalCount <= 0 || issue.remainCount < 0 || issue.remainCount > issue.totalCount)) {
    throw new ValidateException("优惠券发行量配置无效，不能启用");
  }
  const now = Date.now();
  if (Boolean(issue.startTime) !== Boolean(issue.endTime)
    || (issue.startTime && issue.endTime && issue.startTime > issue.endTime)
    || (issue.endTime && issue.endTime.getTime() < now)) {
    throw new ValidateException("优惠券领取时间配置无效或已结束，不能启用");
  }
  if (issue.day <= 0 && (!issue.useStartTime || !issue.useEndTime
    || issue.useStartTime > issue.useEndTime || issue.useEndTime.getTime() < now)) {
    throw new ValidateException("优惠券使用时间配置无效或已结束，不能启用");
  }
  if (![0, 1, 2, 3].includes(issue.couponType)) {
    throw new ValidateException("优惠券适用范围无效，不能启用");
  }
  if (issue.couponType === 1) {
    const categoryId = positiveStoredId(issue.legacyCategoryId, issue.category_id);
    const rows = categoryId > 0
      ? await tx.select({ id: storeProductCategory.id }).from(storeProductCategory).where(and(
          eq(storeProductCategory.id, categoryId),
          eq(storeProductCategory.type, PLATFORM_TYPE),
          eq(storeProductCategory.relationId, 0),
        )).limit(1).for("share")
      : [];
    if (!rows[0]) throw new ValidateException("优惠券适用分类不存在或不属于平台，不能启用");
  }
  if (issue.couponType === 2) {
    const links = await tx.select({ productId: storeCouponProduct.productId }).from(storeCouponProduct)
      .where(eq(storeCouponProduct.couponId, issue.id)).orderBy(storeCouponProduct.productId).for("share");
    const productIds = [...new Set(links.map((row) => row.productId).filter((id) => id > 0))];
    const products = productIds.length
      ? await tx.select({ id: storeProduct.id }).from(storeProduct).where(and(
          inArray(storeProduct.id, productIds),
          eq(storeProduct.type, PLATFORM_TYPE),
          eq(storeProduct.relationId, 0),
          eq(storeProduct.productType, PHYSICAL_PRODUCT_TYPE),
          eq(storeProduct.isDel, 0),
        )).for("share")
      : [];
    if (!productIds.length || products.length !== productIds.length) {
      throw new ValidateException("优惠券适用商品关系无效，不能启用");
    }
  }
  if (issue.couponType === 3) {
    const brandId = positiveStoredId(issue.legacyBrandId, issue.brandId);
    const rows = brandId > 0
      ? await tx.select({ id: storeBrand.id }).from(storeBrand).where(and(
          eq(storeBrand.id, brandId),
          eq(storeBrand.storeId, 0),
          eq(storeBrand.isDel, 0),
        )).limit(1).for("share")
      : [];
    if (!rows[0]) throw new ValidateException("优惠券适用品牌不存在或不属于平台，不能启用");
  }
}

async function usageCounts(tx: DbClient, couponId: number) {
  const [users, evidence] = await Promise.all([
    tx.select({
      claimed: count(),
      used: sql<number>`count(*) FILTER (WHERE ${storeCouponUser.status} = 1)::integer`,
      reserved: sql<number>`count(*) FILTER (WHERE ${storeCouponUser.status} = 3)::integer`,
    }).from(storeCouponUser).where(eq(storeCouponUser.issueCouponId, couponId)),
    tx.select({ claims: count() }).from(storeCouponIssueUser)
      .where(eq(storeCouponIssueUser.issueCouponId, couponId)),
  ]);
  return {
    issued_rows: Number(users[0]?.claimed ?? 0),
    used_rows: Number(users[0]?.used ?? 0),
    reserved_rows: Number(users[0]?.reserved ?? 0),
    claim_evidence_rows: Number(evidence[0]?.claims ?? 0),
  };
}

async function activeConflictNames(tx: DbClient, couponId: number): Promise<string[]> {
  const now = Math.floor(Date.now() / 1_000);
  const configRowsPromise = tx.select({ menuName: systemConfig.menuName, value: systemConfig.value })
    .from(systemConfig)
    .where(and(
      eq(systemConfig.isStore, 0),
      inArray(systemConfig.menuName, ["newcomer_status", "register_coupon_status", "register_give_coupon"]),
    )).for("update");
  const [productGrant, lottery, promotionMain, promotionAux, configRows] = await Promise.all([
    tx.select({ id: storeProductCoupon.id }).from(storeProductCoupon)
      .innerJoin(storeProduct, eq(storeProduct.id, storeProductCoupon.productId))
      .where(and(eq(storeProductCoupon.issueCouponId, couponId), eq(storeProduct.isDel, 0))).limit(1),
    tx.select({ id: luckPrize.id }).from(luckPrize)
      .innerJoin(luckLottery, eq(luckLottery.id, luckPrize.lotteryId))
      .where(and(
        eq(luckPrize.type, 5),
        eq(luckPrize.couponId, couponId),
        eq(luckPrize.status, 1),
        eq(luckPrize.isDel, 0),
        eq(luckLottery.status, 1),
        eq(luckLottery.isDel, 0),
        or(eq(luckLottery.endTime, 0), gte(luckLottery.endTime, now)),
      )).limit(1),
    tx.select({ id: storePromotions.id }).from(storePromotions).where(and(
      eq(storePromotions.status, 1),
      eq(storePromotions.isDel, 0),
      or(eq(storePromotions.stopTime, 0), gte(storePromotions.stopTime, now)),
      sql`(',' || regexp_replace(COALESCE(${storePromotions.giveCouponId}, ''), '[^0-9]+', ',', 'g') || ',') LIKE ${`%,${couponId},%`}`,
    )).limit(1),
    tx.select({ id: storePromotionsAuxiliary.id }).from(storePromotionsAuxiliary)
      .innerJoin(storePromotions, eq(storePromotions.id, storePromotionsAuxiliary.promotionsId))
      .where(and(
        eq(storePromotionsAuxiliary.couponId, couponId),
        eq(storePromotions.status, 1),
        eq(storePromotions.isDel, 0),
        or(eq(storePromotions.stopTime, 0), gte(storePromotions.stopTime, now)),
      )).limit(1),
    configRowsPromise,
  ]);
  const configValues = (name: string) => configRows
    .filter((row) => row.menuName === name)
    .map((row) => row.value);
  // Duplicate system_config keys exist in production. Treat any enabled value
  // as authoritative for a destructive guard instead of picking an arbitrary row.
  const newcomer = configValues("newcomer_status").some((value) => configFlag(value))
    && configValues("register_coupon_status").some((value) => configFlag(value))
    && configValues("register_give_coupon")
      .some((value) => parseConfigIds(value).includes(couponId));
  return [
    productGrant[0] ? "商品支付后赠券" : "",
    lottery[0] ? "抽奖活动" : "",
    promotionMain[0] || promotionAux[0] ? "促销活动" : "",
    newcomer ? "新人礼包" : "",
  ].filter(Boolean);
}

export class OutCouponService {
  constructor(private readonly container: Container) {}

  async create(account: { id: number }, inputValue: UnknownRecord, requestKeyValue: unknown) {
    const input = normalizeOutCouponInput(inputValue);
    const key = normalizeOutCouponRequestKey(requestKeyValue);
    const operation: CouponWriteOperation = "coupon_create";
    const hash = await outRequestHash({ operation, input });
    return withTx(this.container, async (tx) => {
      const replay = await replayResult(tx, account.id, operation, key, hash);
      if (replay) return { id: replay.couponId, status: replay.resultStatus, idempotent: true };
      await lockCouponCatalog(tx);
      await assertCreateScope(tx, input);
      const productId = input.scopeType === 2 ? input.productIds.join(",") : "0";
      const categoryId = input.scopeType === 1 ? input.categoryId : 0;
      const rows = await tx.insert(storeCouponIssue).values({
        couponType: input.scopeType,
        couponTitle: input.couponTitle,
        title: input.couponTitle,
        type: input.discountType,
        couponPrice: input.couponPrice,
        useMinPrice: input.useMinPrice,
        productId,
        category_id: String(categoryId),
        brandId: "0",
        legacyProductIds: productId,
        legacyCategoryId: categoryId,
        legacyBrandId: 0,
        totalCount: input.totalCount,
        remainCount: input.totalCount,
        receiveLimit: 0,
        receiveType: input.receiveType,
        startTime: input.startTime,
        endTime: input.endTime,
        day: input.day,
        isPermanent: input.isPermanent,
        useStartTime: input.useStartTime,
        useEndTime: input.useEndTime,
        status: input.status,
        sort: input.sort,
        addTime: Math.floor(Date.now() / 1_000),
      }).returning({ id: storeCouponIssue.id });
      const couponId = rows[0]?.id;
      if (!couponId) throw new Error("优惠券创建失败");
      if (input.scopeType === 2) {
        await tx.insert(storeCouponProduct).values(
          input.productIds.map((productIdValue) => ({ couponId, productId: productIdValue })),
        );
      }
      await recordReplay(tx, account.id, operation, key, hash, couponId, input.status);
      return { id: couponId, status: input.status, idempotent: false };
    });
  }

  async setStatus(
    account: { id: number },
    idValue: unknown,
    statusValue: unknown,
    requestKeyValue: unknown,
  ) {
    const couponId = integer(idValue, "优惠券ID", 0, 1, 2_147_483_647);
    const status = integer(statusValue, "优惠券状态", -1, 0, 1) as 0 | 1;
    const key = normalizeOutCouponRequestKey(requestKeyValue);
    const operation: CouponWriteOperation = "coupon_status";
    const hash = await outRequestHash({ operation, couponId, status });
    return withTx(this.container, async (tx) => {
      const replay = await replayResult(tx, account.id, operation, key, hash);
      if (replay) return { id: replay.couponId, status: replay.resultStatus, idempotent: true };
      await lockCouponCatalog(tx);
      const rows = await tx.select().from(storeCouponIssue)
        .where(eq(storeCouponIssue.id, couponId)).limit(1).for("update");
      const issue = rows[0];
      if (!issue || issue.isDel === 1 || issue.status === -1) throw new NotFoundException("优惠券不存在或已删除");
      if (status === 1) await assertIssueCanEnable(tx, issue);
      const idempotent = issue.status === status;
      if (!idempotent) {
        await tx.update(storeCouponIssue).set({ status }).where(and(
          eq(storeCouponIssue.id, couponId),
          eq(storeCouponIssue.isDel, 0),
        ));
      }
      await recordReplay(tx, account.id, operation, key, hash, couponId, status);
      return { id: couponId, status, idempotent };
    });
  }

  async delete(account: { id: number }, idValue: unknown, requestKeyValue: unknown) {
    const couponId = integer(idValue, "优惠券ID", 0, 1, 2_147_483_647);
    const key = normalizeOutCouponRequestKey(requestKeyValue);
    const operation: CouponWriteOperation = "coupon_delete";
    const hash = await outRequestHash({ operation, couponId });
    return withTx(this.container, async (tx) => {
      const replay = await replayResult(tx, account.id, operation, key, hash);
      if (replay) {
        return {
          id: replay.couponId,
          status: replay.resultStatus,
          idempotent: true,
          preserved_usage: await usageCounts(tx, replay.couponId),
        };
      }
      await lockCouponCatalog(tx);
      await tx.execute(sql.raw(
        'LOCK TABLE "store_product_coupon", "luck_prize", "luck_lottery", "store_promotions", '
          + '"store_promotions_auxiliary", "system_config" IN SHARE ROW EXCLUSIVE MODE',
      ));
      const rows = await tx.select().from(storeCouponIssue)
        .where(eq(storeCouponIssue.id, couponId)).limit(1).for("update");
      const issue = rows[0];
      if (!issue) throw new NotFoundException("优惠券不存在");
      const preservedUsage = await usageCounts(tx, couponId);
      if (issue.isDel === 1 || issue.status === -1) {
        await recordReplay(tx, account.id, operation, key, hash, couponId, -1);
        return { id: couponId, status: -1, idempotent: true, preserved_usage: preservedUsage };
      }
      const conflicts = await activeConflictNames(tx, couponId);
      if (conflicts.length) {
        throw new ValidateException(`优惠券仍被${conflicts.join("、")}引用，请先解除发放配置`);
      }
      await tx.update(storeCouponIssue).set({ isDel: 1, status: -1 }).where(eq(storeCouponIssue.id, couponId));
      // Keep store_coupon_product: issued product coupons still consult this
      // scope relation when an existing user coupon is applied to an order.
      await recordReplay(tx, account.id, operation, key, hash, couponId, -1);
      return { id: couponId, status: -1, idempotent: false, preserved_usage: preservedUsage };
    });
  }
}
