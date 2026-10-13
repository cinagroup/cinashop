import { and, desc, eq, or } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { legacyCategory, storeBrand, storeProductLabel } from "@/models/schema";
import { ServiceUnavailableException, ValidateException } from "@/utils/errors";
import { supplierReadSnapshot } from "./SupplierReadSupport";

const LABEL_CATEGORY_GROUP = 2;
const MAX_CATEGORIES = 1_000;
const MAX_LABELS = 5_000;
const MAX_BRANDS = 1_000;
const MAX_BRAND_DEPTH = 16;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const labelDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function supplierIdentity(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) {
    throw new ValidateException("供应商ID错误");
  }
}

export function supplierBrandCatalogType(value: string | undefined): 1 | 2 {
  if (value === undefined) return 1;
  if (value !== "1" && value !== "2") throw new ValidateException("品牌目录类型错误");
  return Number(value) as 1 | 2;
}

function boundedResponse<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_RESPONSE_BYTES) {
    throw new ServiceUnavailableException("商品目录过大，请联系管理员整理");
  }
  return value;
}

interface BrandNode {
  value: number;
  label: string;
  pid?: number;
  children?: BrandNode[];
}

/** Legacy selection DTOs. Catalog ownership never comes from request fields. */
export class SupplierProductCatalogService {
  constructor(private readonly container: Container) {}

  async labels(supplierId: number) {
    supplierIdentity(supplierId);
    return supplierReadSnapshot(this.container, async (db) => {
      const categories = await db.select({
        id: legacyCategory.id,
        name: legacyCategory.name,
        type: legacyCategory.type,
        relationId: legacyCategory.relationId,
      }).from(legacyCategory).where(and(
        eq(legacyCategory.group, LABEL_CATEGORY_GROUP),
        eq(legacyCategory.ownerId, 0),
        eq(legacyCategory.isShow, 1),
        or(
          and(eq(legacyCategory.type, 0), eq(legacyCategory.relationId, 0)),
          and(eq(legacyCategory.type, 2), eq(legacyCategory.relationId, supplierId)),
        ),
      )).orderBy(desc(legacyCategory.sort), desc(legacyCategory.id)).limit(MAX_CATEGORIES + 1);
      if (categories.length > MAX_CATEGORIES) {
        throw new ServiceUnavailableException("商品标签分类过多，请联系管理员整理");
      }
      // Legacy Supplier creation deliberately uses the platform group form.
      // Its own labels may therefore belong to platform groups; other tenants
      // and platform labels attached to private Supplier groups remain excluded.
      const labels = await db.select({ label: storeProductLabel }).from(storeProductLabel)
        .innerJoin(legacyCategory, and(
          eq(storeProductLabel.labelCate, legacyCategory.id),
          or(
            and(eq(storeProductLabel.type, legacyCategory.type), eq(storeProductLabel.relationId, legacyCategory.relationId)),
            and(eq(legacyCategory.type, 0), eq(legacyCategory.relationId, 0),
              eq(storeProductLabel.type, 2), eq(storeProductLabel.relationId, supplierId)),
          ),
        )).where(and(
          eq(legacyCategory.group, LABEL_CATEGORY_GROUP),
          eq(legacyCategory.ownerId, 0),
          eq(legacyCategory.isShow, 1),
          eq(storeProductLabel.status, 1),
          eq(storeProductLabel.isShow, 1),
          or(
            and(eq(legacyCategory.type, 0), eq(legacyCategory.relationId, 0)),
            and(eq(legacyCategory.type, 2), eq(legacyCategory.relationId, supplierId)),
          ),
        )).orderBy(desc(storeProductLabel.sort), desc(storeProductLabel.id)).limit(MAX_LABELS + 1);
      if (labels.length > MAX_LABELS) {
        throw new ServiceUnavailableException("商品标签过多，请联系管理员整理");
      }
      const byCategory = new Map<number, ReturnType<typeof labelDto>[]>();
      for (const { label } of labels) {
        const children = byCategory.get(label.labelCate) ?? [];
        children.push(labelDto(label));
        byCategory.set(label.labelCate, children);
      }
      return boundedResponse(categories.map((category) => ({
        id: category.id,
        value: category.id,
        label_cate: 0,
        label_name: category.name,
        label: category.name,
        relation_id: category.relationId,
        type: category.type,
        children: byCategory.get(category.id) ?? [],
      })));
    });
  }

  async brands(supplierId: number, type: 1 | 2) {
    supplierIdentity(supplierId);
    if (type !== 1 && type !== 2) throw new ValidateException("品牌目录类型错误");
    return supplierReadSnapshot(this.container, async (db) => {
      // store_brand has no Supplier owner tuple. Only the platform catalog is
      // selectable; a nonzero store_id belongs to a different business scope.
      const rows = await db.select({ id: storeBrand.id, name: storeBrand.brandName, pid: storeBrand.pid })
        .from(storeBrand).where(and(
          eq(storeBrand.storeId, 0), eq(storeBrand.isShow, 1), eq(storeBrand.isDel, 0),
        )).orderBy(desc(storeBrand.sort), desc(storeBrand.id)).limit(MAX_BRANDS + 1);
      if (rows.length > MAX_BRANDS) {
        throw new ServiceUnavailableException("商品品牌过多，请联系管理员整理");
      }
      const byParent = new Map<number, typeof rows>();
      for (const row of rows) {
        const children = byParent.get(row.pid) ?? [];
        children.push(row);
        byParent.set(row.pid, children);
      }
      const subtree = (pid: number, depth: number): BrandNode[] => {
        const children = byParent.get(pid) ?? [];
        if (!children.length) return [];
        if (depth > MAX_BRAND_DEPTH) {
          throw new ServiceUnavailableException("商品品牌层级过深，请联系管理员整理");
        }
        return children.map((row) => {
          const node: BrandNode = { value: row.id, label: row.name, pid: row.pid };
          // PHP type=1 prepends a root choice and trims below the second level.
          const descendants = type === 1 && depth === 2 ? [] : subtree(row.id, depth + 1);
          if (descendants.length) node.children = descendants;
          return node;
        });
      };
      // Orphaned rows, cycles, and children of hidden/deleted/store parents are
      // unreachable from platform pid=0 and cannot become selectable roots.
      const tree = subtree(0, 1);
      return boundedResponse(type === 1 ? [{ value: 0, label: "顶级品牌" }, ...tree] : tree);
    });
  }
}

function labelDto(label: typeof storeProductLabel.$inferSelect) {
  // PHP StoreProductLabel::getAddTimeAttr(), including epoch zero. Use the
  // named timezone rather than a fixed offset to retain historical DST.
  const time = Object.fromEntries(labelDateFormatter.formatToParts(new Date(label.addTime * 1000))
    .map((part) => [part.type, part.value]));
  return {
    id: label.id, value: label.id, label: label.labelName,
    type: label.type, relation_id: label.relationId,
    label_cate: label.labelCate, label_name: label.labelName,
    style_type: label.styleType, color: label.color, bg_color: label.bgColor,
    border_color: label.borderColor, icon: label.icon,
    is_show: label.isShow, status: label.status, sort: label.sort,
    add_time: `${time.year}-${time.month}-${time.day} ${time.hour}:${time.minute}:${time.second}`,
  };
}
