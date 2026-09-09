import { and, eq, sql } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { storeBargain, storeProduct } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

type Patch = Partial<typeof storeBargain.$inferInsert>;
const MAX_INT = 2_147_483_647;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function integer(value: unknown, name: string, minimum = 0, maximum = MAX_INT): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ValidateException(`砍价${name}无效`);
  }
  return value;
}
function money(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) {
    throw new ValidateException("砍价金额无效");
  }
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}
function cents(value: string): number {
  const [whole, fraction] = money(value).split(".");
  return Number(whole) * 100 + Number(fraction);
}
function text(value: unknown, maximum: number, required: boolean): string {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value) || required && !value.trim()) {
    throw new ValidateException("砍价文本字段无效");
  }
  return value;
}
function parse(body: Record<string, unknown>): Patch {
  for (const field of ["sales", "addTime", "isDel", "quotaShow"]) {
    if (own(body, field)) throw new ValidateException(`砍价${field}由系统维护`);
  }
  const patch: Patch = {};
  if (own(body, "storeName")) patch.storeName = text(body.storeName, 256, true);
  if (own(body, "image")) patch.image = text(body.image, 256, false);
  if (own(body, "productId")) patch.productId = integer(body.productId, "商品ID", 1);
  if (own(body, "price")) patch.price = money(body.price);
  if (own(body, "minPrice")) patch.minPrice = money(body.minPrice);
  if (own(body, "stock")) patch.stock = integer(body.stock, "库存");
  if (own(body, "quota")) patch.quota = integer(body.quota, "额度");
  if (own(body, "people")) patch.people = integer(body.people, "人数", 2);
  if (own(body, "num")) patch.num = integer(body.num, "限购数量", 1);
  if (own(body, "sort")) patch.sort = integer(body.sort, "排序");
  if (own(body, "status")) patch.status = integer(body.status, "状态", 0, 1);
  // The legacy generic form also sends fields belonging to other activity types.
  // They are not bargain columns and remain ignored, never mass-assigned.
  return patch;
}
async function limits(tx: DbClient): Promise<void> {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
  await tx.execute(sql.raw(`SELECT
    pg_catalog.set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
    pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
}

/** Generic Worker editor contract; not PHP's complete SKU/description editor.
 * Omitted properties mean unchanged. Stock writes additionally compare the
 * original stock/quota pair, so a stale form cannot undo checkout/compensation.
 */
export async function saveBargain(container: Container, body: Record<string, unknown>): Promise<number> {
  const id = own(body, "id") ? integer(body.id, "活动ID", 1) : undefined;
  const patch = parse(body);
  let expected: { stock: number; quota: number } | undefined;
  if (own(body, "expected")) {
    const value = body.expected;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidateException("砍价库存原值无效");
    const values = value as Record<string, unknown>;
    expected = { stock: integer(values.stock, "库存原值"), quota: integer(values.quota, "额度原值") };
  }
  if (id && (patch.stock !== undefined || patch.quota !== undefined) && !expected) {
    throw new ValidateException("编辑库存或额度须提供原值，请刷新后重试");
  }
  return withTx(container, async tx => {
    await limits(tx);
    const current = id ? (await tx.select().from(storeBargain).where(eq(storeBargain.id, id)).limit(1).for("no key update"))[0] : undefined;
    if (id && (!current || current.isDel !== 0)) throw new ValidateException("砍价活动不存在或已删除");
    if (current && expected && (current.stock !== expected.stock || current.quota !== expected.quota)) {
      throw new ValidateException("砍价库存或额度已变化，请刷新后重试");
    }
    const values = current ? patch : {
      productId: integer(patch.productId, "商品ID", 1), storeName: text(patch.storeName, 256, true),
      image: "", stock: 100, quota: patch.stock ?? 100, price: "0.00", minPrice: "0.00",
      people: 10, num: 1, status: 1, sort: 90, ...patch,
    };
    const merged = { ...current, ...values };
    if (!current || patch.price !== undefined || patch.minPrice !== undefined || patch.people !== undefined) {
      const delta = cents(merged.price!) - cents(merged.minPrice!);
      if (delta <= 0) throw new ValidateException("砍价底价必须低于起价");
      if (integer(merged.people, "人数", 2) > delta) throw new ValidateException("每人至少须可砍0.01元");
    }
    if (!current || patch.stock !== undefined || patch.quota !== undefined) {
      if (integer(merged.quota, "额度") > integer(merged.stock, "库存")) throw new ValidateException("砍价额度不能超过库存");
    }
    if (!current || patch.productId !== undefined) {
      const [product] = await tx.select({ id: storeProduct.id }).from(storeProduct).where(and(
        eq(storeProduct.id, merged.productId!), eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1),
      )).limit(1);
      if (!product) throw new ValidateException("关联商品不存在或不可用");
    }
    if (current) {
      if (patch.quota !== undefined) values.quotaShow = patch.quota;
      // Only supplied fields are written. Never replay the entire locked row.
      if (Object.keys(values).length) await tx.update(storeBargain).set(values).where(eq(storeBargain.id, current.id));
      return current.id;
    }
    const [created] = await tx.insert(storeBargain).values({ ...values, quotaShow: values.quota,
      sales: 0, addTime: sql`floor(extract(epoch from clock_timestamp()))::int` }).returning({ id: storeBargain.id });
    return created.id;
  });
}

export async function setBargainStatus(container: Container, body: Record<string, unknown>): Promise<void> {
  const id = integer(body.id, "活动ID", 1);
  const status = integer(body.status, "状态", 0, 1);
  await withTx(container, async tx => {
    await limits(tx);
    const rows = await tx.update(storeBargain).set({ status }).where(and(eq(storeBargain.id, id), eq(storeBargain.isDel, 0)))
      .returning({ id: storeBargain.id });
    if (!rows[0]) throw new ValidateException("砍价活动不存在或已删除");
  });
}
