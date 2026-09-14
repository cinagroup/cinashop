import { and, asc, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { shippingTemplates, systemCity } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { shippingLifecycleLock, retireShippingTemplate } from '../product/ShippingTemplateLifecycleService';
import { readShippingEditorSnapshot, boundShippingTransaction, requireShippingRevision, assertShippingRevision } from '../product/ShippingTemplateRevision';
import { boundShippingTemplateTransaction } from '../order/ShippingTemplateSnapshot';
import { shippingRuleInteger as integer, normalizeSupplierShippingTemplateInput, formatValidatedShippingRuleGroups, cityAuthority, replaceRules } from '../product/ShippingTemplateRules';
export { normalizeSupplierShippingTemplateInput, formatLegacyShippingRuleGroups, formatValidatedShippingRuleGroups, cityAuthority, replaceRules } from '../product/ShippingTemplateRules';
export type { SupplierShippingTemplateInput } from '../product/ShippingTemplateRules';

const SUPPLIER_OWNER_TYPE = 2;
const SHIPPING_LOCK_NAMESPACE = 731_604;
const MAX_CITY_ROOTS = 64;
const MAX_CITY_CHILDREN = 1_000;
type UnknownRecord = Record<string, unknown>;

function templateScope(supplierId: number, templateId?: number) {
  return and(
    templateId === undefined ? undefined : eq(shippingTemplates.id, templateId),
    eq(shippingTemplates.ownerType, SUPPLIER_OWNER_TYPE),
    eq(shippingTemplates.relationId, supplierId),
    eq(shippingTemplates.isDel, 0),
  );
}

function validSupplierId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new ValidateException("供应商ID错误");
  return value;
}

export class SupplierShippingTemplateService {
  constructor(private readonly container: Container) {}

  async list(supplierIdValue: number, query: Record<string, string>) {
    const supplierId = validSupplierId(supplierIdValue);
    const page = integer(query.page || 1, "页码", 1, 1_000_000);
    const limit = integer(query.limit || 15, "每页数量", 1, 100);
    const name = (query.name ?? "").trim();
    if (name.length > 255) throw new ValidateException("搜索名称不能超过255个字符");
    const where = and(templateScope(supplierId), name ? ilike(shippingTemplates.name, `%${name}%`) : undefined);
    const [rows, countRows] = await Promise.all([
      this.container.db
        .select({
          id: shippingTemplates.id,
          name: shippingTemplates.name,
          billingType: shippingTemplates.type,
          appoint: shippingTemplates.appoint,
          sort: shippingTemplates.sort,
          addTime: sql<string>`to_char(to_timestamp(${shippingTemplates.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')`,
        })
        .from(shippingTemplates)
        .where(where)
        .orderBy(desc(shippingTemplates.sort), desc(shippingTemplates.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(shippingTemplates)
        .where(where),
    ]);
    const typeNames: Record<number, string> = { 1: "按件数", 2: "按重量", 3: "按体积" };
    return {
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: typeNames[row.billingType] ?? "",
        appoint: row.appoint === 1 ? "开启" : "关闭",
        sort: row.sort,
        add_time: row.addTime,
      })),
      count: countRows[0]?.count ?? 0,
    };
  }

  async detail(supplierIdValue: number, templateId: number) {
    const supplierId = validSupplierId(supplierIdValue);
    if (!Number.isSafeInteger(templateId) || templateId <= 0 || templateId > 2_147_483_647) throw new ValidateException("运费模板ID错误");
    return shippingLifecycleLock(() => withTx(this.container, async tx => {
      await boundShippingTransaction(tx);
      const { snapshot: s, revision } = await readShippingEditorSnapshot(tx, templateId, supplierId);
      const templateList = formatValidatedShippingRuleGroups(s.regions.map(r => ({ ...r, cityId: r.regionId })), "region");
      if (!templateList.some(row => (row.city_ids as number[][]).some(path => path.length === 1 && path[0] === 0))) {
        templateList.unshift({ city_ids: [[0]], city_id: [0], regionName: "默认全国" });
      }
      return { revision,
        appointList: formatValidatedShippingRuleGroups(s.free.map(r => ({ ...r })), "free"),
        templateList,
        noDeliveryList: formatValidatedShippingRuleGroups(s.noDelivery.map(r => ({ ...r })), "no_delivery"),
        formData: { name: s.template.name, type: s.template.type, appoint_check: s.template.appoint,
          no_delivery_check: s.template.noDelivery, sort: s.template.sort },
      };
    }));
  }

  async save(
    supplierIdValue: number,
    templateId: number,
    rawInput: UnknownRecord,
  ): Promise<number> {
    const supplierId = validSupplierId(supplierIdValue);
    if (!Number.isSafeInteger(templateId) || templateId < 0 || templateId > 2_147_483_647) throw new ValidateException("运费模板ID错误");
    const expectedRevision = templateId > 0 ? requireShippingRevision(rawInput.expectedRevision) : undefined;
    const input = normalizeSupplierShippingTemplateInput(rawInput);
    return shippingLifecycleLock(() => withTx(this.container, async (tx) => {
      await boundShippingTemplateTransaction(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SHIPPING_LOCK_NAMESPACE}, ${supplierId})`);
      const cities = await cityAuthority(tx, input);
      const now = Math.floor(Date.now() / 1_000);
      let savedId = templateId;
      if (templateId > 0) {
        const existing = await tx
          .select({ id: shippingTemplates.id })
          .from(shippingTemplates)
          .where(templateScope(supplierId, templateId))
          .limit(1)
          .for("update");
        if (!existing[0]) throw new NotFoundException("运费模板不存在或不属于当前供应商");
        // A new RC statement after the parent lock observes commits made while waiting.
        await assertShippingRevision(tx, templateId, expectedRevision!);
        await tx
          .update(shippingTemplates)
          .set({
            name: input.name,
            type: input.billingType,
            appoint: input.appoint,
            noDelivery: input.noDelivery,
            sort: input.sort,
            addTime: now,
          })
          .where(templateScope(supplierId, templateId));
      } else {
        const inserted = await tx
          .insert(shippingTemplates)
          .values({
            ownerType: SUPPLIER_OWNER_TYPE,
            relationId: supplierId,
            name: input.name,
            type: input.billingType,
            appoint: input.appoint,
            noDelivery: input.noDelivery,
            sort: input.sort,
            status: 1,
            isDel: 0,
            addTime: now,
          })
          .returning({ id: shippingTemplates.id });
        savedId = inserted[0].id;
      }
      await replaceRules(tx, savedId, input, cities, now);
      return savedId;
    }));
  }

  async delete(supplierIdValue: number, templateId: number): Promise<void> {
    const supplierId = validSupplierId(supplierIdValue);
    await retireShippingTemplate(this.container, templateId, supplierId);
  }

  async cityList() {
    const roots = await this.container.db
      .select()
      .from(systemCity)
      .where(eq(systemCity.parentId, 0))
      .orderBy(asc(systemCity.id))
      .limit(MAX_CITY_ROOTS + 1);
    if (roots.length > MAX_CITY_ROOTS) throw new ValidateException("省份数据超过安全上限");
    const rootIds = roots.map((row) => row.cityId);
    const children = rootIds.length
      ? await this.container.db
          .select()
          .from(systemCity)
          .where(inArray(systemCity.parentId, rootIds))
          .orderBy(asc(systemCity.id))
          .limit(MAX_CITY_CHILDREN + 1)
      : [];
    if (children.length > MAX_CITY_CHILDREN) throw new ValidateException("城市数据超过安全上限");
    const byParent = new Map<number, typeof children>();
    for (const child of children) byParent.set(child.parentId, [...(byParent.get(child.parentId) ?? []), child]);
    const legacy = (row: typeof systemCity.$inferSelect) => ({
      id: row.id,
      city_id: row.cityId,
      level: row.level,
      parent_id: row.parentId,
      area_code: row.areaCode,
      name: row.name,
      merger_name: row.mergerName,
      lng: row.lng,
      lat: row.lat,
      is_show: row.isShow,
    });
    return roots.map((root) => ({
      ...legacy(root),
      children: (byParent.get(root.cityId) ?? []).map(legacy),
    }));
  }
}
