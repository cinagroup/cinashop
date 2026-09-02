import { and, eq, inArray, sql } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import { storeConfig } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

export const SUPPLIER_CONFIG_SCOPE_TYPE = 2;
const STORE_CONFIG_WRITE_LOCK = 8_214_004;

export type StoreConfigGroup = "store_printing_deploy" | "store_electronic_sheet";
type StoreConfigFieldKind = "switch" | "text" | "secret";

interface StoreConfigFieldDefinition {
  key: string;
  label: string;
  kind: StoreConfigFieldKind;
  maxLength: number;
}

const PRINTER_FIELDS: readonly StoreConfigFieldDefinition[] = [
  { key: "store_pay_success_printing_switch", label: "支付成功后自动打印", kind: "switch", maxLength: 1 },
  { key: "store_printing_timing", label: "打印时机", kind: "text", maxLength: 64 },
  { key: "store_terminal_number", label: "终端编号", kind: "text", maxLength: 128 },
  { key: "store_printing_client_id", label: "打印平台 Client ID", kind: "text", maxLength: 255 },
  { key: "store_printing_api_key", label: "打印平台 API Key", kind: "secret", maxLength: 512 },
  { key: "store_develop_id", label: "开发者 ID", kind: "text", maxLength: 255 },
  { key: "store_print_type", label: "打印机类型", kind: "text", maxLength: 64 },
  { key: "store_fey_user", label: "飞鹅云账号", kind: "text", maxLength: 255 },
  { key: "store_fey_ukey", label: "飞鹅云 UKEY", kind: "secret", maxLength: 512 },
  { key: "store_fey_sn", label: "飞鹅云打印机 SN", kind: "text", maxLength: 255 },
] as const;

const EXPRESS_FIELDS: readonly StoreConfigFieldDefinition[] = [
  { key: "store_config_export_open", label: "启用电子面单", kind: "switch", maxLength: 1 },
  { key: "store_config_export_id", label: "默认快递公司 ID", kind: "text", maxLength: 255 },
  { key: "store_config_export_temp_id", label: "电子面单模板 ID", kind: "text", maxLength: 255 },
  { key: "store_config_export_to_name", label: "发件人", kind: "text", maxLength: 128 },
  { key: "store_config_export_to_tel", label: "发件电话", kind: "text", maxLength: 32 },
  { key: "store_config_export_to_address", label: "发件地址", kind: "text", maxLength: 255 },
  { key: "store_config_export_siid", label: "云打印机编号", kind: "text", maxLength: 50 },
] as const;

export const SUPPLIER_CONFIG_GROUPS: Readonly<Record<StoreConfigGroup, {
  label: string;
  fields: readonly StoreConfigFieldDefinition[];
}>> = {
  store_printing_deploy: { label: "小票打印", fields: PRINTER_FIELDS },
  store_electronic_sheet: { label: "电子面单", fields: EXPRESS_FIELDS },
};

export interface StoredConfigRow {
  id: number;
  keyName: string;
  value: string;
}

export interface NormalizedConfigUpdate {
  keyName: string;
  value: string | number;
  preserveBlankSecret: boolean;
}

function objectValue(value: unknown, message = "请求数据格式错误"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException(message);
  }
  return value as Record<string, unknown>;
}

function definitionsFor(group?: string): readonly StoreConfigFieldDefinition[] {
  if (!group || group === "third") return [...PRINTER_FIELDS, ...EXPRESS_FIELDS];
  const definition = SUPPLIER_CONFIG_GROUPS[group as StoreConfigGroup];
  if (!definition) throw new ValidateException("配置类型不正确");
  return definition.fields;
}

function switchValue(value: unknown, label: string): number {
  if (value === true || value === 1 || value === "1" || value === "true") return 1;
  if (value === false || value === 0 || value === "0" || value === "false") return 0;
  throw new ValidateException(`${label}只能是0或1`);
}

function textValue(value: unknown, definition: StoreConfigFieldDefinition): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidateException(`${definition.label}格式错误`);
  }
  const normalized = String(value).trim();
  if (normalized.length > definition.maxLength) {
    throw new ValidateException(`${definition.label}不能超过${definition.maxLength}个字符`);
  }
  return normalized;
}

export function normalizeSupplierConfigUpdates(
  input: unknown,
  requestedGroup?: string,
): NormalizedConfigUpdate[] {
  const body = objectValue(input);
  const nestedValues = Object.prototype.hasOwnProperty.call(body, "values")
    ? objectValue(body.values, "配置内容格式错误")
    : null;
  if (nestedValues) {
    const unexpected = Object.keys(body).filter((key) => !["values", "type", "group"].includes(key));
    if (unexpected.length) throw new ValidateException(`不支持的配置项：${unexpected[0]}`);
  }
  const values = nestedValues ?? Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "type" && key !== "group"),
  );
  const definitions = definitionsFor(requestedGroup);
  const allowed = new Map(definitions.map((definition) => [definition.key, definition]));
  const entries = Object.entries(values);
  if (!entries.length) throw new ValidateException("请至少提交一项配置");
  if (entries.length > definitions.length) throw new ValidateException("配置项数量过多");
  return entries.map(([keyName, rawValue]) => {
    const definition = allowed.get(keyName);
    if (!definition) throw new ValidateException(`不支持的配置项：${keyName}`);
    const value = definition.kind === "switch"
      ? switchValue(rawValue, definition.label)
      : textValue(rawValue, definition);
    const encoded = JSON.stringify(value);
    if (encoded.length > 2000) throw new ValidateException(`${definition.label}内容过长`);
    return {
      keyName,
      value,
      preserveBlankSecret: definition.kind === "secret" && value === "",
    };
  });
}

export function requestedConfigGroup(input: unknown): string | undefined {
  const body = objectValue(input);
  const value = typeof body.group === "string"
    ? body.group
    : typeof body.type === "string" ? body.type : undefined;
  if (value) definitionsFor(value);
  return value;
}

function parseLegacyValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function configuredSecret(value: unknown): boolean {
  return typeof value === "string" ? value.length > 0 : value !== null && value !== undefined;
}

export function buildSupplierConfigView(group: string, rows: readonly StoredConfigRow[]) {
  const selected = definitionsFor(group);
  const byKey = new Map<string, StoredConfigRow[]>();
  for (const row of rows) {
    const matches = byKey.get(row.keyName) ?? [];
    matches.push(row);
    byKey.set(row.keyName, matches);
  }
  for (const definition of selected) {
    if ((byKey.get(definition.key)?.length ?? 0) > 1) {
      throw new ValidateException(`配置 ${definition.key} 存在重复历史记录，请先清理`);
    }
  }
  const groups = (Object.entries(SUPPLIER_CONFIG_GROUPS) as Array<[
    StoreConfigGroup,
    (typeof SUPPLIER_CONFIG_GROUPS)[StoreConfigGroup],
  ]>)
    .filter(([, definition]) => definition.fields.some((field) => selected.includes(field)))
    .map(([key, definition]) => ({
      key,
      label: definition.label,
      fields: definition.fields
        .filter((field) => selected.includes(field))
        .map((field) => {
          const row = byKey.get(field.key)?.[0];
          const decoded = row ? parseLegacyValue(row.value) : undefined;
          const value = field.kind === "secret"
            ? ""
            : field.kind === "switch"
              ? (decoded === true || decoded === 1 || decoded === "1" ? 1 : 0)
              : typeof decoded === "string" || typeof decoded === "number" ? String(decoded) : "";
          return {
            key: field.key,
            label: field.label,
            input_type: field.kind === "secret" ? "password" : field.kind,
            value,
            configured: field.kind === "secret" ? configuredSecret(decoded) : !!row,
          };
        }),
    }));
  return {
    type: group,
    title: "供应商履约配置",
    action: "/supplierapi/config",
    method: "POST",
    groups,
  };
}

const LEGACY_PRINTER_INPUT_KEYS = new Set([
  "id",
  "supplier_id",
  "status",
  "develop_id",
  "api_key",
  "client_id",
  "terminal_number",
]);

export function normalizeLegacyPrinterConfigInput(input: unknown): Record<string, unknown> {
  const body = objectValue(input);
  const unexpected = Object.keys(body).find((key) => !LEGACY_PRINTER_INPUT_KEYS.has(key));
  if (unexpected) throw new ValidateException(`不支持的小票打印配置项：${unexpected}`);
  return {
    ...(Object.prototype.hasOwnProperty.call(body, "status")
      ? { store_pay_success_printing_switch: body.status }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "develop_id")
      ? { store_develop_id: body.develop_id }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "api_key")
      ? { store_printing_api_key: body.api_key }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "client_id")
      ? { store_printing_client_id: body.client_id }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "terminal_number")
      ? { store_terminal_number: body.terminal_number }
      : {}),
  };
}

export function buildLegacyPrinterConfigView(
  supplierId: number,
  view: ReturnType<typeof buildSupplierConfigView>,
) {
  const fields = new Map(
    view.groups.flatMap((group) => group.fields).map((field) => [field.key, field]),
  );
  const value = (key: string): string | number => fields.get(key)?.value ?? "";
  return {
    id: 0,
    supplier_id: supplierId,
    status: Number(value("store_pay_success_printing_switch")) === 1 ? 1 : 0,
    develop_id: value("store_develop_id"),
    // Stored printer secrets are intentionally write-only. An empty submission
    // is interpreted as "preserve" by saveSupplierConfig.
    api_key: "",
    client_id: value("store_printing_client_id"),
    terminal_number: value("store_terminal_number"),
  };
}

export class StoreScopedConfigService {
  constructor(private readonly container: Container) {}

  async listSupplierConfig(supplierId: number, group: string) {
    if (!Number.isSafeInteger(supplierId) || supplierId <= 0) {
      throw new ValidateException("供应商ID错误");
    }
    const definitions = definitionsFor(group);
    const rows = await this.container.db
      .select({ id: storeConfig.id, keyName: storeConfig.keyName, value: storeConfig.value })
      .from(storeConfig)
      .where(and(
        eq(storeConfig.type, SUPPLIER_CONFIG_SCOPE_TYPE),
        eq(storeConfig.relationId, supplierId),
        inArray(storeConfig.keyName, definitions.map((definition) => definition.key)),
      ))
      .orderBy(storeConfig.id);
    return buildSupplierConfigView(group, rows);
  }

  async saveSupplierConfig(supplierId: number, input: unknown, requestedGroup?: string) {
    if (!Number.isSafeInteger(supplierId) || supplierId <= 0) {
      throw new ValidateException("供应商ID错误");
    }
    const updates = normalizeSupplierConfigUpdates(input, requestedGroup);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${STORE_CONFIG_WRITE_LOCK}, ${supplierId})`);
      const rows = await tx
        .select({ id: storeConfig.id, keyName: storeConfig.keyName, value: storeConfig.value })
        .from(storeConfig)
        .where(and(
          eq(storeConfig.type, SUPPLIER_CONFIG_SCOPE_TYPE),
          eq(storeConfig.relationId, supplierId),
          inArray(storeConfig.keyName, updates.map((update) => update.keyName)),
        ))
        .orderBy(storeConfig.id)
        .for("update");
      const byKey = new Map<string, StoredConfigRow[]>();
      for (const row of rows) {
        const matches = byKey.get(row.keyName) ?? [];
        matches.push(row);
        byKey.set(row.keyName, matches);
      }
      for (const update of updates) {
        if ((byKey.get(update.keyName)?.length ?? 0) > 1) {
          throw new ValidateException(`配置 ${update.keyName} 存在重复历史记录，请先清理`);
        }
      }
      const now = Math.floor(Date.now() / 1000);
      const inserts: Array<typeof storeConfig.$inferInsert> = [];
      let changed = 0;
      for (const update of updates) {
        const existing = byKey.get(update.keyName)?.[0];
        if (update.preserveBlankSecret) continue;
        const value = JSON.stringify(update.value);
        if (existing) {
          await tx.update(storeConfig)
            .set({ value, addTime: now })
            .where(eq(storeConfig.id, existing.id));
        } else {
          inserts.push({
            type: SUPPLIER_CONFIG_SCOPE_TYPE,
            relationId: supplierId,
            keyName: update.keyName,
            value,
            addTime: now,
          });
        }
        changed += 1;
      }
      if (inserts.length) await tx.insert(storeConfig).values(inserts);
      return { updated: changed };
    });
  }

  async legacyPrinterConfig(supplierId: number) {
    const view = await this.listSupplierConfig(supplierId, "store_printing_deploy");
    return buildLegacyPrinterConfigView(supplierId, view);
  }

  async saveLegacyPrinterConfig(supplierId: number, input: unknown) {
    const mapped = normalizeLegacyPrinterConfigInput(input);
    if (Object.keys(mapped).length === 0) throw new ValidateException("请至少提交一项配置");
    return this.saveSupplierConfig(supplierId, mapped, "store_printing_deploy");
  }
}
