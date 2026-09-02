import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  legacyCategory,
  storeProduct,
  storeProductRelation,
  storeProductRule,
  storeProductSpecs,
  storeProductUnit,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const PLATFORM_TYPE = 0;
const SUPPLIER_TYPE = 2;
const PARAMETER_TEMPLATE_GROUP = 3;
const UNIT_LOCK_NAMESPACE = 731_611;
const RULE_LOCK_NAMESPACE = 731_612;
const SPECS_LOCK_NAMESPACE = 731_613;
const MAX_PAGE_SIZE = 100;
const MAX_TEMPLATE_SPECS = 100;

export interface MetadataOwner {
  type: 0 | 2;
  relationId: number;
}

interface RuleDimension {
  value: string;
  detail: string[];
}

interface ParameterSpecInput {
  name: string;
  value: string;
  sort: number;
  status: number;
}

function record(value: unknown, message = "参数格式错误"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException(message);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new ValidateException(`请填写${field}`);
  const normalized = value.trim();
  if (!normalized) throw new ValidateException(`请填写${field}`);
  if (normalized.length > maxLength) throw new ValidateException(`${field}不能超过${maxLength}个字符`);
  return normalized;
}

function integer(
  value: unknown,
  field: string,
  defaultValue: number,
  max = 2_147_483_647,
): number {
  if (value === undefined || value === null || value === "") return defaultValue;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new ValidateException(`${field}必须是非负整数`);
  }
  return parsed;
}

function pageInput(query: Record<string, string>) {
  return {
    page: Math.max(1, integer(query.page, "页码", 1)),
    limit: Math.max(1, Math.min(MAX_PAGE_SIZE, integer(query.limit, "每页数量", 20))),
  };
}

function scopeLockKey(owner: MetadataOwner): number {
  return owner.type === PLATFORM_TYPE ? 0 : owner.relationId;
}

function ownedUnitScope(owner: MetadataOwner) {
  return and(eq(storeProductUnit.type, owner.type), eq(storeProductUnit.relationId, owner.relationId));
}

function readableUnitScope(owner: MetadataOwner) {
  if (owner.type === PLATFORM_TYPE) return ownedUnitScope(owner);
  return or(
    and(eq(storeProductUnit.type, PLATFORM_TYPE), eq(storeProductUnit.relationId, 0)),
    ownedUnitScope(owner),
  );
}

function ownedRuleScope(owner: MetadataOwner) {
  return and(eq(storeProductRule.type, owner.type), eq(storeProductRule.relationId, owner.relationId));
}

function readableTemplateScope(owner: MetadataOwner) {
  const owned = and(
    eq(legacyCategory.type, owner.type),
    eq(legacyCategory.relationId, owner.relationId),
  );
  if (owner.type === PLATFORM_TYPE) return owned;
  return or(
    and(eq(legacyCategory.type, PLATFORM_TYPE), eq(legacyCategory.relationId, 0)),
    owned,
  );
}

function ownedTemplateScope(owner: MetadataOwner) {
  return and(
    eq(legacyCategory.type, owner.type),
    eq(legacyCategory.relationId, owner.relationId),
  );
}

export function parseProductRuleValue(value: string | null): RuleDimension[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      if (typeof row.value !== "string" || !Array.isArray(row.detail)) return [];
      const detail = row.detail.filter((entry): entry is string => typeof entry === "string");
      return row.value ? [{ value: row.value, detail }] : [];
    });
  } catch {
    return [];
  }
}

export function normalizeProductRuleInput(value: unknown): RuleDimension[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new ValidateException("商品规格维度需为1至3项");
  }
  const dimensions = value.map((item) => {
    const row = record(item, "商品规格格式错误");
    const name = requiredString(row.value ?? row.attr_name, "规格名称", 32);
    const rawDetails = row.detail ?? row.attr_values;
    if (!Array.isArray(rawDetails) || rawDetails.length < 1 || rawDetails.length > 50) {
      throw new ValidateException(`规格“${name}”至少需要一个且不能超过50个规格值`);
    }
    const detail = rawDetails.map((entry) => requiredString(entry, "规格值", 64));
    if (new Set(detail).size !== detail.length) {
      throw new ValidateException(`规格“${name}”的规格值不能重复`);
    }
    return { value: name, detail };
  });
  if (new Set(dimensions.map((item) => item.value)).size !== dimensions.length) {
    throw new ValidateException("规格名称不能重复");
  }
  return dimensions;
}

function normalizeParameterSpecs(value: unknown): ParameterSpecInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TEMPLATE_SPECS) {
    throw new ValidateException(`商品参数必须是数组且不能超过${MAX_TEMPLATE_SPECS}项`);
  }
  return value.map((item) => {
    const row = record(item, "商品参数格式错误");
    return {
      name: requiredString(row.name, "参数名称", 255),
      value: requiredString(row.value, "参数值", 255),
      sort: integer(row.sort, "参数排序", 0),
      status: integer(row.status, "参数状态", 1, 1),
    };
  });
}

function formatRule(row: {
  id: number;
  type: number;
  relationId: number;
  ruleName: string;
  ruleValue: string | null;
}) {
  const spec = parseProductRuleValue(row.ruleValue);
  return {
    id: row.id,
    type: row.type,
    relation_id: row.relationId,
    rule_name: row.ruleName,
    rule_value: row.ruleValue,
    attr_name: spec.map((item) => item.value).join(","),
    attr_value: spec.map((item) => item.detail.join(",")),
    spec,
  };
}

export class ProductMetadataService {
  constructor(private readonly container: Container) {}

  async allUnits(owner: MetadataOwner) {
    return this.container.db
      .select({ id: storeProductUnit.id, name: storeProductUnit.name })
      .from(storeProductUnit)
      .where(
        and(
          readableUnitScope(owner),
          eq(storeProductUnit.status, 1),
          eq(storeProductUnit.isDel, 0),
        ),
      )
      .orderBy(desc(storeProductUnit.sort), desc(storeProductUnit.id));
  }

  async unitList(owner: MetadataOwner, query: Record<string, string>) {
    const { page, limit } = pageInput(query);
    const conditions = [
      ownedUnitScope(owner),
      eq(storeProductUnit.status, 1),
      eq(storeProductUnit.isDel, 0),
    ];
    const name = query.name?.trim();
    if (name) conditions.push(ilike(storeProductUnit.name, `%${name}%`));
    const where = and(...conditions);
    const [list, countRows] = await Promise.all([
      this.container.db
        .select({
          id: storeProductUnit.id,
          type: storeProductUnit.type,
          relation_id: storeProductUnit.relationId,
          name: storeProductUnit.name,
          sort: storeProductUnit.sort,
          status: storeProductUnit.status,
          is_del: storeProductUnit.isDel,
          add_time: storeProductUnit.addTime,
        })
        .from(storeProductUnit)
        .where(where)
        .orderBy(desc(storeProductUnit.sort), desc(storeProductUnit.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeProductUnit)
        .where(where),
    ]);
    return { list, count: countRows[0]?.count ?? 0, page, limit };
  }

  async unitDetail(owner: MetadataOwner, id: number) {
    const rows = await this.container.db
      .select()
      .from(storeProductUnit)
      .where(and(eq(storeProductUnit.id, id), ownedUnitScope(owner), eq(storeProductUnit.isDel, 0)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("商品单位不存在");
    return {
      id: row.id,
      type: row.type,
      relation_id: row.relationId,
      name: row.name,
      sort: row.sort,
      status: row.status,
      is_del: row.isDel,
      add_time: row.addTime,
    };
  }

  async saveUnit(owner: MetadataOwner, id: number, input: unknown) {
    const body = record(input);
    const name = requiredString(body.name, "单位名称", 50);
    const sort = integer(body.sort, "排序", 0, 32_767);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${UNIT_LOCK_NAMESPACE}, ${scopeLockKey(owner)})`);
      if (id > 0) {
        const existing = await tx
          .select({ id: storeProductUnit.id })
          .from(storeProductUnit)
          .where(and(eq(storeProductUnit.id, id), ownedUnitScope(owner), eq(storeProductUnit.isDel, 0)))
          .limit(1);
        if (!existing[0]) throw new NotFoundException("商品单位不存在");
      }
      const duplicateConditions = [
        ownedUnitScope(owner),
        eq(storeProductUnit.name, name),
        eq(storeProductUnit.isDel, 0),
      ];
      if (id > 0) duplicateConditions.push(ne(storeProductUnit.id, id));
      const duplicate = await tx
        .select({ id: storeProductUnit.id })
        .from(storeProductUnit)
        .where(and(...duplicateConditions))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("单位已经存在，请勿重复添加");
      if (id > 0) {
        await tx.update(storeProductUnit).set({ name, sort }).where(eq(storeProductUnit.id, id));
        return { id };
      }
      const inserted = await tx
        .insert(storeProductUnit)
        .values({
          type: owner.type,
          relationId: owner.relationId,
          name,
          sort,
          status: 1,
          isDel: 0,
          addTime: Math.floor(Date.now() / 1000),
        })
        .returning({ id: storeProductUnit.id });
      return { id: inserted[0].id };
    });
  }

  async deleteUnit(owner: MetadataOwner, id: number) {
    return withTx(this.container, async (tx) => {
      const rows = await tx
        .select({ name: storeProductUnit.name })
        .from(storeProductUnit)
        .where(and(eq(storeProductUnit.id, id), ownedUnitScope(owner), eq(storeProductUnit.isDel, 0)))
        .limit(1)
        .for("update");
      const unit = rows[0];
      if (!unit) throw new NotFoundException("商品单位不存在");
      const used = await tx
        .select({ id: storeProduct.id })
        .from(storeProduct)
        .where(
          and(
            eq(storeProduct.unitName, unit.name),
            eq(storeProduct.type, owner.type),
            eq(storeProduct.relationId, owner.relationId),
            eq(storeProduct.isDel, 0),
          ),
        )
        .limit(1);
      if (used[0]) throw new ValidateException("该单位正在使用，不能删除");
      await tx.update(storeProductUnit).set({ isDel: 1 }).where(eq(storeProductUnit.id, id));
    });
  }

  async ruleList(owner: MetadataOwner, query: Record<string, string>) {
    const { page, limit } = pageInput(query);
    const conditions = [ownedRuleScope(owner)];
    const name = query.rule_name?.trim();
    if (name) conditions.push(ilike(storeProductRule.ruleName, `%${name}%`));
    const where = and(...conditions);
    const [rows, countRows] = await Promise.all([
      this.container.db
        .select()
        .from(storeProductRule)
        .where(where)
        .orderBy(desc(storeProductRule.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeProductRule)
        .where(where),
    ]);
    return { list: rows.map(formatRule), count: countRows[0]?.count ?? 0, page, limit };
  }

  async ruleTemplates(owner: MetadataOwner) {
    const rows = await this.container.db
      .select()
      .from(storeProductRule)
      .where(ownedRuleScope(owner))
      .orderBy(desc(storeProductRule.id));
    return rows.map((row) => ({ ...formatRule(row), rule_value: parseProductRuleValue(row.ruleValue) }));
  }

  async ruleDetail(owner: MetadataOwner, id: number) {
    const rows = await this.container.db
      .select()
      .from(storeProductRule)
      .where(and(eq(storeProductRule.id, id), ownedRuleScope(owner)))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("商品规则不存在");
    return { info: formatRule(rows[0]) };
  }

  async saveRule(owner: MetadataOwner, id: number, input: unknown) {
    const body = record(input);
    const ruleName = requiredString(body.rule_name ?? body.ruleName, "规格模板名称", 32);
    const spec = normalizeProductRuleInput(body.spec);
    const ruleValue = JSON.stringify(spec);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${RULE_LOCK_NAMESPACE}, ${scopeLockKey(owner)})`);
      if (id > 0) {
        const existing = await tx
          .select({ id: storeProductRule.id })
          .from(storeProductRule)
          .where(and(eq(storeProductRule.id, id), ownedRuleScope(owner)))
          .limit(1);
        if (!existing[0]) throw new NotFoundException("商品规则不存在");
      }
      const duplicateConditions = [ownedRuleScope(owner), eq(storeProductRule.ruleName, ruleName)];
      if (id > 0) duplicateConditions.push(ne(storeProductRule.id, id));
      const duplicate = await tx
        .select({ id: storeProductRule.id })
        .from(storeProductRule)
        .where(and(...duplicateConditions))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("规格模板名称已存在");
      if (id > 0) {
        await tx
          .update(storeProductRule)
          .set({ ruleName, ruleValue })
          .where(eq(storeProductRule.id, id));
        return { id };
      }
      const inserted = await tx
        .insert(storeProductRule)
        .values({ type: owner.type, relationId: owner.relationId, ruleName, ruleValue })
        .returning({ id: storeProductRule.id });
      return { id: inserted[0].id };
    });
  }

  async deleteRule(owner: MetadataOwner, id: number) {
    const deleted = await this.container.db
      .delete(storeProductRule)
      .where(and(eq(storeProductRule.id, id), ownedRuleScope(owner)))
      .returning({ id: storeProductRule.id });
    if (!deleted[0]) throw new NotFoundException("商品规则不存在");
  }

  async specTemplateList(
    owner: MetadataOwner,
    query: Record<string, string>,
    includeGlobal = false,
  ) {
    const { page, limit } = pageInput(query);
    const scope = includeGlobal ? readableTemplateScope(owner) : ownedTemplateScope(owner);
    const conditions = [scope, eq(legacyCategory.group, PARAMETER_TEMPLATE_GROUP)];
    const name = query.name?.trim();
    if (name) conditions.push(ilike(legacyCategory.name, `%${name}%`));
    const where = and(...conditions);
    const [templates, countRows] = await Promise.all([
      this.container.db
        .select()
        .from(legacyCategory)
        .where(where)
        .orderBy(desc(legacyCategory.sort), desc(legacyCategory.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(legacyCategory)
        .where(where),
    ]);
    const specs = templates.length
      ? await this.container.db
          .select()
          .from(storeProductSpecs)
          .where(inArray(storeProductSpecs.tempId, templates.map((item) => item.id)))
          .orderBy(desc(storeProductSpecs.sort), asc(storeProductSpecs.id))
      : [];
    const byTemplate = new Map<number, typeof specs>();
    for (const item of specs) {
      const list = byTemplate.get(item.tempId) ?? [];
      list.push(item);
      byTemplate.set(item.tempId, list);
    }
    return {
      list: templates.map((item) => this.formatTemplate(item, byTemplate.get(item.id) ?? [])),
      count: countRows[0]?.count ?? 0,
      page,
      limit,
    };
  }

  async allSpecTemplates(owner: MetadataOwner) {
    const templates = await this.container.db
      .select()
      .from(legacyCategory)
      .where(
        and(
          readableTemplateScope(owner),
          eq(legacyCategory.group, PARAMETER_TEMPLATE_GROUP),
        ),
      )
      .orderBy(desc(legacyCategory.sort), desc(legacyCategory.id));
    const specs = templates.length
      ? await this.container.db
          .select()
          .from(storeProductSpecs)
          .where(
            and(
              inArray(storeProductSpecs.tempId, templates.map((item) => item.id)),
              eq(storeProductSpecs.status, 1),
            ),
          )
          .orderBy(desc(storeProductSpecs.sort), asc(storeProductSpecs.id))
      : [];
    const byTemplate = new Map<number, typeof specs>();
    for (const item of specs) {
      const list = byTemplate.get(item.tempId) ?? [];
      list.push(item);
      byTemplate.set(item.tempId, list);
    }
    return templates.map((template) => {
      const item = this.formatTemplate(template, byTemplate.get(template.id) ?? []);
      return {
      id: item.id,
      name: item.name,
        specs: item.specs,
      };
    });
  }

  async specTemplateDetail(owner: MetadataOwner, id: number) {
    const templates = await this.container.db
      .select()
      .from(legacyCategory)
      .where(
        and(
          eq(legacyCategory.id, id),
          eq(legacyCategory.group, PARAMETER_TEMPLATE_GROUP),
          readableTemplateScope(owner),
        ),
      )
      .limit(1);
    if (!templates[0]) throw new NotFoundException("参数模板不存在");
    const specs = await this.container.db
      .select()
      .from(storeProductSpecs)
      .where(eq(storeProductSpecs.tempId, id))
      .orderBy(desc(storeProductSpecs.sort), asc(storeProductSpecs.id));
    return this.formatTemplate(templates[0], specs);
  }

  async saveSpecTemplate(owner: MetadataOwner, id: number, input: unknown) {
    const body = record(input);
    const name = requiredString(body.name, "参数模板名称", 255);
    const sort = integer(body.sort, "排序", 0);
    const specs = normalizeParameterSpecs(body.specs);
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SPECS_LOCK_NAMESPACE}, ${scopeLockKey(owner)})`);
      if (id > 0) {
        const existing = await tx
          .select({ id: legacyCategory.id })
          .from(legacyCategory)
          .where(
            and(
              eq(legacyCategory.id, id),
              eq(legacyCategory.group, PARAMETER_TEMPLATE_GROUP),
              ownedTemplateScope(owner),
            ),
          )
          .limit(1);
        if (!existing[0]) throw new NotFoundException("参数模板不存在");
      }
      const duplicateConditions = [
        ownedTemplateScope(owner),
        eq(legacyCategory.group, PARAMETER_TEMPLATE_GROUP),
        eq(legacyCategory.name, name),
      ];
      if (id > 0) duplicateConditions.push(ne(legacyCategory.id, id));
      const duplicate = await tx
        .select({ id: legacyCategory.id })
        .from(legacyCategory)
        .where(and(...duplicateConditions))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("参数模板已经存在");

      let templateId = id;
      if (id > 0) {
        await tx.update(legacyCategory).set({ name, sort }).where(eq(legacyCategory.id, id));
      } else {
        const inserted = await tx
          .insert(legacyCategory)
          .values({
            pid: 0,
            type: owner.type,
            relationId: owner.relationId,
            ownerId: 0,
            name,
            sort,
            group: PARAMETER_TEMPLATE_GROUP,
            isShow: 1,
            addTime: now,
          })
          .returning({ id: legacyCategory.id });
        templateId = inserted[0].id;
      }
      await tx.delete(storeProductSpecs).where(eq(storeProductSpecs.tempId, templateId));
      if (specs.length) {
        await tx.insert(storeProductSpecs).values(
          specs.map((item) => ({
            type: owner.type,
            relationId: owner.relationId,
            tempId: templateId,
            name: item.name,
            value: item.value,
            sort: item.sort,
            status: item.status,
            addTime: now,
          })),
        );
      }
      return { id: templateId };
    });
  }

  async deleteSpecTemplate(owner: MetadataOwner, id: number) {
    return withTx(this.container, async (tx) => {
      const template = await tx
        .select({ id: legacyCategory.id })
        .from(legacyCategory)
        .where(
          and(
            eq(legacyCategory.id, id),
            eq(legacyCategory.group, PARAMETER_TEMPLATE_GROUP),
            ownedTemplateScope(owner),
          ),
        )
        .limit(1)
        .for("update");
      if (!template[0]) throw new NotFoundException("参数模板不存在");
      const [direct, relation] = await Promise.all([
        tx.select({ id: storeProduct.id }).from(storeProduct).where(and(
          eq(storeProduct.specsId, id),
          eq(storeProduct.isDel, 0),
        )).limit(1),
        tx.select({ id: storeProductRelation.id }).from(storeProductRelation).where(and(
          eq(storeProductRelation.type, 6),
          eq(storeProductRelation.relationId, id),
        )).limit(1),
      ]);
      if (direct[0] || relation[0]) {
        throw new ValidateException("该参数模板仍被商品使用，不能删除");
      }
      await tx.delete(legacyCategory).where(eq(legacyCategory.id, id));
      await tx.delete(storeProductSpecs).where(eq(storeProductSpecs.tempId, id));
    });
  }

  private formatTemplate(
    item: typeof legacyCategory.$inferSelect,
    specs: Array<typeof storeProductSpecs.$inferSelect>,
  ) {
    return {
      id: item.id,
      pid: item.pid,
      type: item.type,
      relation_id: item.relationId,
      owner_id: item.ownerId,
      name: item.name,
      sort: item.sort,
      group: item.group,
      other: item.other,
      is_show: item.isShow,
      add_time: item.addTime,
      integral_min: item.integralMin,
      integral_max: item.integralMax,
      specs: specs.map((spec) => ({
        id: spec.id,
        type: spec.type,
        relation_id: spec.relationId,
        temp_id: spec.tempId,
        name: spec.name,
        value: spec.value,
        sort: spec.sort,
        status: spec.status,
        add_time: spec.addTime,
      })),
    };
  }
}

export const platformMetadataOwner: MetadataOwner = { type: 0, relationId: 0 };
export function supplierMetadataOwner(relationId: number): MetadataOwner {
  if (!Number.isSafeInteger(relationId) || relationId <= 0) {
    throw new ValidateException("供应商ID错误");
  }
  return { type: SUPPLIER_TYPE, relationId };
}
