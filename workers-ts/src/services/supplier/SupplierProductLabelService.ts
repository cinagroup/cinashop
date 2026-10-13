import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { legacyCategory, storeProductLabel, storeProductLabelAuxiliary, storeProductRelation, storeProduct,
  systemAdmin, systemSupplier, systemRole, systemMenus, systemLog } from '@/models/schema';
import { ApiErrorCode, AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { SupplierPermissionService } from './SupplierPermissionService';
import { parseSupplierProductLabelDelete, parseSupplierProductLabelInput, supplierLabelId, supplierLabelNoQuery } from './SupplierProductLabelInput';

export interface SupplierProductLabelActor { id: number; authVersion: string; expiresAt: number; ip?: string }
type Label = typeof storeProductLabel.$inferSelect;
const LABEL_SCOPE = 731_737, MAX_LABELS = 2_000, MAX_GROUPS = 1_000, MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const own = (supplierId: number) => and(eq(storeProductLabel.type, 2), eq(storeProductLabel.relationId, supplierId));
const groupScope = (supplierId: number) => and(eq(legacyCategory.group, 2), eq(legacyCategory.ownerId, 0), or(
  and(eq(legacyCategory.type, 0), eq(legacyCategory.relationId, 0)),
  and(eq(legacyCategory.type, 2), eq(legacyCategory.relationId, supplierId)),
));
const time = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function date(seconds: number) {
  const p = Object.fromEntries(time.formatToParts(new Date(seconds * 1000)).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function claims(actor: SupplierProductLabelActor) {
  if (!actor || !Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2_147_483_647 ||
    typeof actor.authVersion !== 'string' || !/^[a-f0-9]{32}$/.test(actor.authVersion) || !Number.isSafeInteger(actor.expiresAt)) {
    throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  }
  if (actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
}
async function hash(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(part => part.toString(16).padStart(2, '0')).join('');
}
function bounded<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_RESPONSE_BYTES) throw new ServiceUnavailableException('商品标签目录过大，请先整理');
  return value;
}
function sameRow(left: Label, right: Label) {
  return Object.keys(left).every(key => left[key as keyof Label] === right[key as keyof Label]);
}
function conflict() { return new HttpApiException('商品标签或权限已变化，请刷新后重试', 409, 409); }

/** Reuse only within the caller's actual product-write transaction. */
export async function assertSupplierProductLabelAuthority(db: DbClient, supplierId: number, actor: SupplierProductLabelActor,
  method: 'GET' | 'POST' | 'DELETE', path: string) {
  supplierLabelId(supplierId);
  return SupplierProductLabelService.assertAuthority(db, supplierId, actor, method, path);
}

/** Owner-scoped label edits never rewrite presentation, status or product rows. */
export class SupplierProductLabelService {
  constructor(private readonly container: Container) {}

  async assertBindingAuthority(db: DbClient, supplierId: number, actor: SupplierProductLabelActor, path: string) {
    return assertSupplierProductLabelAuthority(db, supplierId, actor, 'POST', path);
  }

  static async assertAuthority(db: DbClient, supplierId: number, actor: SupplierProductLabelActor, method: 'GET' | 'POST' | 'DELETE', path: string) {
    claims(actor); const write = method !== 'GET';
    const adminQuery = db.select().from(systemAdmin).where(and(eq(systemAdmin.id, actor.id), eq(systemAdmin.adminType, 4),
      eq(systemAdmin.relationId, supplierId), eq(systemAdmin.status, 1), eq(systemAdmin.isDel, 0))).limit(1);
    const supplierQuery = db.select().from(systemSupplier).where(and(eq(systemSupplier.id, supplierId), eq(systemSupplier.isShow, 1), eq(systemSupplier.isDel, 0))).limit(1);
    const [admin] = await (write ? adminQuery.for('share') : adminQuery);
    const [supplier] = await (write ? supplierQuery.for('share') : supplierQuery);
    if (!admin || !supplier) throw new AuthException('供应商标签权限已变化', ApiErrorCode.ERR_AUTH);
    if (!timingSafeEqual(new TextEncoder().encode(md5(admin.pwd)), new TextEncoder().encode(actor.authVersion))) {
      throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
    }
    if (supplier.adminId !== admin.id) {
      const roleIds = [...new Set(admin.roles.split(',').map(value => value.trim()).filter(Boolean).map(value => {
        if (!/^[1-9]\d*$/.test(value) || Number(value) > 2_147_483_647) throw new ValidateException('供应商角色身份异常');
        return Number(value);
      }))].sort((a, b) => a - b);
      if (roleIds.length > 512) throw new ValidateException('供应商角色数量异常');
      const roleQuery = db.select().from(systemRole).where(and(inArray(systemRole.id, roleIds.length ? roleIds : [0]),
        eq(systemRole.type, 4), eq(systemRole.relationId, supplierId))).orderBy(asc(systemRole.id));
      const roles = roleIds.length ? await (write ? roleQuery.for('share', { noWait: true }) : roleQuery) : [];
      const menuIds = [...new Set(roles.flatMap(role => role.rules.split(',').map(value => value.trim())
        .filter(value => /^[1-9]\d*$/.test(value)).map(Number)))].sort((a, b) => a - b);
      if (menuIds.length > 512 || menuIds.some(id => !Number.isSafeInteger(id) || id > 2_147_483_647)) throw new ValidateException('供应商菜单权限数量异常');
      if (menuIds.length) {
        const menuQuery = db.select({ id: systemMenus.id }).from(systemMenus).where(and(inArray(systemMenus.id, menuIds),
          eq(systemMenus.type, 4), eq(systemMenus.authType, 2), eq(systemMenus.access, 1), eq(systemMenus.isDel, 0))).orderBy(asc(systemMenus.id));
        await (write ? menuQuery.for('share', { noWait: true }) : menuQuery);
      }
    }
    await new SupplierPermissionService(db).assertAuthorized({ id: admin.id, roles: admin.roles, isPrimary: supplier.adminId === admin.id }, supplierId, method, path);
    return { id: admin.id, name: (admin.realName || admin.account).slice(0, 64), ip: (actor.ip ?? '').slice(0, 45) };
  }

  private async transaction<T>(supplierId: number, actor: SupplierProductLabelActor, method: 'GET' | 'POST' | 'DELETE', path: string, work: (db: DbClient) => Promise<T>) {
    supplierLabelId(supplierId); claims(actor);
    try {
      return await withTx(this.container, async db => {
        if (method === 'GET') await db.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY`);
        await db.execute(sql`SET LOCAL statement_timeout='5s'`); await db.execute(sql`SET LOCAL lock_timeout='2s'`);
        await db.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
        await db.execute(sql`SELECT pg_advisory_xact_lock(${LABEL_SCOPE}, ${supplierId})`);
        await assertSupplierProductLabelAuthority(db, supplierId, actor, method, path);
        const result = await work(db);
        await assertSupplierProductLabelAuthority(db, supplierId, actor, method, path); claims(actor);
        return bounded(result);
      });
    } catch (error) {
      let cause: unknown = error;
      for (let i = 0; i < 6 && cause && typeof cause === 'object'; i++) {
        if ('code' in cause && ['55P03', '40P01', '40001'].includes(String(cause.code))) throw conflict();
        cause = 'cause' in cause ? cause.cause : null;
      }
      throw error;
    }
  }

  private async labels(db: DbClient, supplierId: number) {
    const rows = await db.select().from(storeProductLabel).where(own(supplierId)).orderBy(desc(storeProductLabel.sort), desc(storeProductLabel.id)).limit(MAX_LABELS + 1);
    if (rows.length > MAX_LABELS) throw new ServiceUnavailableException('商品标签超过2000项，请先整理');
    return rows;
  }
  private async groups(db: DbClient, supplierId: number) {
    const rows = await db.select().from(legacyCategory).where(groupScope(supplierId)).orderBy(desc(legacyCategory.sort), desc(legacyCategory.id)).limit(MAX_GROUPS + 1);
    if (rows.length > MAX_GROUPS) throw new ServiceUnavailableException('商品标签组超过1000项，请先整理');
    return rows;
  }
  private async label(db: DbClient, supplierId: number, id: number, lock = false) {
    const query = db.select().from(storeProductLabel).where(and(own(supplierId), eq(storeProductLabel.id, id))).limit(1);
    const [row] = await (lock ? query.for('update', { noWait: true }) : query);
    if (!row) throw new NotFoundException('商品标签不存在或不属于当前供应商');
    return row;
  }
  private async revision(db: DbClient, supplierId: number) { return hash({ labels: await this.labels(db, supplierId), groups: await this.groups(db, supplierId) }); }

  async catalog(supplierId: number, query: URLSearchParams, actor: SupplierProductLabelActor) {
    supplierLabelNoQuery(query);
    return this.transaction(supplierId, actor, 'GET', '/supplierapi/product/label/catalog', async db => {
      const rows = await this.labels(db, supplierId), groups = await this.groups(db, supplierId), byId = new Map(groups.map(group => [group.id, group]));
      return { count: rows.length, revision: await hash({ labels: rows, groups }),
        groups: groups.map(row => ({ id: row.id, name: row.name, type: row.type, relation_id: row.relationId, is_show: row.isShow })),
        list: await Promise.all(rows.map(async row => ({ id: row.id, type: row.type, relation_id: row.relationId,
          label_cate: row.labelCate, label_name: row.labelName, style_type: row.styleType, color: row.color, bg_color: row.bgColor,
          border_color: row.borderColor, icon: row.icon, is_show: row.isShow, status: row.status, sort: row.sort, add_time: date(row.addTime),
          group_name: byId.get(row.labelCate)?.name ?? '', group_valid: byId.has(row.labelCate),
          selectable: row.isShow === 1 && row.status === 1 && byId.get(row.labelCate)?.isShow === 1, revision: await hash(row) }))),
      };
    });
  }
  async all(supplierId: number, query: URLSearchParams, actor: SupplierProductLabelActor) {
    supplierLabelNoQuery(query);
    return this.transaction(supplierId, actor, 'GET', '/supplierapi/product/all_label', async db => (await this.labels(db, supplierId)).map(row => ({ id: row.id, label_name: row.labelName })));
  }
  async form(supplierId: number, query: URLSearchParams, actor: SupplierProductLabelActor) {
    supplierLabelNoQuery(query);
    return this.transaction(supplierId, actor, 'GET', '/supplierapi/product/label/form', async db => ({ title: '添加商品标签', method: 'POST', action: 'product/label/0', rules: [
      { type: 'select', field: 'label_cate', title: '标签分组', value: '', options: (await this.groups(db, supplierId))
        .filter(row => row.type === 0 && row.relationId === 0).map(row => ({ label: row.name, value: row.id })) },
      { type: 'input', field: 'label_name', title: '标签名称', value: '', props: { maxlength: 20 } },
    ] as const }));
  }

  private async audit(db: DbClient, supplierId: number, actor: SupplierProductLabelActor, operation: 'create' | 'update' | 'delete', id: number) {
    const action = JSON.stringify({ operation, ids: [id] }), method = operation === 'delete' ? 'DELETE' : 'POST';
    const receipts = await db.insert(systemLog).values({ adminId: actor.id, merchantId: supplierId, path: `product/label/${id}`,
      page: '供应商商品标签管理', method, action, type: 'supplier_product_label', addTime: Math.floor(Date.now() / 1000) })
      .returning({ id: systemLog.id, adminId: systemLog.adminId, merchantId: systemLog.merchantId, path: systemLog.path, method: systemLog.method, action: systemLog.action, type: systemLog.type });
    const receipt = receipts[0];
    if (receipts.length !== 1 || !receipt || receipt.id <= 0 || receipt.adminId !== actor.id || receipt.merchantId !== supplierId || receipt.path !== `product/label/${id}` ||
      receipt.method !== method || receipt.action !== action || receipt.type !== 'supplier_product_label') throw Error('商品标签审计回执不完整');
  }

  async save(supplierId: number, id: number, body: unknown, actor: SupplierProductLabelActor) {
    id = supplierLabelId(id, true); const input = parseSupplierProductLabelInput(body);
    return this.transaction(supplierId, actor, 'POST', `/supplierapi/product/label/${id}`, async db => {
      const previous = id ? await this.label(db, supplierId, id, true) : undefined;
      if (!previous && (await this.labels(db, supplierId)).length >= MAX_LABELS) throw new ServiceUnavailableException('商品标签已达2000项，请先整理');
      if (input.expectedRevision && input.expectedRevision !== (previous ? await hash(previous) : await this.revision(db, supplierId))) throw conflict();
      const [group] = await db.select().from(legacyCategory).where(and(groupScope(supplierId), eq(legacyCategory.id, input.labelCate))).limit(1).for('share', { noWait: true });
      if (!group) throw new ValidateException('标签组不存在或不属于平台及当前供应商');
      const duplicates = await db.select({ id: storeProductLabel.id }).from(storeProductLabel).where(and(own(supplierId),
        eq(storeProductLabel.labelCate, input.labelCate), eq(storeProductLabel.labelName, input.labelName))).limit(2);
      if (duplicates.some(row => row.id !== id)) throw new ValidateException('标签已经存在');
      const values = { labelCate: input.labelCate, labelName: input.labelName };
      const initial = { ...values, type: 2, relationId: supplierId, styleType: 1, color: '', bgColor: '', borderColor: '', icon: '',
        isShow: 1, status: 1, sort: 0, addTime: Math.floor(Date.now() / 1000) };
      const rows = previous ? await db.update(storeProductLabel).set(values).where(and(own(supplierId), eq(storeProductLabel.id, id))).returning()
        : await db.insert(storeProductLabel).values(initial).returning();
      const saved = rows[0], expected = previous ? { ...previous, ...values } : { id: saved?.id, ...initial };
      if (rows.length !== 1 || !saved || saved.id <= 0 || !sameRow(expected as Label, saved)) throw Error('商品标签保存回执不完整');
      await this.audit(db, supplierId, actor, previous ? 'update' : 'create', saved.id);
      const actual = await this.label(db, supplierId, saved.id);
      if (!sameRow(expected as Label, actual)) throw Error('商品标签提交前事实已变化');
      const [actualGroup] = await db.select().from(legacyCategory).where(and(groupScope(supplierId), eq(legacyCategory.id, group.id))).limit(1);
      if (!actualGroup || Object.keys(group).some(key => group[key as keyof typeof group] !== actualGroup[key as keyof typeof group])) {
        throw Error('商品标签提交前分组事实已变化');
      }
      return { id: saved.id, revision: await hash(actual) };
    });
  }

  private async assertUnreferenced(db: DbClient, id: number) {
      const [reference] = await db.execute(sql`SELECT (
        EXISTS(SELECT 1 FROM ${storeProductRelation} WHERE type=3 AND relation_id=${id}) OR
        EXISTS(SELECT 1 FROM ${storeProductLabelAuxiliary} WHERE label_id=${id}) OR
        EXISTS(SELECT 1 FROM ${storeProduct} p WHERE p.is_del=0 AND btrim(coalesce(p.store_label_id,''))<>'' AND
          EXISTS(SELECT 1 FROM unnest(string_to_array(coalesce(p.store_label_id,''),',')) AS token(value)
            WHERE btrim(token.value)<>'' AND CASE WHEN btrim(token.value) ~ '^[+-]?[0-9]+$'
              THEN ltrim(btrim(token.value),'+0')=${String(id)} ELSE true END))
      ) AS linked`) as unknown as Array<{ linked: boolean }>;
      if (reference?.linked !== false) throw new ValidateException('标签仍被商品或历史辅助引用使用，不能删除');
  }

  async delete(supplierId: number, id: number, body: unknown, actor: SupplierProductLabelActor) {
    id = supplierLabelId(id); const input = parseSupplierProductLabelDelete(body);
    return this.transaction(supplierId, actor, 'DELETE', `/supplierapi/product/label/${id}`, async db => {
      const row = await this.label(db, supplierId, id, true);
      if (input.expectedRevision && input.expectedRevision !== await hash(row)) throw conflict();
      await this.assertUnreferenced(db, id);
      const removed = await db.delete(storeProductLabel).where(and(own(supplierId), eq(storeProductLabel.id, id))).returning();
      if (removed.length !== 1 || !sameRow(row, removed[0])) throw Error('商品标签删除回执不完整');
      await this.audit(db, supplierId, actor, 'delete', id);
      await this.assertUnreferenced(db, id);
      const remaining = await db.select({ id: storeProductLabel.id }).from(storeProductLabel).where(eq(storeProductLabel.id, id)).limit(1);
      if (remaining.length) throw Error('商品标签删除后仍存在');
      return null;
    });
  }
}
