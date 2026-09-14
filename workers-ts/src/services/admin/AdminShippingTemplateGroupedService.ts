import { and, eq } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { shippingTemplates } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { normalizeSupplierShippingTemplateInput, cityAuthority, replaceRules } from '../product/ShippingTemplateRules';
import { assertShippingTemplateUnreferenced } from '../product/ShippingTemplateLifecycleService';
import { assertShippingRevision, boundShippingTransaction, requireShippingRevision } from './AdminShippingTemplateSnapshot';
import { createShippingTemplateOnce } from '../product/ShippingTemplateCreateReplay';
import { requireShippingCreationContext, type ShippingCreationContext } from '../product/ShippingCreationContext';

function integer(value: unknown, max: number) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new ValidateException('运费模板整数参数无效');
  return Number(value);
}
/** Same global-admin authority as the flat endpoint, with complete replacement and mandatory edit baseline. */
export async function saveGroupedAdminShippingTemplate(container: Container, raw: Record<string, unknown>, creation?: ShippingCreationContext) {
  if (Object.keys(raw).some(key => !['id','name','type','status','sort','appoint','no_delivery','region_info','appoint_info','no_delivery_info','expectedRevision'].includes(key))) {
    throw new ValidateException('分组模板包含不支持的字段');
  }
  const id = integer(raw.id === undefined ? 0 : raw.id, 2_147_483_647), status = integer(raw.status === undefined ? 1 : raw.status, 1);
  const revision = id ? requireShippingRevision(raw.expectedRevision) : undefined;
  for (const key of ['type','sort','appoint','no_delivery']) integer(raw[key] === undefined ? 0 : raw[key], key === 'type' ? 3 : key === 'sort' ? 2_147_483_647 : 1);
  for (const key of ['region_info','appoint_info','no_delivery_info']) {
    if (!Array.isArray(raw[key])) throw new ValidateException('必须提交完整的三类模板规则');
    for (const row of raw[key]) {
      if (!row || typeof row !== 'object' || !('city_ids' in row) || !Array.isArray(row.city_ids)) throw new ValidateException('地区路径格式错误');
      for (const path of row.city_ids) {
        if (!Array.isArray(path)) throw new ValidateException('地区路径格式错误');
        for (const part of path) integer(part, 2_147_483_647);
      }
    }
  }
  if (typeof raw.name === 'string' && raw.name.includes('\0')) throw new ValidateException('模板名称无效');
  const input = normalizeSupplierShippingTemplateInput(raw);
  // Unlike a partial flat edit, these flags describe an explicit full replacement.
  if ((Number(raw.appoint) === 1 && !input.freeRules.length) || (Number(raw.no_delivery) === 1 && !input.noDeliveryRules.length)) {
    throw new ValidateException('开启包邮或禁配时必须设置对应区域');
  }
  if (id === 0) {
    const context = requireShippingCreationContext(creation);
    const receipt = await createShippingTemplateOnce(container, { ownerType: 0, relationId: 0, actorId: context.actorId }, context.requestKey, { ...raw, status });
    return { id: receipt.id, created: !receipt.replayed, receipt };
  }
  return withTx(container, async tx => {
    await boundShippingTransaction(tx);
    let savedId = id;
    if (id) {
      const [current] = await tx.select({ id: shippingTemplates.id, status: shippingTemplates.status }).from(shippingTemplates)
        .where(and(eq(shippingTemplates.id, id), eq(shippingTemplates.isDel, 0))).limit(1).for('no key update');
      if (!current) throw new ValidateException('运费模板不存在或已删除');
      await assertShippingRevision(tx, id, revision!);
      if (status === 0 && current.status !== 0) await assertShippingTemplateUnreferenced(tx, id);
    }
    const cities = await cityAuthority(tx, input);
    const fields = { name: input.name, type: input.billingType, status, sort: input.sort, appoint: input.appoint, noDelivery: input.noDelivery };
    const now = Math.floor(Date.now() / 1000);
    if (id) await tx.update(shippingTemplates).set(fields).where(eq(shippingTemplates.id, id));
    await replaceRules(tx, savedId, input, cities, now);
    return { id: savedId, created: false, receipt: undefined };
  });
}
