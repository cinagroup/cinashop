import {
  and,
  desc,
  eq,
  ilike,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  deliveryService,
  storeUser,
  systemStore,
  systemStoreStaff,
  user as userTable,
  type DeliveryService,
  type SystemStore,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_PAGE_SIZE = 100;
const STAFF_WRITE_LOCK = 8_214_001;
const DELIVERY_WRITE_LOCK = 8_214_002;
const STORE_USER_WRITE_LOCK = 8_214_003;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

function sourceValue(body: Record<string, unknown>, snake: string, camel?: string) {
  if (Object.prototype.hasOwnProperty.call(body, snake)) return body[snake];
  if (camel && Object.prototype.hasOwnProperty.call(body, camel)) return body[camel];
  return undefined;
}

function hasSource(body: Record<string, unknown>, snake: string, camel?: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, snake)
    || !!camel && Object.prototype.hasOwnProperty.call(body, camel);
}

function boundedText(
  value: unknown,
  field: string,
  maxLength: number,
  required = false,
  fallback = "",
): string {
  if (value === undefined || value === null) value = fallback;
  if (Array.isArray(value)) value = value.join(",");
  if (typeof value !== "string") throw new ValidateException(`${field}格式错误`);
  const normalized = value.trim();
  if (required && !normalized) throw new ValidateException(`请填写${field}`);
  if (normalized.length > maxLength) {
    throw new ValidateException(`${field}不能超过${maxLength}个字符`);
  }
  return normalized;
}

function nonNegativeInteger(
  value: unknown,
  field: string,
  fallback = 0,
  max = 2_147_483_647,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new ValidateException(`${field}必须是非负整数`);
  }
  return parsed;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = nonNegativeInteger(value, field);
  if (parsed <= 0) throw new ValidateException(`${field}错误`);
  return parsed;
}

function binaryFlag(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = value === true ? 1 : value === false ? 0 : Number(value);
  if (parsed !== 0 && parsed !== 1) throw new ValidateException(`${field}只能是0或1`);
  return parsed;
}

function pagination(query: Record<string, string>) {
  const page = Math.max(1, nonNegativeInteger(query.page, "页码", 1));
  const limit = Math.max(
    1,
    Math.min(MAX_PAGE_SIZE, nonNegativeInteger(query.limit, "每页数量", 20)),
  );
  return { page, limit, offset: (page - 1) * limit };
}

export function isLegacyMobile(value: string): boolean {
  return /^1[3456789]\d{9}$/.test(value);
}

function mobile(value: unknown, fallback = ""): string {
  const normalized = boundedText(value, "手机号", 20, true, fallback);
  if (!isLegacyMobile(normalized)) throw new ValidateException("手机号格式不正确");
  return normalized;
}

function coordinate(value: unknown, field: string, min: number, max: number): string {
  const normalized = boundedText(value, field, 25, true);
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ValidateException(`${field}格式错误`);
  }
  return normalized;
}

function timeRange(value: unknown, field: string, maxLength: number): string {
  if (Array.isArray(value)) value = value.join(" - ");
  return boundedText(value, field, maxLength, true);
}

export interface NormalizedStoreInput {
  erpShopId: number;
  name: string;
  introduction: string;
  phone: string;
  address: string;
  province: number;
  city: number;
  area: number;
  street: number;
  detailedAddress: string;
  image: string;
  oblongImage: string;
  latitude: string;
  longitude: string;
  validTime: string;
  validRange: number;
  dayTime: string;
  dayStart: string;
  dayEnd: string;
  isShow: number;
  isStore: number;
}

export function normalizeStoreInput(input: unknown): NormalizedStoreInput {
  const body = record(input);
  let latitude = sourceValue(body, "latitude");
  let longitude = sourceValue(body, "longitude");
  const latlng = sourceValue(body, "latlng");
  if ((!latitude || !longitude) && typeof latlng === "string") {
    const pair = latlng.split(",").map((item) => item.trim());
    if (pair.length === 2) [latitude, longitude] = pair;
  }
  const addressValue = sourceValue(body, "address");
  const address = Array.isArray(addressValue)
    ? addressValue.map((item) => String(item).trim()).filter(Boolean).join(",")
    : addressValue;
  return {
    erpShopId: nonNegativeInteger(sourceValue(body, "erp_shop_id", "erpShopId"), "ERP门店ID"),
    name: boundedText(sourceValue(body, "name"), "门店名称", 100, true),
    introduction: boundedText(sourceValue(body, "introduction"), "门店简介", 1000),
    phone: mobile(sourceValue(body, "phone")),
    address: boundedText(address, "门店地址", 255, true),
    province: nonNegativeInteger(sourceValue(body, "province"), "省ID"),
    city: nonNegativeInteger(sourceValue(body, "city"), "市ID"),
    area: nonNegativeInteger(sourceValue(body, "area"), "区ID"),
    street: nonNegativeInteger(sourceValue(body, "street"), "街道ID"),
    detailedAddress: boundedText(
      sourceValue(body, "detailed_address", "detailedAddress"),
      "详细地址",
      255,
      true,
    ),
    image: boundedText(sourceValue(body, "image"), "门店图片", 255),
    oblongImage: boundedText(
      sourceValue(body, "oblong_image", "oblongImage"),
      "门店推荐图",
      255,
    ),
    latitude: coordinate(latitude, "纬度", -90, 90),
    longitude: coordinate(longitude, "经度", -180, 180),
    validTime: boundedText(sourceValue(body, "valid_time", "validTime"), "核销时段", 100),
    validRange: nonNegativeInteger(
      sourceValue(body, "valid_range", "validRange"),
      "有效距离",
    ),
    dayTime: timeRange(sourceValue(body, "day_time", "dayTime"), "营业时间", 100),
    dayStart: boundedText(sourceValue(body, "day_start", "dayStart"), "营业开始时间", 20),
    dayEnd: boundedText(sourceValue(body, "day_end", "dayEnd"), "营业结束时间", 20),
    isShow: binaryFlag(sourceValue(body, "is_show", "isShow"), "门店状态", 0),
    isStore: binaryFlag(sourceValue(body, "is_store", "isStore"), "自提状态", 0),
  };
}

export interface NormalizedStaffInput {
  storeId: number;
  uid: number;
  avatar: string;
  staffName: string;
  phone: string;
  verifyStatus: number;
  status: number;
}

export function normalizeStaffInput(input: unknown): NormalizedStaffInput {
  const body = record(input);
  const image = sourceValue(body, "image");
  const imageRecord = image && typeof image === "object" && !Array.isArray(image)
    ? image as Record<string, unknown>
    : null;
  return {
    storeId: positiveInteger(sourceValue(body, "store_id", "storeId"), "门店ID"),
    uid: positiveInteger(imageRecord?.uid ?? sourceValue(body, "uid"), "用户ID"),
    avatar: boundedText(
      imageRecord?.image ?? sourceValue(body, "avatar") ?? (typeof image === "string" ? image : ""),
      "店员头像",
      255,
    ),
    staffName: boundedText(
      sourceValue(body, "staff_name", "staffName"),
      "店员名称",
      64,
      true,
    ),
    phone: boundedText(sourceValue(body, "phone"), "店员电话", 15, true),
    verifyStatus: binaryFlag(
      sourceValue(body, "verify_status", "verifyStatus"),
      "核销权限",
      1,
    ),
    status: binaryFlag(sourceValue(body, "status"), "店员状态", 1),
  };
}

export interface NormalizedDeliveryInput {
  uid: number;
  avatar: string;
  nickname: string;
  phone: string;
  status: number;
}

export function normalizeDeliveryInput(
  input: unknown,
  fallback: { uid: number; avatar: string; nickname: string; phone: string },
): NormalizedDeliveryInput {
  const body = record(input);
  const image = sourceValue(body, "image");
  const imageRecord = image && typeof image === "object" && !Array.isArray(image)
    ? image as Record<string, unknown>
    : null;
  return {
    uid: positiveInteger(imageRecord?.uid ?? sourceValue(body, "uid") ?? fallback.uid, "用户ID"),
    avatar: boundedText(
      imageRecord?.image ?? sourceValue(body, "avatar") ?? fallback.avatar,
      "配送员头像",
      250,
    ),
    nickname: boundedText(
      sourceValue(body, "nickname") ?? fallback.nickname,
      "配送员名称",
      50,
      true,
    ),
    phone: mobile(sourceValue(body, "phone"), fallback.phone),
    status: binaryFlag(sourceValue(body, "status"), "配送员状态", 1),
  };
}

function trimmed(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function storeApi(row: SystemStore) {
  return {
    id: row.id,
    erp_shop_id: row.erpShopId,
    name: row.name,
    introduction: row.introduction,
    phone: trimmed(row.phone),
    address: row.address,
    province: row.province,
    city: row.city,
    area: row.area,
    street: row.street ?? 0,
    detailed_address: row.detailedAddress,
    image: row.image,
    oblong_image: row.oblongImage,
    latitude: trimmed(row.latitude),
    longitude: trimmed(row.longitude),
    valid_time: row.validTime,
    valid_range: row.validRange,
    day_time: row.dayTime,
    day_start: row.dayStart ?? "",
    day_end: row.dayEnd,
    add_time: row.addTime,
    is_show: row.isShow,
    is_del: row.isDel,
    is_store: row.isStore,
    latlng: `${trimmed(row.latitude)},${trimmed(row.longitude)}`,
    dataVal: row.validTime ? row.validTime.split(" - ") : [],
    timeVal: row.dayTime ? row.dayTime.split(" - ") : [],
    address2: row.address ? row.address.split(",") : [],
    status_name: row.isShow === 1 && row.isDel === 0 ? "营业中" : "已停业",
  };
}

export class StoreOperationsService {
  constructor(private readonly container: Container) {}

  async storeList(query: Record<string, string>) {
    const { page, limit, offset } = pagination(query);
    const conditions: SQL[] = [];
    switch (query.type) {
      case "1":
        conditions.push(eq(systemStore.isDel, 0), eq(systemStore.isShow, 1));
        break;
      case "-1":
        conditions.push(eq(systemStore.isDel, 0), eq(systemStore.isShow, 0));
        break;
      case "2":
        conditions.push(eq(systemStore.isDel, 1));
        break;
      default:
        conditions.push(eq(systemStore.isDel, 0));
    }
    const keyword = query.keywords?.trim() ?? query.keyword?.trim();
    if (keyword) {
      const pattern = `%${keyword}%`;
      const keywordCondition = or(
        sql`${systemStore.id}::text ILIKE ${pattern}`,
        ilike(systemStore.name, pattern),
        ilike(systemStore.introduction, pattern),
        ilike(systemStore.phone, pattern),
        ilike(systemStore.address, pattern),
        ilike(systemStore.detailedAddress, pattern),
      );
      if (keywordCondition) conditions.push(keywordCondition);
    }
    const where = and(...conditions);
    const [rows, count] = await Promise.all([
      this.container.db
        .select()
        .from(systemStore)
        .where(where)
        .orderBy(desc(systemStore.id))
        .limit(limit)
        .offset(offset),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(systemStore)
        .where(where),
    ]);
    return { list: rows.map(storeApi), count: count[0]?.count ?? 0, page, limit };
  }

  async storeHeader() {
    const rows = await this.container.db.select({
      show: sql<number>`COUNT(*) FILTER (WHERE ${systemStore.isDel} = 0 AND ${systemStore.isShow} = 1)::int`,
      hide: sql<number>`COUNT(*) FILTER (WHERE ${systemStore.isDel} = 0 AND ${systemStore.isShow} = 0)::int`,
      recycle: sql<number>`COUNT(*) FILTER (WHERE ${systemStore.isDel} = 1)::int`,
    }).from(systemStore);
    const counts = rows[0] ?? { show: 0, hide: 0, recycle: 0 };
    return {
      count: {
        show: { name: "显示中的提货点", num: counts.show },
        hide: { name: "隐藏中的提货点", num: counts.hide },
        recycle: { name: "回收站的提货点", num: counts.recycle },
      },
    };
  }

  async storeDetail(id: number) {
    const rows = await this.container.db
      .select()
      .from(systemStore)
      .where(eq(systemStore.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("门店不存在");
    return { info: storeApi(rows[0]) };
  }

  async storeOptions() {
    const rows = await this.container.db
      .select({ id: systemStore.id, name: systemStore.name })
      .from(systemStore)
      .where(eq(systemStore.isDel, 0))
      .orderBy(desc(systemStore.id));
    return rows;
  }

  /** Public checkout catalog: never expose bank, payment-account, or staff fields. */
  async publicPickupStores() {
    return this.container.db
      .select({
        id: systemStore.id,
        name: systemStore.name,
        introduction: systemStore.introduction,
        phone: systemStore.phone,
        address: systemStore.address,
        detailed_address: systemStore.detailedAddress,
        image: systemStore.image,
        latitude: systemStore.latitude,
        longitude: systemStore.longitude,
        valid_time: systemStore.validTime,
        day_time: systemStore.dayTime,
      })
      .from(systemStore)
      .where(and(
        eq(systemStore.isStore, 1),
        eq(systemStore.isShow, 1),
        eq(systemStore.isDel, 0),
      ))
      .orderBy(systemStore.id);
  }

  async saveStore(id: number, input: unknown) {
    if (!Number.isSafeInteger(id) || id < 0) throw new ValidateException("门店ID错误");
    const raw = record(input);
    const values = normalizeStoreInput(input);
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      if (id > 0) {
        const rows = await tx
          .select()
          .from(systemStore)
          .where(eq(systemStore.id, id))
          .limit(1)
          .for("update");
        if (!rows[0]) throw new NotFoundException("门店不存在");
        const existing = rows[0];
        await tx.update(systemStore).set({
          ...values,
          erpShopId: hasSource(raw, "erp_shop_id", "erpShopId")
            ? values.erpShopId : existing.erpShopId,
          province: hasSource(raw, "province") ? values.province : existing.province,
          city: hasSource(raw, "city") ? values.city : existing.city,
          area: hasSource(raw, "area") ? values.area : existing.area,
          street: hasSource(raw, "street") ? values.street : (existing.street ?? 0),
          oblongImage: hasSource(raw, "oblong_image", "oblongImage")
            ? values.oblongImage : existing.oblongImage,
          validTime: hasSource(raw, "valid_time", "validTime")
            ? values.validTime : existing.validTime,
          validRange: hasSource(raw, "valid_range", "validRange")
            ? values.validRange : existing.validRange,
          dayStart: hasSource(raw, "day_start", "dayStart")
            ? values.dayStart : (existing.dayStart ?? ""),
          dayEnd: hasSource(raw, "day_end", "dayEnd") ? values.dayEnd : existing.dayEnd,
          isShow: hasSource(raw, "is_show", "isShow") ? values.isShow : existing.isShow,
          isStore: hasSource(raw, "is_store", "isStore") ? values.isStore : existing.isStore,
        }).where(eq(systemStore.id, id));
        return { id };
      }
      const inserted = await tx
        .insert(systemStore)
        .values({ ...values, addTime: now, isDel: 0 })
        .returning({ id: systemStore.id });
      return { id: inserted[0].id };
    });
  }

  async setStoreVisibility(id: number, isShowValue: unknown) {
    const isShow = binaryFlag(isShowValue, "门店状态", 0);
    return withTx(this.container, async (tx) => {
      const rows = await tx
        .select({ id: systemStore.id, isDel: systemStore.isDel })
        .from(systemStore)
        .where(eq(systemStore.id, id))
        .limit(1)
        .for("update");
      if (!rows[0]) throw new NotFoundException("门店不存在");
      if (rows[0].isDel) throw new ValidateException("回收站门店不能变更营业状态");
      await tx.update(systemStore).set({ isShow }).where(eq(systemStore.id, id));
      return { id, is_show: isShow };
    });
  }

  async toggleStoreDeleted(id: number) {
    return withTx(this.container, async (tx) => {
      const rows = await tx
        .select({ id: systemStore.id, isDel: systemStore.isDel })
        .from(systemStore)
        .where(eq(systemStore.id, id))
        .limit(1)
        .for("update");
      if (!rows[0]) throw new NotFoundException("门店不存在");
      const isDel = rows[0].isDel ? 0 : 1;
      await tx
        .update(systemStore)
        .set(isDel ? { isDel, isShow: 0 } : { isDel })
        .where(eq(systemStore.id, id));
      return { id, is_del: isDel };
    });
  }

  async staffList(query: Record<string, string>) {
    const { page, limit, offset } = pagination(query);
    const conditions: SQL[] = [eq(systemStoreStaff.isDel, 0)];
    if (query.store_id) {
      conditions.push(eq(systemStoreStaff.storeId, positiveInteger(query.store_id, "门店ID")));
    }
    const keyword = query.keyword?.trim();
    if (keyword) {
      const pattern = `%${keyword}%`;
      const keywordCondition = or(
        sql`${systemStoreStaff.id}::text ILIKE ${pattern}`,
        sql`${systemStoreStaff.uid}::text ILIKE ${pattern}`,
        ilike(systemStoreStaff.staffName, pattern),
        ilike(systemStoreStaff.phone, pattern),
      );
      if (keywordCondition) conditions.push(keywordCondition);
    }
    const where = and(...conditions);
    const safeSelection = {
      id: systemStoreStaff.id,
      store_id: systemStoreStaff.storeId,
      uid: systemStoreStaff.uid,
      account: systemStoreStaff.account,
      avatar: systemStoreStaff.avatar,
      staff_name: systemStoreStaff.staffName,
      phone: systemStoreStaff.phone,
      roles: systemStoreStaff.roles,
      last_time: systemStoreStaff.lastTime,
      login_count: systemStoreStaff.loginCount,
      level: systemStoreStaff.level,
      verify_status: systemStoreStaff.verifyStatus,
      order_status: systemStoreStaff.orderStatus,
      is_admin: systemStoreStaff.isAdmin,
      is_manager: systemStoreStaff.isManager,
      is_cashier: systemStoreStaff.isCashier,
      status: systemStoreStaff.status,
      notify: systemStoreStaff.notify,
      is_del: systemStoreStaff.isDel,
      add_time: systemStoreStaff.addTime,
      name: systemStore.name,
      nickname: userTable.nickname,
    };
    const [list, count] = await Promise.all([
      this.container.db
        .select(safeSelection)
        .from(systemStoreStaff)
        .leftJoin(systemStore, eq(systemStore.id, systemStoreStaff.storeId))
        .leftJoin(userTable, eq(userTable.uid, systemStoreStaff.uid))
        .where(where)
        .orderBy(desc(systemStoreStaff.addTime), desc(systemStoreStaff.id))
        .limit(limit)
        .offset(offset),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(systemStoreStaff)
        .where(where),
    ]);
    return {
      list: list.map((item) => ({ ...item, phone: trimmed(item.phone), roles: item.roles ?? "" })),
      count: count[0]?.count ?? 0,
      page,
      limit,
    };
  }

  async staffDetail(id: number) {
    const rows = await this.container.db
      .select({
        id: systemStoreStaff.id,
        store_id: systemStoreStaff.storeId,
        uid: systemStoreStaff.uid,
        account: systemStoreStaff.account,
        avatar: systemStoreStaff.avatar,
        staff_name: systemStoreStaff.staffName,
        phone: systemStoreStaff.phone,
        roles: systemStoreStaff.roles,
        level: systemStoreStaff.level,
        verify_status: systemStoreStaff.verifyStatus,
        order_status: systemStoreStaff.orderStatus,
        is_admin: systemStoreStaff.isAdmin,
        is_manager: systemStoreStaff.isManager,
        is_cashier: systemStoreStaff.isCashier,
        status: systemStoreStaff.status,
        notify: systemStoreStaff.notify,
        add_time: systemStoreStaff.addTime,
        name: systemStore.name,
        nickname: userTable.nickname,
      })
      .from(systemStoreStaff)
      .leftJoin(systemStore, eq(systemStore.id, systemStoreStaff.storeId))
      .leftJoin(userTable, eq(userTable.uid, systemStoreStaff.uid))
      .where(and(eq(systemStoreStaff.id, id), eq(systemStoreStaff.isDel, 0)))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("店员不存在");
    return {
      info: { ...rows[0], phone: trimmed(rows[0].phone), roles: rows[0].roles ?? "" },
      stores: await this.storeOptions(),
    };
  }

  async staffForm(id = 0) {
    return {
      stores: await this.storeOptions(),
      info: id > 0 ? (await this.staffDetail(id)).info : null,
    };
  }

  async saveStaff(id: number, input: unknown) {
    if (!Number.isSafeInteger(id) || id < 0) throw new ValidateException("店员ID错误");
    const values = normalizeStaffInput(input);
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${STAFF_WRITE_LOCK}, 0)`);
      const existing = id > 0
        ? (await tx
          .select({
            id: systemStoreStaff.id,
            storeId: systemStoreStaff.storeId,
            uid: systemStoreStaff.uid,
          })
          .from(systemStoreStaff)
          .where(and(eq(systemStoreStaff.id, id), eq(systemStoreStaff.isDel, 0)))
          .limit(1)
          .for("update"))[0]
        : undefined;
      if (id > 0 && !existing) throw new NotFoundException("店员不存在");
      const stores = await tx
        .select({ id: systemStore.id })
        .from(systemStore)
        .where(and(eq(systemStore.id, values.storeId), eq(systemStore.isDel, 0)))
        .limit(1)
        .for("key share");
      if (!stores[0]) throw new NotFoundException("门店不存在或已删除");
      const users = await tx
        .select({ uid: userTable.uid })
        .from(userTable)
        .where(and(
          eq(userTable.uid, values.uid),
          eq(userTable.isDel, 0),
          eq(userTable.status, 1),
        ))
        .limit(1)
        .for("key share");
      if (!users[0]) throw new NotFoundException("用户不存在或已删除");
      if (!existing || existing.storeId !== values.storeId || existing.uid !== values.uid) {
        const duplicate = await tx
          .select({ id: systemStoreStaff.id })
          .from(systemStoreStaff)
          .where(and(
            eq(systemStoreStaff.storeId, values.storeId),
            eq(systemStoreStaff.uid, values.uid),
            eq(systemStoreStaff.isDel, 0),
            id > 0 ? ne(systemStoreStaff.id, id) : undefined,
          ))
          .limit(1);
        if (duplicate[0]) throw new ValidateException("该用户已经是此门店店员");
      }
      if (existing) {
        await tx.update(systemStoreStaff).set(values).where(eq(systemStoreStaff.id, id));
        return { id };
      }
      const inserted = await tx
        .insert(systemStoreStaff)
        .values({ ...values, addTime: now, isDel: 0 })
        .returning({ id: systemStoreStaff.id });
      return { id: inserted[0].id };
    });
  }

  async setStaffStatus(id: number, value: unknown) {
    const status = binaryFlag(value, "店员状态", 0);
    return withTx(this.container, async (tx) => {
      const rows = await tx
        .select({
          id: systemStoreStaff.id,
          storeId: systemStoreStaff.storeId,
          uid: systemStoreStaff.uid,
        })
        .from(systemStoreStaff)
        .where(and(eq(systemStoreStaff.id, id), eq(systemStoreStaff.isDel, 0)))
        .limit(1)
        .for("update");
      if (!rows[0]) throw new NotFoundException("店员不存在");
      if (status === 1) {
        const stores = await tx.select({ id: systemStore.id }).from(systemStore)
          .where(and(eq(systemStore.id, rows[0].storeId), eq(systemStore.isDel, 0))).limit(1);
        if (!stores[0]) throw new ValidateException("所属门店已删除，不能启用店员");
        const users = await tx.select({ uid: userTable.uid }).from(userTable)
          .where(and(
            eq(userTable.uid, rows[0].uid),
            eq(userTable.status, 1),
            eq(userTable.isDel, 0),
          )).limit(1);
        if (!users[0]) throw new ValidateException("关联用户已停用，不能启用店员");
      }
      await tx.update(systemStoreStaff).set({ status }).where(eq(systemStoreStaff.id, id));
      return { id, status };
    });
  }

  async deleteStaff(id: number) {
    const rows = await this.container.db
      .update(systemStoreStaff)
      .set({ isDel: 1, status: 0, verifyStatus: 0, notify: 0 })
      .where(and(eq(systemStoreStaff.id, id), eq(systemStoreStaff.isDel, 0)))
      .returning({ id: systemStoreStaff.id });
    if (!rows[0]) throw new NotFoundException("店员不存在");
  }

  async canStaffVerify(uid: number, storeId: number): Promise<boolean> {
    const rows = await this.container.db
      .select({ id: systemStoreStaff.id })
      .from(systemStoreStaff)
      .innerJoin(systemStore, eq(systemStore.id, systemStoreStaff.storeId))
      .innerJoin(userTable, eq(userTable.uid, systemStoreStaff.uid))
      .where(and(
        eq(systemStoreStaff.uid, uid),
        eq(systemStoreStaff.storeId, storeId),
        eq(systemStoreStaff.status, 1),
        eq(systemStoreStaff.verifyStatus, 1),
        eq(systemStoreStaff.isDel, 0),
        eq(systemStore.isShow, 1),
        eq(systemStore.isDel, 0),
        eq(userTable.status, 1),
        eq(userTable.isDel, 0),
      ))
      .limit(1);
    return !!rows[0];
  }

  async deliveryList(query: Record<string, string>, onlyActive = false) {
    const { page, limit, offset } = pagination(query);
    const conditions: SQL[] = [
      eq(deliveryService.type, 0),
      eq(deliveryService.relationId, 0),
      eq(deliveryService.isDel, 0),
    ];
    if (onlyActive) conditions.push(eq(deliveryService.status, 1));
    const keyword = query.keyword?.trim();
    if (keyword) {
      const pattern = `%${keyword}%`;
      const keywordCondition = or(
        sql`${deliveryService.id}::text ILIKE ${pattern}`,
        sql`${deliveryService.uid}::text ILIKE ${pattern}`,
        ilike(deliveryService.nickname, pattern),
        ilike(deliveryService.phone, pattern),
      );
      if (keywordCondition) conditions.push(keywordCondition);
    }
    const where = and(...conditions);
    const [list, count] = await Promise.all([
      this.container.db
        .select({
          id: deliveryService.id,
          uid: deliveryService.uid,
          avatar: deliveryService.avatar,
          wx_name: deliveryService.nickname,
          phone: deliveryService.phone,
          status: deliveryService.status,
          add_time: deliveryService.addTime,
          user_nickname: userTable.nickname,
        })
        .from(deliveryService)
        .leftJoin(userTable, eq(userTable.uid, deliveryService.uid))
        .where(where)
        .orderBy(desc(deliveryService.id))
        .limit(limit)
        .offset(offset),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(deliveryService)
        .where(where),
    ]);
    return {
      list: list.map(({ user_nickname, ...item }) => ({
        ...item,
        nickname: user_nickname || item.wx_name,
      })),
      count: count[0]?.count ?? 0,
      page,
      limit,
    };
  }

  async deliveryCandidates(query: Record<string, string>) {
    const { page, limit, offset } = pagination(query);
    const conditions: SQL[] = [
      eq(userTable.isDel, 0),
      eq(userTable.status, 1),
      isNull(deliveryService.id),
    ];
    const keyword = query.nickname?.trim() ?? query.keyword?.trim();
    if (keyword) {
      const pattern = `%${keyword}%`;
      const keywordCondition = or(
        ilike(userTable.nickname, pattern),
        ilike(userTable.phone, pattern),
        sql`${userTable.uid}::text ILIKE ${pattern}`,
      );
      if (keywordCondition) conditions.push(keywordCondition);
    }
    const join = and(
      eq(deliveryService.uid, userTable.uid),
      eq(deliveryService.type, 0),
      eq(deliveryService.relationId, 0),
      eq(deliveryService.isDel, 0),
    );
    const where = and(...conditions);
    const [list, count] = await Promise.all([
      this.container.db
        .select({
          uid: userTable.uid,
          nickname: userTable.nickname,
          headimgurl: userTable.avatar,
          phone: userTable.phone,
        })
        .from(userTable)
        .leftJoin(deliveryService, join)
        .where(where)
        .orderBy(desc(userTable.uid))
        .limit(limit)
        .offset(offset),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(userTable)
        .leftJoin(deliveryService, join)
        .where(where),
    ]);
    return { list, count: count[0]?.count ?? 0, page, limit };
  }

  async deliveryDetail(id: number) {
    const rows = await this.container.db
      .select({
        id: deliveryService.id,
        uid: deliveryService.uid,
        avatar: deliveryService.avatar,
        nickname: deliveryService.nickname,
        phone: deliveryService.phone,
        status: deliveryService.status,
        add_time: deliveryService.addTime,
      })
      .from(deliveryService)
      .where(and(
        eq(deliveryService.id, id),
        eq(deliveryService.type, 0),
        eq(deliveryService.relationId, 0),
        eq(deliveryService.isDel, 0),
      ))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("配送员不存在");
    return rows[0];
  }

  async saveDelivery(id: number, input: unknown, type = 0, relationId = 0) {
    if (!Number.isSafeInteger(id) || id < 0) throw new ValidateException("配送员ID错误");
    if (![0, 1, 2].includes(type) || relationId < 0) throw new ValidateException("配送作用域错误");
    const body = record(input);
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${DELIVERY_WRITE_LOCK}, 0)`);
      const existing: Pick<DeliveryService, "id" | "uid" | "avatar" | "nickname" | "phone"> | undefined = id > 0
        ? (await tx
          .select({
            id: deliveryService.id,
            uid: deliveryService.uid,
            avatar: deliveryService.avatar,
            nickname: deliveryService.nickname,
            phone: deliveryService.phone,
          })
          .from(deliveryService)
          .where(and(
            eq(deliveryService.id, id),
            eq(deliveryService.type, type),
            eq(deliveryService.relationId, relationId),
            eq(deliveryService.isDel, 0),
          ))
          .limit(1)
          .for("update"))[0]
        : undefined;
      if (id > 0 && !existing) throw new NotFoundException("配送员不存在");
      const requestedUid = existing?.uid ?? positiveInteger(
        (sourceValue(body, "image") as Record<string, unknown> | undefined)?.uid
          ?? sourceValue(body, "uid"),
        "用户ID",
      );
      const users = await tx
        .select({
          uid: userTable.uid,
          avatar: userTable.avatar,
          nickname: userTable.nickname,
          phone: userTable.phone,
        })
        .from(userTable)
        .where(and(
          eq(userTable.uid, requestedUid),
          eq(userTable.isDel, 0),
          eq(userTable.status, 1),
        ))
        .limit(1)
        .for("key share");
      if (!users[0]) throw new NotFoundException("用户不存在或已删除");
      const values = normalizeDeliveryInput(body, {
        uid: users[0].uid,
        avatar: existing?.avatar || users[0].avatar,
        nickname: existing?.nickname || users[0].nickname,
        phone: existing?.phone || users[0].phone,
      });
      if (!existing || existing.uid !== values.uid) {
        const duplicateUid = await tx
          .select({ id: deliveryService.id })
          .from(deliveryService)
          .where(and(
            eq(deliveryService.type, type),
            eq(deliveryService.relationId, relationId),
            eq(deliveryService.uid, values.uid),
            eq(deliveryService.isDel, 0),
            id > 0 ? ne(deliveryService.id, id) : undefined,
          ))
          .limit(1);
        if (duplicateUid[0]) throw new ValidateException("该用户已经是当前作用域配送员");
      }
      if (!existing || trimmed(existing.phone) !== values.phone) {
        const duplicatePhone = await tx
          .select({ id: deliveryService.id })
          .from(deliveryService)
          .where(and(
            eq(deliveryService.type, type),
            eq(deliveryService.relationId, relationId),
            eq(deliveryService.phone, values.phone),
            eq(deliveryService.isDel, 0),
            id > 0 ? ne(deliveryService.id, id) : undefined,
          ))
          .limit(1);
        if (duplicatePhone[0]) throw new ValidateException("同一手机号只能有一个有效配送员");
      }
      if (existing) {
        await tx.update(deliveryService).set(values).where(eq(deliveryService.id, id));
        return { id };
      }
      const inserted = await tx
        .insert(deliveryService)
        .values({ ...values, type, relationId, addTime: now, isDel: 0 })
        .returning({ id: deliveryService.id });
      return { id: inserted[0].id };
    });
  }

  async setDeliveryStatus(id: number, value: unknown) {
    const status = binaryFlag(value, "配送员状态", 0);
    return withTx(this.container, async (tx) => {
      const rows = await tx
        .select({ id: deliveryService.id, uid: deliveryService.uid })
        .from(deliveryService)
        .where(and(
          eq(deliveryService.id, id),
          eq(deliveryService.type, 0),
          eq(deliveryService.relationId, 0),
          eq(deliveryService.isDel, 0),
        ))
        .limit(1)
        .for("update");
      if (!rows[0]) throw new NotFoundException("配送员不存在");
      if (status === 1) {
        const users = await tx.select({ uid: userTable.uid }).from(userTable)
          .where(and(
            eq(userTable.uid, rows[0].uid),
            eq(userTable.status, 1),
            eq(userTable.isDel, 0),
          )).limit(1);
        if (!users[0]) throw new ValidateException("关联用户已停用，不能启用配送员");
      }
      await tx.update(deliveryService).set({ status }).where(eq(deliveryService.id, id));
      return { id, status };
    });
  }

  async deleteDelivery(id: number) {
    const rows = await this.container.db
      .update(deliveryService)
      .set({ isDel: 1, status: 0 })
      .where(and(
        eq(deliveryService.id, id),
        eq(deliveryService.type, 0),
        eq(deliveryService.relationId, 0),
        eq(deliveryService.isDel, 0),
      ))
      .returning({ id: deliveryService.id });
    if (!rows[0]) throw new NotFoundException("配送员不存在");
  }

  async requireActiveDelivery(uid: number, type = 0, relationId = 0) {
    const rows = await this.container.db
      .select({
        id: deliveryService.id,
        uid: deliveryService.uid,
        nickname: deliveryService.nickname,
        phone: deliveryService.phone,
      })
      .from(deliveryService)
      .innerJoin(userTable, eq(userTable.uid, deliveryService.uid))
      .where(and(
        eq(deliveryService.uid, uid),
        eq(deliveryService.type, type),
        eq(deliveryService.relationId, relationId),
        eq(deliveryService.status, 1),
        eq(deliveryService.isDel, 0),
        eq(userTable.status, 1),
        eq(userTable.isDel, 0),
      ))
      .orderBy(desc(deliveryService.id))
      .limit(2);
    if (!rows.length) throw new NotFoundException("配送员不存在或已停用");
    if (rows.length > 1) throw new ValidateException("配送员身份存在重复，请先清理历史数据");
    return { ...rows[0], phone: trimmed(rows[0].phone) };
  }

  async ensureStoreUser(storeId: number, uid: number) {
    if (storeId <= 0 || uid <= 0) throw new ValidateException("门店或用户ID错误");
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${STORE_USER_WRITE_LOCK}, ${storeId})`);
      const [stores, users] = await Promise.all([
        tx.select({ id: systemStore.id }).from(systemStore)
          .where(and(eq(systemStore.id, storeId), eq(systemStore.isDel, 0))).limit(1),
        tx.select({ uid: userTable.uid }).from(userTable)
          .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0))).limit(1),
      ]);
      if (!stores[0]) throw new NotFoundException("门店不存在或已删除");
      if (!users[0]) throw new NotFoundException("用户不存在或已删除");
      const existing = await tx
        .select({ id: storeUser.id })
        .from(storeUser)
        .where(and(eq(storeUser.storeId, storeId), eq(storeUser.uid, uid), eq(storeUser.status, 1)))
        .orderBy(desc(storeUser.id))
        .limit(1)
        .for("update");
      if (existing[0]) return existing[0];
      const inserted = await tx
        .insert(storeUser)
        .values({ storeId, uid, status: 1, addTime: Math.floor(Date.now() / 1000) })
        .returning({ id: storeUser.id });
      return inserted[0];
    });
  }
}
