import { createHash } from 'node:crypto';
import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemAttachment, systemAttachmentCategory, user } from '@/models/schema';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { publicDeliveryAvatarReferences, renderDeliveryAvatarReferences } from '@/services/delivery/DeliveryAvatarPolicy';
import { NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { assertAdminAuthoritySession, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { authorizeAdminLegacyProductRead, assertAdminLegacyProductReadDeadline } from './AdminLegacyProductReadAuthority';

const IMAGE_CAPACITY = 5000;
export interface DeliveryUserSelectionRow { uid: number; nickname: string; phone: string; avatar: string; status: number; isDel: number; deleteTime: Date | null; rowVersion: string }
/** A complete source stamp, not an authorization token. The author must lock
 * and independently verify this same current user before using the selection. */
export function deliveryUserSelection(row: DeliveryUserSelectionRow): string {
  if (!Number.isSafeInteger(row.uid) || row.uid < 1 || row.uid > 2_147_483_647 || typeof row.nickname !== 'string' || [...row.nickname].length > 60
    || typeof row.phone !== 'string' || [...row.phone].length > 15
    || typeof row.avatar !== 'string' || [...row.avatar].length > 256 || !Number.isSafeInteger(row.status) || !Number.isSafeInteger(row.isDel)
    || row.deleteTime !== null && (!(row.deleteTime instanceof Date) || !Number.isFinite(row.deleteTime.getTime()))
    || typeof row.rowVersion !== 'string' || !/^[1-9]\d*$/u.test(row.rowVersion)) throw new ValidateException('所选用户快照无效');
  return createHash('sha256').update(JSON.stringify({ domain: 'delivery-user-selection-v1', uid: row.uid, nickname: row.nickname, phone: row.phone, avatar: row.avatar,
    status: row.status, isDel: row.isDel, deleteTime: row.deleteTime?.toISOString() ?? null, rowVersion: row.rowVersion })).digest('hex');
}
function parameters(query: URLSearchParams, allowed: readonly string[]) {
  for (const [key] of query) if (!allowed.includes(key) || query.getAll(key).length !== 1) throw new ValidateException('配送员选择查询字段无效或重复');
}
function integer(raw: string | null, fallback: number, min: number, max: number) {
  if (raw === null) return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) throw new ValidateException('配送员选择分页或分类无效');
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new ValidateException('配送员选择分页或分类超出范围'); return value;
}
function name(value: string, label: string) { if ([...value].length > 80 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ValidateException(label + '查询无效'); return value; }
export interface DeliveryUserOption { uid: number; nickname: string; phone: string; avatar: string; preview: string; selection: string }
export interface DeliveryAttachmentOption { att_id: number; pid: number; real_name: string; reference: string; preview: string }

/** Dedicated live order.manage selection reads. No user/profile writes, no
 * broad user.view/attachment.manage grant, no provider/R2/KV interaction. */
export class AdminDeliverySupportService {
  constructor(private readonly container: Container, private readonly env: Pick<Env, 'APP_KEY'>) {}
  private read<T>(actor: AdminAuthorityActor, work: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await tx.execute(sql`SET LOCAL lock_timeout='2s'`); await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      await authorizeAdminLegacyProductRead(tx, actor, 'order.manage'); const result = await work(tx); await assertAdminLegacyProductReadDeadline(tx, actor); return result;
    });
  }
  async users(query: URLSearchParams, actor: AdminAuthorityActor, excludePlatformAssigned = false) {
    parameters(query, ['page', 'limit', 'keyword']);
    const page = integer(query.get('page'), 1, 1, 2_147_483_647), limit = integer(query.get('limit'), 20, 1, 100), keyword = name(query.get('keyword') ?? '', '用户');
    const numeric = /^[1-9]\d*$/u.test(keyword) && Number.isSafeInteger(Number(keyword)) && Number(keyword) <= 2_147_483_647 ? Number(keyword) : null;
    const pattern = `%${keyword.replace(/[\\%_]/gu, value => '\\' + value)}%`;
    const where = and(eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime), excludePlatformAssigned ? sql`NOT EXISTS (SELECT 1 FROM public.delivery_service d WHERE d.uid=${user.uid} AND d.type=0 AND d.relation_id=0 AND d.is_del=0)` : undefined, keyword ? or(numeric === null ? undefined : eq(user.uid, numeric), ilike(user.nickname, pattern)) : undefined);
    const snapshot = await this.read(actor, async tx => {
      const [total] = await tx.select({ count: sql<number>`count(*)::integer` }).from(user).where(where);
      const rows = await tx.select({ uid: user.uid, nickname: user.nickname, phone: user.phone, avatar: user.avatar, status: user.status, isDel: user.isDel,
        deleteTime: user.deleteTime, rowVersion: sql<string>`xmin::text` }).from(user).where(where).orderBy(desc(user.uid)).limit(limit).offset((page - 1) * limit);
      const count = total?.count;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 2_147_483_647 || rows.length !== Math.max(0, Math.min(limit, count - (page - 1) * limit))) throw new ServiceUnavailableException('用户选择目录计数或分页不完整');
      const references = await publicDeliveryAvatarReferences(tx, rows.map(row => ({ avatar: row.avatar, uid: row.uid, userAvatar: row.avatar })));
      return { count, list: rows.map((row, index) => ({ uid: row.uid, nickname: row.nickname, phone: row.phone, avatar: row.avatar, reference: references[index]!.avatar, selection: deliveryUserSelection(row) })) };
    });
    const previews = await renderDeliveryAvatarReferences(this.env.APP_KEY, snapshot.list.map(row => ({ avatar: row.reference }))); assertAdminAuthoritySession(actor);
    return { list: snapshot.list.map((row, index): DeliveryUserOption => ({ uid: row.uid, nickname: row.nickname, phone: row.phone, avatar: row.avatar, preview: previews[index]!.avatar, selection: row.selection })), count: snapshot.count, page, limit };
  }
  async categories(query: URLSearchParams, actor: AdminAuthorityActor) {
    parameters(query, []);
    return this.read(actor, async tx => {
      const rows = await tx.select({ id: systemAttachmentCategory.id, pid: systemAttachmentCategory.pid, name: systemAttachmentCategory.name }).from(systemAttachmentCategory)
        .where(and(eq(systemAttachmentCategory.type, 1), eq(systemAttachmentCategory.relationId, 0), eq(systemAttachmentCategory.fileType, 1)))
        .orderBy(asc(systemAttachmentCategory.id)).limit(IMAGE_CAPACITY + 1);
      if (rows.length > IMAGE_CAPACITY) throw new ServiceUnavailableException('配送员头像图库分类超过5000项，不能截断'); return { list: rows };
    });
  }
  async options(query: URLSearchParams, actor: AdminAuthorityActor) {
    parameters(query, ['page', 'limit', 'pid', 'name']);
    const page = integer(query.get('page'), 1, 1, 5000), limit = integer(query.get('limit'), 20, 1, 100), pid = integer(query.get('pid'), 0, 0, 2_147_483_647), keyword = name(query.get('name') ?? '', '头像');
    const snapshot = await this.read(actor, async tx => {
      if (pid > 0) { const [category] = await tx.select({ id: systemAttachmentCategory.id }).from(systemAttachmentCategory)
        .where(and(eq(systemAttachmentCategory.id, pid), eq(systemAttachmentCategory.type, 1), eq(systemAttachmentCategory.relationId, 0), eq(systemAttachmentCategory.fileType, 1))).limit(1);
        if (!category) throw new NotFoundException('平台头像分类不存在'); }
      const rows = await tx.select().from(systemAttachment).where(and(eq(systemAttachment.type, 1), eq(systemAttachment.relationId, 0), eq(systemAttachment.moduleType, 1), eq(systemAttachment.fileType, 1), eq(systemAttachment.pid, pid)))
        .orderBy(desc(systemAttachment.attId)).limit(IMAGE_CAPACITY + 1);
      if (rows.length > IMAGE_CAPACITY) throw new ServiceUnavailableException('当前头像分类超过5000项，请先整理，不能截断');
      const references = await publicDeliveryAvatarReferences(tx, rows.map(row => ({ avatar: row.attDir, uid: 0 })));
      const list = rows.flatMap((row, index) => references[index]?.avatar && (parseCanonicalAttachmentId(references[index]!.avatar) === null || references[index]!.avatar === `/api/assets/${row.attId}`) && row.realName.includes(keyword)
        ? [{ att_id: row.attId, pid: row.pid, real_name: row.realName, reference: references[index]!.avatar }] : []);
      return { list: list.slice((page - 1) * limit, page * limit), count: list.length };
    });
    const previews = await renderDeliveryAvatarReferences(this.env.APP_KEY, snapshot.list.map(row => ({ avatar: row.reference }))); assertAdminAuthoritySession(actor);
    return { list: snapshot.list.map((row, index): DeliveryAttachmentOption => ({ ...row, preview: previews[index]!.avatar })), count: snapshot.count, page, limit };
  }
}
