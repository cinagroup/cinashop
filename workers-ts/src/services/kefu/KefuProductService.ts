import {
  and,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { Env } from "@/env";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { readKefuProductMedia, renderKefuProductMedia, type KefuProductMediaRow } from "@/services/kefu/KefuProductMediaPolicy";
import {
  storeOrder,
  storeOrderCartInfo,
  storeProduct,
  storeProductDescription,
  storeProductRelation,
  storeVisit,
  user as userTable,
} from "@/models/schema";
import { assertKefuConversation, parseKefuPageLimit } from "@/services/kefu/KefuCoreService";
import { ownedKefuConversation } from "@/services/kefu/KefuOwnership";
import { NotFoundException, ValidateException } from "@/utils/errors";

const CATEGORY_RELATION_TYPE = 1;
const MAX_PAGE = 1_000_000;

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new ValidateException(`${field}错误`);
  }
  return parsed;
}

export function parseKefuProductPage(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const parsed = positiveInteger(value, "页码");
  if (parsed > MAX_PAGE) throw new ValidateException("页码错误");
  return parsed;
}

export function parseKefuProductId(value: unknown): number {
  return positiveInteger(value, "商品ID");
}

function searchName(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new ValidateException("商品名称错误");
  const result = value.trim();
  if (result.length > 100) throw new ValidateException("商品名称不能超过100个字符");
  return result;
}

const productSummary = {
  id: storeProduct.id,
  sales: sql<number>`COALESCE(${storeProduct.sales}, 0) + COALESCE(${storeProduct.ficti}, 0)`,
  store_name: storeProduct.storeName,
  image: storeProduct.image,
  type: storeProduct.type,
  relationId: storeProduct.relationId,
  stock: storeProduct.stock,
  price: storeProduct.price,
};

export class KefuProductService {
  constructor(private readonly container: Container, private readonly env?: Pick<Env, "APP_KEY">) {}

  /** The initial conversation grant remains outside this snapshot, so a transfer
   * committed after that check is visible to the history query. Product owner
   * and attachment authority are read from one bounded, coherent SQL snapshot.
   * Existing caller-owned transactions retain their isolation and ownership. */
  private async snapshot<T>(read: (db: DbClient) => Promise<T>): Promise<T> {
    if (this.container.db instanceof PgTransaction) return read(this.container.db);
    return withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql.raw(`SELECT
        pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
        pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
      return read(db);
    });
  }

  private async productList<T extends KefuProductMediaRow>(read: (db: DbClient) => Promise<T[]>) {
    const result = await this.snapshot(async db => {
      const rows = await read(db);
      return { rows, media: await readKefuProductMedia(db, rows) };
    });
    // Owned snapshots have committed before HMAC work; no R2 reads or writes.
    const media = await renderKefuProductMedia(this.env?.APP_KEY, result.media);
    return result.rows.map(({ type: _type, relationId: _owner, ...row }, index) => ({
      ...row, image: media[index]?.image ?? "",
    }));
  }

  private async customerScope(kefuUid: number, uidValue: unknown): Promise<number> {
    const uid = positiveInteger(uidValue, "用户ID");
    await assertKefuConversation(this.container, kefuUid, uid, 0);
    return uid;
  }

  private page(query: Record<string, string>) {
    return {
      page: parseKefuProductPage(query.page),
      limit: parseKefuPageLimit(query.limit),
      storeName: searchName(query.store_name),
    };
  }

  private currentCustomerContext(db: DbClient, kefuUid: number, uid: number) {
    return and(ownedKefuConversation(db, kefuUid, uid),
      exists(db.select({ uid: userTable.uid }).from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0), isNull(userTable.deleteTime)))))!;
  }

  async purchasedProducts(
    kefuUid: number,
    uidValue: unknown,
    query: Record<string, string>,
  ) {
    const uid = await this.customerScope(kefuUid, uidValue);
    const { page, limit, storeName } = this.page(query);
    return this.productList(async db => {
      const conditions: SQL[] = [eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0)];
      if (storeName) {
        // PHP deliberately widens an explicit search to the complete platform
        // catalog instead of restricting it to the customer's purchase history.
        conditions.push(eq(storeProduct.pid, 0), ilike(storeProduct.storeName, `%${storeName}%`));
      } else {
        conditions.push(this.currentCustomerContext(db, kefuUid, uid));
        const purchasedProductIds = db
          .select({ productId: storeOrderCartInfo.productId })
          .from(storeOrderCartInfo)
          .innerJoin(storeOrder, eq(storeOrder.id, storeOrderCartInfo.oid))
          .where(eq(storeOrder.uid, uid));
        conditions.push(inArray(storeProduct.id, purchasedProductIds));
      }
      return db
        .select(productSummary)
        .from(storeProduct)
        .where(and(...conditions))
        .orderBy(desc(storeProduct.sort), desc(storeProduct.id))
        .limit(limit)
        .offset((page - 1) * limit);
    });
  }

  async visitedProducts(
    kefuUid: number,
    uidValue: unknown,
    query: Record<string, string>,
  ) {
    const uid = await this.customerScope(kefuUid, uidValue);
    const { page, limit, storeName } = this.page(query);
    return this.productList(async db => {
      const conditions: SQL[] = [eq(storeVisit.uid, uid), this.currentCustomerContext(db, kefuUid, uid)];
      if (storeName) conditions.push(ilike(storeProduct.storeName, `%${storeName}%`));
      return db
        .select(productSummary)
        .from(storeProduct)
        .innerJoin(storeVisit, eq(storeVisit.productId, storeProduct.id))
        .where(and(...conditions))
        .orderBy(desc(storeVisit.addTime), desc(storeProduct.sort), desc(storeProduct.id))
        .limit(limit)
        .offset((page - 1) * limit);
    });
  }

  async hotProducts(
    kefuUid: number,
    uidValue: unknown,
    query: Record<string, string>,
  ) {
    const uid = await this.customerScope(kefuUid, uidValue);
    const storeName = searchName(query.store_name);
    return this.productList(async db => {
      const purchasedProductIds = db
        .select({ productId: storeOrderCartInfo.productId })
        .from(storeOrderCartInfo)
        .innerJoin(storeOrder, eq(storeOrder.id, storeOrderCartInfo.oid))
        .where(eq(storeOrder.uid, uid));
      const categoryIds = db
        .select({ relationId: storeProductRelation.relationId })
        .from(storeProductRelation)
        .where(and(
          eq(storeProductRelation.type, CATEGORY_RELATION_TYPE),
          inArray(storeProductRelation.productId, purchasedProductIds),
        ));
      const candidateIds = db
        .select({ productId: storeProductRelation.productId })
        .from(storeProductRelation)
        .where(and(
          eq(storeProductRelation.type, CATEGORY_RELATION_TYPE),
          inArray(storeProductRelation.relationId, categoryIds),
        ));
      const conditions: SQL[] = [inArray(storeProduct.id, candidateIds), this.currentCustomerContext(db, kefuUid, uid)];
      if (storeName) conditions.push(ilike(storeProduct.storeName, `%${storeName}%`));
      return db
        .select({
          ...productSummary,
          ot_price: storeProduct.otPrice,
        })
        .from(storeProduct)
        .where(and(...conditions))
        .orderBy(desc(sql`COALESCE(${storeProduct.sales}, 0) + COALESCE(${storeProduct.ficti}, 0)`), desc(storeProduct.id))
        .limit(20);
    });
  }
  async productInfo(idValue: unknown, publicOnly = false) {
    const id = parseKefuProductId(idValue);
    const conditions: SQL[] = [eq(storeProduct.id, id)];
    if (publicOnly) {
      conditions.push(
        eq(storeProduct.isDel, 0),
        eq(storeProduct.isShow, 1),
        eq(storeProduct.isVerify, 1),
      );
    }
    const result = await this.snapshot(async db => {
      const row = (
        await db
          .select({
            id: storeProduct.id,
            sales: sql<number>`COALESCE(${storeProduct.sales}, 0) + COALESCE(${storeProduct.ficti}, 0)`,
            store_name: storeProduct.storeName,
            image: storeProduct.image,
            type: storeProduct.type,
            relationId: storeProduct.relationId,
            slider_image: storeProduct.sliderImage,
            price: storeProduct.price,
            vip_price: storeProduct.vipPrice,
            ot_price: storeProduct.otPrice,
            stock: storeProduct.stock,
            description: storeProductDescription.description,
          })
          .from(storeProduct)
          .leftJoin(
            storeProductDescription,
            and(
              eq(storeProductDescription.productId, storeProduct.id),
              eq(storeProductDescription.type, 0),
            ),
          )
          .where(and(...conditions))
          .limit(1)
      )[0];
      if (!row) throw new NotFoundException("商品未查到");
      return { row, media: (await readKefuProductMedia(db, [row]))[0]! };
    });
    const [media] = await renderKefuProductMedia(this.env?.APP_KEY, [result.media]);
    const { type: _type, relationId: _owner, ...row } = result.row;
    return { ...row, image: media!.image, slider_image: media!.slider_image, description: row.description ?? "" };
  }
}
