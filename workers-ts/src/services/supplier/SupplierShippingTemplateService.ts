import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  sql,
} from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  shippingTemplates,
  shippingTemplatesFree,
  shippingTemplatesNoDelivery,
  shippingTemplatesRegion,
  storeProduct,
  systemCity,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const SUPPLIER_OWNER_TYPE = 2;
const SHIPPING_LOCK_NAMESPACE = 731_604;
const MAX_RULE_GROUPS = 100;
const MAX_RULE_PATHS = 1_000;
const MAX_CITY_PATH_DEPTH = 4;
const MAX_CITY_ROOTS = 64;
const MAX_CITY_CHILDREN = 1_000;

type UnknownRecord = Record<string, unknown>;

interface ShippingRegionRule {
  paths: number[][];
  first: string;
  firstPrice: string;
  continue: string;
  continuePrice: string;
}

interface ShippingFreeRule {
  paths: number[][];
  number: string;
  price: string;
}

interface ShippingNoDeliveryRule {
  paths: number[][];
}

export interface SupplierShippingTemplateInput {
  name: string;
  billingType: 1 | 2 | 3;
  appoint: 0 | 1;
  noDelivery: 0 | 1;
  sort: number;
  regions: ShippingRegionRule[];
  freeRules: ShippingFreeRule[];
  noDeliveryRules: ShippingNoDeliveryRule[];
}

interface CityAuthorityRow {
  cityId: number;
  parentId: number;
  name: string;
}

interface LegacyRuleRow {
  id: number;
  provinceId: number;
  cityId: number;
  value: string;
  uniqid: string;
  first?: string;
  firstPrice?: string;
  continue?: string;
  continuePrice?: string;
  number?: string;
  price?: string;
  billingGroup?: number;
}

function asRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException(`${label}格式错误`);
  }
  return value as UnknownRecord;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidateException(`${label}格式错误`);
  }
  return parsed;
}

function flag(value: unknown, label: string): 0 | 1 {
  return integer(value ?? 0, label, 0, 1) as 0 | 1;
}

function decimal(
  value: unknown,
  label: string,
  wholeDigits: number,
  mustBePositive: boolean,
): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidateException(`${label}格式错误`);
  }
  const raw = String(value).trim();
  const pattern = new RegExp(`^\\d{1,${wholeDigits}}(?:\\.\\d{1,2})?$`);
  if (!pattern.test(raw)) throw new ValidateException(`${label}必须是最多两位小数的非负数`);
  const [whole, fraction = ""] = raw.split(".");
  const normalized = `${BigInt(whole).toString()}.${fraction.padEnd(2, "0")}`;
  if (mustBePositive && BigInt(normalized.replace(".", "")) <= 0n) {
    throw new ValidateException(`${label}必须大于0`);
  }
  return normalized;
}

function cityPaths(value: unknown, label: string, allowNationwide: boolean): number[][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidateException(`${label}至少需要一个地区`);
  }
  if (value.length > MAX_RULE_PATHS) throw new ValidateException(`${label}地区数量过多`);
  return value.map((rawPath) => {
    if (!Array.isArray(rawPath) || rawPath.length === 0 || rawPath.length > MAX_CITY_PATH_DEPTH) {
      throw new ValidateException(`${label}地区路径格式错误`);
    }
    const path = rawPath.map((entry) => integer(entry, `${label}地区ID`, 0, 2_147_483_647));
    if (path.includes(0)) {
      if (!allowNationwide || path.length !== 1 || path[0] !== 0) {
        throw new ValidateException(`${label}全国路径格式错误`);
      }
    }
    if (new Set(path).size !== path.length) throw new ValidateException(`${label}地区路径存在循环`);
    return path;
  });
}

function ruleArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ValidateException(`${label}必须为数组`);
  if (value.length > MAX_RULE_GROUPS) throw new ValidateException(`${label}不能超过${MAX_RULE_GROUPS}组`);
  return value;
}

function assertUniqueEndpoints(groups: Array<{ paths: number[][] }>, label: string) {
  const endpoints = new Set<number>();
  let pathCount = 0;
  for (const group of groups) {
    pathCount += group.paths.length;
    if (pathCount > MAX_RULE_PATHS) throw new ValidateException(`${label}地区数量不能超过${MAX_RULE_PATHS}项`);
    for (const path of group.paths) {
      const endpoint = path[path.length - 1];
      if (endpoints.has(endpoint)) throw new ValidateException(`${label}不能重复`);
      endpoints.add(endpoint);
    }
  }
}

export function normalizeSupplierShippingTemplateInput(
  input: UnknownRecord,
): SupplierShippingTemplateInput {
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new ValidateException("请填写运费模板名称");
  }
  const name = input.name.trim();
  if (name.length > 255) throw new ValidateException("运费模板名称不能超过255个字符");
  const billingType = integer(input.type, "计费方式", 1, 3) as 1 | 2 | 3;
  const requestedAppoint = flag(input.appoint, "指定包邮状态");
  const requestedNoDelivery = flag(input.no_delivery, "禁配状态");
  const sort = integer(input.sort ?? 0, "排序", 0, 2_147_483_647);

  const regions = ruleArray(input.region_info, "运费信息").map((value) => {
    const row = asRecord(value, "运费信息");
    return {
      paths: cityPaths(row.city_ids, "运费信息", true),
      first: decimal(row.first, "首计量", 10, true),
      firstPrice: decimal(row.first_price, "首费", 10, false),
      continue: decimal(row.continue, "续计量", 10, true),
      continuePrice: decimal(row.continue_price, "续费", 10, false),
    };
  });
  if (regions.length === 0) throw new ValidateException("请设置配送区域");
  assertUniqueEndpoints(regions, "配送区域");
  const nationwideCount = regions.reduce(
    (count, row) => count + row.paths.filter((path) => path.length === 1 && path[0] === 0).length,
    0,
  );
  if (nationwideCount !== 1) throw new ValidateException("配送区域必须且只能包含一个默认全国规则");

  const parsedFreeRules = ruleArray(input.appoint_info, "包邮信息").map((value) => {
    const row = asRecord(value, "包邮信息");
    return {
      paths: cityPaths(row.city_ids, "包邮信息", false),
      number: decimal(row.number, "包邮计量", 8, true),
      price: decimal(row.price, "包邮金额", 8, false),
    };
  });
  assertUniqueEndpoints(parsedFreeRules, "包邮区域");

  const parsedNoDeliveryRules = ruleArray(input.no_delivery_info, "禁配信息").map((value) => {
    const row = asRecord(value, "禁配信息");
    return { paths: cityPaths(row.city_ids, "禁配信息", false) };
  });
  assertUniqueEndpoints(parsedNoDeliveryRules, "禁配区域");

  const freeRules = requestedAppoint ? parsedFreeRules : [];
  const noDeliveryRules = requestedNoDelivery ? parsedNoDeliveryRules : [];
  const appoint = freeRules.length > 0 ? 1 : 0;
  const noDelivery = noDeliveryRules.length > 0 ? 1 : 0;
  return { name, billingType, appoint, noDelivery, sort, regions, freeRules, noDeliveryRules };
}

function parseStoredPath(value: string, label: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed)
      || parsed.length === 0
      || parsed.length > MAX_CITY_PATH_DEPTH
      || parsed.some((entry) => !Number.isSafeInteger(Number(entry)) || Number(entry) < 0)
    ) {
      throw new Error("invalid path");
    }
    return parsed.map(Number);
  } catch {
    throw new ValidateException(`${label}地区路径数据损坏`);
  }
}

export function formatLegacyShippingRuleGroups(
  rows: LegacyRuleRow[],
  kind: "region" | "free" | "no_delivery",
): Array<Record<string, unknown>> {
  const groups = new Map<string, LegacyRuleRow[]>();
  for (const row of [...rows].sort((left, right) => left.id - right.id)) {
    const key = row.uniqid || `legacy-${row.id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const last = group[group.length - 1];
    const common: Record<string, unknown> = {
      id: last.id,
      province_id: last.provinceId,
      uniqid: last.uniqid,
      city_id: group.map((row) => row.cityId),
      city_ids: group.map((row) => parseStoredPath(row.value, "运费模板")),
    };
    if (kind === "region") {
      return {
        ...common,
        first: last.first ?? "0.00",
        first_price: last.firstPrice ?? "0.00",
        continue: last.continue ?? "0.00",
        continue_price: last.continuePrice ?? "0.00",
        group: last.billingGroup ?? 1,
      };
    }
    if (kind === "free") {
      return { ...common, number: last.number ?? "0.00", price: last.price ?? "0.00", group: last.billingGroup ?? 1 };
    }
    return common;
  });
}

function randomRuleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `sup${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function templateScope(supplierId: number, templateId?: number) {
  return and(
    templateId === undefined ? undefined : eq(shippingTemplates.id, templateId),
    eq(shippingTemplates.ownerType, SUPPLIER_OWNER_TYPE),
    eq(shippingTemplates.relationId, supplierId),
    eq(shippingTemplates.isDel, 0),
  );
}

function validSupplierId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValidateException("供应商ID错误");
  return value;
}

async function cityAuthority(tx: DbClient, input: SupplierShippingTemplateInput) {
  const paths = [
    ...input.regions.flatMap((row) => row.paths),
    ...input.freeRules.flatMap((row) => row.paths),
    ...input.noDeliveryRules.flatMap((row) => row.paths),
  ];
  const ids = [...new Set(paths.flat().filter((id) => id > 0))];
  const rows = ids.length
    ? await tx
        .select({ cityId: systemCity.cityId, parentId: systemCity.parentId, name: systemCity.name })
        .from(systemCity)
        .where(inArray(systemCity.cityId, ids))
    : [];
  const byId = new Map<number, CityAuthorityRow>();
  for (const row of rows) {
    const existing = byId.get(row.cityId);
    if (existing && (existing.parentId !== row.parentId || existing.name !== row.name)) {
      throw new ValidateException(`城市ID ${row.cityId} 在权威表中不唯一`);
    }
    byId.set(row.cityId, row);
  }
  if (byId.size !== ids.length) throw new ValidateException("所选地区不存在或已失效");
  for (const path of paths) {
    if (path[0] === 0) continue;
    for (let index = 0; index < path.length; index += 1) {
      const city = byId.get(path[index]);
      const expectedParent = index === 0 ? 0 : path[index - 1];
      if (!city || city.parentId !== expectedParent) throw new ValidateException("所选地区层级关系无效");
    }
  }
  return byId;
}

async function replaceRules(
  tx: DbClient,
  templateId: number,
  input: SupplierShippingTemplateInput,
  cities: Map<number, CityAuthorityRow>,
  now: number,
) {
  await Promise.all([
    tx.delete(shippingTemplatesRegion).where(eq(shippingTemplatesRegion.templateId, templateId)),
    tx.delete(shippingTemplatesFree).where(eq(shippingTemplatesFree.tempId, templateId)),
    tx.delete(shippingTemplatesNoDelivery).where(eq(shippingTemplatesNoDelivery.tempId, templateId)),
  ]);

  const regionRows = input.regions.flatMap((rule) => {
    const uniqid = randomRuleId();
    return rule.paths.map((path) => {
      const endpoint = path[path.length - 1];
      return {
        templateId,
        provinceId: path[0] || 0,
        regionId: endpoint,
        regionName: endpoint === 0 ? "默认全国" : (cities.get(endpoint)?.name ?? ""),
        first: rule.first,
        firstPrice: rule.firstPrice,
        continue: rule.continue,
        continuePrice: rule.continuePrice,
        billingGroup: input.billingType,
        value: JSON.stringify(path),
        uniqid,
        addTime: now,
      };
    });
  });
  const freeRows = input.freeRules.flatMap((rule) => {
    const uniqid = randomRuleId();
    return rule.paths.map((path) => ({
      tempId: templateId,
      provinceId: path[0],
      cityId: path[path.length - 1],
      number: rule.number,
      price: rule.price,
      billingGroup: input.billingType,
      value: JSON.stringify(path),
      uniqid,
    }));
  });
  const noDeliveryRows = input.noDeliveryRules.flatMap((rule) => {
    const uniqid = randomRuleId();
    return rule.paths.map((path) => ({
      tempId: templateId,
      provinceId: path[0],
      cityId: path[path.length - 1],
      value: JSON.stringify(path),
      uniqid,
    }));
  });
  if (regionRows.length) await tx.insert(shippingTemplatesRegion).values(regionRows);
  if (freeRows.length) await tx.insert(shippingTemplatesFree).values(freeRows);
  if (noDeliveryRows.length) await tx.insert(shippingTemplatesNoDelivery).values(noDeliveryRows);
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
    const templates = await this.container.db
      .select()
      .from(shippingTemplates)
      .where(templateScope(supplierId, templateId))
      .limit(1);
    const template = templates[0];
    if (!template) throw new NotFoundException("运费模板不存在或不属于当前供应商");
    const [regions, freeRules, noDeliveryRules] = await Promise.all([
      this.container.db
        .select({
          id: shippingTemplatesRegion.id,
          provinceId: shippingTemplatesRegion.provinceId,
          cityId: shippingTemplatesRegion.regionId,
          value: shippingTemplatesRegion.value,
          uniqid: shippingTemplatesRegion.uniqid,
          first: shippingTemplatesRegion.first,
          firstPrice: shippingTemplatesRegion.firstPrice,
          continue: shippingTemplatesRegion.continue,
          continuePrice: shippingTemplatesRegion.continuePrice,
          billingGroup: shippingTemplatesRegion.billingGroup,
        })
        .from(shippingTemplatesRegion)
        .where(eq(shippingTemplatesRegion.templateId, templateId))
        .orderBy(asc(shippingTemplatesRegion.id)),
      this.container.db
        .select({
          id: shippingTemplatesFree.id,
          provinceId: shippingTemplatesFree.provinceId,
          cityId: shippingTemplatesFree.cityId,
          value: shippingTemplatesFree.value,
          uniqid: shippingTemplatesFree.uniqid,
          number: shippingTemplatesFree.number,
          price: shippingTemplatesFree.price,
          billingGroup: shippingTemplatesFree.billingGroup,
        })
        .from(shippingTemplatesFree)
        .where(eq(shippingTemplatesFree.tempId, templateId))
        .orderBy(asc(shippingTemplatesFree.id)),
      this.container.db
        .select({
          id: shippingTemplatesNoDelivery.id,
          provinceId: shippingTemplatesNoDelivery.provinceId,
          cityId: shippingTemplatesNoDelivery.cityId,
          value: shippingTemplatesNoDelivery.value,
          uniqid: shippingTemplatesNoDelivery.uniqid,
        })
        .from(shippingTemplatesNoDelivery)
        .where(eq(shippingTemplatesNoDelivery.tempId, templateId))
        .orderBy(asc(shippingTemplatesNoDelivery.id)),
    ]);
    const templateList = formatLegacyShippingRuleGroups(regions, "region");
    if (!templateList.some((row) => (row.city_ids as number[][]).some((path) => path.length === 1 && path[0] === 0))) {
      templateList.unshift({ city_ids: [[0]], city_id: [0], regionName: "默认全国" });
    }
    return {
      appointList: formatLegacyShippingRuleGroups(freeRules, "free"),
      templateList,
      noDeliveryList: formatLegacyShippingRuleGroups(noDeliveryRules, "no_delivery"),
      formData: {
        name: template.name,
        type: template.type,
        appoint_check: template.appoint,
        no_delivery_check: template.noDelivery,
        sort: template.sort,
      },
    };
  }

  async save(
    supplierIdValue: number,
    templateId: number,
    rawInput: UnknownRecord,
  ): Promise<number> {
    const supplierId = validSupplierId(supplierIdValue);
    if (!Number.isSafeInteger(templateId) || templateId < 0) throw new ValidateException("运费模板ID错误");
    const input = normalizeSupplierShippingTemplateInput(rawInput);
    return withTx(this.container, async (tx) => {
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
    });
  }

  async delete(supplierIdValue: number, templateId: number): Promise<void> {
    const supplierId = validSupplierId(supplierIdValue);
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SHIPPING_LOCK_NAMESPACE}, ${supplierId})`);
      const existing = await tx
        .select({ id: shippingTemplates.id })
        .from(shippingTemplates)
        .where(templateScope(supplierId, templateId))
        .limit(1)
        .for("update");
      if (!existing[0]) throw new NotFoundException("运费模板不存在或不属于当前供应商");
      const products = await tx
        .select({ id: storeProduct.id })
        .from(storeProduct)
        .where(and(
          eq(storeProduct.type, SUPPLIER_OWNER_TYPE),
          eq(storeProduct.relationId, supplierId),
          eq(storeProduct.tempId, templateId),
          eq(storeProduct.isDel, 0),
        ))
        .limit(1)
        .for("key share");
      if (products[0]) throw new ValidateException("运费模板仍被商品使用，不能删除");
      await Promise.all([
        tx.delete(shippingTemplatesRegion).where(eq(shippingTemplatesRegion.templateId, templateId)),
        tx.delete(shippingTemplatesFree).where(eq(shippingTemplatesFree.tempId, templateId)),
        tx.delete(shippingTemplatesNoDelivery).where(eq(shippingTemplatesNoDelivery.tempId, templateId)),
      ]);
      const updated = await tx
        .update(shippingTemplates)
        .set({ isDel: 1, status: 0 })
        .where(templateScope(supplierId, templateId))
        .returning({ id: shippingTemplates.id });
      if (!updated[0]) throw new NotFoundException("运费模板不存在或不属于当前供应商");
    });
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
