import { and, eq, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { shippingTemplates, shippingTemplatesRegion } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { assertShippingTemplateUnreferenced } from '../product/ShippingTemplateLifecycleService';

type Fields = Pick<typeof shippingTemplates.$inferInsert, 'name' | 'type' | 'sort' | 'status'>;
type Region = Pick<typeof shippingTemplatesRegion.$inferInsert,
  'regionId' | 'regionName' | 'first' | 'firstPrice' | 'continue' | 'continuePrice'>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('运费模板数据格式错误');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    throw new ValidateException('运费模板整数参数无效');
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new ValidateException('运费模板整数参数越界');
  return result;
}
function decimal(value: unknown): string {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d{1,10}(?:\.\d{1,2})?$/.test(String(value))) {
    throw new ValidateException('运费模板计量或金额格式无效');
  }
  const [whole, fraction = ''] = String(value).split('.');
  return `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
}
function parse(raw: unknown) {
  const input = record(raw), id = input.id === undefined ? 0 : integer(input.id, 0, 2_147_483_647);
  const fields: Fields = {};
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 255) throw new ValidateException('请输入有效模板名称');
    fields.name = input.name.trim();
  }
  if (!id && !fields.name) throw new ValidateException('请输入模板名称');
  if (input.type !== undefined) fields.type = integer(input.type, 1, 3);
  if (input.sort !== undefined) fields.sort = integer(input.sort, 0, 2_147_483_647);
  if (input.status !== undefined) fields.status = integer(input.status, 0, 1);
  let regions: Region[] | undefined;
  if (input.regions !== undefined) {
    if (!Array.isArray(input.regions) || input.regions.length > 1000) throw new ValidateException('运费模板区域必须是最多1000项的数组');
    regions = input.regions.map(value => {
      const row = record(value);
      if (typeof row.region_name !== 'string' || row.region_name.length > 255) throw new ValidateException('运费模板区域名称无效');
      return { regionId: integer(row.region_id, 0, 2_147_483_647), regionName: row.region_name,
        first: decimal(row.first ?? '1'), firstPrice: decimal(row.first_price ?? '0'),
        continue: decimal(row.continue ?? '1'), continuePrice: decimal(row.continue_price ?? '0') };
    });
  }
  return { id, fields, regions };
}

/** Global-admin writer. Scope/creation fields and specialized free/no-delivery
 * rules cannot be overwritten by this legacy flat form. Every child mutation
 * holds its parent NO KEY UPDATE until commit, compatible with the supplier
 * writer's existing FOR UPDATE boundary. No external I/O in this transaction.
 * These are statement/lock/idle bounds, not a total transaction deadline.
 */
export async function saveAdminShippingTemplate(container: Container, raw: unknown) {
  const input = parse(raw);
  try {
    return await withTx(container, async tx => {
      await tx.execute(sql.raw(`SELECT
        set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
        set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
        set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
      const now = Math.floor(Date.now() / 1000);
      let id = input.id, billingGroup = input.fields.type ?? 1;
      if (id) {
        const [current] = await tx.select({ id: shippingTemplates.id, type: shippingTemplates.type, status: shippingTemplates.status }).from(shippingTemplates)
          .where(and(eq(shippingTemplates.id, id), eq(shippingTemplates.isDel, 0))).limit(1).for('no key update');
        if (!current) throw new ValidateException('运费模板不存在或已删除');
        billingGroup = input.fields.type ?? current.type;
        if (input.fields.status === 0 && current.status !== 0) await assertShippingTemplateUnreferenced(tx, id);
        if (Object.keys(input.fields).length) await tx.update(shippingTemplates).set(input.fields).where(eq(shippingTemplates.id, id));
      } else {
        const [created] = await tx.insert(shippingTemplates).values({ ...input.fields, ownerType: 0, relationId: 0,
          appoint: 0, noDelivery: 0, isDel: 0, addTime: now }).returning({ id: shippingTemplates.id });
        if (!created) throw new ValidateException('运费模板创建失败');
        id = created.id;
      }
      // Omission preserves existing rows; an explicit [] intentionally clears them.
      if (input.regions !== undefined) {
        await tx.delete(shippingTemplatesRegion).where(eq(shippingTemplatesRegion.templateId, id));
        if (input.regions.length) await tx.insert(shippingTemplatesRegion).values(
          input.regions.map(row => ({ ...row, templateId: id, billingGroup, addTime: now })),
        );
      }
      return { id, created: input.id === 0 };
    });
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('运费模板正在更新，请稍后重试');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}
