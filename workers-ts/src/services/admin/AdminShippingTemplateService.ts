import { and, eq, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { shippingTemplates, shippingTemplatesRegion } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { assertShippingTemplateUnreferenced } from '../product/ShippingTemplateLifecycleService';
import { assertShippingRevision, requireShippingRevision } from './AdminShippingTemplateSnapshot';
import { saveGroupedAdminShippingTemplate } from './AdminShippingTemplateGroupedService';
import { parseFlatAdminShippingInput as parse, shippingInputRecord as record } from '../product/FlatShippingTemplateInput';

/** Global-admin writer. Scope/creation fields and specialized free/no-delivery
 * rules cannot be overwritten by this legacy flat form. Every child mutation
 * holds its parent NO KEY UPDATE until commit, compatible with the supplier
 * writer's existing FOR UPDATE boundary. No external I/O in this transaction.
 * These are statement/lock/idle bounds, not a total transaction deadline.
 */
export async function saveAdminShippingTemplate(container: Container, raw: unknown) {
  const rawInput = record(raw);
  if (['region_info', 'appoint_info', 'no_delivery_info'].some(key => key in rawInput)) return saveGroupedAdminShippingTemplate(container, rawInput);
  const input = parse(raw);
  const revision = input.id ? requireShippingRevision(rawInput.expectedRevision) : undefined;
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
        const snapshot = await assertShippingRevision(tx, id, revision!);
        if ((input.regions !== undefined || (input.fields.type !== undefined && input.fields.type !== current.type))
          && (snapshot.regions.some(row => row.value || row.uniqid || row.provinceId) || snapshot.free.some(row => row.value || row.uniqid) || snapshot.noDelivery.some(row => row.value || row.uniqid))) {
          throw new ValidateException('旧区域表单不能覆盖分组规则，请重新打开完整模板编辑器');
        }
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
