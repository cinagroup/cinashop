import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container } from '@/lib/di';
import { systemAttachment, systemDise, systemLog } from '@/models/schema';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { fabCatalog, fabDeadlines, fabProject, renderFabSnapshot } from '@/services/content/FabReadService';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { FAB_MAX_VALUE_BYTES, FAB_TEMPLATE_NAME, FabSettingsRejected, FabSettingsStaleVersion, fabCanonical, fabHash, fabObject, fabRequestId, validateFabValues, type FabReceipt } from './AdminFabSettingsInput';

export const FAB_SETTINGS_LOCK_NAMESPACE = 731_700;
const JOURNAL_TYPE = 'fab_settings';
const receiptPath = (requestId: string) => `/setting/fab/request/${requestId}`;
function receiptFrom(value: string, request_id: string): FabReceipt | null {
  const match = /^update;id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(value);
  if (!match || Number(match[1]) > 2147483647) return null;
  return { operation: 'update', id: Number(match[1]), request_id, payload_hash: match[2] };
}
function actorId(actor: { id: number }) {
  if (!actor || !Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2147483647) throw new ValidateException('管理员身份无效');
  return actor.id;
}
export class AdminFabSettingsService {
  constructor(private readonly container: Container, private readonly env: Pick<Env, 'APP_KEY'>) {}
  async read() {
    const snapshot = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await fabDeadlines(tx);
      return (await fabProject(tx, await fabCatalog(tx))).snapshot;
    });
    return renderFabSnapshot(this.env, snapshot);
  }
  async receipt(value: unknown, actor: { id: number }): Promise<FabReceipt> {
    const requestId = fabRequestId(value), id = actorId(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await fabDeadlines(tx);
      const rows = await tx.select({ action: systemLog.action }).from(systemLog).where(and(eq(systemLog.type, JOURNAL_TYPE), eq(systemLog.path, receiptPath(requestId)), eq(systemLog.adminId, id))).limit(2);
      if (!rows.length) throw new NotFoundException('悬浮按钮操作回执不存在');
      const receipt = rows.length === 1 ? receiptFrom(rows[0].action, requestId) : null;
      if (!receipt) throw new ValidateException('悬浮按钮回执异常，无法确认结果');
      return receipt;
    });
  }
  async save(input: unknown, actor: { id: number }): Promise<FabReceipt> {
    const id = actorId(actor), { request_id, canonical } = fabCanonical(input), payload_hash = await fabHash(canonical);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`); await fabDeadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${FAB_SETTINGS_LOCK_NAMESPACE},0)`);
      const journals = await tx.select({ action: systemLog.action, actor: systemLog.adminId }).from(systemLog)
        .where(and(eq(systemLog.type, JOURNAL_TYPE), eq(systemLog.path, receiptPath(request_id)))).limit(2);
      if (journals.length) {
        const receipt = journals.length === 1 ? receiptFrom(journals[0].action, request_id) : null;
        if (!receipt || journals[0].actor !== id || receipt.payload_hash !== payload_hash) throw new ValidateException('请求标识已用于其他悬浮按钮操作');
        return receipt;
      }
      // First catalogue lock, before any row lock. It fences inserts (including
      // a missing template) and legacy generic writers lacking our advisory.
      await tx.execute(sql`LOCK TABLE ${systemDise} IN SHARE ROW EXCLUSIVE MODE`);
      const catalog = await fabCatalog(tx);
      if (catalog.revision !== canonical.revision) throw new FabSettingsStaleVersion(request_id, payload_hash);
      const { snapshot, source, sourceIds } = await fabProject(tx, catalog);
      let merged: string;
      try {
        if (!snapshot.editable) throw new ValidateException(snapshot.issues.join('；'));
        const values = canonical.values; validateFabValues(values);
        const used = new Set<string>();
        const button = values.button.map(row => {
          let previous: Record<string, unknown> = {};
          if (row.source_id !== null) {
            if (!sourceIds.has(row.source_id) || used.has(row.source_id)) throw new ValidateException('子按钮来源失效或重复，请重新读取并明确关联');
            used.add(row.source_id);
            try { previous = fabObject(sourceIds.get(row.source_id)); } catch { /* Explicitly repair an invalid known array member. */ }
          }
          return { ...previous, img: row.img, url: row.url };
        });
        merged = JSON.stringify({ ...(source ?? {}), is_show: values.is_show, index: values.index, shifting: values.shifting,
          main_ago_image: values.main_ago_image, main_after_image: values.main_after_image, button });
        if (new TextEncoder().encode(merged).byteLength > FAB_MAX_VALUE_BYTES) throw new ValidateException('合并后的历史配置超过安全容量，未保存');
        const references = [values.main_ago_image, values.main_after_image, ...values.button.map(row => row.img)].filter(Boolean);
        const assetIds = [...new Set(references.map(parseCanonicalAttachmentId).filter((value): value is number => value !== null))].sort((a,b) => a-b);
        // Ascending actual attachment rows; no signing, R2 or provider I/O in tx.
        for (const assetId of assetIds) await tx.select({ id: systemAttachment.attId }).from(systemAttachment).where(eq(systemAttachment.attId, assetId)).for('share');
        const available = await publicProductPictures(tx, references.map(image => ({ type: 0, relationId: 0, image })));
        if (available.some(reference => reference === '')) throw new ValidateException('图片素材不可用或不属于平台');
      } catch (error) {
        // Only this preparation phase can prove a deterministic rejection.
        // Raw parse, UUID/journal, SQL and later DML errors never emit its code.
        if (error instanceof ValidateException && error.constructor === ValidateException) throw new FabSettingsRejected(error.message, request_id, payload_hash);
        throw error;
      }
      const now = Math.floor(Date.now() / 1000), version = crypto.randomUUID();
      let resultId: number;
      if (catalog.rows[0]) {
        resultId = catalog.rows[0].id;
        await tx.update(systemDise).set({ value: merged, version, updateTime: sql<number>`GREATEST(${systemDise.updateTime}+1,${now})` }).where(eq(systemDise.id, resultId));
      } else {
        const [created] = await tx.insert(systemDise).values({ name: '悬浮窗', title: '悬浮窗可视化', templateName: FAB_TEMPLATE_NAME, type: 3,
          value: merged, version, status: 0, isShow: 0, isDel: 0, isDiy: 0, addTime: now, updateTime: now }).returning({ id: systemDise.id });
        resultId = created.id;
      }
      await tx.insert(systemLog).values({ adminId: id, type: JOURNAL_TYPE, path: receiptPath(request_id), page: 'fab_settings', method: 'POST',
        action: `update;id=${resultId};payload=${payload_hash}`, addTime: now });
      return { operation: 'update', id: resultId, request_id, payload_hash };
    });
  }
}
