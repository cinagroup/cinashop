import { and, eq, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { systemDise, systemLog } from '@/models/schema';
import { lockDiseCatalogForMutation, projectThemeCatalog, THEME_TEMPLATE_NAME, themeCatalog, themeDeadlines, themeHash, ThemeReadService } from '@/services/content/ThemeReadService';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { themeCanonical, themeRequestId, ThemeSettingsRejected, ThemeSettingsStaleVersion, type ThemeReceipt } from './AdminThemeSettingsInput';

export const THEME_SETTINGS_LOCK_NAMESPACE = 731_719;
const JOURNAL_TYPE = 'theme_settings';
const receiptPath = (requestId: string) => `/setting/theme-style/request/${requestId}`;
function receiptFrom(value: string, request_id: string): ThemeReceipt | null {
  const match = /^update;id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(value);
  if (!match || Number(match[1]) > 2147483647) return null;
  return { operation: 'update', id: Number(match[1]), request_id, payload_hash: match[2] };
}
function actorId(actor: { id: number }) {
  if (!actor || !Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2147483647) throw new ValidateException('管理员身份无效');
  return actor.id;
}

export class AdminThemeSettingsService {
  constructor(private readonly container: Container) {}
  read() { return new ThemeReadService(this.container).read(); }
  async receipt(value: unknown, actor: { id: number }): Promise<ThemeReceipt> {
    const request_id = themeRequestId(value), id = actorId(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await themeDeadlines(tx);
      const rows = await tx.select({ action: systemLog.action }).from(systemLog)
        .where(and(eq(systemLog.type, JOURNAL_TYPE), eq(systemLog.path, receiptPath(request_id)), eq(systemLog.adminId, id))).limit(2);
      if (!rows.length) throw new NotFoundException('主题操作回执不存在');
      const receipt = rows.length === 1 ? receiptFrom(rows[0].action, request_id) : null;
      if (!receipt) throw new ValidateException('主题回执异常，无法确认结果');
      return receipt;
    });
  }
  async save(input: unknown, actor: { id: number }): Promise<ThemeReceipt> {
    const id = actorId(actor), { request_id, canonical } = themeCanonical(input), payload_hash = await themeHash(canonical);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`); await themeDeadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${THEME_SETTINGS_LOCK_NAMESPACE},0)`);
      const journals = await tx.select({ action: systemLog.action, actor: systemLog.adminId }).from(systemLog)
        .where(and(eq(systemLog.type, JOURNAL_TYPE), eq(systemLog.path, receiptPath(request_id)))).limit(2);
      if (journals.length) {
        const receipt = journals.length === 1 ? receiptFrom(journals[0].action, request_id) : null;
        if (!receipt || journals[0].actor !== id || receipt.payload_hash !== payload_hash) throw new ValidateException('请求标识已用于其他主题操作');
        return receipt;
      }
      await lockDiseCatalogForMutation(tx);
      const catalog = await themeCatalog(tx);
      if (catalog.revision !== canonical.revision) throw new ThemeSettingsStaleVersion(request_id, payload_hash);
      const snapshot = projectThemeCatalog(catalog);
      if (!snapshot.editable) throw new ThemeSettingsRejected('主题模板存在重复或身份异常，不能自动合并，请先处理导入数据', request_id, payload_hash);
      const now = Math.floor(Date.now() / 1000), version = crypto.randomUUID();
      let resultId: number;
      if (catalog.rows[0]) {
        resultId = catalog.rows[0].id;
        await tx.update(systemDise).set({ value: String(canonical.status), version,
          updateTime: sql<number>`GREATEST(${systemDise.updateTime}+1,${now})` }).where(eq(systemDise.id, resultId));
      } else {
        const [created] = await tx.insert(systemDise).values({ name: '一键换色', title: '一键换色', templateName: THEME_TEMPLATE_NAME,
          type: 3, value: String(canonical.status), version, status: 0, isShow: 0, isDel: 0, isDiy: 1,
          addTime: now, updateTime: now }).returning({ id: systemDise.id });
        resultId = created.id;
      }
      await tx.insert(systemLog).values({ adminId: id, type: JOURNAL_TYPE, path: receiptPath(request_id), page: JOURNAL_TYPE, method: 'POST',
        action: `update;id=${resultId};payload=${payload_hash}`, addTime: now });
      return { operation: 'update', id: resultId, request_id, payload_hash };
    });
  }
}
