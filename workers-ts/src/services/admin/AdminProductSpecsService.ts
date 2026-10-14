import { asc, eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { legacyCategory, storeProductSpecs, systemAdmin, systemLog } from '@/models/schema';
import { ProductMetadataService, platformMetadataOwner, formatParameterSpecTime } from '@/services/product/ProductMetadataService';
import { ApiErrorCode, AuthException, HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { acquireAdminAuthorityWriteBarrier, assertAdminAuthoritySession, loadAdminAuthorityLiveActor,
  parseAdminAuthorityRoleIds, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminLegacyRoleReferenceHistory } from './AdminLegacyRoleDeletionProof';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';

export type AdminProductSpecsActor = AdminAuthorityActor;
const MAX_ID = 2_147_483_647;
const parentFields = ['id', 'pid', 'type', 'relation_id', 'owner_id', 'name', 'sort', 'group', 'other',
  'is_show', 'add_time', 'integral_min', 'integral_max', 'specs'] as const;
const childFields = ['id', 'type', 'relation_id', 'temp_id', 'name', 'value', 'sort', 'status', 'add_time'] as const;
interface TemplateReceipt {
  parent: typeof legacyCategory.$inferSelect | undefined;
  children: Array<typeof storeProductSpecs.$inferSelect>;
}

function sameStoredRow(actual: object | undefined, expected: object | undefined): boolean {
  if (!actual || !expected) return false;
  const a = actual as Record<string, unknown>, e = expected as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(e).length && Object.keys(e).every(key => a[key] === e[key]);
}

export function specsId(value: unknown, allowZero = false): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < (allowZero ? 0 : 1) || id > MAX_ID) throw new ValidateException('商品参数模板ID错误');
  return id;
}

/** The Specs model accessor formats epoch zero too; only the parent list maps zero to an empty string. */
export function legacySpecsTime(seconds: number): string {
  return formatParameterSpecTime(seconds);
}

function noQuery(query: URLSearchParams): void {
  if (query.size) throw new ValidateException('此商品参数模板操作不接受查询参数');
}

function listQuery(query: URLSearchParams): Record<string, string> {
  const input: Record<string, string> = {};
  for (const [key, value] of query) {
    if (!['name', 'page', 'limit'].includes(key) || Object.hasOwn(input, key)) throw new ValidateException('商品参数模板查询参数错误或重复');
    input[key] = value;
  }
  if (input.name !== undefined && ([...input.name].length > 255 || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(input.name))) {
    throw new ValidateException('商品参数模板查询名称错误');
  }
  const page = input.page === undefined ? 1 : specsId(input.page);
  const limit = input.limit === undefined ? 20 : specsId(input.limit);
  if (limit > 100 || (page - 1) * limit > MAX_ID) throw new ValidateException('商品参数模板分页超出范围');
  return input;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException(message);
  return value as Record<string, unknown>;
}

function saveInput(id: number, value: unknown): Record<string, unknown> {
  const input = object(value, '商品参数模板正文必须是对象');
  if (Object.keys(input).some(key => !(parentFields as readonly string[]).includes(key))) throw new ValidateException('商品参数模板正文包含未知字段');
  if (input.id !== undefined && specsId(input.id, true) !== id) throw new ValidateException('商品参数模板正文ID必须与路径一致');
  if (input.specs !== undefined) {
    if (!Array.isArray(input.specs) || input.specs.length > 100) throw new ValidateException('商品参数必须是数组且不能超过100项');
    for (const value of input.specs) {
      const row = object(value, '商品参数行必须是对象');
      if (Object.keys(row).some(key => !(childFields as readonly string[]).includes(key))) throw new ValidateException('商品参数行包含未知字段');
    }
  }
  // Retain the complete displayed DTO. Ownership/time/row identities are compared
  // by ProductMetadataService under its lifecycle lock, before child replacement.
  return input;
}

function operationError(error: unknown): never {
  let cause: unknown = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(new HttpApiException('参数模板、商品或管理员权限正在更新，请刷新后重试', 409, 409), { cause: error });
    if (['42501', '57014'].includes(code)) throw Object.assign(new ServiceUnavailableException('参数模板运行权限配置未就绪或操作超时'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

/** Legacy product/specs endpoints and contemporary aliases share one authority transaction. */
export class AdminProductSpecsService {
  constructor(private readonly container: Container) {}

  private async readActor(tx: DbClient, actor: AdminProductSpecsActor): Promise<void> {
    const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
    if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
      || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
    const encoder = new TextEncoder();
    if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
    const roles = parseAdminAuthorityRoleIds(live.roles);
    await loadAdminLegacyRoleReferenceHistory(tx, roles, live.level);
    const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
    if (live.level !== 0 && !hasAdminPermission(keys, 'product.view')) throw new AuthException('商品参数模板查看权限已变化', ApiErrorCode.ERR_AUTH);
    assertAdminAuthoritySession(actor);
  }

  private async transaction<T>(actor: AdminProductSpecsActor, write: boolean,
    work: (tx: DbClient, metadata: ProductMetadataService) => Promise<T>): Promise<T> {
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

  async all(query: URLSearchParams, actor: AdminProductSpecsActor) {
    noQuery(query);
    return this.transaction(actor, false, (_tx, metadata) => metadata.allSpecTemplates(platformMetadataOwner));
  }

  async list(query: URLSearchParams, actor: AdminProductSpecsActor, legacy = true) {
    const input = listQuery(query);
    return this.transaction(actor, false, async (_tx, metadata) => {
      const result = await metadata.specTemplateList(platformMetadataOwner, input, false, !legacy);
      if (!legacy) return result;
      return { list: result.list.map(({ specs: _specs, ...row }) => ({ ...row, add_time: row.add_time ? legacySpecsTime(row.add_time) : '' })), count: result.count };
    });
  }

  async detail(id: number, query: URLSearchParams, actor: AdminProductSpecsActor, legacy = true) {
    noQuery(query); id = specsId(id);
    return this.transaction(actor, false, async (_tx, metadata) => {
      const result = await metadata.specTemplateDetail(platformMetadataOwner, id);
      return legacy ? { ...result, specs: result.specs.map(row => ({ ...row, add_time: legacySpecsTime(row.add_time) })) } : result;
    });
  }

  private async audit(tx: DbClient, actor: AdminProductSpecsActor, id: number, operation: 'create' | 'update' | 'delete'): Promise<void> {
    const expected = { adminId: actor.id, path: `product/specs/${id}`, page: '商品参数模板管理',
      method: operation === 'delete' ? 'DELETE' : 'POST', type: 'product_specs_catalog', action: JSON.stringify({ operation, id }),
      addTime: Math.floor(Date.now() / 1000) };
    const rows = await tx.insert(systemLog).values(expected).returning();
    const row = rows[0];
    const matches = (value: typeof row | undefined) => value && Number.isSafeInteger(value.id) && value.id > 0
      && Object.entries(expected).every(([key, expectedValue]) => value[key as keyof typeof value] === expectedValue);
    if (rows.length !== 1 || !matches(row)) throw new Error('商品参数模板审计回执不完整');
    const [readBack] = await tx.select().from(systemLog).where(eq(systemLog.id, row.id)).limit(1);
    if (!matches(readBack)) throw new Error('商品参数模板审计回读不一致');
  }

  private async templateReceipt(tx: DbClient, id: number): Promise<TemplateReceipt> {
    const [parents, children] = await Promise.all([
      tx.select().from(legacyCategory).where(eq(legacyCategory.id, id)).limit(1),
      tx.select().from(storeProductSpecs).where(eq(storeProductSpecs.tempId, id))
        .orderBy(asc(storeProductSpecs.id)).limit(101),
    ]);
    return { parent: parents[0], children };
  }

  async save(id: number, value: unknown, actor: AdminProductSpecsActor) {
    id = specsId(id, true);
    const input = saveInput(id, value);
    return this.transaction(actor, true, async (tx, metadata) => {
      const result = await metadata.saveSpecTemplate(platformMetadataOwner, id, input);
      const savedId = specsId(result.id);
      if (id && savedId !== id) throw new Error('商品参数模板保存回执ID不一致');
      const receipt = await this.templateReceipt(tx, savedId);
      if (!receipt.parent || receipt.children.length > 100) throw new Error('商品参数模板保存业务回执不完整');
      await this.audit(tx, actor, savedId, id ? 'update' : 'create');
      // Audit triggers run after the core's readback. Verify the complete final
      // business rows too, including mismatched owners and newly added children.
      const afterAudit = await this.templateReceipt(tx, savedId);
      if (!sameStoredRow(afterAudit.parent, receipt.parent) || afterAudit.children.length !== receipt.children.length
        || afterAudit.children.some((row, index) => !sameStoredRow(row, receipt.children[index]))) {
        throw new Error('商品参数模板审计后保存核验失败');
      }
      return result;
    });
  }

  async remove(id: number, query: URLSearchParams, actor: AdminProductSpecsActor) {
    noQuery(query); id = specsId(id);
    return this.transaction(actor, true, async (tx, metadata) => {
      await metadata.deleteSpecTemplate(platformMetadataOwner, id);
      await this.audit(tx, actor, id, 'delete');
      const [parents, children] = await Promise.all([
        tx.select({ id: legacyCategory.id }).from(legacyCategory).where(eq(legacyCategory.id, id)).limit(1),
        tx.select({ id: storeProductSpecs.id }).from(storeProductSpecs).where(eq(storeProductSpecs.tempId, id)).limit(1),
      ]);
      if (parents.length || children.length) throw new Error('商品参数模板审计后删除核验失败');
      return null;
    });
  }
}
