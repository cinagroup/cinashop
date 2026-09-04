import bcrypt from "bcryptjs";
import { and, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderRefund,
  storeProduct,
  systemAdmin,
  systemSupplier,
} from "@/models/schema";
import { createToken, md5 } from "@/utils/jwt";
import { setTokenBucket } from "@/utils/cache";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { SupplierPermissionService } from "@/services/supplier/SupplierPermissionService";

const SUPPLIER_ADMIN_TYPE = 4;
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface PageInput {
  page: number;
  limit: number;
  offset: number;
}

const MAX_PICKING_SHEET_ORDERS = 10;
const MAX_PICKING_SNAPSHOT_BYTES = 256 * 1024;

type JsonObject = Record<string, unknown>;

function jsonObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function boundedPickingSnapshot(value: string | null): JsonObject {
  if (!value || new TextEncoder().encode(value).byteLength > MAX_PICKING_SNAPSHOT_BYTES) return {};
  try {
    return jsonObject(JSON.parse(value));
  } catch {
    return {};
  }
}

function pickingText(value: unknown, fallback: string, maximum: number): string {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim();
  return (normalized || fallback).slice(0, maximum);
}

function moneyNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000_000 ? parsed : 0;
}

export interface PickingSheetCartSource {
  cartNum: number;
  skuUnique: string;
  settlePrice: string;
  cartInfo: string | null;
}

function projectPickingSheetCart(row: PickingSheetCartSource, index: number) {
  const snapshot = boundedPickingSnapshot(row.cartInfo);
  const product = jsonObject(snapshot.product);
  const productInfo = jsonObject(snapshot.productInfo);
  const sku = jsonObject(snapshot.sku);
  const attrInfo = jsonObject(productInfo.attrInfo);
  const quantity = Number.isInteger(row.cartNum) && row.cartNum > 0 ? row.cartNum : 0;
  const unitPrice = moneyNumber(
    snapshot.sum_price ?? sku.price ?? snapshot.truePrice ?? snapshot.true_price ?? row.settlePrice,
  );
  return {
    item: {
      index,
      product_name: pickingText(product.storeName ?? productInfo.store_name, "商品快照", 256),
      sku: pickingText(sku.suk ?? attrInfo.suk ?? row.skuUnique, "默认", 255),
      unit_price: unitPrice.toFixed(2),
      quantity,
      subtotal: (unitPrice * quantity).toFixed(2),
    },
    vipDiscount: moneyNumber(snapshot.vip_truePrice ?? snapshot.vip_true_price) * Math.max(quantity, 1),
  };
}

export function projectPickingSheetCartItem(row: PickingSheetCartSource, index: number) {
  return projectPickingSheetCart(row, index).item;
}

export function normalizeSupplierPickingSheetIds(value: string | undefined): number[] {
  const parts = String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!parts.length) throw new ValidateException("请选择需要预览的订单");
  if (parts.length > MAX_PICKING_SHEET_ORDERS) {
    throw new ValidateException(`每次最多预览${MAX_PICKING_SHEET_ORDERS}个订单`);
  }
  const ids = parts.map((item) => Number(item));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ValidateException("订单ID格式错误");
  }
  if (new Set(ids).size !== ids.length) throw new ValidateException("订单ID不能重复");
  return ids;
}

export function parsePagination(pageValue: string | undefined, limitValue: string | undefined): PageInput {
  const rawPage = Number(pageValue ?? "1");
  const rawLimit = Number(limitValue ?? "20");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  return { page, limit, offset: (page - 1) * limit };
}

export function dayRangeUtc8(offsetDays = 0, nowMs = Date.now()): [number, number] {
  const shifted = new Date(nowMs + UTC8_OFFSET_MS);
  const startMs =
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + offsetDays) -
    UTC8_OFFSET_MS;
  return [Math.floor(startMs / 1000), Math.floor((startMs + 86_400_000 - 1) / 1000)];
}

function monthStartUtc8(nowMs = Date.now()): number {
  const shifted = new Date(nowMs + UTC8_OFFSET_MS);
  return Math.floor(
    (Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - UTC8_OFFSET_MS) / 1000,
  );
}

function normalizeBcryptHash(hash: string): string {
  return hash.replace(/^\$2[by]\$/, "$2a$");
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidateException(`${key} 格式错误`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new ValidateException(`${key} 长度不能超过 ${maxLength}`);
  return normalized;
}

function optionalInteger(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ValidateException(`${key} 格式错误`);
  return parsed;
}

export interface SupplierProfileInput {
  supplierName?: string;
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  province?: number;
  city?: number;
  area?: number;
  street?: number;
  detailedAddress?: string;
  account?: string;
}

export function normalizeSupplierProfileInput(input: Record<string, unknown>): SupplierProfileInput {
  const password = optionalString(input, "pwd", 72);
  const confirmPassword = optionalString(input, "conf_pwd", 72);
  if ((password?.length ?? 0) > 0 || (confirmPassword?.length ?? 0) > 0) {
    throw new ValidateException("请通过修改密码功能更改登录密码");
  }

  const email = optionalString(input, "email", 50);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidateException("邮箱格式错误");
  }

  const phone = optionalString(input, "phone", 15);
  if (phone && !/^[+\d][\d -]{5,14}$/.test(phone)) {
    throw new ValidateException("手机号格式错误");
  }

  return {
    supplierName: optionalString(input, "supplier_name", 50),
    name: optionalString(input, "name", 255),
    phone,
    email,
    address: optionalString(input, "address", 255),
    province: optionalInteger(input, "province"),
    city: optionalInteger(input, "city"),
    area: optionalInteger(input, "area"),
    street: optionalInteger(input, "street"),
    detailedAddress: optionalString(input, "detailed_address", 255),
    account: optionalString(input, "account", 32),
  };
}

export interface SupplierPasswordInput {
  currentPassword: string;
  newPassword: string;
}

export function normalizeSupplierPasswordInput(input: Record<string, unknown>): SupplierPasswordInput {
  const passwordValue = (key: string): string => {
    const value = input[key];
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw new ValidateException(`${key} 格式错误`);
    if (value.length > 72) throw new ValidateException(`${key} 长度不能超过 72`);
    return value;
  };
  const currentPassword = passwordValue("pwd");
  const newPassword = passwordValue("new_pwd");
  const confirmPassword = passwordValue("conf_pwd");
  if (!currentPassword) throw new ValidateException("请输入原密码");
  if (!newPassword) throw new ValidateException("请输入新密码");
  if (newPassword.length < 12) throw new ValidateException("新密码至少需要 12 位");
  if (newPassword !== confirmPassword) throw new ValidateException("两次输入的密码不一致");
  if (newPassword === currentPassword) throw new ValidateException("新密码不能与原密码相同");
  return { currentPassword, newPassword };
}

export class SupplierService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async login(account: string, password: string) {
    const normalizedAccount = account.trim();
    if (!normalizedAccount || !password) throw new ValidateException("请输入账号和密码");

    const admin = await this.container.systemAdminDao.findByAccountAndType(
      normalizedAccount,
      SUPPLIER_ADMIN_TYPE,
    );
    if (!admin || admin.isDel || !admin.status) throw new ValidateException("账号或密码错误");
    if (admin.relationId <= 0) throw new ValidateException("供应商账号未绑定");

    const supplier = await this.container.systemSupplierDao.findActiveById(admin.relationId);
    if (!supplier) throw new ValidateException("供应商已停用或绑定关系无效");

    const valid = await bcrypt.compare(password, normalizeBcryptHash(admin.pwd));
    if (!valid) throw new ValidateException("账号或密码错误");
    const isPrimary = supplier.adminId === admin.id;
    const permissions = await new SupplierPermissionService(this.container.db).permissionsFor(
      { id: admin.id, roles: admin.roles, isPrimary },
      supplier.id,
    );
    if (!isPrimary && permissions.size === 0) {
      throw new ValidateException("子账号尚未配置有效权限");
    }

    const { token, exp } = await createToken(
      admin.id,
      "supplier",
      md5(admin.pwd),
      this.env.APP_KEY,
    );
    await setTokenBucket(
      md5(token),
      {
        uid: admin.id,
        type: "supplier",
        token,
        exp: exp - Math.floor(Date.now() / 1000) + 60,
      },
      this.env,
    );
    await this.container.systemAdminDao.update(admin.id, {
      lastTime: Math.floor(Date.now() / 1000),
      loginCount: admin.loginCount + 1,
    });

    return {
      token,
      expires_time: exp,
      user_info: {
        id: admin.id,
        account: admin.account,
        avatar: admin.headPic || supplier.avatar,
        real_name: admin.realName || supplier.name,
        supplier_id: supplier.id,
        supplier_name: supplier.supplierName,
        is_primary: isPrimary,
      },
      unique_auth: [...permissions],
      menus: new SupplierPermissionService(this.container.db).buildNavigation(permissions),
      logo: "",
      logo_square: "",
      version: "CinaShop Supplier TS",
    };
  }

  async profile(supplierId: number, adminId: number) {
    const supplier = await this.container.systemSupplierDao.getOrThrow(supplierId, "供应商不存在");
    const admin = await this.container.systemAdminDao.getOrThrow(adminId, "管理员不存在");
    if (
      admin.adminType !== SUPPLIER_ADMIN_TYPE
      || admin.relationId !== supplier.id
      || admin.isDel
      || !admin.status
    ) {
      throw new NotFoundException("管理员不存在");
    }
    return {
      id: supplier.id,
      supplier_name: supplier.supplierName,
      avatar: supplier.avatar,
      name: supplier.name,
      phone: supplier.phone,
      email: supplier.email,
      address: supplier.address,
      province: supplier.province,
      city: supplier.city,
      area: supplier.area,
      street: supplier.street,
      detailed_address: supplier.detailedAddress,
      sort: supplier.sort,
      is_show: supplier.isShow,
      mark: supplier.mark,
      account: admin.account,
      pwd: "",
    };
  }

  async updateProfile(supplierId: number, adminId: number, input: SupplierProfileInput) {
    await this.container.db.transaction(async (tx) => {
      const supplierRows = await tx
        .select()
        .from(systemSupplier)
        .where(
          and(
            eq(systemSupplier.id, supplierId),
            eq(systemSupplier.isDel, 0),
          ),
        )
        .limit(1);
      const supplier = supplierRows[0];
      if (!supplier) throw new NotFoundException("供应商不存在");

      const actorRows = await tx
        .select()
        .from(systemAdmin)
        .where(
          and(
            eq(systemAdmin.id, adminId),
            eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
            eq(systemAdmin.relationId, supplierId),
            eq(systemAdmin.status, 1),
            eq(systemAdmin.isDel, 0),
          ),
        )
        .limit(1);
      const actor = actorRows[0];
      if (!actor) throw new NotFoundException("管理员不存在");
      const primaryRows = await tx
        .select()
        .from(systemAdmin)
        .where(and(
          eq(systemAdmin.id, supplier.adminId),
          eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
          eq(systemAdmin.relationId, supplierId),
          eq(systemAdmin.isDel, 0),
        ))
        .limit(1);
      const primary = primaryRows[0];
      if (!primary) throw new NotFoundException("主管理员不存在");
      const isPrimary = actor.id === primary.id;

      if (!isPrimary && input.account && input.account !== actor.account) {
        throw new ValidateException("子管理员不能在供应商资料中修改账号");
      }
      if (isPrimary && input.account && input.account !== primary.account) {
        const duplicate = await tx
          .select({ id: systemAdmin.id })
          .from(systemAdmin)
          .where(
            and(
              eq(systemAdmin.account, input.account),
              eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
              ne(systemAdmin.id, primary.id),
              eq(systemAdmin.isDel, 0),
            ),
          )
          .limit(1);
        if (duplicate.length > 0) throw new ValidateException("管理员账号已存在");
      }

      const supplierUpdate: Partial<typeof systemSupplier.$inferInsert> = {};
      if (input.supplierName !== undefined) supplierUpdate.supplierName = input.supplierName;
      if (input.name !== undefined) supplierUpdate.name = input.name;
      if (input.phone !== undefined) supplierUpdate.phone = input.phone;
      if (input.email !== undefined) supplierUpdate.email = input.email;
      if (input.address !== undefined) supplierUpdate.address = input.address;
      if (input.province !== undefined) supplierUpdate.province = input.province;
      if (input.city !== undefined) supplierUpdate.city = input.city;
      if (input.area !== undefined) supplierUpdate.area = input.area;
      if (input.street !== undefined) supplierUpdate.street = input.street;
      if (input.detailedAddress !== undefined) supplierUpdate.detailedAddress = input.detailedAddress;
      if (Object.keys(supplierUpdate).length > 0) {
        await tx.update(systemSupplier).set(supplierUpdate).where(eq(systemSupplier.id, supplierId));
      }

      if (isPrimary) {
        const adminUpdate: Partial<typeof systemAdmin.$inferInsert> = {};
        if (input.account !== undefined) adminUpdate.account = input.account;
        if (input.name !== undefined) adminUpdate.realName = input.name;
        if (input.phone !== undefined) adminUpdate.phone = input.phone;
        if (Object.keys(adminUpdate).length > 0) {
          await tx.update(systemAdmin).set(adminUpdate).where(eq(systemAdmin.id, primary.id));
        }
      }
    });
  }

  async changePassword(
    supplierId: number,
    adminId: number,
    input: SupplierPasswordInput,
  ): Promise<void> {
    const rows = await this.container.db
      .select({ id: systemAdmin.id, pwd: systemAdmin.pwd })
      .from(systemAdmin)
      .where(and(
        eq(systemAdmin.id, adminId),
        eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
        eq(systemAdmin.relationId, supplierId),
        eq(systemAdmin.status, 1),
        eq(systemAdmin.isDel, 0),
      ))
      .limit(1);
    const admin = rows[0];
    if (!admin) throw new NotFoundException("供应商管理员不存在");
    const valid = await bcrypt.compare(input.currentPassword, normalizeBcryptHash(admin.pwd));
    if (!valid) throw new ValidateException("原密码错误");
    const nextHash = await bcrypt.hash(input.newPassword, 12);
    const updated = await this.container.db
      .update(systemAdmin)
      .set({ pwd: nextHash })
      .where(and(
        eq(systemAdmin.id, admin.id),
        eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
        eq(systemAdmin.relationId, supplierId),
        eq(systemAdmin.status, 1),
        eq(systemAdmin.isDel, 0),
        eq(systemAdmin.pwd, admin.pwd),
      ))
      .returning({ id: systemAdmin.id });
    if (!updated[0]) throw new ValidateException("密码已被其他会话修改，请重试");
  }

  async dashboard(supplierId: number) {
    const [todayStart, todayEnd] = dayRangeUtc8();
    const [yesterdayStart, yesterdayEnd] = dayRangeUtc8(-1);
    const monthStart = monthStartUtc8();
    const [trendStart] = dayRangeUtc8(-6);

    const summarize = async (start: number, end: number) => {
      const rows = await this.container.db
        .select({
          sales: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::numeric(12,2)`,
          orders: sql<number>`COUNT(*)::int`,
        })
        .from(storeOrder)
        .where(
          and(
            eq(storeOrder.supplierId, supplierId),
            eq(storeOrder.paid, 1),
            sql`${storeOrder.pid} >= 0`,
            eq(storeOrder.isSystemDel, 0),
            sql`${storeOrder.addTime} BETWEEN ${start} AND ${end}`,
          ),
        );
      return { sales: rows[0]?.sales ?? "0.00", orders: rows[0]?.orders ?? 0 };
    };

    const [today, yesterday, month, pendingRows, productRows, refundRows, trendRows] = await Promise.all([
      summarize(todayStart, todayEnd),
      summarize(yesterdayStart, yesterdayEnd),
      summarize(monthStart, todayEnd),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeOrder)
        .where(
          and(
            eq(storeOrder.supplierId, supplierId),
            eq(storeOrder.paid, 1),
            eq(storeOrder.status, 0),
            sql`${storeOrder.pid} >= 0`,
            eq(storeOrder.isSystemDel, 0),
          ),
        ),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeProduct)
        .where(
          and(
            eq(storeProduct.type, 2),
            eq(storeProduct.relationId, supplierId),
            eq(storeProduct.isDel, 0),
          ),
        ),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeOrderRefund)
        .where(
          and(
            eq(storeOrderRefund.supplierId, supplierId),
            eq(storeOrderRefund.isCancel, 0),
            eq(storeOrderRefund.isDel, 0),
          ),
        ),
      this.container.db
        .select({
          date: sql<string>`TO_CHAR(TO_TIMESTAMP(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'MM-DD')`,
          sales: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::numeric(12,2)`,
          orders: sql<number>`COUNT(*)::int`,
        })
        .from(storeOrder)
        .where(
          and(
            eq(storeOrder.supplierId, supplierId),
            eq(storeOrder.paid, 1),
            sql`${storeOrder.pid} >= 0`,
            eq(storeOrder.isSystemDel, 0),
            sql`${storeOrder.addTime} BETWEEN ${trendStart} AND ${todayEnd}`,
          ),
        )
        .groupBy(sql`TO_CHAR(TO_TIMESTAMP(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'MM-DD')`)
        .orderBy(sql`MIN(${storeOrder.addTime})`),
    ]);

    return {
      today_sales: today.sales,
      yesterday_sales: yesterday.sales,
      month_sales: month.sales,
      today_orders: today.orders,
      yesterday_orders: yesterday.orders,
      month_orders: month.orders,
      pending_delivery: pendingRows[0]?.count ?? 0,
      product_count: productRows[0]?.count ?? 0,
      refund_count: refundRows[0]?.count ?? 0,
      trend: trendRows,
    };
  }

  async productList(supplierId: number, query: Record<string, string>) {
    const page = parsePagination(query.page, query.limit);
    const conditions: SQL[] = [
      eq(storeProduct.type, 2),
      eq(storeProduct.relationId, supplierId),
      eq(storeProduct.isDel, 0),
    ];
    const keyword = query.store_name?.trim();
    if (keyword) conditions.push(ilike(storeProduct.storeName, `%${keyword}%`));
    if (query.is_show === "0" || query.is_show === "1") {
      conditions.push(eq(storeProduct.isShow, Number(query.is_show)));
    }
    if (query.is_verify && ["-2", "-1", "0", "1"].includes(query.is_verify)) {
      conditions.push(eq(storeProduct.isVerify, Number(query.is_verify)));
    }
    const where = and(...conditions);

    const [list, totalRows] = await Promise.all([
      this.container.db
        .select({
          id: storeProduct.id,
          product_type: storeProduct.productType,
          image: storeProduct.image,
          store_name: storeProduct.storeName,
          price: storeProduct.price,
          stock: storeProduct.stock,
          sales: storeProduct.sales,
          is_show: storeProduct.isShow,
          is_verify: storeProduct.isVerify,
          add_time: storeProduct.addTime,
        })
        .from(storeProduct)
        .where(where)
        .orderBy(desc(storeProduct.sort), desc(storeProduct.id))
        .limit(page.limit)
        .offset(page.offset),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeProduct)
        .where(where),
    ]);
    return { list, count: totalRows[0]?.count ?? 0, page: page.page, limit: page.limit };
  }

  async productDetail(supplierId: number, productId: number) {
    const rows = await this.container.db
      .select()
      .from(storeProduct)
      .where(
        and(
          eq(storeProduct.id, productId),
          eq(storeProduct.type, 2),
          eq(storeProduct.relationId, supplierId),
          eq(storeProduct.isDel, 0),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new NotFoundException("商品不存在或不属于当前供应商");
    return rows[0];
  }

  async setProductShow(supplierId: number, productId: number, isShow: number) {
    if (isShow !== 0 && isShow !== 1) throw new ValidateException("商品状态错误");
    const rows = await this.container.db
      .update(storeProduct)
      .set({ isShow })
      .where(
        and(
          eq(storeProduct.id, productId),
          eq(storeProduct.type, 2),
          eq(storeProduct.relationId, supplierId),
          eq(storeProduct.isDel, 0),
        ),
      )
      .returning({ id: storeProduct.id });
    if (!rows[0]) throw new NotFoundException("商品不存在或不属于当前供应商");
  }

  async orderList(supplierId: number, query: Record<string, string>) {
    const page = parsePagination(query.page, query.limit);
    const conditions: SQL[] = [
      eq(storeOrder.supplierId, supplierId),
      sql`${storeOrder.pid} >= 0`,
      eq(storeOrder.isSystemDel, 0),
    ];
    const keyword = query.real_name?.trim() || query.order?.trim();
    if (keyword) {
      const keywordCondition = or(
        ilike(storeOrder.orderId, `%${keyword}%`),
        ilike(storeOrder.realName, `%${keyword}%`),
        ilike(storeOrder.userPhone, `%${keyword}%`),
      );
      if (keywordCondition) conditions.push(keywordCondition);
    }
    if (query.paid === "0" || query.paid === "1") conditions.push(eq(storeOrder.paid, Number(query.paid)));
    if (query.status && ["0", "1", "2", "3", "4", "5"].includes(query.status)) {
      conditions.push(eq(storeOrder.status, Number(query.status)));
    }
    if (query.pay_type) conditions.push(eq(storeOrder.payType, query.pay_type));
    const where = and(...conditions);

    const [list, totalRows] = await Promise.all([
      this.container.db
        .select({
          id: storeOrder.id,
          pid: storeOrder.pid,
          order_id: storeOrder.orderId,
          real_name: storeOrder.realName,
          user_phone: storeOrder.userPhone,
          total_num: storeOrder.totalNum,
          pay_price: storeOrder.payPrice,
          paid: storeOrder.paid,
          status: storeOrder.status,
          pay_type: storeOrder.payType,
          refund_status: storeOrder.refundStatus,
          shipping_type: storeOrder.shippingType,
          product_type: storeOrder.productType,
          delivery_type: storeOrder.deliveryType,
          delivery_name: storeOrder.deliveryName,
          delivery_code: storeOrder.deliveryCode,
          delivery_id: storeOrder.deliveryId,
          fictitious_content: storeOrder.fictitiousContent,
          remark: storeOrder.remark,
          add_time: storeOrder.addTime,
          pay_time: storeOrder.payTime,
        })
        .from(storeOrder)
        .where(where)
        .orderBy(desc(storeOrder.id))
        .limit(page.limit)
        .offset(page.offset),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeOrder)
        .where(where),
    ]);
    return { list, count: totalRows[0]?.count ?? 0, page: page.page, limit: page.limit };
  }

  async pickingSheets(supplierId: number, ids: number[]) {
    if (
      !ids.length
      || ids.length > MAX_PICKING_SHEET_ORDERS
      || new Set(ids).size !== ids.length
      || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    ) {
      throw new ValidateException("配货单订单范围错误");
    }
    const orders = await this.container.db
      .select({
        id: storeOrder.id,
        orderId: storeOrder.orderId,
        realName: storeOrder.realName,
        userPhone: storeOrder.userPhone,
        userAddress: storeOrder.userAddress,
        payTime: storeOrder.payTime,
        payType: storeOrder.payType,
        payPostage: storeOrder.payPostage,
        couponPrice: storeOrder.couponPrice,
        deductionPrice: storeOrder.deductionPrice,
        useIntegral: storeOrder.useIntegral,
        payPrice: storeOrder.payPrice,
        mark: storeOrder.mark,
        remark: storeOrder.remark,
      })
      .from(storeOrder)
      .where(and(
        inArray(storeOrder.id, ids),
        eq(storeOrder.supplierId, supplierId),
        eq(storeOrder.isSystemDel, 0),
      ));
    if (orders.length !== ids.length) {
      throw new NotFoundException("部分订单不存在或不属于当前供应商");
    }
    const carts = await this.container.db
      .select({
        oid: storeOrderCartInfo.oid,
        cartNum: storeOrderCartInfo.cartNum,
        skuUnique: storeOrderCartInfo.skuUnique,
        settlePrice: storeOrderCartInfo.settlePrice,
        cartInfo: sql<string | null>`case
          when octet_length(${storeOrderCartInfo.cartInfo}) <= ${MAX_PICKING_SNAPSHOT_BYTES}
          then ${storeOrderCartInfo.cartInfo}
          else null
        end`,
      })
      .from(storeOrderCartInfo)
      .where(inArray(storeOrderCartInfo.oid, ids))
      .orderBy(storeOrderCartInfo.id);
    const cartsByOrder = new Map<number, typeof carts>();
    for (const cart of carts) {
      const current = cartsByOrder.get(cart.oid) ?? [];
      current.push(cart);
      cartsByOrder.set(cart.oid, current);
    }
    const supplierRows = await this.container.db
      .select({
        supplierName: systemSupplier.supplierName,
        phone: systemSupplier.phone,
        address: systemSupplier.address,
        detailedAddress: systemSupplier.detailedAddress,
      })
      .from(systemSupplier)
      .where(and(eq(systemSupplier.id, supplierId), eq(systemSupplier.isDel, 0)))
      .limit(1);
    const supplier = supplierRows[0];
    if (!supplier) throw new NotFoundException("供应商不存在");
    const orderById = new Map(orders.map((order) => [order.id, order]));
    return {
      supplier: {
        name: pickingText(supplier.supplierName, "供应商", 50),
        phone: pickingText(supplier.phone, "", 15),
        address: [...new Set([supplier.address, supplier.detailedAddress].map((item) => item.trim()).filter(Boolean))]
          .join(" ")
          .slice(0, 510),
      },
      list: ids.map((id) => {
        const order = orderById.get(id)!;
        const orderCarts = cartsByOrder.get(id) ?? [];
        const projectedCarts = orderCarts.map((cart, index) => projectPickingSheetCart(cart, index + 1));
        return {
          id: order.id,
          order_id: order.orderId,
          real_name: order.realName,
          user_phone: order.userPhone,
          user_address: order.userAddress,
          pay_time: order.payTime,
          pay_type: order.payType,
          freight_price: order.payPostage,
          coupon_price: order.couponPrice,
          vip_true_price: projectedCarts
            .reduce((total, cart) => total + cart.vipDiscount, 0)
            .toFixed(2),
          deduction_price: order.deductionPrice,
          use_integral: order.useIntegral,
          pay_price: order.payPrice,
          mark: order.mark,
          supplier_remark: order.remark,
          items: projectedCarts.map((cart) => cart.item),
        };
      }),
    };
  }

  async orderDetail(supplierId: number, orderId: number) {
    const rows = await this.container.db
      .select()
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.id, orderId),
          eq(storeOrder.supplierId, supplierId),
          eq(storeOrder.isSystemDel, 0),
        ),
      )
      .limit(1);
    const order = rows[0];
    if (!order) throw new NotFoundException("订单不存在或不属于当前供应商");
    const cartInfo = await this.container.db
      .select()
      .from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, order.id))
      .orderBy(storeOrderCartInfo.id);
    return {
      id: order.id,
      pid: order.pid,
      order_id: order.orderId,
      real_name: order.realName,
      user_phone: order.userPhone,
      total_num: order.totalNum,
      pay_price: order.payPrice,
      paid: order.paid,
      status: order.status,
      pay_type: order.payType,
      refund_status: order.refundStatus,
      shipping_type: order.shippingType,
      product_type: order.productType,
      delivery_type: order.deliveryType,
      delivery_name: order.deliveryName,
      delivery_code: order.deliveryCode,
      delivery_id: order.deliveryId,
      fictitious_content: order.fictitiousContent,
      remark: order.remark,
      add_time: order.addTime,
      pay_time: order.payTime,
      cart_info: cartInfo,
    };
  }

  async updateOrderRemark(supplierId: number, orderId: number, remark: string) {
    const normalized = remark.trim();
    if (normalized.length > 512) throw new ValidateException("备注不能超过 512 个字符");
    const rows = await this.container.db
      .update(storeOrder)
      .set({ remark: normalized })
      .where(
        and(
          eq(storeOrder.id, orderId),
          eq(storeOrder.supplierId, supplierId),
          eq(storeOrder.isSystemDel, 0),
        ),
      )
      .returning({ id: storeOrder.id });
    if (!rows[0]) throw new NotFoundException("订单不存在或不属于当前供应商");
  }

}
