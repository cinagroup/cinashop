import { decimalToCents } from "@/services/order/OrderBrokerageService";

export interface ShippingItemInput {
  freight: number;
  postage: string | number;
  tempId: number;
  quantity: number;
  unitPrice: string | number;
  weight: string | number;
  volume: string | number;
}

export interface ShippingTemplateInput {
  id: number;
  /** PHP shipping_templates.group: 1=quantity, 2=weight, 3=volume. */
  type: number;
  appoint?: number;
  noDelivery?: number;
}

export interface ShippingRegionInput {
  id: number;
  templateId: number;
  regionId: number;
  regionName: string;
  first: string | number;
  firstPrice: string | number;
  continue: string | number;
  continuePrice: string | number;
}

export interface ShippingDestinationInput {
  cityId?: number;
  province?: string;
  /** PHP city_area.path for the selected city, e.g. /1/2/3/. */
  regionPath?: string;
  /** Resolved IDs ordered from the selected city to its nearest/root ancestors. */
  regionIds?: readonly number[];
}

export interface ShippingFreeRuleInput {
  id: number;
  tempId: number;
  provinceId: number;
  cityId: number;
  number: string | number;
  price: string | number;
  value: string;
}

export interface ShippingNoDeliveryRuleInput {
  id: number;
  tempId: number;
  provinceId: number;
  cityId: number;
  value: string;
}

export class ShippingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShippingConfigurationError";
  }
}

interface TemplateCharge {
  templateId: number;
  number: number;
  first: number;
  firstPriceCents: number;
  continue: number;
  continuePriceCents: number;
}

interface TemplateMeasurement {
  number: number;
  subtotalCents: number;
}

const HUNDREDTHS_PATTERN = /^\d+(?:\.\d{1,2})?$/;

function decimalToHundredths(value: string | number, label: string): number {
  const normalized = String(value).trim();
  if (!HUNDREDTHS_PATTERN.test(normalized)) {
    throw new ShippingConfigurationError(`${label}格式无效`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result)) {
    throw new ShippingConfigurationError(`${label}超出安全范围`);
  }
  return result;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new ShippingConfigurationError(`${label}超出安全范围`);
  }
  return result;
}

function checkedMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) {
    throw new ShippingConfigurationError(`${label}超出安全范围`);
  }
  return result;
}

function ceilDivide(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator - 1) / denominator);
}

function matchesProvince(regionName: string, province: string): boolean {
  const left = regionName.trim();
  const right = province.trim();
  if (!left || !right || left === "全国") return false;
  return left === right || left.includes(right) || right.includes(left);
}

export function expandShippingRegionIds(cityId?: number, path?: string): number[] {
  if (cityId === undefined || cityId === 0) return [];
  if (!Number.isSafeInteger(cityId) || cityId < 0) {
    throw new ShippingConfigurationError("Invalid city ID");
  }
  const ancestors = (path ?? "")
    .split("/")
    .filter(Boolean)
    .map((part) => {
      if (!/^\d+$/.test(part)) {
        throw new ShippingConfigurationError("Invalid city hierarchy path");
      }
      const id = Number(part);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new ShippingConfigurationError("Invalid city hierarchy path");
      }
      return id;
    })
    .reverse();
  return [...new Set([cityId, ...ancestors])];
}

function destinationRegionIds(destination: ShippingDestinationInput): readonly number[] {
  return destination.regionIds ?? expandShippingRegionIds(destination.cityId, destination.regionPath);
}

function selectRegion(
  templateId: number,
  regions: readonly ShippingRegionInput[],
  destination: ShippingDestinationInput,
): ShippingRegionInput {
  const candidates = regions
    .filter((region) => region.templateId === templateId)
    .sort((left, right) => left.id - right.id);
  const regional = destinationRegionIds(destination)
    .map((regionId) => candidates.find((region) => region.regionId === regionId))
    .find((region) => region !== undefined);
  const named = destination.province
    ? candidates.find((region) => matchesProvince(region.regionName, destination.province!))
    : undefined;
  const fallback = candidates.find(
    (region) => region.regionId === 0 || region.regionName.trim() === "全国",
  );
  const selected = regional ?? named ?? fallback;
  if (!selected) {
    throw new ShippingConfigurationError(`运费模板 ${templateId} 未配置当前地区费率`);
  }
  return selected;
}

function legacyRulePath(value: string, templateId: number): number[] {
  const normalized = value.trim();
  if (!normalized) return [];
  try {
    const parsed: unknown = JSON.parse(normalized);
    if (
      !Array.isArray(parsed) ||
      parsed.some((entry) => !Number.isSafeInteger(Number(entry)) || Number(entry) < 0)
    ) {
      throw new Error("invalid path");
    }
    return parsed.map(Number);
  } catch {
    throw new ShippingConfigurationError(`运费模板 ${templateId} 的区域路径无效`);
  }
}

function matchesRuleDestination(
  rule: ShippingFreeRuleInput | ShippingNoDeliveryRuleInput,
  destination: ShippingDestinationInput,
): boolean {
  const regionIds = destinationRegionIds(destination);
  if (!regionIds.length) return rule.cityId === 0 && rule.provinceId === 0;
  if (regionIds.includes(rule.cityId) || regionIds.includes(rule.provinceId)) return true;
  const legacyPath = legacyRulePath(rule.value, rule.tempId);
  return legacyPath.some((regionId) => regionIds.includes(regionId));
}

function primaryTemplateCharge(charge: TemplateCharge): number {
  if (charge.number <= charge.first) return charge.firstPriceCents;
  if (charge.continue <= 0) {
    throw new ShippingConfigurationError(
      `运费模板 ${charge.templateId} 的续计量必须大于 0`,
    );
  }
  const extraUnits = ceilDivide(charge.number - charge.first, charge.continue);
  return checkedAdd(
    charge.firstPriceCents,
    checkedMultiply(extraUnits, charge.continuePriceCents, "续费"),
    "模板运费",
  );
}

function secondaryTemplateCharge(charge: TemplateCharge): number {
  if (charge.number <= 0) return 0;
  if (charge.continue <= 0) {
    throw new ShippingConfigurationError(
      `运费模板 ${charge.templateId} 的续计量必须大于 0`,
    );
  }
  return checkedMultiply(
    ceilDivide(charge.number, charge.continue),
    charge.continuePriceCents,
    "续费",
  );
}

/**
 * Reproduces PHP fixed/template freight, designated-free, and no-delivery rules.
 */
export function calculateOrderPostageCents(
  items: readonly ShippingItemInput[],
  templates: readonly ShippingTemplateInput[],
  regions: readonly ShippingRegionInput[],
  destination: ShippingDestinationInput,
  freeRules: readonly ShippingFreeRuleInput[] = [],
  noDeliveryRules: readonly ShippingNoDeliveryRuleInput[] = [],
): number {
  if (
    destination.cityId !== undefined &&
    (!Number.isSafeInteger(destination.cityId) || destination.cityId < 0)
  ) {
    throw new ShippingConfigurationError("城市 ID 必须是非负整数");
  }

  const resolvedDestination: ShippingDestinationInput = {
    ...destination,
    regionIds: destination.regionIds ?? expandShippingRegionIds(destination.cityId, destination.regionPath),
  };
  for (const regionId of resolvedDestination.regionIds ?? []) {
    if (!Number.isSafeInteger(regionId) || regionId <= 0) {
      throw new ShippingConfigurationError("Invalid shipping region ID");
    }
  }

  let fixedPostageCents = 0;
  const measurements = new Map<number, TemplateMeasurement>();
  const templatesById = new Map(templates.map((template) => [template.id, template]));

  for (const templateId of new Set(items.map((item) => item.tempId).filter((id) => id > 0))) {
    const template = templatesById.get(templateId);
    if (template?.noDelivery !== 1) continue;
    const rules = noDeliveryRules.filter((rule) => rule.tempId === templateId);
    if (!rules.length) {
      throw new ShippingConfigurationError(`运费模板 ${templateId} 启用了禁配但未配置区域`);
    }
    if ((destination.cityId ?? 0) === 0) {
      const nationwide = rules.some((rule) => matchesRuleDestination(rule, resolvedDestination));
      if (nationwide) throw new ShippingConfigurationError("当前地区不支持配送");
      throw new ShippingConfigurationError("校验禁配区域必须提供城市 ID");
    }
    if (rules.some((rule) => matchesRuleDestination(rule, resolvedDestination))) {
      throw new ShippingConfigurationError("当前地区不支持配送");
    }
  }

  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new ShippingConfigurationError("商品数量必须是正整数");
    }
    if (item.freight === 1) continue;
    if (item.freight === 2) {
      const itemPostage = checkedMultiply(
        decimalToCents(item.postage),
        item.quantity,
        "固定运费",
      );
      fixedPostageCents = checkedAdd(fixedPostageCents, itemPostage, "固定运费");
      continue;
    }

    const templateId = item.tempId > 0 ? item.tempId : 1;
    const template = templatesById.get(templateId);
    if (!template) {
      throw new ShippingConfigurationError(`运费模板 ${templateId} 不存在或已停用`);
    }
    let unitMeasurement: number;
    if (template.type === 1) {
      unitMeasurement = 100;
    } else if (template.type === 2) {
      unitMeasurement = decimalToHundredths(item.weight, "商品重量");
    } else if (template.type === 3) {
      unitMeasurement = decimalToHundredths(item.volume, "商品体积");
    } else {
      throw new ShippingConfigurationError(`运费模板 ${templateId} 的计费方式无效`);
    }
    const itemMeasurement = checkedMultiply(unitMeasurement, item.quantity, "计费数量");
    const itemSubtotalCents = checkedMultiply(
      decimalToCents(item.unitPrice),
      item.quantity,
      "模板商品小计",
    );
    const current = measurements.get(templateId) ?? { number: 0, subtotalCents: 0 };
    measurements.set(
      templateId,
      {
        number: checkedAdd(current.number, itemMeasurement, "计费数量"),
        subtotalCents: checkedAdd(
          current.subtotalCents,
          itemSubtotalCents,
          "模板商品小计",
        ),
      },
    );
  }

  if (!measurements.size) return fixedPostageCents;

  const charges: TemplateCharge[] = [];
  for (const [templateId, measurement] of measurements) {
    const template = templatesById.get(templateId)!;
    const isDesignatedFree = template.appoint === 1 && freeRules
      .filter((rule) => rule.tempId === templateId)
      .filter((rule) => matchesRuleDestination(rule, resolvedDestination))
      .some(
        (rule) =>
          measurement.number >= decimalToHundredths(rule.number, "包邮计量") &&
          measurement.subtotalCents >= decimalToCents(rule.price),
      );
    if (isDesignatedFree) continue;
    const region = selectRegion(templateId, regions, resolvedDestination);
    charges.push({
      templateId,
      number: measurement.number,
      first: decimalToHundredths(region.first, "首计量"),
      firstPriceCents: decimalToCents(region.firstPrice),
      continue: decimalToHundredths(region.continue, "续计量"),
      continuePriceCents: decimalToCents(region.continuePrice),
    });
  }

  if (!charges.length) return fixedPostageCents;

  const maxFirstPrice = Math.max(...charges.map((charge) => charge.firstPriceCents));
  let templatePostageCents = 0;
  for (const primary of charges.filter(
    (charge) => charge.firstPriceCents === maxFirstPrice,
  )) {
    let candidate = primaryTemplateCharge(primary);
    for (const secondary of charges) {
      if (secondary === primary) continue;
      candidate = checkedAdd(candidate, secondaryTemplateCharge(secondary), "模板运费");
    }
    templatePostageCents = Math.max(templatePostageCents, candidate);
  }

  return checkedAdd(fixedPostageCents, templatePostageCents, "订单运费");
}
