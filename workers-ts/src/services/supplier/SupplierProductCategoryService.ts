import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { storeProduct, storeProductCategory, storeProductRelation, systemAdmin, systemLog, systemMenus, systemRole, systemSupplier } from "@/models/schema";
import { ApiErrorCode, AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from "@/utils/errors";
import { classifyProductMediaReference } from "../../../../view/common/productMediaReference";
import { SupplierPermissionService } from "./SupplierPermissionService";
import { supplierReadSnapshot } from "./SupplierReadSupport";
import { md5 } from "@/utils/jwt";
import { timingSafeEqual } from "node:crypto";

export const SUPPLIER_CATEGORY_LOCK_NAMESPACE = 731_703;
const MAX_CATEGORIES = 1_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
type Category = typeof storeProductCategory.$inferSelect;
export interface SupplierCategoryActor { id: number; authVersion: string; expiresAt: number; name?: string; ip?: string }
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function identity(value: number, label = "供应商ID") {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new ValidateException(`${label}错误`);
}

export async function lockSupplierCategoryScope(db: DbClient, supplierId: number) {
  identity(supplierId);
  await db.execute(sql`SELECT set_config('lock_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true)`);
  await db.execute(sql`SELECT set_config('statement_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
  await db.execute(sql`SELECT pg_advisory_xact_lock(${SUPPLIER_CATEGORY_LOCK_NAMESPACE}, ${supplierId})`);
}

function owner(supplierId: number) {
  return and(eq(storeProductCategory.type, 2), eq(storeProductCategory.relationId, supplierId));
}

function integer(value: unknown, label: string, fallback = 0, maximum = 2_147_483_647): number {
  if (value === undefined || value === "" || value === null) return fallback;
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value))) throw new ValidateException(`${label}错误`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) throw new ValidateException(`${label}错误`);
  return number;
}

function parentId(value: unknown): number {
  if (!Array.isArray(value)) return integer(value, "父级分类");
  if (value.length < 1 || value.length > 3) throw new ValidateException("父级分类错误");
  const ids = value.map(item => integer(item, "父级分类"));
  if ((ids.includes(0) && ids.length !== 1) || new Set(ids).size !== ids.length) throw new ValidateException("父级分类错误");
  return ids[ids.length - 1];
}

function image(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) throw new ValidateException(`${label}错误`);
  if (value === "") return "";
  const classified = classifyProductMediaReference(value);
  if (classified.kind !== "public") throw new ValidateException(`${label}必须使用HTTPS或安全公共站内路径`);
  return classified.reference;
}

function expectedRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined; // Legacy clients predate confirmation values.
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new ValidateException("分类确认版本错误，请刷新");
  return value;
}

function bounded<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_RESPONSE_BYTES) throw new ServiceUnavailableException("分类目录过大，请联系管理员整理");
  return value;
}

function shanghaiTime(value: number) {
  const time = Object.fromEntries(dateFormatter.formatToParts(new Date(value * 1000)).map(part => [part.type, part.value]));
  return `${time.year}-${time.month}-${time.day} ${time.hour}:${time.minute}:${time.second}`;
}

function dto(row: Category) {
  return { id: row.id, pid: row.pid, type: row.type, relation_id: row.relationId,
    cate_name: row.cateName, path: row.path, level: row.level,
    pic: row.pic, big_pic: row.bigPic, adv_pic: row.advPic, adv_link: row.advLink,
    sort: row.sort, is_show: row.isShow, add_time: shanghaiTime(row.addTime) };
}

async function revision(rows: readonly Category[]) {
  const data = JSON.stringify([...rows].sort((left, right) => left.id - right.id).map(row => [
    row.id, row.pid, row.type, row.relationId, row.cateName, row.path, row.level,
    row.pic, row.bigPic, row.advPic, row.advLink, row.sort, row.isShow, row.addTime,
  ]));
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function graph(rows: readonly Category[]) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const byParent = new Map<number, Category[]>();
  for (const row of rows) {
    if (row.id <= 0 || row.pid < 0 || (row.pid && !byId.has(row.pid))) throw new ServiceUnavailableException("分类父级归属异常，请联系管理员修复");
    const children = byParent.get(row.pid) ?? [];
    children.push(row); byParent.set(row.pid, children);
  }
  const seen = new Set<number>();
  const visit = (parent: number, path: number[]) => {
    for (const row of byParent.get(parent) ?? []) {
      if (path.length > 2 || seen.has(row.id) || row.level !== path.length || row.path !== path.join(",")) {
        throw new ServiceUnavailableException("分类层级或父链异常，请联系管理员修复");
      }
      seen.add(row.id); visit(row.id, [...path, row.id]);
    }
  };
  visit(0, []);
  if (seen.size !== rows.length) throw new ServiceUnavailableException("分类父链存在环，请联系管理员修复");
  return { byId, byParent };
}

async function readRows(db: DbClient, supplierId: number, locked = false) {
  const query = db.select().from(storeProductCategory).where(owner(supplierId))
    .orderBy(locked ? asc(storeProductCategory.id) : desc(storeProductCategory.sort), desc(storeProductCategory.id)).limit(MAX_CATEGORIES + 1);
  const rows = await (locked ? query.for("update") : query);
  if (rows.length > MAX_CATEGORIES) throw new ServiceUnavailableException("分类数量过多，请联系管理员整理");
  if (locked) rows.sort((left, right) => right.sort - left.sort || right.id - left.id);
  graph(rows);
  return rows;
}

/** Caller must hold the Supplier category scope lock before product/SKU locks. */
export async function assertSupplierProductCategoryBindings(db: DbClient, supplierId: number, categoryIds: readonly number[]) {
  const rows = await readRows(db, supplierId), { byId } = graph(rows);
  return categoryIds.map(id => {
    const row = byId.get(id);
    if (!row || row.isShow !== 1 || row.path.split(",").filter(Boolean).some(parent => byId.get(Number(parent))?.isShow !== 1)) {
      throw new ValidateException("商品分类不存在、已停用或不属于当前供应商");
    }
    return row;
  });
}

async function assertActor(db: DbClient, supplierId: number, actor: SupplierCategoryActor | undefined) {
  if (!actor || !Number.isSafeInteger(actor.id) || actor.id <= 0) throw new AuthException("分类操作身份缺失", ApiErrorCode.ERR_AUTH);
  assertSession(actor);
  const [admin] = await db.select().from(systemAdmin).where(and(eq(systemAdmin.id, actor.id),
    eq(systemAdmin.adminType, 4), eq(systemAdmin.relationId, supplierId), eq(systemAdmin.status, 1), eq(systemAdmin.isDel, 0))).limit(1).for("share");
  const [supplier] = await db.select().from(systemSupplier).where(and(eq(systemSupplier.id, supplierId),
    eq(systemSupplier.isShow, 1), eq(systemSupplier.isDel, 0))).limit(1).for("share");
  if (!admin || !supplier) throw new AuthException("供应商分类管理权限已变更", ApiErrorCode.ERR_AUTH);
  if (!timingSafeEqual(new TextEncoder().encode(md5(admin.pwd)), new TextEncoder().encode(actor.authVersion))) {
    throw new AuthException("登录凭据已变化", ApiErrorCode.ERR_EXPIRED);
  }
  // Match the existing Admin permission decision protocol: ordered row SHARE
  // NOWAIT locks, never a new table barrier or enlarged runtime privileges.
  // Missing references cannot supply a current grant; their later insertion
  // cannot revoke a grant already selected and locked here.
  if (supplier.adminId !== admin.id) {
    const roleIds = [...new Set(admin.roles.split(",").map(token => token.trim()).filter(Boolean).map(token => {
      if (!/^[1-9]\d*$/.test(token) || Number(token) > 2_147_483_647) throw new ValidateException("供应商角色身份异常");
      return Number(token);
    }))].sort((left, right) => left - right);
    const roles = roleIds.length ? await db.select().from(systemRole).where(and(inArray(systemRole.id, roleIds),
      eq(systemRole.type, 4), eq(systemRole.relationId, supplierId))).orderBy(asc(systemRole.id)).for("share", { noWait: true }) : [];
    const menuIds = [...new Set(roles.flatMap(role => role.rules.split(",").map(token => token.trim())
      .filter(token => /^[1-9]\d*$/.test(token)).map(Number)))].sort((left, right) => left - right);
    if (menuIds.length > 512 || menuIds.some(id => !Number.isSafeInteger(id) || id > 2_147_483_647)) throw new ValidateException("供应商菜单权限数量异常");
    if (menuIds.length) await db.select({ id: systemMenus.id }).from(systemMenus).where(and(inArray(systemMenus.id, menuIds),
      eq(systemMenus.type, 4), eq(systemMenus.authType, 2), eq(systemMenus.access, 1), eq(systemMenus.isDel, 0)))
      .orderBy(asc(systemMenus.id)).for("share", { noWait: true });
  }
  await new SupplierPermissionService(db).assertAuthorized({ id: admin.id, roles: admin.roles, isPrimary: supplier.adminId === admin.id },
    supplierId, "POST", "/supplierapi/product/category");
  return { id: admin.id, name: admin.realName || admin.account, ip: actor.ip ?? "" };
}

function assertSession(actor: SupplierCategoryActor) {
  if (typeof actor.authVersion !== "string" || !/^[a-f0-9]{32}$/.test(actor.authVersion)
    || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= 0) throw new AuthException("请重新登录", ApiErrorCode.ERR_LOGIN);
  if (actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException("登录已过期", ApiErrorCode.ERR_EXPIRED);
}

async function audit(db: DbClient, supplierId: number, actor: Awaited<ReturnType<typeof assertActor>>, operation: string, id: number) {
  await db.insert(systemLog).values({ adminId: actor.id, adminName: actor.name.slice(0, 64),
    path: `/supplierapi/product/category/${id}`, page: "/products", method: operation === "create" ? "POST" : operation === "delete" ? "DELETE" : "PUT",
    action: `category.${operation};supplier=${supplierId};category=${id}`, ip: actor.ip.slice(0, 45),
    type: "supplier_category", merchantId: supplierId, addTime: Math.floor(Date.now() / 1000) });
}

async function categoryWrite<T>(container: Container, work: (db: DbClient) => Promise<T>): Promise<T> {
  try { return await withTx(container, work); } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
      const code = "code" in current ? String(current.code) : "";
      if (["55P03", "40P01", "40001"].includes(code)) throw new HttpApiException("分类或账号权限正在变更，请刷新后重试", 409, 409);
      if (code === "42501") throw new ServiceUnavailableException("分类管理权限配置尚未就绪");
      if (code === "57014") throw new ServiceUnavailableException("分类管理操作超时，请重试");
      current = "cause" in current ? current.cause : undefined;
    }
    throw error;
  }
}

export class SupplierProductCategoryService {
  constructor(private readonly container: Container) {}

  async modernTree(supplierId: number, includeHidden = true) {
    identity(supplierId);
    return supplierReadSnapshot(this.container, async db => {
      const rows = await readRows(db, supplierId), stamp = await revision(rows), { byParent } = graph(rows);
      const walk = (pid: number): any[] => (byParent.get(pid) ?? []).filter(row => includeHidden || row.isShow === 1)
        .map(row => ({ ...dto(row), add_time: row.addTime, revision: stamp, children: walk(row.id) }));
      return bounded(walk(0));
    });
  }

  async modernDetail(supplierId: number, id: number) {
    identity(supplierId); identity(id, "分类ID");
    return supplierReadSnapshot(this.container, async db => {
      const rows = await readRows(db, supplierId), row = rows.find(item => item.id === id);
      if (!row) throw new NotFoundException("分类不存在或不属于当前供应商");
      return { ...dto(row), add_time: row.addTime, revision: await revision(rows) };
    });
  }

  async legacyList(supplierId: number, query: Record<string, string>) {
    identity(supplierId);
    const pid = integer(query.pid, "父级分类");
    const show = query.is_show === undefined || query.is_show === "" ? undefined : integer(query.is_show, "分类状态", 1, 1);
    const name = query.cate_name?.trim() ?? "";
    if (name.length > 100) throw new ValidateException("分类名称查询过长");
    return supplierReadSnapshot(this.container, async db => {
      const rows = await readRows(db, supplierId), { byParent } = graph(rows);
      const list = rows.filter(row => row.pid === pid && (show === undefined || row.isShow === show) && row.cateName.includes(name))
        .map(row => ({ ...dto(row), ...((byParent.get(row.id) ?? []).some(child => child.isShow === 1)
          ? { children: [], loading: false, _loading: false } : {}) }));
      return bounded({ list, count: list.length });
    });
  }

  async legacyTier(supplierId: number, type: string) {
    identity(supplierId);
    const expanded = integer(type, "分类目录类型", 0, 2) !== 0;
    return supplierReadSnapshot(this.container, async db => {
      const rows = await readRows(db, supplierId), { byParent } = graph(rows), list: ReturnType<typeof dto>[] = [];
      const walk = (pid: number) => { for (const row of byParent.get(pid) ?? []) if (row.isShow === 1) {
        list.push(dto(row)); if (expanded) walk(row.id);
      } };
      walk(0); return bounded(list);
    });
  }

  async cascader(supplierId: number, type?: string) {
    if (type !== undefined) integer(type, "分类目录类型", 0, 2);
    identity(supplierId);
    return supplierReadSnapshot(this.container, async db => {
      const rows = await readRows(db, supplierId), { byParent } = graph(rows);
      const walk = (pid: number): any[] => (byParent.get(pid) ?? []).filter(row => row.isShow === 1).map(row => {
        const children = walk(row.id);
        return { value: row.id, label: row.cateName, pid: row.pid, ...(children.length ? { children } : {}) };
      });
      return bounded(walk(0));
    });
  }

  async form(supplierId: number, id = 0) {
    identity(supplierId); if (id) identity(id, "分类ID");
    return supplierReadSnapshot(this.container, async db => {
      const rows = await readRows(db, supplierId), { byId, byParent } = graph(rows), stamp = await revision(rows);
      const row = id ? byId.get(id) : undefined;
      if (id && !row) throw new NotFoundException("分类不存在或不属于当前供应商");
      const excluded = new Set<number>();
      const exclude = (current: number) => { excluded.add(current); for (const child of byParent.get(current) ?? []) exclude(child.id); };
      if (row) exclude(row.id);
      const options = (pid: number): any[] => (byParent.get(pid) ?? []).filter(item => item.level < 2 && !excluded.has(item.id) && item.isShow === 1)
        .map(item => ({ value: item.id, label: item.cateName, ...(item.level === 0 && options(item.id).length ? { children: options(item.id) } : {}) }));
      const value = row?.pid ? [...row.path.split(",").map(Number)] : [0];
      return bounded({ title: id ? "编辑分类" : "添加分类", action: `/supplierapi/product/category${id ? `/${id}` : ""}`,
        method: id ? "PUT" : "POST", status: true, revision: stamp,
        rules: [
          { type: "cascader", field: "pid", title: "父级", value, props: { data: [{ value: 0, label: "顶级分类" }, ...options(0)], changeOnSelect: true, filterable: true } },
          { type: "input", field: "cate_name", title: "分类名称", value: row?.cateName ?? "", props: { maxlength: 30 }, validate: [{ required: true, message: "请输入分类名称", trigger: "blur" }] },
          { type: "input", field: "pic", title: "移动端图(180*180)", value: row?.pic ?? "" },
          { type: "input", field: "big_pic", title: "PC端大图(468*340)", value: row?.bigPic ?? "" },
          { type: "inputNumber", field: "sort", title: "排序", value: row?.sort ?? 0, props: { min: 0, max: 1_000_000 } },
          { type: "radio", field: "is_show", title: "状态", value: row?.isShow ?? 1, options: [{ label: "显示", value: 1 }, { label: "隐藏", value: 0 }] },
          ...(id ? [{ type: "hidden", field: "expected_revision", value: stamp }] : []),
        ] });
    });
  }

  async save(supplierId: number, id: number, input: Record<string, unknown>, actor?: SupplierCategoryActor) {
    identity(supplierId); if (id) identity(id, "分类ID");
    const name = typeof (input.cate_name ?? input.cateName) === "string" ? String(input.cate_name ?? input.cateName).trim() : "";
    if (!name || name.length > 30 || /[\u0000-\u001f\u007f]/u.test(name)) throw new ValidateException("分类名称须为1至30个字符");
    const pid = parentId(input.pid), pic = image(input.pic, "移动端分类图", 512), bigPic = image(input.big_pic, "PC分类图", 255);
    const sort = integer(input.sort, "分类排序", 0, 1_000_000), isShow = integer(input.is_show ?? input.isShow, "分类状态", 0, 1);
    const expected = expectedRevision(input.expected_revision);
    return categoryWrite(this.container, async db => {
      await lockSupplierCategoryScope(db, supplierId);
      const currentActor = await assertActor(db, supplierId, actor), rows = await readRows(db, supplierId, true), { byId, byParent } = graph(rows);
      const current = id ? byId.get(id) : undefined;
      if (id && !current) throw new NotFoundException("分类不存在或不属于当前供应商");
      if (expected !== undefined && expected !== await revision(rows)) throw new HttpApiException("分类已变更，请刷新后重试", 409, 409);
      if (!id && rows.length >= MAX_CATEGORIES) throw new ServiceUnavailableException("分类数量过多，请联系管理员整理");
      const parent = pid ? byId.get(pid) : undefined;
      if (pid && !parent) throw new ValidateException("父级分类不存在或不属于当前供应商");
      if (current && (pid === id || parent?.path.split(",").includes(String(id)))) throw new ValidateException("不能将分类移动到自身或子分类下");
      if (parent && parent.isShow !== 1 && isShow === 1) throw new ValidateException("父级分类已停用，不能启用下级分类");
      if (rows.some(row => row.id !== id && row.pid === pid && row.cateName === name)) throw new ValidateException("同一父级下分类名称已存在");
      const level = parent ? parent.level + 1 : 0, path = parent ? [parent.path, String(parent.id)].filter(Boolean).join(",") : "";
      if (level > 2) throw new ValidateException("商品分类最多三级");
      const affected: Array<{ id: number; pid: number; level: number; path: string }> = [];
      const descend = (parentId: number, parentPath: string, parentLevel: number) => {
        for (const child of byParent.get(parentId) ?? []) {
          const childLevel = parentLevel + 1, childPath = [parentPath, String(parentId)].filter(Boolean).join(",");
          if (childLevel > 2) throw new ValidateException("移动后分类层级将超过三级");
          affected.push({ id: child.id, pid: child.pid, level: childLevel, path: childPath });
          descend(child.id, childPath, childLevel);
        }
      };
      if (current) descend(id, path, level);
      const values = { pid, cateName: name, pic: pic ?? current?.pic ?? "", bigPic: bigPic ?? current?.bigPic ?? "", sort, isShow, level, path };
      let savedId = id;
      if (current) await db.update(storeProductCategory).set(values).where(and(owner(supplierId), eq(storeProductCategory.id, id)));
      else savedId = (await db.insert(storeProductCategory).values({ ...values, type: 2, relationId: supplierId, addTime: Math.floor(Date.now() / 1000) }).returning({ id: storeProductCategory.id }))[0].id;
      for (const child of affected) await db.update(storeProductCategory).set({ path: child.path, level: child.level,
        ...(current && current.isShow !== isShow ? { isShow } : {}) }).where(and(owner(supplierId), eq(storeProductCategory.id, child.id)));
      if (current && (current.pid !== pid || current.path !== path)) {
        for (const category of [{ id, pid }, ...affected]) await db.update(storeProductRelation).set({ relationPid: category.pid })
          .where(and(eq(storeProductRelation.type, 1), eq(storeProductRelation.relationId, category.id),
            inArray(storeProductRelation.productId, db.select({ id: storeProduct.id }).from(storeProduct).where(and(eq(storeProduct.type, 2), eq(storeProduct.relationId, supplierId))))));
      }
      await audit(db, supplierId, currentActor, current ? "update" : "create", savedId);
      const fresh = await readRows(db, supplierId);
      const stamp = await revision(fresh); assertSession(actor!);
      return { id: savedId, revision: stamp };
    });
  }

  async delete(supplierId: number, id: number, expectedValue: unknown, actor?: SupplierCategoryActor) {
    identity(supplierId); identity(id, "分类ID"); const expected = expectedRevision(expectedValue);
    return categoryWrite(this.container, async db => {
      await lockSupplierCategoryScope(db, supplierId);
      const currentActor = await assertActor(db, supplierId, actor), rows = await readRows(db, supplierId, true), { byId, byParent } = graph(rows);
      if (!byId.has(id)) throw new NotFoundException("分类不存在或不属于当前供应商");
      if (expected !== undefined && expected !== await revision(rows)) throw new HttpApiException("分类已变更，请刷新后重试", 409, 409);
      if (byParent.get(id)?.length) throw new ValidateException("请先删除下级分类");
      const [used] = await db.select({ id: storeProduct.id }).from(storeProduct).where(and(
        eq(storeProduct.type, 2), eq(storeProduct.relationId, supplierId), eq(storeProduct.isDel, 0),
        or(sql`${String(id)} = ANY(string_to_array(${storeProduct.cateId}, ','))`,
          inArray(storeProduct.id, db.select({ id: storeProductRelation.productId }).from(storeProductRelation)
            .where(and(eq(storeProductRelation.type, 1), eq(storeProductRelation.relationId, id))))),
      )).limit(1);
      if (used) throw new ValidateException("分类下仍有商品，不能删除");
      await db.delete(storeProductCategory).where(and(owner(supplierId), eq(storeProductCategory.id, id)));
      await audit(db, supplierId, currentActor, "delete", id);
      const stamp = await revision(rows.filter(row => row.id !== id)); assertSession(actor!);
      return { revision: stamp };
    });
  }

  async setShow(supplierId: number, id: number, isShow: number, expectedValue: unknown, actor?: SupplierCategoryActor) {
    identity(supplierId); identity(id, "分类ID");
    if (isShow !== 0 && isShow !== 1) throw new ValidateException("分类状态错误");
    const expected = expectedRevision(expectedValue);
    return categoryWrite(this.container, async db => {
      await lockSupplierCategoryScope(db, supplierId);
      const currentActor = await assertActor(db, supplierId, actor), rows = await readRows(db, supplierId, true), { byId, byParent } = graph(rows), current = byId.get(id);
      if (!current) throw new NotFoundException("分类不存在或不属于当前供应商");
      if (expected !== undefined && expected !== await revision(rows)) throw new HttpApiException("分类已变更，请刷新后重试", 409, 409);
      if (isShow === 1 && current.pid && byId.get(current.pid)?.isShow !== 1) throw new ValidateException("父级分类已停用，不能启用下级分类");
      const ids: number[] = [];
      const visit = (parent: number) => { ids.push(parent); for (const child of byParent.get(parent) ?? []) visit(child.id); };
      visit(id);
      await db.update(storeProductCategory).set({ isShow }).where(and(owner(supplierId), inArray(storeProductCategory.id, ids)));
      await audit(db, supplierId, currentActor, "status", id);
      const stamp = await revision(rows.map(row => ids.includes(row.id) ? { ...row, isShow } : row)); assertSession(actor!);
      return { updated: ids.length, revision: stamp };
    });
  }
}
