import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { storeProductRule, systemAdmin, systemLog } from '@/models/schema';
import { ProductMetadataService, platformMetadataOwner } from '@/services/product/ProductMetadataService';
import { ApiErrorCode, AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { acquireAdminAuthorityWriteBarrier, assertAdminAuthoritySession, loadAdminAuthorityLiveActor,
  parseAdminAuthorityRoleIds, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminLegacyRoleReferenceHistory } from './AdminLegacyRoleDeletionProof';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';

export type AdminProductRuleActor = AdminAuthorityActor;
type RuleRow = typeof storeProductRule.$inferSelect;
const MAX_ID = 2_147_483_647;
const fields = ['id', 'type', 'relation_id', 'rule_name', 'ruleName', 'rule_value', 'attr_name', 'attr_value', 'spec'];
const scope = and(eq(storeProductRule.type, 0), eq(storeProductRule.relationId, 0));

export function ruleId(value: unknown, allowZero = false): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < (allowZero ? 0 : 1) || id > MAX_ID) throw new ValidateException('商品规格模板ID错误');
  return id;
}

function noQuery(query: URLSearchParams): void {
  if (query.size) throw new ValidateException('此商品规格模板操作不接受查询参数');
}

function listQuery(query: URLSearchParams): Record<string, string> {
  const input: Record<string, string> = {};
  for (const [key, value] of query) {
    if (!['rule_name', 'page', 'limit'].includes(key) || Object.hasOwn(input, key)) throw new ValidateException('商品规格模板查询参数错误或重复');
    input[key] = value;
  }
  if (input.rule_name !== undefined && ([...input.rule_name].length > 32 || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(input.rule_name))) {
    throw new ValidateException('商品规格模板查询名称错误');
  }
  const page = input.page === undefined ? 1 : ruleId(input.page);
  const limit = input.limit === undefined ? 20 : ruleId(input.limit);
  if (limit > 100 || (page - 1) * limit > MAX_ID) throw new ValidateException('商品规格模板分页超出范围');
  return input;
}

function saveInput(id: number, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('商品规格模板正文必须是对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !fields.includes(key))) throw new ValidateException('商品规格模板正文包含未知字段');
  if (input.id !== undefined && ruleId(input.id, true) !== id) throw new ValidateException('商品规格模板正文ID必须与路径一致');
  // The old editor posts the complete getInfo object. Retain its raw/derived
  // read-only metadata for the core's comparison under the lifecycle fence.
  return input;
}

function deletionInput(value: unknown, legacy: boolean): void {
  if (value === undefined) return;
  if (legacy && value && typeof value === 'object' && !Array.isArray(value)) {
    const body = value as Record<string, unknown>;
    if (Object.keys(body).length === 1 && Object.hasOwn(body, 'ids') && body.ids === '') return;
  }
  throw new ValidateException(legacy ? '规格模板删除仅接受空正文或旧弹窗空ids字段' : '规格模板删除不接受正文');
}

function rawDto(row: RuleRow) {
  return { id: row.id, type: row.type, relation_id: row.relationId, rule_name: row.ruleName, rule_value: row.ruleValue };
}

function decodeLegacyRule(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function phpTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '' || value === '0') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function legacyAttributes(value: unknown): { attr_name: string; attr_value: string[] } {
  if (!phpTruthy(value)) return { attr_name: '', attr_value: [''] };
  const dimensions = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : undefined;
  if (!dimensions) throw new ServiceUnavailableException('历史规格模板结构异常，请先核对数据');
  const names: string[] = [], values: string[] = [];
  for (const dimension of dimensions) {
    if (!dimension || typeof dimension !== 'object' || Array.isArray(dimension)) throw new ServiceUnavailableException('历史规格模板结构异常，请先核对数据');
    const row = dimension as Record<string, unknown>;
    if (typeof row.value !== 'string' || !Array.isArray(row.detail) || row.detail.some(item => typeof item !== 'string')) {
      throw new ServiceUnavailableException('历史规格模板结构异常，请先核对数据');
    }
    names.push(row.value); values.push(row.detail.join(','));
  }
  return { attr_name: names.join(','), attr_value: values };
}

function legacyListDto(row: RuleRow) {
  const dto = rawDto(row);
  return phpTruthy(row.ruleValue) ? { ...dto, ...legacyAttributes(decodeLegacyRule(row.ruleValue)) } : dto;
}

function legacyTemplateDto(row: RuleRow) {
  const dto = rawDto(row);
  if (!phpTruthy(row.ruleValue)) return dto;
  const decoded = decodeLegacyRule(row.ruleValue);
  return { ...dto, rule_value: decoded, ...legacyAttributes(decoded) };
}

function sameStoredRow(actual: RuleRow | undefined, expected: RuleRow): boolean {
  if (!actual) return false;
  return Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => actual[key as keyof RuleRow] === value);
}

function operationError(error: unknown): never {
  let cause: unknown = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(new HttpApiException('规格模板或管理员权限正在更新，请刷新后重试', 409, 409), { cause: error });
    if (['42501', '57014'].includes(code)) throw Object.assign(new ServiceUnavailableException('规格模板运行权限配置未就绪或操作超时'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

export class AdminProductRuleService {
  constructor(private readonly container: Container) {}

  private async readActor(tx: DbClient, actor: AdminProductRuleActor): Promise<void> {
    const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
    if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
      || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
    const encoder = new TextEncoder();
    if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
    await loadAdminLegacyRoleReferenceHistory(tx, parseAdminAuthorityRoleIds(live.roles), live.level);
    const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
    if (live.level !== 0 && !hasAdminPermission(keys, 'product.view')) throw new AuthException('商品规格模板查看权限已变化', ApiErrorCode.ERR_AUTH);
    assertAdminAuthoritySession(actor);
  }

  private async transaction<T>(actor: AdminProductRuleActor, write: boolean,
    work: (tx: DbClient, core: ProductMetadataService) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container, async tx => {
        let initial: typeof systemAdmin.$inferSelect | undefined;
        if (write) {
          await acquireAdminAuthorityWriteBarrier(tx);
          await loadAdminAuthorityLiveActor(tx, actor, 'product.manage');
          [initial] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
        } else {
          await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
          await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
          await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
          await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
          await this.readActor(tx, actor);
        }
        const result = await work(tx, new ProductMetadataService(createContainerFromDb(tx)));
        if (write) {
          await loadAdminAuthorityLiveActor(tx, actor, 'product.manage');
          const [fresh] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
          if (!initial || JSON.stringify(fresh) !== JSON.stringify(initial)) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_AUTH);
        }
        const [clock] = await tx.execute(sql`SELECT extract(epoch from clock_timestamp()) >= ${actor.expiresAt} AS expired`) as unknown as Array<{ expired: boolean }>;
        if (clock?.expired !== false) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
        assertAdminAuthoritySession(actor);
        return result;
      });
    } catch (error) { return operationError(error); }
  }

  async list(query: URLSearchParams, actor: AdminProductRuleActor, legacy = true) {
    const input = listQuery(query);
    return this.transaction(actor, false, async (tx, core) => {
      if (!legacy) return core.ruleList(platformMetadataOwner, input);
      const name = input.rule_name?.trim(), where = and(scope, name ? ilike(storeProductRule.ruleName, `%${name}%`) : undefined);
      const page = input.page === undefined ? 1 : ruleId(input.page), limit = input.limit === undefined ? 20 : ruleId(input.limit);
      const [rows, counts] = await Promise.all([
        tx.select().from(storeProductRule).where(where).orderBy(desc(storeProductRule.id)).limit(limit).offset((page - 1) * limit),
        tx.select({ count: sql<number>`count(*)::integer` }).from(storeProductRule).where(where),
      ]);
      return { list: rows.map(legacyListDto), count: counts[0]?.count ?? 0 };
    });
  }

  async templates(query: URLSearchParams, actor: AdminProductRuleActor, legacy = true) {
    noQuery(query);
    return this.transaction(actor, false, async (tx, core) => {
      if (!legacy) return core.ruleTemplates(platformMetadataOwner);
      const rows = await tx.select().from(storeProductRule).where(scope).orderBy(desc(storeProductRule.id)).limit(2001);
      if (rows.length > 2000) throw new ServiceUnavailableException('商品规格模板超过2000项，请缩小范围');
      return rows.map(legacyTemplateDto);
    });
  }

  async detail(id: number, query: URLSearchParams, actor: AdminProductRuleActor, legacy = true) {
    noQuery(query); id = ruleId(id);
    return this.transaction(actor, false, async (tx, core) => {
      if (!legacy) return core.ruleDetail(platformMetadataOwner, id);
      const [row] = await tx.select().from(storeProductRule).where(and(scope, eq(storeProductRule.id, id))).limit(1);
      if (!row) throw new NotFoundException('商品规格模板不存在');
      return { info: { ...rawDto(row), spec: decodeLegacyRule(row.ruleValue) } };
    });
  }

  private async audit(tx: DbClient, actor: AdminProductRuleActor, id: number, operation: 'create' | 'update' | 'delete'): Promise<void> {
    const expected = { storeId: 0, merchantId: 0, adminName: '', ip: '',
      adminId: actor.id, path: `product/product/rule/${id}`, page: '商品规格模板管理',
      method: operation === 'delete' ? 'DELETE' : 'POST', type: 'product_rule_catalog',
      action: JSON.stringify({ operation, id }), addTime: Math.floor(Date.now() / 1000) };
    const rows = await tx.insert(systemLog).values(expected).returning();
    const row = rows[0];
    const matches = (value: typeof row | undefined) => value && Number.isSafeInteger(value.id) && value.id > 0
      && Object.entries(expected).every(([key, expectedValue]) => value[key as keyof typeof value] === expectedValue);
    if (rows.length !== 1 || !matches(row)) throw new Error('商品规格模板审计回执不完整');
    const [readBack] = await tx.select().from(systemLog).where(eq(systemLog.id, row.id)).limit(1);
    if (!matches(readBack)) throw new Error('商品规格模板审计回读不一致');
  }

  async save(id: number, value: unknown, actor: AdminProductRuleActor, legacy = true) {
    id = ruleId(id, true); const input = saveInput(id, value);
    // The PHP controller tests the name's truthiness before calling its service.
    if (legacy && (input.rule_name ?? input.ruleName) === '0') throw new ValidateException('请输入分类名称');
    return this.transaction(actor, true, async (tx, core) => {
      const result = await core.saveRule(platformMetadataOwner, id, input);
      const savedId = ruleId(result.id);
      if (id && savedId !== id) throw new Error('商品规格模板保存回执ID不一致');
      const [receipt] = await tx.select().from(storeProductRule).where(eq(storeProductRule.id, savedId)).limit(1);
      if (!receipt || receipt.type !== 0 || receipt.relationId !== 0) throw new Error('商品规格模板业务回执不完整');
      await this.audit(tx, actor, savedId, id ? 'update' : 'create');
      const [after] = await tx.select().from(storeProductRule).where(eq(storeProductRule.id, savedId)).limit(1);
      if (!sameStoredRow(after, receipt)) throw new Error('商品规格模板审计后保存核验失败');
      return result;
    });
  }

  async remove(id: number, query: URLSearchParams, value: unknown, actor: AdminProductRuleActor, legacy = true) {
    noQuery(query); id = ruleId(id); deletionInput(value, legacy);
    return this.transaction(actor, true, async (tx, core) => {
      await core.deleteRule(platformMetadataOwner, id);
      await this.audit(tx, actor, id, 'delete');
      const [after] = await tx.select({ id: storeProductRule.id }).from(storeProductRule).where(eq(storeProductRule.id, id)).limit(1);
      if (after) throw new Error('商品规格模板审计后删除核验失败');
      return null;
    });
  }
}
