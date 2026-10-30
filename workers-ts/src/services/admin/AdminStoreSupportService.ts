import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { cityArea, systemAttachment, systemAttachmentCategory, systemConfig } from '@/models/schema';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { publicStoreImageReferences, renderStoreImageReferences } from '@/services/store/StoreAssetPolicy';
import { normalizeConfigScalar } from '@/utils/config';
import { NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { assertAdminAuthoritySession, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { authorizeAdminLegacyProductRead, assertAdminLegacyProductReadDeadline } from './AdminLegacyProductReadAuthority';

const IMAGE_CAPACITY = 5000;
const REGION_CAPACITY = 10000;
const MAP_ORIGIN = 'https://apis.map.qq.com' as const;

function parameters(query: URLSearchParams, allowed: readonly string[]) {
  for (const [key] of query) {
    if (!allowed.includes(key) || query.getAll(key).length !== 1) throw new ValidateException('提货点支持查询字段无效或重复');
  }
}
function integer(raw: string | null, fallback: number, min: number, max: number) {
  if (raw === null) return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) throw new ValidateException('提货点图库分页或分类无效');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ValidateException('提货点图库分页或分类超出范围');
  return value;
}
export interface StoreAttachmentOption { att_id: number; pid: number; real_name: string; reference: string; preview: string }
export interface StoreRegionRow { id: number; pid: number; level: 1 | 2 | 3; name: string }

/** Validate the complete selected three-level catalogue, without repairing or
 * trimming historical names, hiding orphans, or treating street rows as areas. */
export function checkedStoreRegionDirectory(rows: readonly { id: number; pid: number; level: number; name: string }[]): StoreRegionRow[] {
  if (rows.length > REGION_CAPACITY) throw new ServiceUnavailableException('提货点省市区目录超过10000项，不能截断');
  const byId = new Map<number, { id: number; pid: number; level: number; name: string }>();
  const names = new Set<string>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.id) || row.id < 1 || row.id > 2_147_483_647 || !Number.isSafeInteger(row.pid) || row.pid < 0 || row.pid > 2_147_483_647
      || ![1, 2, 3].includes(row.level) || typeof row.name !== 'string' || !row.name || row.name !== row.name.trim()
      || [...row.name].length > 100 || /[\u0000-\u001f\u007f]/u.test(row.name) || byId.has(row.id)) {
      throw new ServiceUnavailableException('提货点省市区目录字段异常');
    }
    const name = JSON.stringify([row.pid, row.name]);
    if (names.has(name)) throw new ServiceUnavailableException('提货点省市区名称路径存在歧义');
    names.add(name); byId.set(row.id, row);
  }
  for (const row of rows) {
    if (row.level === 1 ? row.pid !== 0 : !byId.has(row.pid) || byId.get(row.pid)!.level !== row.level - 1) {
      throw new ServiceUnavailableException('提货点省市区父级或层级异常');
    }
  }
  return rows.map(row => ({ id: row.id, pid: row.pid, level: row.level as 1 | 2 | 3, name: row.name }));
}

/** Dedicated store.manage selection/config reads. No attachment management,
 * provider/R2 access, KV cache population or configuration mutations. */
export class AdminStoreSupportService {
  constructor(private readonly container: Container, private readonly env: Pick<Env, 'APP_KEY'>) {}

  private read<T>(actor: AdminAuthorityActor, work: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      await authorizeAdminLegacyProductRead(tx, actor, 'store.manage');
      const result = await work(tx);
      await assertAdminLegacyProductReadDeadline(tx, actor);
      return result;
    });
  }

  async categories(query: URLSearchParams, actor: AdminAuthorityActor) {
    parameters(query, []);
    return this.read(actor, async tx => {
      const rows = await tx.select({ id: systemAttachmentCategory.id, pid: systemAttachmentCategory.pid, name: systemAttachmentCategory.name })
        .from(systemAttachmentCategory).where(and(eq(systemAttachmentCategory.type, 1), eq(systemAttachmentCategory.relationId, 0), eq(systemAttachmentCategory.fileType, 1)))
        .orderBy(asc(systemAttachmentCategory.id)).limit(IMAGE_CAPACITY + 1);
      if (rows.length > IMAGE_CAPACITY) throw new ServiceUnavailableException('提货点图库分类超过5000项，不能截断');
      return { list: rows };
    });
  }

  async options(query: URLSearchParams, actor: AdminAuthorityActor) {
    parameters(query, ['page', 'limit', 'pid', 'name']);
    const page = integer(query.get('page'), 1, 1, 5000), limit = integer(query.get('limit'), 20, 1, 100), pid = integer(query.get('pid'), 0, 0, 2_147_483_647);
    const name = query.get('name') ?? '';
    if ([...name].length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) throw new ValidateException('提货点图库名称查询无效');
    const snapshot = await this.read(actor, async tx => {
      if (pid > 0) {
        const [category] = await tx.select({ id: systemAttachmentCategory.id }).from(systemAttachmentCategory)
          .where(and(eq(systemAttachmentCategory.id, pid), eq(systemAttachmentCategory.type, 1), eq(systemAttachmentCategory.relationId, 0), eq(systemAttachmentCategory.fileType, 1))).limit(1);
        if (!category) throw new NotFoundException('平台图片分类不存在');
      }
      const rows = await tx.select().from(systemAttachment).where(and(eq(systemAttachment.type, 1), eq(systemAttachment.relationId, 0),
        eq(systemAttachment.moduleType, 1), eq(systemAttachment.fileType, 1), eq(systemAttachment.pid, pid)))
        .orderBy(desc(systemAttachment.attId)).limit(IMAGE_CAPACITY + 1);
      if (rows.length > IMAGE_CAPACITY) throw new ServiceUnavailableException('当前图片分类超过5000项，请先整理，不能截断目录');
      const references = await publicStoreImageReferences(tx, rows.map(row => ({ image: row.attDir })));
      const eligible = rows.flatMap((row, index) => references[index]?.image
        && (parseCanonicalAttachmentId(references[index]!.image) === null || references[index]!.image === `/api/assets/${row.attId}`)
        && row.realName.includes(name)
        ? [{ att_id: row.attId, pid: row.pid, real_name: row.realName, reference: references[index]!.image }] : []);
      return { list: eligible.slice((page - 1) * limit, page * limit), count: eligible.length };
    });
    const previews = await renderStoreImageReferences(this.env.APP_KEY, snapshot.list.map(row => ({ image: row.reference })));
    assertAdminAuthoritySession(actor);
    return { list: snapshot.list.map((row, index): StoreAttachmentOption => ({ ...row, preview: previews[index]!.image })), count: snapshot.count, page, limit };
  }

  async regions(query: URLSearchParams, actor: AdminAuthorityActor) {
    parameters(query, []);
    return this.read(actor, async tx => {
      const source = await tx.select({ id: cityArea.id, pid: cityArea.parentId, level: cityArea.level, name: cityArea.name })
        .from(cityArea).where(inArray(cityArea.level, [1, 2, 3])).orderBy(asc(cityArea.level), asc(cityArea.snum), asc(cityArea.id)).limit(REGION_CAPACITY + 1);
      const list = checkedStoreRegionDirectory(source);
      return { list, count: list.length };
    });
  }

  async mapConfig(query: URLSearchParams, actor: AdminAuthorityActor): Promise<{ available: boolean; url: string; origin: typeof MAP_ORIGIN }> {
    parameters(query, []);
    return this.read(actor, async tx => {
      const [row] = await tx.select({ value: systemConfig.value }).from(systemConfig)
        .where(and(eq(systemConfig.isStore, 0), eq(systemConfig.menuName, 'tengxun_map_key')))
        .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(1);
      const key = normalizeConfigScalar(row?.value);
      if (key === '0' || !/^[A-Za-z0-9_-]{1,255}$/u.test(key)) return { available: false, url: '', origin: MAP_ORIGIN };
      const url = new URL('/tools/locpicker', MAP_ORIGIN);
      url.searchParams.set('type', '1');
      url.searchParams.set('key', key);
      url.searchParams.set('referer', 'myapp');
      return { available: true, url: url.toString(), origin: MAP_ORIGIN };
    });
  }
}
