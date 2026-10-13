import { and, asc, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeProductRule, systemAdmin, systemSupplier, systemRole, systemMenus, systemLog } from '@/models/schema';
import { ApiErrorCode, AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { parseProductRuleValue } from '@/services/product/ProductMetadataService';
import { SupplierPermissionService } from './SupplierPermissionService';
import { parseSupplierProductRuleDelete, parseSupplierProductRuleInput, parseSupplierProductRuleList, supplierRuleId,
  supplierRuleNoQuery, SUPPLIER_RULE_LIMIT } from './SupplierProductRuleInput';

export interface SupplierProductRuleActor { id: number; authVersion: string; expiresAt: number; ip?: string }
type Rule = typeof storeProductRule.$inferSelect;
const RULE_SCOPE = 731_612, MAX_BYTES = 2 * 1024 * 1024;
const scope = (supplierId: number) => and(eq(storeProductRule.type, 2), eq(storeProductRule.relationId, supplierId));
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const conflict = () => new HttpApiException('规格模板已变化，请重新读取后确认', 409, 409);
async function revision(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
function claims(actor: SupplierProductRuleActor) {
  if (!actor || !Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2_147_483_647 ||
    typeof actor.authVersion !== 'string' || !/^[a-f0-9]{32}$/.test(actor.authVersion) || !Number.isSafeInteger(actor.expiresAt)) throw new AuthException();
  if (actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
}
function bounded<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES) throw new ServiceUnavailableException('规格模板目录超过2MiB，请先整理');
  return value;
}

/** Dedicated Supplier protocol; the shared Admin metadata implementation stays intact. */
export class SupplierProductRuleService {
  constructor(private readonly container: Container) {}
  private async authority(db: DbClient, supplierId: number, actor: SupplierProductRuleActor, method: string, path: string) {
    claims(actor); const write = method !== 'GET';
    const adminQuery = db.select().from(systemAdmin).where(and(eq(systemAdmin.id, actor.id), eq(systemAdmin.adminType, 4),
      eq(systemAdmin.relationId, supplierId), eq(systemAdmin.status, 1), eq(systemAdmin.isDel, 0))).limit(1);
    const supplierQuery = db.select().from(systemSupplier).where(and(eq(systemSupplier.id, supplierId), eq(systemSupplier.isShow, 1), eq(systemSupplier.isDel, 0))).limit(1);
    const [admin] = await (write ? adminQuery.for('share', { noWait: true }) : adminQuery);
    const [supplier] = await (write ? supplierQuery.for('share', { noWait: true }) : supplierQuery);
    if (!admin || !supplier) throw new AuthException('供应商规格权限已变化', ApiErrorCode.ERR_AUTH);
    if (!timingSafeEqual(new TextEncoder().encode(md5(admin.pwd)), new TextEncoder().encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
    if (supplier.adminId !== admin.id) {
      const roleIds = [...new Set(admin.roles.split(',').map(value => value.trim()).filter(Boolean).map(value => {
        if (!/^[1-9]\d*$/.test(value) || Number(value) > 2_147_483_647) throw new ValidateException('供应商角色身份异常'); return Number(value);
      }))].sort((a, b) => a - b);
      if (roleIds.length > 512) throw new ValidateException('供应商角色数量超限');
      const rolesQuery = db.select().from(systemRole).where(and(inArray(systemRole.id, roleIds.length ? roleIds : [0]),
        eq(systemRole.type, 4), eq(systemRole.relationId, supplierId))).orderBy(asc(systemRole.id));
      const roles = roleIds.length ? await (write ? rolesQuery.for('share', { noWait: true }) : rolesQuery) : [];
      const menuIds = [...new Set(roles.flatMap(role => role.rules.split(',').map(value => value.trim())
        .filter(value => /^[1-9]\d*$/.test(value)).map(Number)))].sort((a, b) => a - b);
      if (menuIds.length > 512 || menuIds.some(id => !Number.isSafeInteger(id) || id > 2_147_483_647)) throw new ValidateException('供应商菜单数量超限');
      if (menuIds.length) {
        const menusQuery = db.select({ id: systemMenus.id }).from(systemMenus).where(and(inArray(systemMenus.id, menuIds),
          eq(systemMenus.type, 4), eq(systemMenus.authType, 2), eq(systemMenus.access, 1), eq(systemMenus.isDel, 0))).orderBy(asc(systemMenus.id));
        await (write ? menusQuery.for('share', { noWait: true }) : menusQuery);
      }
    }
    await new SupplierPermissionService(db).assertAuthorized({ id: admin.id, roles: admin.roles, isPrimary: supplier.adminId === admin.id }, supplierId, method, path);
    return { name: (admin.realName || admin.account).slice(0, 64), ip: (actor.ip ?? '').slice(0, 45) };
  }
  private async transaction<T>(supplierId: number, actor: SupplierProductRuleActor, method: string, path: string, work: (db: DbClient) => Promise<T>) {
    supplierRuleId(supplierId); claims(actor);
    try {
      return await withTx(this.container, async db => {
        if (method === 'GET') await db.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY`);
        await db.execute(sql`SET LOCAL statement_timeout='5s'`); await db.execute(sql`SET LOCAL lock_timeout='2s'`);
        await db.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
        // Same owner namespace as the existing shared rule writer, including DELETE.
        await db.execute(sql`SELECT pg_advisory_xact_lock(${RULE_SCOPE}, ${supplierId})`);
        await this.authority(db, supplierId, actor, method, path);
        const result = await work(db);
        await this.authority(db, supplierId, actor, method, path); claims(actor);
        return bounded(result);
      });
    } catch (error) {
      let cause: unknown = error;
      for (let i = 0; i < 8 && cause && typeof cause === 'object'; i++) {
        if ('code' in cause && ['55P03', '40P01', '40001', '57014'].includes(String(cause.code))) throw conflict();
        cause = 'cause' in cause ? cause.cause : null;
      }
      throw error;
    }
  }
  private async rows(db: DbClient, supplierId: number) {
    const rows = await db.select().from(storeProductRule).where(scope(supplierId)).orderBy(desc(storeProductRule.id)).limit(SUPPLIER_RULE_LIMIT + 1);
    if (rows.length > SUPPLIER_RULE_LIMIT) throw new ServiceUnavailableException('规格模板超过1000项，请先整理');
    bounded(rows); return rows;
  }
  private async row(db: DbClient, supplierId: number, id: number, lock = false) {
    const query = db.select().from(storeProductRule).where(and(scope(supplierId), eq(storeProductRule.id, id))).limit(1);
    const [row] = await (lock ? query.for('update', { noWait: true }) : query);
    if (!row) throw new NotFoundException('规格模板不存在或不属于当前供应商'); return row;
  }
  private async dto(row: Rule, decoded = false) {
    const spec = parseProductRuleValue(row.ruleValue);
    return { id: row.id, type: row.type, relation_id: row.relationId, rule_name: row.ruleName,
      rule_value: decoded ? spec : row.ruleValue, attr_name: spec.map(item => item.value).join(','),
      attr_value: spec.map(item => item.detail.join(',')), spec, revision: await revision(row) };
  }
  async list(supplierId: number, query: URLSearchParams, actor: SupplierProductRuleActor) {
    const input = parseSupplierProductRuleList(query);
    return this.transaction(supplierId, actor, 'GET', '/supplierapi/product/product/rule', async db => {
      const all = await this.rows(db, supplierId);
      // Scoped writers serialize here; search keeps old SQL LIKE wildcard semantics.
      const filtered = input.name ? await db.select().from(storeProductRule).where(and(scope(supplierId), ilike(storeProductRule.ruleName, `%${input.name}%`)))
        .orderBy(desc(storeProductRule.id)).limit(SUPPLIER_RULE_LIMIT + 1) : all;
      if (filtered.length > SUPPLIER_RULE_LIMIT || filtered.some(row => !all.some(prior => same(row, prior)))) throw conflict();
      const pageRows = input.paged ? filtered.slice((input.page - 1) * input.limit, input.page * input.limit) : filtered;
      return { list: await Promise.all(pageRows.map(row => this.dto(row))), count: filtered.length,
        page: input.page, limit: input.limit, revision: await revision(all) };
    });
  }
  async templates(supplierId: number, query: URLSearchParams, actor: SupplierProductRuleActor) {
    supplierRuleNoQuery(query);
    return this.transaction(supplierId, actor, 'GET', '/supplierapi/product/product/get_rule', async db =>
      Promise.all((await this.rows(db, supplierId)).map(row => this.dto(row, true))));
  }
  async detail(supplierId: number, id: number, query: URLSearchParams, actor: SupplierProductRuleActor) {
    supplierRuleNoQuery(query); id = supplierRuleId(id);
    return this.transaction(supplierId, actor, 'GET', `/supplierapi/product/product/rule/${id}`, async db => ({ info: await this.dto(await this.row(db, supplierId, id)) }));
  }
  private async proof(db: DbClient, supplierId: number, expected: Rule[]) {
    const actual = await this.rows(db, supplierId);
    if (!same(actual, [...expected].sort((a, b) => b.id - a.id))) throw conflict();
  }
  private async audit(db: DbClient, supplierId: number, actor: SupplierProductRuleActor, action: string, id: number) {
    const method = action === 'delete' ? 'DELETE' : 'POST';
    const path = action === 'delete' ? `/supplierapi/product/product/rule/delete/${id}` : `/supplierapi/product/product/rule/${action === 'create' ? 0 : id}`;
    await this.authority(db, supplierId, actor, method, path);
    const values = { adminId: actor.id, merchantId: supplierId, type: 'supplier_product_rule',
      method, path, page: '供应商规格模板管理', action: JSON.stringify({ operation: action, ids: [id] }), addTime: Math.floor(Date.now() / 1000) };
    const receipt = await db.insert(systemLog).values(values).returning();
    if (receipt.length !== 1 || receipt[0].id <= 0 || Object.keys(values).some(key => receipt[0][key as keyof typeof values] !== values[key as keyof typeof values])) throw Error('规格模板审计回执不完整');
  }
  async save(supplierId: number, id: number, body: unknown, actor: SupplierProductRuleActor) {
    id = supplierRuleId(id, true); const input = parseSupplierProductRuleInput(body);
    return this.transaction(supplierId, actor, 'POST', `/supplierapi/product/product/rule/${id}`, async db => {
      const prior = id ? await this.row(db, supplierId, id, true) : undefined, all = await this.rows(db, supplierId);
      if (!prior && all.length >= SUPPLIER_RULE_LIMIT) throw new ServiceUnavailableException('规格模板已达1000项，请先整理');
      if (input.expectedRevision && input.expectedRevision !== await revision(prior ?? all)) throw conflict();
      if (all.some(row => row.id !== id && row.ruleName === input.name)) throw new ValidateException('规格模板名称已存在');
      const values = { ruleName: input.name, ruleValue: JSON.stringify(input.spec) };
      const returned = prior ? await db.update(storeProductRule).set(values).where(and(scope(supplierId), eq(storeProductRule.id, id))).returning()
        : await db.insert(storeProductRule).values({ ...values, type: 2, relationId: supplierId }).returning();
      const saved = returned[0];
      if (returned.length !== 1 || !saved || !Number.isSafeInteger(saved.id) || saved.id <= 0) throw conflict();
      const expected: Rule = prior ? { ...prior, ...values } : { id: saved.id, type: 2, relationId: supplierId, ...values };
      if (!same(saved, expected)) throw conflict();
      const expectedRows = [...all.filter(row => row.id !== saved.id), expected];
      await this.proof(db, supplierId, expectedRows);
      await this.audit(db, supplierId, actor, prior ? 'update' : 'create', saved.id);
      await this.proof(db, supplierId, expectedRows);
      return { id: saved.id, revision: await revision(expected) };
    });
  }
  async delete(supplierId: number, id: number, body: unknown, actor: SupplierProductRuleActor) {
    id = supplierRuleId(id); const input = parseSupplierProductRuleDelete(body);
    return this.transaction(supplierId, actor, 'DELETE', `/supplierapi/product/product/rule/delete/${id}`, async db => {
      const prior = await this.row(db, supplierId, id, true), all = await this.rows(db, supplierId);
      if (input.expectedRevision && input.expectedRevision !== await revision(prior)) throw conflict();
      const removed = await db.delete(storeProductRule).where(and(scope(supplierId), eq(storeProductRule.id, id))).returning();
      if (removed.length !== 1 || !same(removed[0], prior)) throw conflict();
      const expected = all.filter(row => row.id !== id);
      await this.proof(db, supplierId, expected);
      await this.audit(db, supplierId, actor, 'delete', id);
      await this.proof(db, supplierId, expected);
      // Templates are copied by the product editor. There is no product rule FK.
      return null;
    });
  }
}
