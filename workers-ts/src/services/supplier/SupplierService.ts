import bcrypt from "bcryptjs";
import { and, desc, eq, ilike, ne, or, sql, type SQL } from "drizzle-orm";
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

const SUPPLIER_ADMIN_TYPE = 4;
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface PageInput {
  page: number;
  limit: number;
  offset: number;
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

    const supplier = await this.container.systemSupplierDao.findActiveByRelation(
      admin.relationId,
      admin.id,
    );
    if (!supplier) throw new ValidateException("供应商已停用或绑定关系无效");

    const valid = await bcrypt.compare(password, normalizeBcryptHash(admin.pwd));
    if (!valid) throw new ValidateException("账号或密码错误");

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
      },
      unique_auth: [
        "supplier:dashboard",
        "supplier:product",
        "supplier:order",
        "supplier:refund",
        "supplier:finance",
        "supplier:profile",
      ],
      menus: this.menus(),
      logo: "",
      logo_square: "",
      version: "CinaShop Supplier TS",
    };
  }

  async profile(supplierId: number) {
    const supplier = await this.container.systemSupplierDao.getOrThrow(supplierId, "供应商不存在");
    const admin = await this.container.systemAdminDao.getOrThrow(supplier.adminId, "管理员不存在");
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
            eq(systemSupplier.adminId, adminId),
            eq(systemSupplier.isDel, 0),
          ),
        )
        .limit(1);
      const supplier = supplierRows[0];
      if (!supplier) throw new NotFoundException("供应商不存在");

      const adminRows = await tx
        .select()
        .from(systemAdmin)
        .where(
          and(
            eq(systemAdmin.id, adminId),
            eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
            eq(systemAdmin.isDel, 0),
          ),
        )
        .limit(1);
      const admin = adminRows[0];
      if (!admin) throw new NotFoundException("管理员不存在");

      if (input.account && input.account !== admin.account) {
        const duplicate = await tx
          .select({ id: systemAdmin.id })
          .from(systemAdmin)
          .where(
            and(
              eq(systemAdmin.account, input.account),
              eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
              ne(systemAdmin.id, adminId),
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

      const adminUpdate: Partial<typeof systemAdmin.$inferInsert> = {};
      if (input.account !== undefined) adminUpdate.account = input.account;
      if (input.name !== undefined) adminUpdate.realName = input.name;
      if (input.phone !== undefined) adminUpdate.phone = input.phone;
      if (Object.keys(adminUpdate).length > 0) {
        await tx.update(systemAdmin).set(adminUpdate).where(eq(systemAdmin.id, adminId));
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

  private menus() {
    return [
      { path: "/dashboard", name: "经营概览", icon: "DataAnalysis" },
      { path: "/products", name: "商品管理", icon: "Goods" },
      { path: "/orders", name: "订单管理", icon: "List" },
      { path: "/refunds", name: "售后管理", icon: "RefreshLeft" },
      { path: "/finance", name: "财务结算", icon: "Wallet" },
      { path: "/profile", name: "供应商资料", icon: "Setting" },
    ];
  }
}
