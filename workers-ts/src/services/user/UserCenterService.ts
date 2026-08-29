/**
 * 用户中心 Service (M5)
 * 地址 + 收藏 + 签到
 *
 * 对应 PHP:
 *   - UserAddressServices (editAddress/setDefault)
 *   - UserRelationServices (productRelation 收藏)
 *   - UserSignServices (sign 签到)
 */
import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import {
  cityArea,
  memberRight,
  storeProduct,
  storeProductLog,
  systemConfig,
  systemSignReward,
  user as userTable,
  userAddress,
  userBill,
  userRelation,
  userSign,
  video,
} from "@/models/schema";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import { detectUserLevel } from "@/services/order/OrderRewardService";
import {
  calculateSignReward,
  type SignRewardRule,
} from "@/services/system/SystemSignRewardService";
import { normalizeConfigScalar, parseConfigInteger } from "@/utils/config";
import { ValidateException, NotFoundException } from "@/utils/errors";
import { nextContinuousSignDays, signDayWindow, type SignDayWindow } from "@/utils/sign";

const SIGN_LOCK_NAMESPACE = 731_623;
const ADDRESS_LOCK_NAMESPACE = 731_624;
const MAX_COLLECT_IDS = 100;
const POSTGRES_INT_MAX = 2_147_483_647;
const POSTGRES_INT_MIN = -2_147_483_648;
// user_sign.exp_balance is still int4 even though user.exp is NUMERIC(12, 2).
const USER_SIGN_EXP_BALANCE_MAX_HUNDREDTHS = POSTGRES_INT_MAX * 100 + 99;
const COLLECT_CATEGORIES = new Set([
  "product",
  "video",
]);
const SIGN_CONFIG_KEYS = [
  "sign_status",
  "sign_in_switch",
  "sign_mode",
  "sign_give_point",
  "sign_in_integral",
  "sign_give_exp",
  "member_func_status",
  "member_card_status",
] as const;

interface SignStats {
  signedToday: boolean;
  signedYesterday: boolean;
  cumulativeDays: number;
}

interface SignConfig {
  enabled: boolean;
  signMode: number;
  basePoint: number;
  baseExp: number;
  memberFunctionEnabled: boolean;
  memberCardEnabled: boolean;
}

type AddressRow = typeof userAddress.$inferSelect;

function positiveId(value: unknown, field: string): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^[1-9]\d*$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ValidateException(`${field}参数错误`);
  }
  return parsed;
}

function legacyAddress(row: AddressRow): Record<string, unknown> {
  return {
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
  };
}

function collectCategory(value: unknown): string {
  const category = String(value ?? "product").trim().toLowerCase();
  if (!COLLECT_CATEGORIES.has(category)) throw new ValidateException("收藏分类错误");
  return category;
}

function collectIds(values: readonly unknown[]): number[] {
  const ids = [...new Set(values.map((value) => {
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
      return Number(value.trim());
    }
    return Number.NaN;
  }))];
  if (
    ids.length === 0
    || ids.length > MAX_COLLECT_IDS
    || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new ValidateException("请选择有效商品");
  }
  return ids;
}

async function syncProductCollectCounts(db: DbClient, productIds: readonly number[]): Promise<void> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return;
  await db.execute(sql`
    WITH requested(id) AS (
      SELECT value::integer
      FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)
    ), actual AS (
      SELECT relation.relation_id AS product_id, COUNT(*)::integer AS count
      FROM user_relation relation
      JOIN requested ON requested.id = relation.relation_id
      WHERE relation.type = 'collect' AND relation.category = 'product'
      GROUP BY relation.relation_id
    )
    UPDATE store_product product
    SET collect = COALESCE(actual.count, 0)
    FROM requested
    LEFT JOIN actual ON actual.product_id = requested.id
    WHERE product.id = requested.id
  `);
}

async function syncVideoCollectCounts(db: DbClient, videoIds: readonly number[]): Promise<void> {
  const ids = [...new Set(videoIds)];
  if (!ids.length) return;
  await db.execute(sql`
    WITH requested(id) AS (
      SELECT value::integer
      FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)
    ), actual AS (
      SELECT relation.relation_id AS video_id, COUNT(*)::integer AS count
      FROM user_relation relation
      JOIN requested ON requested.id = relation.relation_id
      WHERE relation.type = 'collect' AND relation.category = 'video'
      GROUP BY relation.relation_id
    )
    UPDATE video item
    SET collect_num = COALESCE(actual.count, 0)
    FROM requested
    LEFT JOIN actual ON actual.video_id = requested.id
    WHERE item.id = requested.id
  `);
}

async function lockCollectProducts(db: DbClient, productIds: readonly number[]): Promise<void> {
  const ids = [...new Set(productIds)].sort((left, right) => left - right);
  const rows = await db
    .select({ id: storeProduct.id })
    .from(storeProduct)
    .where(inArray(storeProduct.id, ids))
    .orderBy(asc(storeProduct.id))
    .for("update");
  if (rows.length !== ids.length) throw new NotFoundException("商品不存在");
}

async function lockExistingCollectProducts(db: DbClient, productIds: readonly number[]): Promise<void> {
  const ids = [...new Set(productIds)].sort((left, right) => left - right);
  await db
    .select({ id: storeProduct.id })
    .from(storeProduct)
    .where(inArray(storeProduct.id, ids))
    .orderBy(asc(storeProduct.id))
    .for("update");
}

async function lockCollectVideos(db: DbClient, videoIds: readonly number[]): Promise<void> {
  const ids = [...new Set(videoIds)].sort((left, right) => left - right);
  const rows = await db
    .select({ id: video.id })
    .from(video)
    .where(inArray(video.id, ids))
    .orderBy(asc(video.id))
    .for("update");
  if (rows.length !== ids.length) throw new NotFoundException("视频不存在");
}

async function lockExistingCollectVideos(db: DbClient, videoIds: readonly number[]): Promise<void> {
  const ids = [...new Set(videoIds)].sort((left, right) => left - right);
  await db
    .select({ id: video.id })
    .from(video)
    .where(inArray(video.id, ids))
    .orderBy(asc(video.id))
    .for("update");
}

function normalizedAddressSegments(values: readonly string[]): string[] {
  const raw = values.map((segment) => segment.trim()).filter(Boolean);
  return raw.filter((segment, index) => index === 0 || segment !== raw[index - 1]);
}

async function findCityAreaBySegments(
  db: DbClient,
  segments: readonly string[],
): Promise<{ id: number; path: string; matched: number } | null> {
  if (!segments.length) return null;
  let first = await db
    .select({ id: cityArea.id, path: cityArea.path })
    .from(cityArea)
    .where(and(eq(cityArea.name, segments[0]), eq(cityArea.parentId, 0)))
    .orderBy(asc(cityArea.id))
    .limit(1);
  if (!first[0]) {
    first = await db
      .select({ id: cityArea.id, path: cityArea.path })
      .from(cityArea)
      .where(eq(cityArea.name, segments[0]))
      .orderBy(asc(cityArea.id))
      .limit(1);
  }
  if (!first[0]) return null;
  let selected = first[0];
  let matched = 1;
  const pathIds = [selected.id];
  for (const segment of segments.slice(1)) {
    const descendants = await db
      .select({ id: cityArea.id, path: cityArea.path })
      .from(cityArea)
      .where(and(
        like(cityArea.path, `/${pathIds.join("/")}/%`),
        eq(cityArea.name, segment),
      ))
      .orderBy(asc(cityArea.id))
      .limit(1);
    if (!descendants[0]) break;
    selected = descendants[0];
    matched++;
    pathIds.push(selected.id);
  }
  return { ...selected, matched };
}

async function legacyAddressCityList(
  db: DbClient,
  row: AddressRow,
): Promise<Record<string, unknown>[] | null> {
  // PHP removes adjacent duplicate municipality/county segments such as
  // 北京市/北京市/朝阳区 before walking the city-area hierarchy.
  const segments = normalizedAddressSegments(
    [row.province, row.city, row.district, row.street],
  );
  if (!segments.length) return null;
  const selected = await findCityAreaBySegments(db, segments);
  if (!selected) return null;
  const ancestorIds = [...new Set([
    selected.id,
    ...selected.path.split("/").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0),
  ])];
  return db
    .select({
      value: cityArea.id,
      id: cityArea.id,
      label: cityArea.name,
      pid: cityArea.parentId,
    })
    .from(cityArea)
    .where(inArray(cityArea.id, ancestorIds))
    .orderBy(asc(cityArea.id));
}

async function setDefaultAddressInTransaction(
  tx: DbClient,
  uid: number,
  id: number,
): Promise<void> {
  const target = await tx
    .select({ id: userAddress.id })
    .from(userAddress)
    .where(and(
      eq(userAddress.id, id),
      eq(userAddress.uid, uid),
      eq(userAddress.isDel, 0),
    ))
    .limit(1)
    .for("update");
  if (!target[0]) throw new NotFoundException("地址不存在");
  await tx
    .update(userAddress)
    .set({ isDefault: 0 })
    .where(and(
      eq(userAddress.uid, uid),
      eq(userAddress.isDel, 0),
      eq(userAddress.isDefault, 1),
    ));
  const updated = await tx
    .update(userAddress)
    .set({ isDefault: 1 })
    .where(and(
      eq(userAddress.id, id),
      eq(userAddress.uid, uid),
      eq(userAddress.isDel, 0),
    ))
    .returning({ id: userAddress.id });
  if (!updated[0]) throw new Error("默认地址更新失败");
}

function assertUid(uid: number): void {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户ID错误");
}

function isUniqueIndexViolation(error: unknown, indexName: string): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4 && candidate && typeof candidate === "object"; depth++) {
    const record = candidate as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
    };
    if (
      record.code === "23505"
      && (record.constraint === indexName || record.constraint_name === indexName)
    ) {
      return true;
    }
    candidate = record.cause;
  }
  return false;
}

function pickConfig(
  values: Readonly<Record<string, string>>,
  primary: string,
  alias?: string,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(values, primary)) return values[primary];
  return alias && Object.prototype.hasOwnProperty.call(values, alias) ? values[alias] : undefined;
}

function nonNegativeConfig(value: string | undefined, fallback: number): number {
  const parsed = parseConfigInteger(value, fallback);
  return parsed >= 0 && parsed <= 1_000_000 ? parsed : fallback;
}

function decimalToHundredths(value: string | number): number {
  const normalized = normalizeConfigScalar(String(value));
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error("用户经验格式无效");
  const [whole, fraction = ""] = normalized.split(".");
  const units = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(units)) throw new Error("用户经验超出安全范围");
  return units;
}

function hundredthsToDecimal(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("用户经验超出安全范围");
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

async function getSignStats(db: DbClient, uid: number, window: SignDayWindow): Promise<SignStats> {
  const rows = await db
    .select({
      signedToday: sql<boolean>`COUNT(*) FILTER (
        WHERE ${userSign.addTime} >= ${window.todayStart}
          AND ${userSign.addTime} < ${window.tomorrowStart}
      ) > 0`,
      signedYesterday: sql<boolean>`COUNT(*) FILTER (
        WHERE ${userSign.addTime} >= ${window.yesterdayStart}
          AND ${userSign.addTime} < ${window.todayStart}
      ) > 0`,
      cumulativeDays: sql<number>`COUNT(*)::int`,
    })
    .from(userSign)
    .where(eq(userSign.uid, uid));
  return rows[0] ?? { signedToday: false, signedYesterday: false, cumulativeDays: 0 };
}

async function loadSignConfig(db: DbClient): Promise<SignConfig> {
  const rows = await db
    .select({ menuName: systemConfig.menuName, value: systemConfig.value })
    .from(systemConfig)
    .where(
      and(
        eq(systemConfig.isStore, 0),
        inArray(systemConfig.menuName, [...SIGN_CONFIG_KEYS]),
      ),
    )
    .orderBy(asc(systemConfig.sort), asc(systemConfig.id));
  const values: Record<string, string> = {};
  for (const row of rows) values[row.menuName] = row.value;
  const rawMode = parseConfigInteger(values.sign_mode, 1);
  return {
    enabled: parseConfigInteger(pickConfig(values, "sign_status", "sign_in_switch"), 0) !== 0,
    signMode: rawMode === 0 || rawMode === 1 ? rawMode : 1,
    basePoint: nonNegativeConfig(
      pickConfig(values, "sign_give_point", "sign_in_integral"),
      0,
    ),
    baseExp: nonNegativeConfig(values.sign_give_exp, 0),
    memberFunctionEnabled: parseConfigInteger(values.member_func_status, 1) === 1,
    memberCardEnabled: parseConfigInteger(values.member_card_status, 1) === 1,
  };
}

async function calculateConfiguredSignReward(
  db: DbClient,
  account: Pick<
    typeof userTable.$inferSelect,
    "isMoneyLevel" | "isEverLevel" | "overdueTime" | "levelStatus"
  >,
  config: SignConfig,
  continuousDays: number,
  cumulativeDays: number,
  now: number,
) {
  const rules = await db
    .select()
    .from(systemSignReward)
    .where(
      or(
        and(eq(systemSignReward.type, 0), eq(systemSignReward.days, continuousDays)),
        and(eq(systemSignReward.type, 1), eq(systemSignReward.days, cumulativeDays)),
      ),
    )
    .orderBy(asc(systemSignReward.id));
  let pointMultiplier = 1;
  const activeSvip = account.isEverLevel > 0
    || (account.isMoneyLevel > 0 && account.overdueTime > now);
  if (config.memberCardEnabled && activeSvip) {
    const rights = await db
      .select({ number: memberRight.number })
      .from(memberRight)
      .where(and(eq(memberRight.rightType, "sign"), eq(memberRight.status, 1)))
      .orderBy(asc(memberRight.id))
      .limit(1);
    if (rights[0]?.number && rights[0].number > 0) pointMultiplier = rights[0].number;
  }
  const calculated = calculateSignReward({
    basePoint: config.basePoint,
    baseExp: config.baseExp,
    continuousDays,
    cumulativeDays,
    rules: rules as SignRewardRule[],
    memberFunctionEnabled: config.memberFunctionEnabled,
    levelActive: account.levelStatus === 1,
    pointMultiplier,
  });
  return {
    ...calculated,
    pointMultiplier,
    bonusPoint: calculated.point - Math.trunc(calculated.point / pointMultiplier),
  };
}

export class UserCenterService {
  constructor(private readonly container: Container) {}

  // ─── 地址 ─────────────────────────────────────────────────

  /** 地址列表 */
  async addressList(uid: number) {
    assertUid(uid);
    return (await this.container.userAddressDao.listByUid(uid)).map(legacyAddress);
  }

  /** 默认地址 */
  async addressDefault(uid: number) {
    assertUid(uid);
    const row = await this.container.userAddressDao.getDefault(uid);
    return row ? legacyAddress(row) : [];
  }

  /** 单个地址；查询条件先绑定 uid，避免泄露其他用户地址。 */
  async addressDetail(uid: number, idValue: unknown) {
    assertUid(uid);
    const id = positiveId(idValue, "地址");
    const rows = await this.container.db
      .select()
      .from(userAddress)
      .where(and(
        eq(userAddress.id, id),
        eq(userAddress.uid, uid),
        eq(userAddress.isDel, 0),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("地址不存在");
    const result = legacyAddress(row);
    const cityList = await legacyAddressCityList(this.container.db, row);
    if (cityList) result.city_list = cityList;
    return result;
  }

  /** 原子设置默认地址；目标不存在/跨用户时保留原默认地址。 */
  async addressSetDefault(uid: number, idValue: unknown): Promise<void> {
    assertUid(uid);
    const id = positiveId(idValue, "地址");
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADDRESS_LOCK_NAMESPACE}, ${uid})`);
      await setDefaultAddressInTransaction(tx, uid, id);
    });
  }

  /** 新增/编辑地址 (对应 PHP editAddress) */
  async addressSave(uid: number, params: {
    id?: unknown;
    realName: string;
    phone: string;
    province: string;
    city: string;
    district: string;
    street?: string;
    cityId?: number;
    detail: string;
    postCode?: number;
    longitude?: string;
    latitude?: string;
    isDefault?: number;
  }) {
    assertUid(uid);
    if (!params.realName || !params.phone || !params.detail) {
      throw new ValidateException("收货人、电话、详细地址不能为空");
    }
    if (!params.province || !params.city || !params.district) {
      throw new ValidateException("省、市、区/县不能为空");
    }
    if (!/^(?:1[3-9]\d{9}|(?:\d{3,4}-)?\d{7,8})$/.test(params.phone)) {
      throw new ValidateException("手机号格式错误");
    }
    if (
      params.realName.length > 25
      || params.phone.length > 16
      || params.province.length > 64
      || params.city.length > 64
      || params.district.length > 64
      || (params.street?.length ?? 0) > 100
      || params.detail.length > 256
      || (params.longitude?.length ?? 0) > 16
      || (params.latitude?.length ?? 0) > 16
    ) {
      throw new ValidateException("地址信息长度超出限制");
    }
    const id = params.id === undefined || params.id === null || params.id === ""
      ? 0
      : positiveId(params.id, "地址");
    const normalizedDefault = params.isDefault === undefined
      ? undefined
      : params.isDefault === 0 || params.isDefault === 1
        ? params.isDefault
        : Number.NaN;
    if (Number.isNaN(normalizedDefault)) throw new ValidateException("默认地址参数错误");
    const suppliedCityId = params.cityId ?? 0;
    const postCode = params.postCode ?? 0;
    if (!Number.isSafeInteger(suppliedCityId) || suppliedCityId < 0) {
      throw new ValidateException("城市ID参数错误");
    }
    if (!Number.isSafeInteger(postCode) || postCode < 0) throw new ValidateException("邮编参数错误");
    const hasLongitude = Boolean(params.longitude);
    const hasLatitude = Boolean(params.latitude);
    if (hasLongitude !== hasLatitude) throw new ValidateException("经纬度必须同时提供");
    if (hasLongitude) {
      const longitude = Number(params.longitude);
      const latitude = Number(params.latitude);
      if (
        !Number.isFinite(longitude)
        || longitude < -180
        || longitude > 180
        || !Number.isFinite(latitude)
        || latitude < -90
        || latitude > 90
      ) {
        throw new ValidateException("经纬度格式错误");
      }
    }
    const addressSegments = normalizedAddressSegments([
      params.province,
      params.city,
      params.district,
      params.street ?? "",
    ]);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADDRESS_LOCK_NAMESPACE}, ${uid})`);
      // Resolve and write the authoritative shipping region in the same
      // transaction. Besides making random-schema production tests reliable,
      // this prevents a region catalogue change between validation and save.
      const resolved = await findCityAreaBySegments(tx, addressSegments);
      if (!resolved || resolved.matched !== addressSegments.length) {
        // A zero or mismatched region id bypasses shipping/no-delivery rules.
        // Resolve the full hierarchy server-side and fail closed.
        throw new ValidateException("收货地址区域不存在");
      }
      if (suppliedCityId > 0 && suppliedCityId !== resolved.id) {
        throw new ValidateException("收货地址区域与省市区不一致");
      }
      const values = {
        realName: params.realName,
        phone: params.phone,
        province: params.province,
        city: params.city,
        district: params.district,
        street: params.street ?? "",
        cityId: resolved.id,
        detail: params.detail,
        postCode,
        longitude: params.longitude ?? "",
        latitude: params.latitude ?? "",
      };
      if (id) {
        const updated = await tx
          .update(userAddress)
          // Setting a new default must clear the old row first. Keep this
          // update neutral for `1` so a future partial unique index can be
          // enabled once the legacy PHP write path is retired or repaired.
          .set(normalizedDefault === 0 ? { ...values, isDefault: 0 } : values)
          .where(and(
            eq(userAddress.id, id),
            eq(userAddress.uid, uid),
            eq(userAddress.isDel, 0),
          ))
          .returning({ id: userAddress.id });
        if (!updated[0]) throw new NotFoundException("地址不存在");
        if (normalizedDefault === 1) await setDefaultAddressInTransaction(tx, uid, id);
        return id;
      }
      const inserted = await tx
        .insert(userAddress)
        .values({
          uid,
          ...values,
          // Insert under the lock as non-default, then perform the unique
          // switch inside this same transaction.
          isDefault: 0,
          addTime: Math.floor(Date.now() / 1000),
        })
        .returning({ id: userAddress.id });
      const insertedId = inserted[0]?.id;
      if (!insertedId) throw new Error("地址写入失败");
      if (normalizedDefault === 1) await setDefaultAddressInTransaction(tx, uid, insertedId);
      return insertedId;
    });
  }

  /** 删除地址 (软删) */
  async addressDel(uid: number, idValue: unknown) {
    assertUid(uid);
    const id = positiveId(idValue, "地址");
    const rows = await this.container.db
      .update(userAddress)
      .set({ isDel: 1, isDefault: 0 })
      .where(and(
        eq(userAddress.id, id),
        eq(userAddress.uid, uid),
        eq(userAddress.isDel, 0),
      ))
      .returning({ id: userAddress.id });
    if (!rows[0]) throw new NotFoundException("地址不存在");
  }

  // ─── 收藏 ─────────────────────────────────────────────────

  /** 收藏商品 (对应 PHP productRelation) */
  async collectAdd(uid: number, productIdValues: readonly unknown[], categoryValue = "product"): Promise<number> {
    assertUid(uid);
    const ids = collectIds(productIdValues);
    const category = collectCategory(categoryValue);
    return withTx(this.container, async (tx) => {
      if (category === "product") await lockCollectProducts(tx, ids);
      if (category === "video") await lockCollectVideos(tx, ids);
      const inserted = await tx
        .insert(userRelation)
        .values(ids.map((relationId) => ({
          uid,
          relationId,
          type: "collect",
          category,
          addTime: Math.floor(Date.now() / 1000),
        })))
        .onConflictDoNothing({
          target: [userRelation.uid, userRelation.relationId, userRelation.type, userRelation.category],
          where: sql`${userRelation.type} <> 'play'`,
        })
        .returning({ relationId: userRelation.relationId });
      const insertedIds = inserted.map((row) => row.relationId);
      if (category === "product" && insertedIds.length) {
        const now = Math.floor(Date.now() / 1000);
        await tx.insert(storeProductLog).values(insertedIds.map((productId) => ({
          type: "collect",
          productId,
          uid,
          collectNum: 1,
          addTime: now,
        })));
        await syncProductCollectCounts(tx, insertedIds);
      }
      if (category === "video" && insertedIds.length) {
        await syncVideoCollectCounts(tx, insertedIds);
      }
      return insertedIds.length;
    });
  }

  /** 取消收藏 */
  async collectDel(uid: number, productIdValues: readonly unknown[], categoryValue = "product"): Promise<void> {
    assertUid(uid);
    const ids = collectIds(productIdValues);
    const category = collectCategory(categoryValue);
    await withTx(this.container, async (tx) => {
      if (category === "product") await lockExistingCollectProducts(tx, ids);
      if (category === "video") await lockExistingCollectVideos(tx, ids);
      await tx
        .delete(userRelation)
        .where(and(
          eq(userRelation.uid, uid),
          inArray(userRelation.relationId, ids),
          eq(userRelation.type, "collect"),
          eq(userRelation.category, category),
        ));
      if (category === "product") await syncProductCollectCounts(tx, ids);
      if (category === "video") await syncVideoCollectCounts(tx, ids);
    });
  }

  /** 收藏列表 (返回商品 ID, 前端再查商品详情) */
  async collectList(uid: number, categoryValue = "product"): Promise<number[]> {
    assertUid(uid);
    return this.container.userRelationDao.getCollectIds(uid, collectCategory(categoryValue));
  }

  async collectPage(
    uid: number,
    page: number,
    limit: number,
    categoryValue = "product",
  ): Promise<{ ids: number[]; count: number }> {
    assertUid(uid);
    const category = collectCategory(categoryValue);
    const where = and(
      eq(userRelation.uid, uid),
      eq(userRelation.type, "collect"),
      eq(userRelation.category, category),
    );
    const [relations, counts] = await Promise.all([
      this.container.db
        .select({ id: userRelation.relationId })
        .from(userRelation)
        .where(where)
        .orderBy(desc(userRelation.addTime), desc(userRelation.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(userRelation)
        .where(where),
    ]);
    return { ids: relations.map((row) => row.id), count: counts[0]?.count ?? 0 };
  }

  /** 是否收藏 */
  async isCollected(uid: number, productId: number): Promise<boolean> {
    return this.container.userRelationDao.isCollected(uid, productId);
  }

  // ─── 签到 ─────────────────────────────────────────────────

  /**
   * 签到 (对应 PHP UserSignServices::sign)
   *
   * 逻辑:
   *   1. 今日已签到 → 拒绝
   *   2. 昨日未签到 → sign_num 重置为 0
   *   3. sign_num++
   *   4. 基础积分 + 连续/累计奖励 (从 system_config 读)
   *   5. 记 sign 流水 + 加积分
   */
  async sign(uid: number): Promise<{
    point: number;
    exp: number;
    sign_point: number;
    sign_exp: number;
    continuousDays: number;
    cumulativeDays: number;
  }> {
    assertUid(uid);
    const now = Math.floor(Date.now() / 1000);
    const window = signDayWindow(now);
    const signTransaction = () => withTx(this.container, async (tx) => {
      // Serialize Worker requests per user and then lock the account row. The
      // database Shanghai-day unique index also covers legacy PHP writers.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SIGN_LOCK_NAMESPACE}, ${uid})`);
      const accounts = await tx
        .select()
        .from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
        .limit(1)
        .for("update");
      const account = accounts[0];
      if (!account) throw new NotFoundException("用户不存在");

      const stats = await getSignStats(tx, uid, window);
      if (stats.signedToday) throw new ValidateException("今日已签到");
      const config = await loadSignConfig(tx);
      if (!config.enabled) throw new ValidateException("签到功能未开启");
      const continuousDays = nextContinuousSignDays({
        currentDays: account.signNum,
        signedYesterday: stats.signedYesterday,
        signMode: config.signMode,
        weekday: window.weekday,
        dayOfMonth: window.dayOfMonth,
      });
      if (continuousDays > POSTGRES_INT_MAX) {
        throw new ValidateException("连续签到天数超出安全范围");
      }
      // The PHP service queried the pre-insert count and was off by one. Use
      // the day being awarded so a configured day-1 cumulative reward fires.
      const cumulativeDays = stats.cumulativeDays + 1;
      if (!Number.isSafeInteger(cumulativeDays) || cumulativeDays > POSTGRES_INT_MAX) {
        throw new ValidateException("累计签到天数超出安全范围");
      }
      const reward = await calculateConfiguredSignReward(
        tx,
        account,
        config,
        continuousDays,
        cumulativeDays,
        now,
      );
      const nextIntegral = account.integral + reward.point;
      if (
        reward.point > POSTGRES_INT_MAX
        || reward.exp > POSTGRES_INT_MAX
        || !Number.isSafeInteger(nextIntegral)
        || nextIntegral < POSTGRES_INT_MIN
        || nextIntegral > POSTGRES_INT_MAX
      ) {
        throw new ValidateException("签到奖励或用户积分超出安全范围");
      }
      const currentExp = decimalToHundredths(account.exp);
      const nextExp = currentExp + reward.exp * 100;
      if (
        !Number.isSafeInteger(nextExp)
        || nextExp < 0
        || nextExp > USER_SIGN_EXP_BALANCE_MAX_HUNDREDTHS
      ) {
        throw new ValidateException("用户经验超出安全范围");
      }
      const expBalance = hundredthsToDecimal(nextExp);
      const title = reward.pointMultiplier > 1 && !stats.signedYesterday
        ? `签到奖励(SVIP+${reward.bonusPoint}积分)`
        : "签到奖励";

      await tx.insert(userSign).values({
        uid,
        title,
        number: reward.point,
        balance: nextIntegral,
        expNum: reward.exp,
        expBalance: Math.trunc(nextExp / 100),
        addTime: now,
      });
      const billRows: Array<typeof userBill.$inferInsert> = [];
      if (reward.point > 0) {
        billRows.push({
          uid,
          linkId: "0",
          pm: 1,
          title,
          category: "integral",
          type: "sign",
          eventKey: "sign",
          number: String(reward.point),
          balance: String(nextIntegral),
          mark: title,
          status: 1,
          addTime: now,
        });
      }
      if (reward.exp > 0) {
        const expTitle = "签到奖励";
        billRows.push({
          uid,
          linkId: "0",
          pm: 1,
          title: expTitle,
          category: "exp",
          type: "sign",
          eventKey: "sign",
          number: String(reward.exp),
          balance: expBalance,
          mark: expTitle,
          status: 1,
          addTime: now,
        });
      }
      if (billRows.length) await tx.insert(userBill).values(billRows);
      await tx
        .update(userTable)
        .set(reward.exp > 0
          ? { integral: nextIntegral, exp: expBalance, signNum: continuousDays }
          : { integral: nextIntegral, signNum: continuousDays })
        .where(eq(userTable.uid, uid));
      if (reward.exp > 0) {
        await detectUserLevel(tx, uid, account.nickname, nextExp, now);
      }
      return {
        point: reward.point,
        exp: reward.exp,
        sign_point: reward.point,
        sign_exp: reward.exp,
        continuousDays,
        cumulativeDays,
      };
    });
    try {
      return await signTransaction();
    } catch (error) {
      // A legacy PHP process does not participate in the Worker advisory lock.
      // Translate the database invariant into the established API response.
      if (isUniqueIndexViolation(error, "us_uid_shanghai_day_uq")) {
        throw new ValidateException("今日已签到");
      }
      throw error;
    }
  }

  /** 签到状态 (今日是否签、连续天数) */
  async signStatus(uid: number): Promise<{
    signedToday: boolean;
    continuousDays: number;
    cumulativeDays: number;
    integral: number;
    exp: number;
    enabled: boolean;
  }> {
    assertUid(uid);
    const account = await this.container.userDao.findForAuth(uid);
    if (!account) throw new NotFoundException("用户不存在");
    const now = Math.floor(Date.now() / 1000);
    const window = signDayWindow(now);
    const [stats, config] = await Promise.all([
      getSignStats(this.container.db, uid, window),
      loadSignConfig(this.container.db),
    ]);
    const continuousDays = stats.signedToday
      ? account.signNum
      : nextContinuousSignDays({
          currentDays: account.signNum,
          signedYesterday: stats.signedYesterday,
          signMode: config.signMode,
          weekday: window.weekday,
          dayOfMonth: window.dayOfMonth,
        });
    const cumulativeDays = stats.signedToday
      ? stats.cumulativeDays
      : stats.cumulativeDays + 1;
    const reward = await calculateConfiguredSignReward(
      this.container.db,
      account,
      config,
      continuousDays,
      cumulativeDays,
      now,
    );
    return {
      signedToday: stats.signedToday,
      continuousDays: account.signNum,
      cumulativeDays: stats.cumulativeDays,
      integral: reward.point,
      exp: reward.exp,
      enabled: config.enabled,
    };
  }
}
