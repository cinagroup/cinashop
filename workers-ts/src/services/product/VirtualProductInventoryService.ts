import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  storeProduct,
  storeProductAttrValue,
  storeProductStockRecord,
  storeProductVirtual,
  systemVirtualInventoryExport,
} from "@/models/schema";
import { md5 } from "@/utils/jwt";
import { NotFoundException, ValidateException } from "@/utils/errors";

const CARD_PRODUCT_TYPE = 1;
const PRODUCT_ATTR_TYPE = 0;
const SUPPLIER_PRODUCT_TYPE = 2;
const INVENTORY_LOCK_NAMESPACE = 731_603;
const MAX_IMPORT_CARDS = 1_000;
const MAX_LIST_LIMIT = 100;
const DEFAULT_ALERT_THRESHOLD = 5;
const MAX_ALERT_THRESHOLD = 1_000;
const MAX_EXPORT_CARDS = 1_000;
const EXPORT_TICKET_TTL_SECONDS = 60;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const VIRTUAL_INVENTORY_EXPORT_CONFIRM = "EXPORT_AVAILABLE_VIRTUAL_CARDS";

export type VirtualInventoryRiskLevel = "shortage" | "low_buffer" | "healthy";

export type VirtualInventoryOwner =
  | { kind: "admin" }
  | { kind: "supplier"; supplierId: number };

export type VirtualInventoryExportActor =
  | { kind: "admin"; actorId: number }
  | { kind: "supplier"; actorId: number; supplierId: number };

export interface VirtualCardImportRow {
  cardNo: string;
  cardPwd: string;
}

export interface NormalizedVirtualCardImport {
  cards: VirtualCardImportRow[];
  requestDuplicates: number;
}

interface OwnedCardProduct {
  id: number;
  type: number;
  relationId: number;
  storeName: string;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException(message);
  }
  return value as Record<string, unknown>;
}

function validateExportActor(actor: VirtualInventoryExportActor): VirtualInventoryOwner {
  if (!Number.isSafeInteger(actor.actorId) || actor.actorId <= 0) {
    throw new ValidateException("操作人身份错误");
  }
  if (actor.kind === "admin") return { kind: "admin" };
  if (!Number.isSafeInteger(actor.supplierId) || actor.supplierId <= 0) {
    throw new ValidateException("供应商身份错误");
  }
  return { kind: "supplier", supplierId: actor.supplierId };
}

function normalizedExportReason(value: unknown): string {
  if (typeof value !== "string") throw new ValidateException("请填写导出原因");
  const reason = value.trim();
  if (reason.length < 8 || reason.length > 500) {
    throw new ValidateException("导出原因必须为8至500个字符");
  }
  if (CONTROL_CHARACTERS.test(reason)) {
    throw new ValidateException("导出原因不能包含控制字符");
  }
  return reason;
}

function normalizedExportSku(body: Record<string, unknown>): string {
  const value = body.attr_unique ?? body.attrUnique;
  if (typeof value !== "string" || !value.trim()) throw new ValidateException("请选择SKU");
  const skuUnique = value.trim();
  if (skuUnique.length > 20) throw new ValidateException("SKU标识错误");
  return skuUnique;
}

function randomExportTicket(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function exportTicketHash(ticket: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizedExportTicket(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ValidateException("导出票据无效或已失效");
  }
  return value;
}

function normalizeCardField(
  value: unknown,
  rowNumber: number,
  label: string,
  required: boolean,
): string {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") {
    throw new ValidateException(`第 ${rowNumber} 行${label}格式错误`);
  }
  const normalized = value.trim();
  if (required && !normalized) {
    throw new ValidateException(`第 ${rowNumber} 行${label}不能为空`);
  }
  if (normalized.length > 255) {
    throw new ValidateException(`第 ${rowNumber} 行${label}不能超过255个字符`);
  }
  if (CONTROL_CHARACTERS.test(normalized)) {
    throw new ValidateException(`第 ${rowNumber} 行${label}不能包含控制字符`);
  }
  return normalized;
}

/**
 * Accept both the new API contract and the old PHP editor's { key, value }
 * rows. Password-only rows remain supported because the legacy UI treated the
 * card number as optional.
 */
export function normalizeVirtualCardImport(value: unknown): NormalizedVirtualCardImport {
  const source = Array.isArray(value)
    ? value
    : record(value, "卡密导入数据格式错误").cards;
  if (!Array.isArray(source) || source.length === 0) {
    throw new ValidateException("请导入至少一条卡密");
  }
  if (source.length > MAX_IMPORT_CARDS) {
    throw new ValidateException(`单次最多导入 ${MAX_IMPORT_CARDS} 条卡密`);
  }

  const seen = new Set<string>();
  const cards: VirtualCardImportRow[] = [];
  let requestDuplicates = 0;
  for (const [index, item] of source.entries()) {
    const row = record(item, `第 ${index + 1} 行卡密格式错误`);
    const cardNo = normalizeCardField(
      row.card_no ?? row.cardNo ?? row.key,
      index + 1,
      "卡号",
      false,
    );
    const cardPwd = normalizeCardField(
      row.card_pwd ?? row.cardPwd ?? row.value,
      index + 1,
      "密码",
      true,
    );
    const identity = `${cardNo}\u0000${cardPwd}`;
    if (seen.has(identity)) {
      requestDuplicates += 1;
      continue;
    }
    seen.add(identity);
    cards.push({ cardNo, cardPwd });
  }
  if (!cards.length) throw new ValidateException("导入内容全部重复");
  return { cards, requestDuplicates };
}

export function maskVirtualCardNumber(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "未设置";
  if (normalized.length <= 4) return "•".repeat(Math.max(4, normalized.length));
  const suffix = normalized.slice(-4);
  return `${"•".repeat(Math.max(4, normalized.length - suffix.length))}${suffix}`;
}

function positiveInteger(value: string | number | undefined, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ValidateException(`${field}错误`);
  }
  return parsed;
}

function listLimit(value: string | undefined): number {
  if (value === undefined || value === "") return 30;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_LIST_LIMIT) {
    throw new ValidateException(`limit 必须是1至${MAX_LIST_LIMIT}的整数`);
  }
  return parsed;
}

function alertThreshold(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_ALERT_THRESHOLD;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_ALERT_THRESHOLD) {
    throw new ValidateException(`threshold 必须是0至${MAX_ALERT_THRESHOLD}的整数`);
  }
  return parsed;
}

export function classifyVirtualInventoryRisk(
  availableCards: number,
  sellableStock: number,
  threshold: number,
): VirtualInventoryRiskLevel {
  if (availableCards < sellableStock) return "shortage";
  if (availableCards - sellableStock <= threshold) return "low_buffer";
  return "healthy";
}

function ownerConditions(owner: VirtualInventoryOwner): SQL[] {
  if (owner.kind === "admin") return [];
  if (!Number.isSafeInteger(owner.supplierId) || owner.supplierId <= 0) {
    throw new ValidateException("供应商身份错误");
  }
  return [
    eq(storeProduct.type, SUPPLIER_PRODUCT_TYPE),
    eq(storeProduct.relationId, owner.supplierId),
  ];
}

async function ownedProduct(
  db: DbClient,
  owner: VirtualInventoryOwner,
  productId: number,
  lock = false,
): Promise<OwnedCardProduct> {
  let query = db
    .select({
      id: storeProduct.id,
      type: storeProduct.type,
      relationId: storeProduct.relationId,
      productType: storeProduct.productType,
      storeName: storeProduct.storeName,
    })
    .from(storeProduct)
    .where(
      and(
        eq(storeProduct.id, productId),
        eq(storeProduct.isDel, 0),
        ...ownerConditions(owner),
      ),
    )
    .limit(1)
    .$dynamic();
  if (lock) query = query.for("update");
  const product = (await query)[0];
  if (!product) {
    throw new NotFoundException(
      owner.kind === "supplier" ? "商品不存在或不属于当前供应商" : "商品不存在",
    );
  }
  if (product.productType !== CARD_PRODUCT_TYPE) {
    throw new ValidateException("仅卡密商品可以管理卡密库存");
  }
  return product;
}

function inventoryStoreId(product: OwnedCardProduct): number {
  return product.type === 0 ? 0 : Math.max(0, product.relationId);
}

function cardUnique(skuUnique: string, card: VirtualCardImportRow): string {
  // Keep PHP's historical digest input so migrated rows are recognized.
  return md5(`${skuUnique},${card.cardNo},${card.cardPwd}`);
}

export class VirtualProductInventoryService {
  constructor(private readonly container: Container) {}

  async alerts(owner: VirtualInventoryOwner, query: Record<string, string>) {
    const threshold = alertThreshold(query.threshold);
    const limit = listLimit(query.limit);
    const cursor = query.cursor ? positiveInteger(query.cursor, "cursor") : 0;
    const level = (query.level ?? "all").trim().toLowerCase();
    if (!new Set(["all", "shortage", "low_buffer"]).has(level)) {
      throw new ValidateException("预警级别筛选错误");
    }
    // Keep this CASE expression aligned with classifyVirtualInventoryRisk().
    const ownerFilter = owner.kind === "supplier"
      ? sql`AND p.type = ${SUPPLIER_PRODUCT_TYPE} AND p.relation_id = ${owner.supplierId}`
      : sql``;
    if (owner.kind === "supplier") ownerConditions(owner);
    const levelFilter = level === "all"
      ? sql`risk_level <> 'healthy'`
      : sql`risk_level = ${level}`;

    interface AlertRow {
      sku_id: number;
      product_id: number;
      store_name: string;
      owner_type: number;
      owner_id: number;
      attr_unique: string;
      suk: string;
      sellable_stock: number;
      total_cards: number;
      available_cards: number;
      assigned_cards: number;
      buffer: number;
      risk_level: VirtualInventoryRiskLevel;
    }
    interface AlertQueryResult {
      products_scanned: number;
      skus_scanned: number;
      alert_products: number;
      alert_skus: number;
      shortage_skus: number;
      low_buffer_skus: number;
      page_rows: AlertRow[];
    }

    return withTx(this.container, async (tx) => {
      const rows = await tx.execute(sql`
        WITH inventory AS (
          SELECT
            av.id AS sku_id,
            p.id AS product_id,
            p.store_name,
            p.type AS owner_type,
            p.relation_id AS owner_id,
            TRIM(av."unique") AS attr_unique,
            av.suk,
            av.stock::int AS sellable_stock,
            COUNT(v.id)::int AS total_cards,
            COUNT(v.id) FILTER (WHERE v.uid = 0)::int AS available_cards
          FROM store_product p
          INNER JOIN store_product_attr_value av
            ON av.product_id = p.id AND av.type = ${PRODUCT_ATTR_TYPE}
          LEFT JOIN store_product_virtual v
            ON v.product_id = p.id AND v.attr_unique = av."unique"
          WHERE p.is_del = 0
            AND p.product_type = ${CARD_PRODUCT_TYPE}
            AND COALESCE(LENGTH(TRIM(av.disk_info)), 0) = 0
            ${ownerFilter}
          GROUP BY
            av.id, p.id, p.store_name, p.type, p.relation_id,
            av."unique", av.suk, av.stock
        ), candidates AS (
          SELECT *
          FROM inventory
          WHERE sellable_stock > 0 OR total_cards > 0
        ), classified AS (
          SELECT
            *,
            GREATEST(total_cards - available_cards, 0)::int AS assigned_cards,
            (available_cards - sellable_stock)::int AS buffer,
            CASE
              WHEN available_cards < sellable_stock THEN 'shortage'
              WHEN available_cards - sellable_stock <= ${threshold} THEN 'low_buffer'
              ELSE 'healthy'
            END AS risk_level
          FROM candidates
        ), alert_summary AS (
          SELECT
            COUNT(DISTINCT product_id)::int AS products_scanned,
            COUNT(*)::int AS skus_scanned,
            COUNT(DISTINCT product_id) FILTER (WHERE risk_level <> 'healthy')::int AS alert_products,
            COUNT(*) FILTER (WHERE risk_level <> 'healthy')::int AS alert_skus,
            COUNT(*) FILTER (WHERE risk_level = 'shortage')::int AS shortage_skus,
            COUNT(*) FILTER (WHERE risk_level = 'low_buffer')::int AS low_buffer_skus
          FROM classified
        ), page_rows AS (
          SELECT *
          FROM classified
          WHERE ${levelFilter} AND sku_id > ${cursor}
          ORDER BY sku_id ASC
          LIMIT ${limit + 1}
        )
        SELECT
          s.*,
          COALESCE(
            (SELECT jsonb_agg(to_jsonb(page_rows) ORDER BY sku_id) FROM page_rows),
            '[]'::jsonb
          ) AS page_rows
        FROM alert_summary s
      `) as unknown as AlertQueryResult[];
      const result = rows[0];
      if (!result) throw new Error("卡密库存预警查询未返回结果");
      const pageRows = Array.isArray(result.page_rows) ? result.page_rows : [];
      const hasMore = pageRows.length > limit;
      const list = pageRows.slice(0, limit);
      return {
        threshold,
        level,
        summary: {
          products_scanned: Number(result.products_scanned ?? 0),
          skus_scanned: Number(result.skus_scanned ?? 0),
          alert_products: Number(result.alert_products ?? 0),
          alert_skus: Number(result.alert_skus ?? 0),
          shortage_skus: Number(result.shortage_skus ?? 0),
          low_buffer_skus: Number(result.low_buffer_skus ?? 0),
        },
        list,
        next_cursor: hasMore ? list.at(-1)?.sku_id ?? null : null,
      };
    });
  }

  async inventory(
    owner: VirtualInventoryOwner,
    productIdValue: string | number,
    query: Record<string, string>,
  ) {
    const productId = positiveInteger(productIdValue, "商品ID");
    return withTx(this.container, async (tx) => {
    const product = await ownedProduct(tx, owner, productId);
    const skus = await tx
      .select({
        unique: storeProductAttrValue.unique,
        suk: storeProductAttrValue.suk,
        stock: storeProductAttrValue.stock,
        sum_stock: storeProductAttrValue.sumStock,
        sales: storeProductAttrValue.sales,
        disk_info_configured: sql<boolean>`COALESCE(LENGTH(TRIM(${storeProductAttrValue.diskInfo})), 0) > 0`,
      })
      .from(storeProductAttrValue)
      .where(
        and(
          eq(storeProductAttrValue.productId, productId),
          eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
        ),
      )
      .orderBy(asc(storeProductAttrValue.id));
    if (!skus.length) throw new ValidateException("商品没有可管理的SKU");

    const counts = await tx
      .select({
        attrUnique: storeProductVirtual.attrUnique,
        total: count(),
        available: sql<number>`COUNT(*) FILTER (WHERE ${storeProductVirtual.uid} = 0)::int`,
      })
      .from(storeProductVirtual)
      .where(eq(storeProductVirtual.productId, productId))
      .groupBy(storeProductVirtual.attrUnique);
    const countsBySku = new Map(counts.map((item) => [item.attrUnique, item]));
    const skuSummaries = skus.map((sku) => {
      const cardCount = countsBySku.get(sku.unique);
      const total = Number(cardCount?.total ?? 0);
      const available = Number(cardCount?.available ?? 0);
      return {
        ...sku,
        total_cards: total,
        available_cards: available,
        assigned_cards: Math.max(total - available, 0),
        unassigned_minus_sellable: available - sku.stock,
      };
    });

    const selectedUnique = (query.attr_unique ?? query.attrUnique ?? skus[0].unique).trim();
    if (!skuSummaries.some((sku) => sku.unique === selectedUnique)) {
      throw new ValidateException("SKU不存在或不属于当前商品");
    }
    const limit = listLimit(query.limit);
    const cursor = query.cursor ? positiveInteger(query.cursor, "cursor") : undefined;
    const status = (query.status ?? "all").trim().toLowerCase();
    if (!new Set(["all", "available", "assigned"]).has(status)) {
      throw new ValidateException("库存状态筛选错误");
    }
    const conditions: SQL[] = [
      eq(storeProductVirtual.productId, productId),
      eq(storeProductVirtual.attrUnique, selectedUnique),
    ];
    if (cursor) conditions.push(lt(storeProductVirtual.id, cursor));
    if (status === "available") conditions.push(eq(storeProductVirtual.uid, 0));
    if (status === "assigned") conditions.push(sql`${storeProductVirtual.uid} > 0`);

    const rows = await tx
      .select({
        id: storeProductVirtual.id,
        attr_unique: storeProductVirtual.attrUnique,
        card_no: storeProductVirtual.cardNo,
        password_configured: sql<boolean>`COALESCE(LENGTH(TRIM(${storeProductVirtual.cardPwd})), 0) > 0`,
        assigned: sql<boolean>`${storeProductVirtual.uid} > 0`,
      })
      .from(storeProductVirtual)
      .where(and(...conditions))
      .orderBy(desc(storeProductVirtual.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((row) => ({
      id: row.id,
      attr_unique: row.attr_unique,
      card_no_masked: maskVirtualCardNumber(row.card_no),
      password_configured: row.password_configured,
      status: row.assigned ? "assigned" : "available",
    }));
    const totalCards = skuSummaries.reduce((sum, sku) => sum + sku.total_cards, 0);
    const availableCards = skuSummaries.reduce((sum, sku) => sum + sku.available_cards, 0);
    return {
      product: {
        id: product.id,
        store_name: product.storeName,
        owner_type: product.type,
        owner_id: product.relationId,
      },
      summary: {
        total_cards: totalCards,
        available_cards: availableCards,
        assigned_cards: Math.max(totalCards - availableCards, 0),
      },
      skus: skuSummaries,
      selected_attr_unique: selectedUnique,
      list: page,
      next_cursor: hasMore ? page.at(-1)?.id ?? null : null,
    };
    });
  }

  async createExportTicket(
    actor: VirtualInventoryExportActor,
    productIdValue: string | number,
    value: unknown,
  ) {
    const owner = validateExportActor(actor);
    const productId = positiveInteger(productIdValue, "商品ID");
    const body = record(value, "导出申请格式错误");
    if (body.confirm !== VIRTUAL_INVENTORY_EXPORT_CONFIRM) {
      throw new ValidateException("缺少卡密敏感导出确认");
    }
    const skuUnique = normalizedExportSku(body);
    const reason = normalizedExportReason(body.reason);
    const ticket = randomExportTicket();
    const tokenHash = await exportTicketHash(ticket);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + EXPORT_TICKET_TTL_SECONDS * 1_000);

    return withTx(this.container, async (tx) => {
      const product = await ownedProduct(tx, owner, productId);
      const sku = (
        await tx
          .select({
            unique: storeProductAttrValue.unique,
            diskInfo: storeProductAttrValue.diskInfo,
          })
          .from(storeProductAttrValue)
          .where(
            and(
              eq(storeProductAttrValue.productId, productId),
              eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
              eq(storeProductAttrValue.unique, skuUnique),
            ),
          )
          .limit(1)
      )[0];
      if (!sku) throw new ValidateException("SKU不存在或不属于当前商品");
      if (sku.diskInfo?.trim()) {
        throw new ValidateException("固定虚拟内容SKU不支持卡密导出");
      }
      const counts = await tx
        .select({ count: count() })
        .from(storeProductVirtual)
        .where(
          and(
            eq(storeProductVirtual.productId, productId),
            eq(storeProductVirtual.attrUnique, skuUnique),
            eq(storeProductVirtual.uid, 0),
          ),
        );
      const availableCount = Number(counts[0]?.count ?? 0);
      if (availableCount === 0) throw new ValidateException("当前SKU没有可导出的未分配卡密");
      if (availableCount > MAX_EXPORT_CARDS) {
        throw new ValidateException(`单次最多导出 ${MAX_EXPORT_CARDS} 条卡密，请先缩小库存批次`);
      }
      const inserted = await tx
        .insert(systemVirtualInventoryExport)
        .values({
          tokenHash,
          actorType: actor.kind,
          actorId: actor.actorId,
          supplierId: actor.kind === "supplier" ? actor.supplierId : 0,
          productId,
          attrUnique: skuUnique,
          reason,
          requestedCount: availableCount,
          exportedCount: 0,
          status: "READY",
          createdAt,
          expiresAt,
        })
        .returning({ id: systemVirtualInventoryExport.id });
      if (!inserted[0]) throw new Error("卡密导出票据写入失败");
      return {
        ticket,
        expires_at: Math.floor(expiresAt.getTime() / 1_000),
        available_count: availableCount,
        product: { id: product.id, store_name: product.storeName },
        attr_unique: skuUnique,
      };
    });
  }

  async consumeExportTicket(
    actor: VirtualInventoryExportActor,
    productIdValue: string | number,
    value: unknown,
  ) {
    const owner = validateExportActor(actor);
    const productId = positiveInteger(productIdValue, "商品ID");
    const body = record(value, "导出票据格式错误");
    const tokenHash = await exportTicketHash(normalizedExportTicket(body.ticket));
    const consumedAt = new Date();

    const outcome = await withTx(this.container, async (tx) => {
      const row = (
        await tx
          .select({
            id: systemVirtualInventoryExport.id,
            status: systemVirtualInventoryExport.status,
            attrUnique: systemVirtualInventoryExport.attrUnique,
            reason: systemVirtualInventoryExport.reason,
            requestedCount: systemVirtualInventoryExport.requestedCount,
            expiresAt: systemVirtualInventoryExport.expiresAt,
          })
          .from(systemVirtualInventoryExport)
          .where(
            and(
              eq(systemVirtualInventoryExport.tokenHash, tokenHash),
              eq(systemVirtualInventoryExport.actorType, actor.kind),
              eq(systemVirtualInventoryExport.actorId, actor.actorId),
              eq(
                systemVirtualInventoryExport.supplierId,
                actor.kind === "supplier" ? actor.supplierId : 0,
              ),
              eq(systemVirtualInventoryExport.productId, productId),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      if (!row || row.status !== "READY") {
        return { failure: "导出票据无效或已失效" } as const;
      }
      if (row.expiresAt.getTime() <= consumedAt.getTime()) {
        await tx
          .update(systemVirtualInventoryExport)
          .set({ status: "EXPIRED" })
          .where(eq(systemVirtualInventoryExport.id, row.id));
        return { failure: "导出票据无效或已失效" } as const;
      }

      const product = await ownedProduct(tx, owner, productId);
      const sku = (
        await tx
          .select({ diskInfo: storeProductAttrValue.diskInfo })
          .from(storeProductAttrValue)
          .where(
            and(
              eq(storeProductAttrValue.productId, productId),
              eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
              eq(storeProductAttrValue.unique, row.attrUnique),
            ),
          )
          .limit(1)
      )[0];
      if (!sku || sku.diskInfo?.trim()) {
        await tx
          .update(systemVirtualInventoryExport)
          .set({ status: "EXPIRED" })
          .where(eq(systemVirtualInventoryExport.id, row.id));
        return { failure: "SKU已变化，请重新申请导出" } as const;
      }

      const cards = await tx
        .select({
          card_no: storeProductVirtual.cardNo,
          card_pwd: storeProductVirtual.cardPwd,
        })
        .from(storeProductVirtual)
        .where(
          and(
            eq(storeProductVirtual.productId, productId),
            eq(storeProductVirtual.attrUnique, row.attrUnique),
            eq(storeProductVirtual.uid, 0),
          ),
        )
        .orderBy(asc(storeProductVirtual.id))
        .limit(MAX_EXPORT_CARDS + 1);
      if (cards.length === 0 || cards.length > MAX_EXPORT_CARDS) {
        await tx
          .update(systemVirtualInventoryExport)
          .set({ status: "EXPIRED" })
          .where(eq(systemVirtualInventoryExport.id, row.id));
        return { failure: "未分配卡密库存已变化，请重新申请导出" } as const;
      }
      const consumed = await tx
        .update(systemVirtualInventoryExport)
        .set({
          status: "CONSUMED",
          exportedCount: cards.length,
          consumedAt,
        })
        .where(
          and(
            eq(systemVirtualInventoryExport.id, row.id),
            eq(systemVirtualInventoryExport.status, "READY"),
          ),
        )
        .returning({ id: systemVirtualInventoryExport.id });
      if (!consumed[0]) return { failure: "导出票据无效或已失效" } as const;
      return {
        result: {
          export_id: row.id,
          exported_at: Math.floor(consumedAt.getTime() / 1_000),
          reason: row.reason,
          requested_count: row.requestedCount,
          exported_count: cards.length,
          product: { id: product.id, store_name: product.storeName },
          attr_unique: row.attrUnique,
          scope: "available" as const,
          cards,
        },
      } as const;
    });
    if ("failure" in outcome && outcome.failure) throw new ValidateException(outcome.failure);
    if (!("result" in outcome)) throw new Error("卡密导出结果缺失");
    return outcome.result;
  }

  async importCards(
    owner: VirtualInventoryOwner,
    productIdValue: string | number,
    value: unknown,
  ) {
    const productId = positiveInteger(productIdValue, "商品ID");
    const body = record(value, "卡密导入数据格式错误");
    const skuUniqueValue = body.attr_unique ?? body.attrUnique;
    if (typeof skuUniqueValue !== "string" || !skuUniqueValue.trim()) {
      throw new ValidateException("请选择SKU");
    }
    const skuUnique = skuUniqueValue.trim();
    if (skuUnique.length > 8) throw new ValidateException("SKU标识错误");
    const normalized = normalizeVirtualCardImport(body.cards);

    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${INVENTORY_LOCK_NAMESPACE}, ${productId})`);
      const product = await ownedProduct(tx, owner, productId, true);
      const sku = (
        await tx
          .select({
            id: storeProductAttrValue.id,
            unique: storeProductAttrValue.unique,
            suk: storeProductAttrValue.suk,
            stock: storeProductAttrValue.stock,
            sumStock: storeProductAttrValue.sumStock,
            cost: storeProductAttrValue.cost,
            diskInfo: storeProductAttrValue.diskInfo,
          })
          .from(storeProductAttrValue)
          .where(
            and(
              eq(storeProductAttrValue.productId, productId),
              eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
              eq(storeProductAttrValue.unique, skuUnique),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      if (!sku) throw new ValidateException("SKU不存在或不属于当前商品");
      if (sku.diskInfo?.trim()) {
        throw new ValidateException("该SKU使用固定虚拟内容，不能同时导入一次性卡密");
      }

      const candidates = normalized.cards.map((card) => ({
        ...card,
        cardUnique: cardUnique(skuUnique, card),
      }));
      const hashes = [...new Set(candidates.map((card) => card.cardUnique))];
      const existing = hashes.length
        ? await tx
            .select({
              cardNo: storeProductVirtual.cardNo,
              cardPwd: storeProductVirtual.cardPwd,
              cardUnique: storeProductVirtual.cardUnique,
            })
            .from(storeProductVirtual)
            .where(
              and(
                eq(storeProductVirtual.productId, productId),
                eq(storeProductVirtual.attrUnique, skuUnique),
                inArray(storeProductVirtual.cardUnique, hashes),
              ),
            )
        : [];
      const existingIdentities = new Set(
        existing.map((card) => `${card.cardUnique}\u0000${card.cardNo}\u0000${card.cardPwd}`),
      );
      const toInsert = candidates.filter(
        (card) => !existingIdentities.has(`${card.cardUnique}\u0000${card.cardNo}\u0000${card.cardPwd}`),
      );
      const skippedExisting = candidates.length - toInsert.length;
      const inserted = toInsert.length
        ? await tx
            .insert(storeProductVirtual)
            .values(
              toInsert.map((card) => ({
                productId,
                storeId: inventoryStoreId(product),
                attrUnique: skuUnique,
                cardNo: card.cardNo,
                cardPwd: card.cardPwd,
                cardUnique: card.cardUnique,
                orderId: "",
                orderType: 1,
                uid: 0,
              })),
            )
            .returning({ id: storeProductVirtual.id })
        : [];

      if (inserted.length) {
        if (sku.stock > 2_147_483_647 - inserted.length) {
          throw new ValidateException("SKU库存超过安全范围");
        }
        if (sku.sumStock > 2_147_483_647 - inserted.length) {
          throw new ValidateException("SKU累计库存超过安全范围");
        }
        const productStock = (
          await tx
            .select({ stock: storeProduct.stock })
            .from(storeProduct)
            .where(eq(storeProduct.id, productId))
            .limit(1)
        )[0]?.stock ?? 0;
        if (productStock > 2_147_483_647 - inserted.length) {
          throw new ValidateException("商品库存超过安全范围");
        }
        await tx
          .update(storeProductAttrValue)
          .set({
            stock: sql`${storeProductAttrValue.stock} + ${inserted.length}`,
            sumStock: sql`${storeProductAttrValue.sumStock} + ${inserted.length}`,
          })
          .where(eq(storeProductAttrValue.id, sku.id));
        await tx
          .update(storeProduct)
          .set({
            stock: sql`${storeProduct.stock} + ${inserted.length}`,
            isSold: 0,
          })
          .where(eq(storeProduct.id, productId));
        await tx.insert(storeProductStockRecord).values({
          storeId: inventoryStoreId(product),
          productId,
          unique: skuUnique,
          costPrice: sku.cost,
          number: inserted.length,
          pm: 1,
          addTime: Math.floor(Date.now() / 1000),
        });
      }

      const [cardCounts, currentSku, currentProduct] = await Promise.all([
        tx
          .select({
            total: count(),
            available: sql<number>`COUNT(*) FILTER (WHERE ${storeProductVirtual.uid} = 0)::int`,
          })
          .from(storeProductVirtual)
          .where(
            and(
              eq(storeProductVirtual.productId, productId),
              eq(storeProductVirtual.attrUnique, skuUnique),
            ),
          ),
        tx
          .select({ stock: storeProductAttrValue.stock })
          .from(storeProductAttrValue)
          .where(eq(storeProductAttrValue.id, sku.id))
          .limit(1),
        tx
          .select({ stock: storeProduct.stock })
          .from(storeProduct)
          .where(eq(storeProduct.id, productId))
          .limit(1),
      ]);
      const total = Number(cardCounts[0]?.total ?? 0);
      const available = Number(cardCounts[0]?.available ?? 0);
      return {
        inserted: inserted.length,
        skipped_existing: skippedExisting,
        skipped_request_duplicates: normalized.requestDuplicates,
        total_cards: total,
        available_cards: available,
        assigned_cards: Math.max(total - available, 0),
        sku_stock: currentSku[0]?.stock ?? sku.stock,
        product_stock: currentProduct[0]?.stock ?? 0,
      };
    });
  }
}
