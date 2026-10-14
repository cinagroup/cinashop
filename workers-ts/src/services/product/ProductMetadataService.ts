import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  legacyCategory,
  storeProduct,
  storeProductRelation,
  storeProductRule,
  storeProductSpecs,
  storeProductUnit,
} from "@/models/schema";
import { NotFoundException, ServiceUnavailableException, ValidateException } from "@/utils/errors";
import { lockProductUnitLifecycle } from './ProductUnitLifecycle';

const PLATFORM_TYPE = 0;
const SUPPLIER_TYPE = 2;
const PARAMETER_TEMPLATE_GROUP = 3;
const RULE_LOCK_NAMESPACE = 731_612;
const SPECS_LOCK_NAMESPACE = 731_613;
const MAX_PAGE_SIZE = 100;
const MAX_TEMPLATE_SPECS = 100;
const MAX_TEMPLATE_READ_ROWS = 2000;
const parameterClock = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** PHP's child model accessor formats epoch zero as well. */
export function formatParameterSpecTime(seconds: number): string {
  const parts = Object.fromEntries(parameterClock.formatToParts(new Date(seconds * 1000)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function lockParameterTemplate(tx: DbClient, owner: MetadataOwner): Promise<void> {
  if (!(owner.type === 0 && owner.relationId === 0 || owner.type === 2
    && Number.isSafeInteger(owner.relationId) && owner.relationId > 0 && owner.relationId <= 2147483647)) {
    throw new ValidateException('参数模板归属错误');
  }
  await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
  await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SPECS_LOCK_NAMESPACE}, ${scopeLockKey(owner)})`);
}

function parameterString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidateException(`请填写${label}`);
  const text = value.trim();
  if ([...text].length > 255 || /[\u0000\ud800-\udfff]/u.test(text)) throw new ValidateException(`${label}长度或字符错误`);
  return text;
}

function parameterInteger(value: unknown, label: string, fallback = 0, max = 2147483647): number {
  if (value === undefined || value === null || value === '') return fallback;
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^(?:0|[1-9]\d*)$/.test(String(value))) {
    throw new ValidateException(`${label}必须是非负整数`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) throw new ValidateException(`${label}超出范围`);
  return number;
}

function sameStoredRow(actual: object, expected: object): boolean {
  const a = actual as Record<string, unknown>, e = expected as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(e).length && Object.keys(e).every(key => a[key] === e[key]);
}

function echoInteger(value: unknown, expected: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value === expected
    || typeof value === 'string' && /^-?(?:0|[1-9]\d*)$/.test(value) && Number(value) === expected;
}

function echoTime(value: unknown, expected: number, parent = false): boolean {
  return echoInteger(value, expected) || value === formatParameterSpecTime(expected) || parent && expected === 0 && value === '';
}

function validateTemplateEcho(body: Record<string, unknown>, owner: MetadataOwner, id: number,
  existing: typeof legacyCategory.$inferSelect | undefined, children: Array<typeof storeProductSpecs.$inferSelect>): void {
  const parent = existing ?? { id: 0, pid: 0, type: owner.type, relationId: owner.relationId, ownerId: 0,
    name: '', sort: 0, group: 3, other: null, isShow: 1, addTime: 0, integralMin: 0, integralMax: 0 };
  const integers: Record<string, number> = { id, pid: parent.pid, type: parent.type, relation_id: parent.relationId,
    owner_id: parent.ownerId, group: parent.group, is_show: parent.isShow, integral_min: parent.integralMin, integral_max: parent.integralMax };
  const allowed = [...Object.keys(integers), 'name', 'sort', 'other', 'add_time', 'specs'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new ValidateException('参数模板包含未知字段');
  for (const [key, expected] of Object.entries(integers)) {
    if (Object.hasOwn(body, key) && !echoInteger(body[key], expected)) throw new ValidateException('参数模板回显身份或归属已变化');
  }
  if (Object.hasOwn(body, 'other') && body.other !== parent.other) throw new ValidateException('参数模板只读元数据已变化');
  if (Object.hasOwn(body, 'add_time') && !echoTime(body.add_time, parent.addTime, true)) throw new ValidateException('参数模板创建时间不能修改');
  const used = new Set<number>();
  for (const value of Array.isArray(body.specs) ? body.specs : []) {
    const row = record(value, '商品参数格式错误');
    if (Object.keys(row).some(key => !['id', 'temp_id', 'type', 'relation_id', 'name', 'value', 'sort', 'status', 'add_time'].includes(key))) {
      throw new ValidateException('商品参数包含未知字段');
    }
    const rowId = parameterInteger(row.id, '商品参数ID');
    const original = rowId ? children.find(child => child.id === rowId) : undefined;
    if (rowId && (!original || used.has(rowId))) throw new ValidateException('参数回显ID不属于当前模板或重复');
    used.add(rowId);
    for (const [key, expected] of [['type', owner.type], ['relation_id', owner.relationId]] as const) {
      if (Object.hasOwn(row, key) && !echoInteger(row[key], expected)) throw new ValidateException('参数归属不能修改');
    }
    if (Object.hasOwn(row, 'temp_id') && !(echoInteger(row.temp_id, id) || !original && echoInteger(row.temp_id, 0))) {
      throw new ValidateException('参数模板归属不能修改');
    }
    if (Object.hasOwn(row, 'add_time') && !echoTime(row.add_time, original?.addTime ?? 0)) throw new ValidateException('参数创建时间不能修改');
  }
}

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

async function lockProductRule(tx: DbClient, owner: MetadataOwner): Promise<void> {
  if (!(owner.type === 0 && owner.relationId === 0 || owner.type === 2
    && Number.isSafeInteger(owner.relationId) && owner.relationId > 0 && owner.relationId <= 2147483647)) {
    throw new ValidateException('规格模板归属错误');
  }
  await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
  await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${RULE_LOCK_NAMESPACE}, ${scopeLockKey(owner)})`);
}

function ruleString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidateException(`请填写${field}`);
  const text = value.trim();
  if ([...text].length > max || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(text)) {
    throw new ValidateException(`${field}长度或字符错误`);
  }
  return text;
}

function sameJsonValue(actual: unknown, expected: unknown, depth = 0): boolean {
  if (actual === expected) return true;
  if (depth >= 8 || !actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
      && actual.every((value, index) => sameJsonValue(value, expected[index], depth + 1));
  }
  const a = actual as Record<string, unknown>, e = expected as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(e).length && Object.keys(e).every(key => Object.hasOwn(a, key)
    && sameJsonValue(a[key], e[key], depth + 1));
}

function validateRuleEcho(body: Record<string, unknown>, owner: MetadataOwner, id: number,
  original: typeof storeProductRule.$inferSelect | undefined): void {
  const allowed = ['id', 'type', 'relation_id', 'rule_name', 'ruleName', 'spec', 'rule_value', 'attr_name', 'attr_value'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new ValidateException('规格模板包含未知字段');
  for (const [key, value] of [['id', id], ['type', owner.type], ['relation_id', owner.relationId]] as const) {
    if (Object.hasOwn(body, key) && !echoInteger(body[key], value)) throw new ValidateException('规格模板回显身份或归属已变化');
  }
  if (body.rule_name !== undefined && body.ruleName !== undefined && body.rule_name !== body.ruleName) {
    throw new ValidateException('规格模板名称参数冲突');
  }
  const value = original?.ruleValue ?? null;
  const spec = parseProductRuleValue(value);
  let decoded: unknown = null;
  try { if (value !== null) decoded = JSON.parse(value) as unknown; } catch { /* PHP exposes null for invalid JSON. */ }
  if (Object.hasOwn(body, 'rule_value') && body.rule_value !== value
    && !(original && Array.isArray(body.rule_value) && sameJsonValue(body.rule_value, decoded))) {
    throw new ValidateException('规格模板原始回显已变化');
  }
  const attrName = spec.map(row => row.value).join(',');
  const attrValue = spec.map(row => row.detail.join(','));
  if (Object.hasOwn(body, 'attr_name') && body.attr_name !== attrName) throw new ValidateException('规格模板回显规格名称已变化');
  if (Object.hasOwn(body, 'attr_value') && JSON.stringify(body.attr_value) !== JSON.stringify(attrValue)
    && !(value && value !== '0' && !spec.length && JSON.stringify(body.attr_value) === JSON.stringify(['']))) {
    throw new ValidateException('规格模板回显规格值已变化');
  }
}

function readableTemplateScope(owner: MetadataOwner) {
  const owned = and(
    eq(legacyCategory.ownerId, 0),
    eq(legacyCategory.type, owner.type),
    eq(legacyCategory.relationId, owner.relationId),
  );
  if (owner.type === PLATFORM_TYPE) return owned;
  return or(
    and(eq(legacyCategory.ownerId, 0), eq(legacyCategory.type, PLATFORM_TYPE), eq(legacyCategory.relationId, 0)),
    owned,
  );
}

function ownedTemplateScope(owner: MetadataOwner) {
  return and(
    eq(legacyCategory.ownerId, 0),
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
    if (Object.keys(row).some(key => !['value', 'detail', 'attr_name', 'attr_values'].includes(key))) throw new ValidateException('规格内容包含未知字段');
    if (row.value !== undefined && row.attr_name !== undefined && row.value !== row.attr_name
      || row.detail !== undefined && row.attr_values !== undefined && JSON.stringify(row.detail) !== JSON.stringify(row.attr_values)) {
      throw new ValidateException('规格内容参数冲突');
    }
    const name = ruleString(row.value ?? row.attr_name, "规格名称", 32);
    const rawDetails = row.detail ?? row.attr_values;
    if (!Array.isArray(rawDetails) || rawDetails.length < 1 || rawDetails.length > 50) {
      throw new ValidateException(`规格“${name}”至少需要一个且不能超过50个规格值`);
    }
    const detail = rawDetails.map((entry) => ruleString(entry, "规格值", 64));
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
      name: parameterString(row.name, "参数名称"),
      value: parameterString(row.value, "参数值"),
      sort: parameterInteger(row.sort, "参数排序"),
      status: parameterInteger(row.status, "参数状态", 1, 1),
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
    if (typeof body.name !== 'string') throw new ValidateException('请填写单位名称');
    const name = body.name.trim();
    if (!name) throw new ValidateException('请填写单位名称');
    if ([...name].length > 15) throw new ValidateException('单位名称长度超过限制（最多15个字符）');
    if (/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(body.name)) throw new ValidateException('单位名称包含无效字符');
    const sort = integer(body.sort, "排序", 0, 32_767);
    return withTx(this.container, async (tx) => {
      await lockProductUnitLifecycle(tx);
      let original: typeof storeProductUnit.$inferSelect | undefined;
      if (id > 0) {
        const existing = await tx
          .select()
          .from(storeProductUnit)
          .where(and(eq(storeProductUnit.id, id), ownedUnitScope(owner), eq(storeProductUnit.isDel, 0)))
          .limit(1).for('update');
        if (!existing[0]) throw new NotFoundException("商品单位不存在");
        original = existing[0];
        if (original.name !== name) {
          const [used] = await tx.select({ id: storeProduct.id }).from(storeProduct)
            .where(and(eq(storeProduct.unitName, original.name), eq(storeProduct.isDel, 0))).limit(1);
          if (used) throw new ValidateException('该单位正在使用，不能修改名称');
        }
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
        const rows = await tx.update(storeProductUnit).set({ name, sort })
          .where(and(eq(storeProductUnit.id, id), ownedUnitScope(owner), eq(storeProductUnit.isDel, 0))).returning();
        const saved = rows[0];
        if (rows.length !== 1 || !saved || saved.name !== name || saved.sort !== sort
          || Object.entries(original!).some(([key, value]) => !['name', 'sort'].includes(key)
            && saved[key as keyof typeof saved] !== value)) throw Error('商品单位修改回执不完整');
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
        .returning();
      const saved = inserted[0];
      if (inserted.length !== 1 || !saved || saved.id <= 0 || saved.name !== name || saved.sort !== sort
        || saved.type !== owner.type || saved.relationId !== owner.relationId || saved.status !== 1 || saved.isDel !== 0) {
        throw Error('商品单位新增回执不完整');
      }
      return { id: inserted[0].id };
    });
  }

  async deleteUnit(owner: MetadataOwner, id: number) {
    return withTx(this.container, async (tx) => {
      await lockProductUnitLifecycle(tx);
      const rows = await tx
        .select()
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
            eq(storeProduct.isDel, 0),
          ),
        )
        .limit(1);
      if (used[0]) throw new ValidateException("该单位正在使用，不能删除");
      const deleted = await tx.update(storeProductUnit).set({ isDel: 1 })
        .where(and(eq(storeProductUnit.id, id), ownedUnitScope(owner), eq(storeProductUnit.isDel, 0))).returning();
      const saved = deleted[0];
      if (deleted.length !== 1 || !saved || saved.isDel !== 1 || Object.entries(unit).some(([key, value]) => key !== 'isDel'
        && saved[key as keyof typeof saved] !== value)) throw Error('商品单位删除回执不完整');
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
      .orderBy(desc(storeProductRule.id)).limit(MAX_TEMPLATE_READ_ROWS + 1);
    if (rows.length > MAX_TEMPLATE_READ_ROWS) throw new ServiceUnavailableException('规格模板目录超过2000项，请缩小范围');
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
    const ruleName = ruleString(body.rule_name ?? body.ruleName, "规格模板名称", 32);
    const spec = normalizeProductRuleInput(body.spec);
    const ruleValue = JSON.stringify(spec);
    return withTx(this.container, async (tx) => {
      if (!Number.isSafeInteger(id) || id < 0 || id > 2147483647) throw new ValidateException('规格模板ID错误');
      await lockProductRule(tx, owner);
      let original: typeof storeProductRule.$inferSelect | undefined;
      if (id > 0) {
        [original] = await tx
          .select()
          .from(storeProductRule)
          .where(and(eq(storeProductRule.id, id), ownedRuleScope(owner)))
          .limit(1).for('update');
        if (!original) throw new NotFoundException("商品规则不存在");
      }
      validateRuleEcho(body, owner, id, original);
      const duplicateConditions = [ownedRuleScope(owner), eq(storeProductRule.ruleName, ruleName)];
      if (id > 0) duplicateConditions.push(ne(storeProductRule.id, id));
      const duplicate = await tx
        .select({ id: storeProductRule.id })
        .from(storeProductRule)
        .where(and(...duplicateConditions))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("规格模板名称已存在");
      if (id > 0) {
        const rows = await tx
          .update(storeProductRule)
          .set({ ruleName, ruleValue })
          .where(and(eq(storeProductRule.id, id), ownedRuleScope(owner))).returning();
        const expected = { ...original!, ruleName, ruleValue };
        if (rows.length !== 1 || !rows[0] || !sameStoredRow(rows[0], expected)) throw Error('规格模板修改回执不完整');
        const [fresh] = await tx.select().from(storeProductRule).where(eq(storeProductRule.id, id)).limit(1);
        if (!fresh || !sameStoredRow(fresh, expected)) throw Error('规格模板修改回读不完整');
        return { id };
      }
      const inserted = await tx
        .insert(storeProductRule)
        .values({ type: owner.type, relationId: owner.relationId, ruleName, ruleValue })
        .returning();
      const saved = inserted[0];
      const expected = { id: saved?.id, type: owner.type, relationId: owner.relationId, ruleName, ruleValue };
      if (inserted.length !== 1 || !saved || !Number.isSafeInteger(saved.id) || saved.id <= 0
        || !sameStoredRow(saved, expected)) throw Error('规格模板新增回执不完整');
      const [fresh] = await tx.select().from(storeProductRule).where(eq(storeProductRule.id, saved.id)).limit(1);
      if (!fresh || !sameStoredRow(fresh, expected)) throw Error('规格模板新增回读不完整');
      return { id: saved.id };
    });
  }

  async deleteRule(owner: MetadataOwner, id: number) {
    return withTx(this.container, async tx => {
      if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new ValidateException('规格模板ID错误');
      await lockProductRule(tx, owner);
      const [original] = await tx.select().from(storeProductRule)
        .where(and(eq(storeProductRule.id, id), ownedRuleScope(owner))).limit(1).for('update');
      if (!original) throw new NotFoundException('商品规则不存在');
      const removed = await tx.delete(storeProductRule).where(and(eq(storeProductRule.id, id), ownedRuleScope(owner))).returning();
      if (removed.length !== 1 || !removed[0] || !sameStoredRow(removed[0], original)) throw Error('规格模板删除回执不完整');
      const after = await tx.select().from(storeProductRule).where(eq(storeProductRule.id, id)).limit(1);
      if (after.length) throw Error('规格模板删除回读不完整');
    });
  }

  private async templateChildren(ids: number[], enabledOnly = false) {
    if (!ids.length) return [];
    const rows = await this.container.db.select(getTableColumns(storeProductSpecs)).from(storeProductSpecs)
      .innerJoin(legacyCategory, eq(legacyCategory.id, storeProductSpecs.tempId))
      .where(and(inArray(storeProductSpecs.tempId, ids), eq(legacyCategory.group, PARAMETER_TEMPLATE_GROUP),
        eq(legacyCategory.ownerId, 0), eq(storeProductSpecs.type, legacyCategory.type),
        eq(storeProductSpecs.relationId, legacyCategory.relationId),
        enabledOnly ? eq(storeProductSpecs.status, 1) : undefined))
      .orderBy(desc(storeProductSpecs.sort), asc(storeProductSpecs.id)).limit(MAX_TEMPLATE_READ_ROWS + 1);
    if (rows.length > MAX_TEMPLATE_READ_ROWS) throw new ServiceUnavailableException('参数目录超过2000项，请缩小范围');
    return rows;
  }

  async specTemplateList(
    owner: MetadataOwner,
    query: Record<string, string>,
    includeGlobal = false,
    hydrateSpecs = true,
  ) {
    const { page, limit } = pageInput(query);
    const scope = includeGlobal ? readableTemplateScope(owner) : ownedTemplateScope(owner);
    const conditions = [scope, eq(legacyCategory.group, PARAMETER_TEMPLATE_GROUP)];
    const name = query.name?.trim();
    if (name) conditions.push(or(ilike(legacyCategory.name, `%${name}%`), sql`${legacyCategory.id}::text ILIKE ${`%${name}%`}`)!);
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
    const specs = hydrateSpecs ? await this.templateChildren(templates.map(item => item.id)) : [];
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
      .orderBy(desc(legacyCategory.sort), desc(legacyCategory.id)).limit(MAX_TEMPLATE_READ_ROWS + 1);
    if (templates.length > MAX_TEMPLATE_READ_ROWS) throw new ServiceUnavailableException('参数模板超过2000项，请缩小范围');
    const specs = await this.templateChildren(templates.map(item => item.id), true);
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
    const specs = await this.templateChildren([id]);
    return this.formatTemplate(templates[0], specs);
  }

  async saveSpecTemplate(owner: MetadataOwner, id: number, input: unknown) {
    const body = record(input);
    if (!Number.isSafeInteger(id) || id < 0 || id > 2147483647) throw new ValidateException('参数模板ID错误');
    const name = parameterString(body.name, "参数模板名称");
    const sort = parameterInteger(body.sort, "排序");
    const specs = normalizeParameterSpecs(body.specs);
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      await lockParameterTemplate(tx, owner);
      let original: typeof legacyCategory.$inferSelect | undefined;
      if (id > 0) {
        const existing = await tx
          .select()
          .from(legacyCategory)
          .where(
            and(
              eq(legacyCategory.id, id),
              eq(legacyCategory.group, PARAMETER_TEMPLATE_GROUP),
              ownedTemplateScope(owner),
            ),
          )
          .limit(1).for('update');
        if (!existing[0]) throw new NotFoundException("参数模板不存在");
        original = existing[0];
      }
      const children = id ? await tx.select().from(storeProductSpecs).where(eq(storeProductSpecs.tempId, id))
        .orderBy(asc(storeProductSpecs.id)).limit(MAX_TEMPLATE_READ_ROWS + 1).for('update') : [];
      if (children.length > MAX_TEMPLATE_READ_ROWS) throw new ServiceUnavailableException('参数模板超过2000项，请先整理目录');
      if (children.some(row => row.type !== owner.type || row.relationId !== owner.relationId)) {
        throw new ValidateException('参数模板子行归属漂移，请先核对历史数据');
      }
      validateTemplateEcho(body, owner, id, original, children);
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
      let expectedParent: typeof legacyCategory.$inferSelect;
      if (id > 0) {
        const updated = await tx.update(legacyCategory).set({ name, sort })
          .where(and(eq(legacyCategory.id, id), eq(legacyCategory.group, PARAMETER_TEMPLATE_GROUP), ownedTemplateScope(owner))).returning();
        expectedParent = { ...original!, name, sort };
        if (updated.length !== 1 || !sameStoredRow(updated[0], expectedParent)) throw Error('参数模板更新回执不完整');
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
          .returning();
        const saved = inserted[0];
        if (inserted.length !== 1 || !saved || !Number.isSafeInteger(saved.id) || saved.id <= 0) throw Error('参数模板创建回执不完整');
        templateId = saved.id;
        expectedParent = { id: templateId, pid: 0, type: owner.type, relationId: owner.relationId, ownerId: 0,
          name, sort, group: PARAMETER_TEMPLATE_GROUP, other: null, isShow: 1, addTime: now, integralMin: 0, integralMax: 0 };
        if (!sameStoredRow(saved, expectedParent)) throw Error('参数模板创建回执不完整');
      }
      const removed = await tx.delete(storeProductSpecs).where(and(eq(storeProductSpecs.tempId, templateId),
        eq(storeProductSpecs.type, owner.type), eq(storeProductSpecs.relationId, owner.relationId))).returning();
      if (removed.length !== children.length || children.some(old => !removed.some(row => sameStoredRow(row, old)))) throw Error('商品参数删除回执不完整');
      let insertedSpecs: Array<typeof storeProductSpecs.$inferSelect> = [];
      if (specs.length) {
        insertedSpecs = await tx.insert(storeProductSpecs).values(
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
        ).returning();
        const expected = specs.map(item => ({ type: owner.type, relationId: owner.relationId, tempId: templateId,
          name: item.name, value: item.value, sort: item.sort, status: item.status, addTime: now }));
        if (insertedSpecs.length !== expected.length || new Set(insertedSpecs.map(row => row.id)).size !== insertedSpecs.length) throw Error('商品参数创建回执不完整');
        for (const row of insertedSpecs) {
          const match = expected.findIndex(item => sameStoredRow(row, { id: row.id, ...item }));
          if (!Number.isSafeInteger(row.id) || row.id <= 0 || match < 0) throw Error('商品参数创建回执不完整');
          expected.splice(match, 1);
        }
      }
      const [afterParent] = await tx.select().from(legacyCategory).where(eq(legacyCategory.id, templateId)).limit(1);
      const afterSpecs = await tx.select().from(storeProductSpecs).where(eq(storeProductSpecs.tempId, templateId))
        .orderBy(asc(storeProductSpecs.id)).limit(insertedSpecs.length + 1);
      const ordered = [...insertedSpecs].sort((a, b) => a.id - b.id);
      if (!afterParent || !sameStoredRow(afterParent, expectedParent) || afterSpecs.length !== ordered.length
        || afterSpecs.some((row, index) => !sameStoredRow(row, ordered[index]))) throw Error('参数模板保存后核验失败');
      return { id: templateId };
    });
  }

  async deleteSpecTemplate(owner: MetadataOwner, id: number) {
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new ValidateException('参数模板ID错误');
    return withTx(this.container, async (tx) => {
      await lockParameterTemplate(tx, owner);
      const template = await tx
        .select()
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
      const children = await tx.select().from(storeProductSpecs).where(eq(storeProductSpecs.tempId, id))
        .orderBy(asc(storeProductSpecs.id)).limit(MAX_TEMPLATE_READ_ROWS + 1).for('update');
      if (children.length > MAX_TEMPLATE_READ_ROWS) throw new ServiceUnavailableException('参数模板超过2000项，请先整理目录');
      if (children.some(row => row.type !== owner.type || row.relationId !== owner.relationId)) throw new ValidateException('参数模板子行归属漂移，请先核对历史数据');
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
      const removedChildren = await tx.delete(storeProductSpecs).where(and(eq(storeProductSpecs.tempId, id),
        eq(storeProductSpecs.type, owner.type), eq(storeProductSpecs.relationId, owner.relationId))).returning();
      if (removedChildren.length !== children.length || children.some(old => !removedChildren.some(row => sameStoredRow(row, old)))) throw Error('商品参数删除回执不完整');
      const removedParent = await tx.delete(legacyCategory).where(and(eq(legacyCategory.id, id),
        eq(legacyCategory.group, PARAMETER_TEMPLATE_GROUP), ownedTemplateScope(owner))).returning();
      if (removedParent.length !== 1 || !sameStoredRow(removedParent[0], template[0])) throw Error('参数模板删除回执不完整');
      const [parentAfter, childAfter] = await Promise.all([
        tx.select({ id: legacyCategory.id }).from(legacyCategory).where(eq(legacyCategory.id, id)).limit(1),
        tx.select({ id: storeProductSpecs.id }).from(storeProductSpecs).where(eq(storeProductSpecs.tempId, id)).limit(1),
      ]);
      if (parentAfter.length || childAfter.length) throw Error('参数模板删除后核验失败');
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
