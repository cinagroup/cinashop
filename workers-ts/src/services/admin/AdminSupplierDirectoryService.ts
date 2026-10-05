import { hash } from "bcryptjs";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import { storeOrder, storeProduct, systemAdmin, systemLog, systemSupplier } from "@/models/schema";
import { HttpApiException, NotFoundException, ValidateException } from "@/utils/errors";

const MAX_ID = 2_147_483_647;
// SupplierApplicationService.review uses this same lock when allocating a
// supplier account. Manual creation must serialize with that path.
const APPLICATION_ACCOUNT_LOCK_NAMESPACE = 505_607;
const ACCOUNT_LOCK_KEY = 0;
const PENDING_ORDER_STATUSES = [0, 1, 4, 5];

export interface SupplierDirectoryActor {
  id: number;
  name: string;
  ip: string;
}

type SupplierRow = typeof systemSupplier.$inferSelect;
type SupplierAdminRow = typeof systemAdmin.$inferSelect;
type VersionedSupplierRow = SupplierRow & { rowVersion: string };
const supplierProjection = {
  ...getTableColumns(systemSupplier),
  rowVersion: sql<string>`${systemSupplier}.xmin::text`,
};

interface DirectoryForm {
  supplierName: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  province: number;
  city: number;
  area: number;
  street: number;
  detailedAddress: string;
  mark: string;
  account: string;
  password: string;
  sort: number;
  isShow: number;
}

function positiveId(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") throw new ValidateException("供应商ID无效");
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) throw new ValidateException("供应商ID无效");
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id > MAX_ID) throw new ValidateException("供应商ID无效");
  return id;
}

function boundedText(value: unknown, label: string, maximum: number, required = false): string {
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const text = value.trim();
  if ((required && !text) || [...text].length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ValidateException(`${label}无效或超过${maximum}字`);
  }
  return text;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" && typeof value !== "string") throw new ValidateException(`${label}无效`);
  const text = String(value);
  if (!/^(?:0|[1-9]\d*)$/.test(text)) throw new ValidateException(`${label}无效`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function directoryForm(input: Record<string, unknown>, creating: boolean): DirectoryForm {
  const supplierName = boundedText(input.supplier_name, "供应商名称", 25, true);
  const name = boundedText(input.name ?? "", "联系人姓名", 25);
  const phone = boundedText(input.phone, "联系电话", 15, true);
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new ValidateException("联系电话格式错误");
  const email = boundedText(input.email ?? "", "供应商邮箱", 50);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidateException("供应商邮箱格式错误");
  const account = boundedText(input.account, "登录用户名", 32, true);
  const password = input.pwd === undefined ? "" : boundedText(input.pwd, "登录密码", 72);
  if (creating && !password) throw new ValidateException("请输入登录密码");
  if (password && [...password].length < 12) throw new ValidateException("登录密码至少需要12位");
  if (password && new TextEncoder().encode(password).byteLength > 72) {
    throw new ValidateException("登录密码 UTF-8 长度不能超过72字节");
  }
  if (password && password !== input.conf_pwd) throw new ValidateException("两次输入的密码不一致");
  if (!password && input.conf_pwd !== undefined && input.conf_pwd !== "") {
    throw new ValidateException("请填写登录密码");
  }
  return {
    supplierName,
    name,
    phone,
    email,
    address: boundedText(input.address ?? "", "省市区地址", 255),
    province: integer(input.province, "省份", 1, MAX_ID),
    city: integer(input.city, "城市", 1, MAX_ID),
    area: integer(input.area, "区县", 1, MAX_ID),
    street: integer(input.street ?? 0, "街道", 0, MAX_ID),
    detailedAddress: boundedText(input.detailed_address ?? "", "详细地址", 255),
    mark: boundedText(input.mark ?? "", "备注", 255),
    account,
    password,
    sort: integer(input.sort ?? 0, "排序", 0, 999_999),
    isShow: integer(input.is_show, "供应商状态", 0, 1),
  };
}

function expectedRevision(input: Record<string, unknown>): string {
  const revision = input.expected_revision;
  if (typeof revision !== "string" || !/^[0-9a-f]{64}$/.test(revision)) {
    throw new ValidateException("请重新读取供应商资料后操作");
  }
  return revision;
}

function actorId(actor: SupplierDirectoryActor): number {
  return positiveId(actor.id);
}

async function revision(row: VersionedSupplierRow): Promise<string> {
  const fields = [row.id, row.adminId, row.supplierName, row.name, row.phone,
    row.email, row.address, row.province, row.city, row.area, row.street,
    row.detailedAddress, row.sort, row.isShow, row.mark, row.isDel, row.addTime,
    row.rowVersion];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(fields)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formattedTime(epoch: number): string {
  return new Date((epoch + 8 * 3600) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function directoryRow(row: SupplierRow, version: string) {
  return {
    id: row.id,
    supplier_name: row.supplierName,
    name: row.name,
    phone: row.phone,
    address: row.address,
    is_show: row.isShow,
    add_time: row.addTime,
    _add_time: formattedTime(row.addTime),
    mark: row.mark,
    sort: row.sort,
    revision: version,
  };
}

function detailRow(row: SupplierRow, admin: SupplierAdminRow, version: string) {
  return {
    ...directoryRow(row, version),
    email: row.email,
    province: row.province,
    city: row.city,
    area: row.area,
    street: row.street,
    detailed_address: row.detailedAddress,
    account: admin.account,
    pwd: "",
    conf_pwd: "",
  };
}

function conflict(): never {
  throw new HttpApiException("供应商资料已被修改，请刷新后重试", 409, 409);
}

async function accountTaken(tx: DbClient, account: string, excludingId = 0): Promise<boolean> {
  const rows = await tx.select({ id: systemAdmin.id }).from(systemAdmin).where(and(
    sql`lower(${systemAdmin.account}) = lower(${account})`,
    excludingId ? sql`${systemAdmin.id} <> ${excludingId}` : sql`true`,
  )).limit(1);
  return Boolean(rows[0]);
}

async function audit(tx: DbClient, actor: SupplierDirectoryActor, action: string, supplierId: number,
  method: string): Promise<void> {
  await tx.insert(systemLog).values({
    adminId: actorId(actor),
    adminName: actor.name.slice(0, 64),
    path: `/supplier/supplier/${supplierId}`,
    page: "supplier_directory",
    method,
    action: `supplier_directory.${action}:${supplierId}`,
    ip: actor.ip.slice(0, 45),
    type: "supplier_directory",
    addTime: Math.floor(Date.now() / 1000),
  });
}

export class AdminSupplierDirectoryService {
  constructor(private readonly container: Container) {}

  async list(params: URLSearchParams) {
    for (const key of params.keys()) {
      if (!["keywords", "page", "limit"].includes(key) || params.getAll(key).length !== 1) {
        throw new ValidateException("供应商目录查询参数未知或重复");
      }
    }
    const keywords = boundedText(params.get("keywords") ?? "", "搜索词", 80);
    const page = integer(params.get("page") ?? 1, "页码", 1, 100_000);
    const limit = integer(params.get("limit") ?? 15, "每页条数", 1, 100);
    const where = and(eq(systemSupplier.isDel, 0),
      keywords ? sql`position(lower(${keywords}) in lower(${systemSupplier.supplierName})) > 0` : sql`true`);
    const [rows, totals] = await Promise.all([
      this.container.db.select(supplierProjection).from(systemSupplier).where(where).orderBy(desc(systemSupplier.id))
        .limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`count(*)::int` }).from(systemSupplier).where(where),
    ]);
    return { list: await Promise.all(rows.map(async (row) => directoryRow(row, await revision(row)))),
      count: Number(totals[0]?.count ?? 0), page, limit };
  }

  async detail(idValue: unknown) {
    const id = positiveId(idValue);
    const rows = await this.container.db.select(supplierProjection).from(systemSupplier).where(and(
      eq(systemSupplier.id, id), eq(systemSupplier.isDel, 0),
    )).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("供应商不存在");
    const admins = await this.container.db.select().from(systemAdmin).where(and(
      eq(systemAdmin.id, row.adminId), eq(systemAdmin.adminType, 4),
      eq(systemAdmin.relationId, id), eq(systemAdmin.isDel, 0),
    )).limit(1);
    if (!admins[0]) throw new NotFoundException("供应商主管理员不存在");
    return detailRow(row, admins[0], await revision(row));
  }

  async create(input: Record<string, unknown>, actor: SupplierDirectoryActor) {
    actorId(actor);
    const form = directoryForm(input, true);
    const passwordHash = await hash(form.password, 12);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${APPLICATION_ACCOUNT_LOCK_NAMESPACE}, ${ACCOUNT_LOCK_KEY})`);
      if (await accountTaken(tx, form.account)) throw new ValidateException("管理员账号已存在");
      const now = Math.floor(Date.now() / 1000);
      const suppliers = await tx.insert(systemSupplier).values({
        supplierName: form.supplierName, name: form.name, phone: form.phone,
        email: form.email, address: form.address, province: form.province,
        city: form.city, area: form.area, street: form.street,
        detailedAddress: form.detailedAddress, mark: form.mark, sort: form.sort,
        isShow: form.isShow, addTime: now,
      }).returning({ id: systemSupplier.id });
      const id = suppliers[0].id;
      const admins = await tx.insert(systemAdmin).values({
        account: form.account, adminType: 4, relationId: id, pwd: passwordHash,
        realName: [...form.name].slice(0, 16).join(""), phone: form.phone,
        roles: "", level: 0, status: 1, isDel: 0, addTime: now,
      }).returning({ id: systemAdmin.id });
      await tx.update(systemSupplier).set({ adminId: admins[0].id }).where(eq(systemSupplier.id, id));
      await audit(tx, actor, "create", id, "POST");
      return { id, admin_id: admins[0].id };
    });
  }

  async update(idValue: unknown, input: Record<string, unknown>, actor: SupplierDirectoryActor) {
    const id = positiveId(idValue);
    actorId(actor);
    const expected = expectedRevision(input);
    const form = directoryForm(input, false);
    const passwordHash = form.password ? await hash(form.password, 12) : null;
    return withTx(this.container, async (tx) => {
      const suppliers = await tx.select(supplierProjection).from(systemSupplier).where(and(
        eq(systemSupplier.id, id), eq(systemSupplier.isDel, 0),
      )).for("update").limit(1);
      const supplier = suppliers[0];
      if (!supplier) throw new NotFoundException("供应商不存在");
      if (await revision(supplier) !== expected) conflict();
      const admins = await tx.select().from(systemAdmin).where(and(
        eq(systemAdmin.id, supplier.adminId), eq(systemAdmin.adminType, 4),
        eq(systemAdmin.relationId, id), eq(systemAdmin.isDel, 0),
      )).for("update").limit(1);
      const admin = admins[0];
      if (!admin) throw new NotFoundException("供应商主管理员不存在");
      const expectedAccount = boundedText(input.expected_account, "原登录用户名", 32, true);
      if (admin.account !== expectedAccount) conflict();
      if (form.account !== admin.account) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${APPLICATION_ACCOUNT_LOCK_NAMESPACE}, ${ACCOUNT_LOCK_KEY})`);
        if (await accountTaken(tx, form.account, admin.id)) throw new ValidateException("管理员账号已存在");
      }
      await tx.update(systemAdmin).set({
        account: form.account,
        realName: [...form.name].slice(0, 16).join(""),
        phone: form.phone,
        ...(passwordHash ? { pwd: passwordHash } : {}),
      }).where(eq(systemAdmin.id, admin.id));
      const updated = await tx.update(systemSupplier).set({
        supplierName: form.supplierName, name: form.name, phone: form.phone,
        email: form.email, address: form.address, province: form.province,
        city: form.city, area: form.area, street: form.street,
        detailedAddress: form.detailedAddress, mark: form.mark, sort: form.sort,
        isShow: form.isShow,
      }).where(eq(systemSupplier.id, id)).returning(supplierProjection);
      await audit(tx, actor, "update", id, "PUT");
      return detailRow(updated[0], { ...admin, account: form.account }, await revision(updated[0]));
    });
  }

  async setStatus(idValue: unknown, statusValue: unknown, input: Record<string, unknown>,
    actor: SupplierDirectoryActor) {
    const id = positiveId(idValue);
    const status = integer(statusValue, "供应商状态", 0, 1);
    actorId(actor);
    const expected = expectedRevision(input);
    return withTx(this.container, async (tx) => {
      const rows = await tx.select(supplierProjection).from(systemSupplier).where(and(
        eq(systemSupplier.id, id), eq(systemSupplier.isDel, 0),
      )).for("update").limit(1);
      const current = rows[0];
      if (!current) throw new NotFoundException("供应商不存在");
      if (await revision(current) !== expected) conflict();
      const updated = await tx.update(systemSupplier).set({ isShow: status })
        .where(eq(systemSupplier.id, id)).returning(supplierProjection);
      await audit(tx, actor, "status", id, "PUT");
      return { id, is_show: status, revision: await revision(updated[0]) };
    });
  }

  async delete(idValue: unknown, input: Record<string, unknown>, actor: SupplierDirectoryActor) {
    const id = positiveId(idValue);
    actorId(actor);
    const expected = expectedRevision(input);
    return withTx(this.container, async (tx) => {
      const rows = await tx.select(supplierProjection).from(systemSupplier).where(and(
        eq(systemSupplier.id, id), eq(systemSupplier.isDel, 0),
      )).for("update").limit(1);
      const supplier = rows[0];
      if (!supplier) throw new NotFoundException("供应商不存在");
      if (await revision(supplier) !== expected) conflict();
      const pending = await tx.select({ id: storeOrder.id }).from(storeOrder).where(and(
        eq(storeOrder.supplierId, id), inArray(storeOrder.status, PENDING_ORDER_STATUSES),
      )).limit(1);
      if (pending[0]) throw new ValidateException("该供应商还有待处理订单，不能删除");
      // Keep order and settlement evidence. Retiring the supplier must also
      // stop its products being offered and every related account being used.
      await tx.update(storeProduct).set({ isShow: 0, isDel: 1 }).where(and(
        eq(storeProduct.type, 2), eq(storeProduct.relationId, id), eq(storeProduct.isDel, 0),
      ));
      await tx.update(systemAdmin).set({ status: 0, isDel: 1 }).where(and(
        eq(systemAdmin.adminType, 4), eq(systemAdmin.relationId, id), eq(systemAdmin.isDel, 0),
      ));
      await tx.update(systemSupplier).set({ isShow: 0, isDel: 1 }).where(eq(systemSupplier.id, id));
      await audit(tx, actor, "delete", id, "DELETE");
      return { id, is_del: 1 };
    });
  }
}
