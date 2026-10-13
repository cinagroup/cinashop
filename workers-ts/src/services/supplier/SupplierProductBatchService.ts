import { and, asc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductCategory, storeProductRelation, systemAdmin, systemLog, systemMenus, systemRole, systemSupplier } from '@/models/schema';
import { ApiErrorCode, AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { lockSupplierCategoryScope, assertSupplierProductCategoryBindings } from './SupplierProductCategoryService';
import { SupplierPermissionService } from './SupplierPermissionService';
import { supplierReadIdentity } from './SupplierReadSupport';
import { PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE } from '@/services/product/ProductSkuIdentity';
import { boundBargainSourceProductChange, lockBargainSourceProductChange } from '@/services/activity/BargainSourceProductLifecycle';
import { lockShippingTemplateBindings } from '@/services/product/ShippingTemplateLifecycleService';
import { loadActiveOrderSystemForm } from '@/services/order/OrderSystemFormService';
import { MAX_SUPPLIER_BATCH_PRODUCTS, parseSupplierBatchSelection, parseSupplierProductBatchInput,
  type SupplierProductBatchFilter, type SupplierProductBatchSelection } from './SupplierProductBatchInput';

export interface SupplierProductBatchActor { id: number; authVersion: string; expiresAt: number; ip?: string }
const fields = { id: storeProduct.id, type: storeProduct.type, relation_id: storeProduct.relationId,
  product_type: storeProduct.productType, store_name: storeProduct.storeName, is_del: storeProduct.isDel,
  is_show: storeProduct.isShow, is_verify: storeProduct.isVerify, cate_id: storeProduct.cateId,
  delivery_type: storeProduct.deliveryType, system_form_id: storeProduct.systemFormId,
  freight: storeProduct.freight, postage: storeProduct.postage, temp_id: storeProduct.tempId };
type Product = { [K in keyof typeof fields]: K extends 'store_name' | 'cate_id' | 'delivery_type' | 'postage' ? string : number };
const own = (supplierId: number) => and(eq(storeProduct.type, 2), eq(storeProduct.relationId, supplierId));
async function hash(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(part => part.toString(16).padStart(2, '0')).join('');
}
function session(actor: SupplierProductBatchActor) {
  if (typeof actor.authVersion !== 'string' || !/^[a-f0-9]{32}$/.test(actor.authVersion)
    || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= 0) throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  if (actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
}
async function authority(db: DbClient, supplierId: number, actor: SupplierProductBatchActor, write = true) {
  if (!actor || !Number.isSafeInteger(actor.id) || actor.id <= 0) throw new AuthException('批处理操作身份缺失', ApiErrorCode.ERR_AUTH);
  session(actor);
  const adminQuery = db.select().from(systemAdmin).where(and(eq(systemAdmin.id, actor.id), eq(systemAdmin.adminType, 4),
    eq(systemAdmin.relationId, supplierId), eq(systemAdmin.status, 1), eq(systemAdmin.isDel, 0))).limit(1);
  const [admin] = await (write ? adminQuery.for('share') : adminQuery);
  const supplierQuery = db.select().from(systemSupplier).where(and(eq(systemSupplier.id, supplierId), eq(systemSupplier.isShow, 1), eq(systemSupplier.isDel, 0))).limit(1);
  const [supplier] = await (write ? supplierQuery.for('share') : supplierQuery);
  if (!admin || !supplier) throw new AuthException('供应商管理权限已变更', ApiErrorCode.ERR_AUTH);
  if (!timingSafeEqual(new TextEncoder().encode(md5(admin.pwd)), new TextEncoder().encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
  if (supplier.adminId !== admin.id) {
    const roleIds = [...new Set(admin.roles.split(',').map(token => token.trim()).filter(Boolean).map(token => {
      if (!/^[1-9]\d*$/.test(token) || Number(token) > 2_147_483_647) throw new ValidateException('供应商角色身份异常');
      return Number(token);
    }))].sort((a, b) => a - b);
    if (roleIds.length > 512) throw new ValidateException('供应商角色数量异常');
    const roleQuery = db.select().from(systemRole).where(and(inArray(systemRole.id, roleIds.length ? roleIds : [0]), eq(systemRole.type, 4), eq(systemRole.relationId, supplierId))).orderBy(asc(systemRole.id));
    const roles = roleIds.length ? await (write ? roleQuery.for('share', { noWait: true }) : roleQuery) : [];
    const menuIds = [...new Set(roles.flatMap(role => role.rules.split(',').map(token => token.trim()).filter(token => /^[1-9]\d*$/.test(token)).map(Number)))].sort((a, b) => a - b);
    if (menuIds.length > 512 || menuIds.some(id => !Number.isSafeInteger(id) || id > 2_147_483_647)) throw new ValidateException('供应商菜单权限数量异常');
    if (menuIds.length) {
      const menuQuery = db.select({ id: systemMenus.id }).from(systemMenus).where(and(inArray(systemMenus.id, menuIds), eq(systemMenus.type, 4),
        eq(systemMenus.authType, 2), eq(systemMenus.access, 1), eq(systemMenus.isDel, 0))).orderBy(asc(systemMenus.id));
      await (write ? menuQuery.for('share', { noWait: true }) : menuQuery);
    }
  }
  await new SupplierPermissionService(db).assertAuthorized({ id: admin.id, roles: admin.roles, isPrimary: supplier.adminId === admin.id }, supplierId,
    write ? 'POST' : 'GET', write ? '/supplierapi/product/batch_process' : '/supplierapi/product/product/batch-selection');
  return { id: admin.id, name: (admin.realName || admin.account).slice(0, 64), ip: (actor.ip ?? '').slice(0, 45) };
}
function statusFilter(value: number): SQL {
  switch (value) {
    case -2: case -1: return eq(storeProduct.isVerify, value);
    case 0: return and(eq(storeProduct.isVerify, 0), eq(storeProduct.isDel, 0))!;
    case 1: case 2: return and(eq(storeProduct.isShow, value === 1 ? 1 : 0), eq(storeProduct.isVerify, 1), eq(storeProduct.isDel, 0))!;
    case 3: return and(eq(storeProduct.isVerify, 1), eq(storeProduct.isDel, 0))!;
    case 4: return and(eq(storeProduct.isVerify, 1), eq(storeProduct.isDel, 0), or(eq(storeProduct.isSold, 1), eq(storeProduct.stock, 0)))!;
    case 5: return and(eq(storeProduct.isShow, 1), eq(storeProduct.isVerify, 1), eq(storeProduct.isDel, 0), eq(storeProduct.isPolices, 1), sql`${storeProduct.stock} > 0`)!;
    case 6: return eq(storeProduct.isDel, 1);
    default: return or(eq(storeProduct.isDel, 1), eq(storeProduct.isShow, 0))!;
  }
}
async function predicates(db: DbClient, supplierId: number, selection: SupplierProductBatchSelection) {
  const conditions: SQL[] = [own(supplierId)!];
  if (!selection.all) { conditions.push(inArray(storeProduct.id, selection.ids)); return and(...conditions); }
  const filter: SupplierProductBatchFilter = selection.where;
  if (filter.status !== undefined) conditions.push(statusFilter(filter.status));
  else conditions.push(eq(storeProduct.isDel, 0));
  if (filter.store_name) {
    const pattern = `%${filter.store_name}%`;
    conditions.push(or(ilike(storeProduct.storeName, pattern), ilike(storeProduct.keyword, pattern), ilike(storeProduct.storeInfo, pattern),
      ilike(storeProduct.barCode, pattern), ilike(sql`${storeProduct.id}::text`, pattern), sql`EXISTS(SELECT 1 FROM ${storeProductAttrValue}
      WHERE ${storeProductAttrValue.productId}=${storeProduct.id} AND ${storeProductAttrValue.type}=0 AND ${storeProductAttrValue.barCode}=${filter.store_name})`)!);
  }
  if (filter.cate_id?.length) {
    // PHP expands the selected category by one direct child level. Fix its
    // unscoped lookup while preserving the filter rather than broadening it.
    const children = await db.select({ id: storeProductCategory.id }).from(storeProductCategory).where(and(eq(storeProductCategory.type, 2),
      eq(storeProductCategory.relationId, supplierId), inArray(storeProductCategory.pid, filter.cate_id))).limit(1001);
    if (children.length > 1000) throw new ServiceUnavailableException('分类筛选范围过大');
    const ids = [...new Set([...filter.cate_id, ...children.map(row => row.id)])];
    conditions.push(sql`EXISTS(SELECT 1 FROM ${storeProductRelation} WHERE ${storeProductRelation.productId}=${storeProduct.id}
      AND ${storeProductRelation.type}=1 AND ${inArray(storeProductRelation.relationId, ids)})`);
  }
  for (const [key, relationType] of [['brand_id', 2], ['store_label_id', 3]] as const) if (filter[key]?.length) conditions.push(sql`EXISTS(
    SELECT 1 FROM ${storeProductRelation} WHERE ${storeProductRelation.productId}=${storeProduct.id}
      AND ${storeProductRelation.type}=${relationType} AND ${inArray(storeProductRelation.relationId, filter[key]!)})`);
  // BaseDao.withSearchSelect applies searchBrandIdAttr even when search=false;
  // StoreProductDao.search adds the relation condition as well. Keep both.
  if (filter.brand_id?.length) conditions.push(inArray(storeProduct.brandId, filter.brand_id));
  if (filter.is_show !== undefined) conditions.push(eq(storeProduct.isShow, filter.is_show));
  if (filter.is_verify !== undefined) conditions.push(eq(storeProduct.isVerify, filter.is_verify));
  if (filter.pid !== undefined) conditions.push(filter.pid === -1 ? sql`${storeProduct.pid} > 0` : eq(storeProduct.pid, filter.pid));
  if (filter.time) conditions.push(gte(storeProduct.addTime, filter.time[0]), lte(storeProduct.addTime, filter.time[1]));
  return and(...conditions);
}
async function readProducts(db: DbClient, supplierId: number, selection: SupplierProductBatchSelection, locked = false) {
  const query = db.select(fields).from(storeProduct).where(await predicates(db, supplierId, selection))
    .orderBy(asc(storeProduct.id)).limit(MAX_SUPPLIER_BATCH_PRODUCTS + 1);
  const products = await (locked ? query.for('update', { noWait: true }) : query);
  if (products.length > MAX_SUPPLIER_BATCH_PRODUCTS) throw new ServiceUnavailableException(`批处理最多${MAX_SUPPLIER_BATCH_PRODUCTS}个商品，请缩小筛选范围`);
  if (!selection.all && products.length !== selection.ids.length) throw new NotFoundException('商品不存在或不属于当前供应商');
  if (!products.length) throw new ValidateException('筛选范围内没有商品');
  if (products.some(row => row.is_del !== 0)) throw new ValidateException('回收站商品不能批处理');
  // Match actual Supplier saveProduct admission, including manual virtual=3.
  if (products.some(row => ![0, 1, 3].includes(row.product_type))) throw new ValidateException('当前迁移阶段不支持此商品履约类型批处理');
  return products;
}
async function facts(db: DbClient, products: Product[]) {
  const relations = await db.select({ product_id: storeProductRelation.productId, relation_id: storeProductRelation.relationId,
    relation_pid: storeProductRelation.relationPid, status: storeProductRelation.status }).from(storeProductRelation)
    .where(and(inArray(storeProductRelation.productId, products.map(row => row.id)), eq(storeProductRelation.type, 1)))
    .orderBy(asc(storeProductRelation.productId), asc(storeProductRelation.relationId), asc(storeProductRelation.id)).limit(2001);
  if (relations.length > 2000) throw new ServiceUnavailableException('商品分类关系过多，请先整理');
  const value = { products, relations }; return { ...value, ids: products.map(row => row.id), count: products.length, revision: await hash(value) };
}
async function wholeProducts(db: DbClient, supplierId: number, ids: number[]) {
  // Full-row proof stays internal. Server-side window budgeting excludes large
  // rows before they reach a Worker, rather than checking after fetching them.
  const size = sql`SUM(octet_length(to_jsonb(${storeProduct})::text)::bigint) OVER()`;
  const rows = await db.select({ id: storeProduct.id, row: sql<Record<string, unknown> | null>`CASE WHEN ${size} <= 2097152
    THEN to_jsonb(${storeProduct}) ELSE NULL END` }).from(storeProduct).where(and(own(supplierId), inArray(storeProduct.id, ids)))
    .orderBy(asc(storeProduct.id));
  if (rows.length !== ids.length || rows.some(row => !row.row)) throw new ServiceUnavailableException('商品完整核对数据过大或已变化，请缩小范围');
  return rows.map(row => row.row!);
}
function bounded<T>(value: T) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 256 * 1024) throw new ServiceUnavailableException('批处理数据过大');
  return value;
}
function databaseError(error: unknown): never {
  let cause: unknown = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw new HttpApiException('商品或权限正在变化，请刷新后重试', 409, 409);
    if (code === '42501') throw new ServiceUnavailableException('批处理所需权限尚未就绪');
    if (code === '57014') throw new ServiceUnavailableException('批处理超时，请重新读取并核对');
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}
export class SupplierProductBatchService {
  constructor(private readonly container: Container) {}
  async selection(supplierId: number, raw: unknown, actor: SupplierProductBatchActor) {
    supplierReadIdentity(supplierId); const selection = parseSupplierBatchSelection(raw);
    try { return await withTx(this.container, async db => {
      // Establish each RC statement after the in-flight Supplier write finishes.
      // RR would pin an older snapshot while waiting on the scope admission.
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY`);
      await lockSupplierCategoryScope(db, supplierId);
      await authority(db, supplierId, actor, false);
      const result = bounded(await facts(db, await readProducts(db, supplierId, selection)));
      await authority(db, supplierId, actor, false);
      return result;
    }); } catch (error) { databaseError(error); }
  }
  async apply(supplierId: number, raw: unknown, actor: SupplierProductBatchActor) {
    supplierReadIdentity(supplierId); const input = parseSupplierProductBatchInput(raw);
    try { return await withTx(this.container, async db => {
      await lockSupplierCategoryScope(db, supplierId);
      const currentActor = await authority(db, supplierId, actor);
      const initial = await readProducts(db, supplierId, input), ids = initial.map(row => row.id);
      await boundBargainSourceProductChange(db);
      for (const id of ids) await lockBargainSourceProductChange(db, id);
      for (const id of ids) await db.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE}, ${id})`);
      const products = await readProducts(db, supplierId, { all: 0, ids, where: {} }, true);
      const wholeBefore = await wholeProducts(db, supplierId, ids);
      const before = await facts(db, products);
      if (input.all && (await readProducts(db, supplierId, input)).map(row => row.id).join(',') !== ids.join(',')) throw new HttpApiException('筛选商品已变化，请刷新后重试', 409, 409);
      if (input.expectedRevision !== undefined && input.expectedRevision !== before.revision) throw new HttpApiException('批处理商品已变化，请刷新后重试', 409, 409);
      const change = input.change, target = and(own(supplierId), inArray(storeProduct.id, ids), eq(storeProduct.isDel, 0));
      if ([3, 8].includes(change.type) && products.some(row => row.product_type !== 0)) throw new ValidateException('物流和运费设置仅支持实物商品');
      let categoryParents: Map<number, number> | undefined;
      if (change.type === 1) {
        const categories = await assertSupplierProductCategoryBindings(db, supplierId, change.cateIds);
        categoryParents = new Map(categories.map(row => [row.id, row.pid]));
        const csv = change.cateIds.join(','); if (csv.length > 64) throw new ValidateException('分类编码超出商品存储容量');
        await db.update(storeProduct).set({ cateId: csv }).where(target);
        await db.delete(storeProductRelation).where(and(inArray(storeProductRelation.productId, ids), eq(storeProductRelation.type, 1)));
        await db.insert(storeProductRelation).values(products.flatMap(product => categories.map(category => ({
          productId: product.id, relationId: category.id, relationPid: category.pid, type: 1, status: product.is_show, addTime: Math.floor(Date.now() / 1000),
        }))));
      } else if (change.type === 3) await db.update(storeProduct).set({ deliveryType: change.deliveryTypes.join(',') }).where(target);
      else if (change.type === 7) {
        if (change.formId > 0) await loadActiveOrderSystemForm(db, change.formId, true);
        await db.update(storeProduct).set({ systemFormId: change.formId }).where(target);
      } else {
        await lockShippingTemplateBindings(db, products.map(product => ({ tempId: change.templateId, freight: change.freight,
          ownerType: product.type, relationId: product.relation_id })));
        await db.update(storeProduct).set({ freight: change.freight, postage: change.postage, tempId: change.templateId }).where(target);
      }
      const after = await facts(db, await readProducts(db, supplierId, { all: 0, ids, where: {} }));
      const expected = products.map(product => ({ ...product, ...(change.type === 1 ? { cate_id: change.cateIds.join(',') }
        : change.type === 3 ? { delivery_type: change.deliveryTypes.join(',') } : change.type === 7 ? { system_form_id: change.formId }
          : { freight: change.freight, postage: change.postage, temp_id: change.templateId }) }));
      if (JSON.stringify(after.products) !== JSON.stringify(expected)) throw Error('批处理商品回读不一致');
      const selectedColumns = change.type === 1 ? { cate_id: change.cateIds.join(',') }
        : change.type === 3 ? { delivery_type: change.deliveryTypes.join(',') } : change.type === 7 ? { system_form_id: change.formId }
          : { freight: change.freight, postage: Number(change.postage), temp_id: change.templateId };
      const wholeExpected = wholeBefore.map(product => ({ ...product, ...selectedColumns }));
      if (JSON.stringify(await wholeProducts(db, supplierId, ids)) !== JSON.stringify(wholeExpected)) throw Error('批处理修改了未选商品字段');
      if (change.type === 1) {
        const expectedRelations = products.flatMap(product => change.cateIds.map(id => ({ product_id: product.id,
          relation_id: id, relation_pid: categoryParents!.get(id), status: product.is_show })));
        if (JSON.stringify(after.relations) !== JSON.stringify(expectedRelations)) throw Error('批处理分类关系回读不一致');
      } else if (JSON.stringify(after.relations) !== JSON.stringify(before.relations)) throw Error('未选商品关系发生变化');
      const auditAction = `product.batch;type=${change.type};supplier=${supplierId};count=${ids.length};digest=${await hash({ ids, change })}`;
      const auditRows = await db.insert(systemLog).values({ adminId: currentActor.id, adminName: currentActor.name, merchantId: supplierId,
        type: 'supplier_product_batch', method: 'POST', path: '/supplierapi/product/batch_process', page: '/products', ip: currentActor.ip,
        action: auditAction, addTime: Math.floor(Date.now() / 1000) }).returning({ id: systemLog.id, adminId: systemLog.adminId,
          merchantId: systemLog.merchantId, type: systemLog.type, method: systemLog.method, action: systemLog.action });
      if (auditRows.length !== 1 || auditRows[0].id <= 0 || auditRows[0].adminId !== currentActor.id || auditRows[0].merchantId !== supplierId
        || auditRows[0].type !== 'supplier_product_batch' || auditRows[0].method !== 'POST' || auditRows[0].action !== auditAction) throw Error('批处理审计回执不一致');
      if (JSON.stringify(await wholeProducts(db, supplierId, ids)) !== JSON.stringify(wholeExpected)
        || JSON.stringify((await facts(db, await readProducts(db, supplierId, { all: 0, ids, where: {} }))).relations) !== JSON.stringify(after.relations)) throw Error('审计后商品事实发生变化');
      session(actor);
      return bounded({ ...after, updated: ids.length, verified: true as const });
    }); } catch (error) { databaseError(error); }
  }
}
