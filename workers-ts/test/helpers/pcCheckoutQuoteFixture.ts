/** Disposable SQL fixture for the actual confirmation/quote service. No order-create or payment route is mounted. */
import { Hono } from "hono";
import { and, eq } from 'drizzle-orm';
import { financePostgres } from "./financePostgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { createContainerFromDb } from "../../src/lib/di";
import { orderConfirm, orderComputed } from "../../src/controllers/api/v1/OrderController";
import { StoreCartService } from "../../src/services/order/StoreCartService";
import {
  user, userAddress, userBill, storeCart, storeOrder, storeProduct, storeProductAttrValue,
  memberRight, systemConfig, shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery, cityArea, systemStore,
} from "../../src/models/schema";
import type { AppVariables, Env } from "../../src/env";

// An explicit test-owned factory can supply a complete ORM database. The default
// remains the existing disposable column fixture; no environment/production fallback.
type QuoteFixtureDatabase = Pick<Awaited<ReturnType<typeof financePostgres>>, 'db' | 'exec' | 'close'>;
export async function createPcCheckoutQuoteFixture(extraTables: PgTable[] = [],
  createDatabase: (tables: PgTable[]) => Promise<QuoteFixtureDatabase> = financePostgres) {
  const fixture = await createDatabase([...new Set([user, userAddress, userBill, storeCart, storeOrder, storeProduct, storeProductAttrValue,
    memberRight, systemConfig, shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery, cityArea, systemStore, ...extraTables])]);
  const container = createContainerFromDb(fixture.db);
  const cache = new Map<string, string>();
  const pricingKeys = ['member_func_status', 'member_card_status', 'svip_price_status', 'integral_ratio_status',
    'integral_ratio', 'integral_max_type', 'integral_max_num', 'integral_max_rate', 'whole_free_shipping', 'store_free_postage', 'offline_postage'];
  const config: Record<string, string> = {
    ...Object.fromEntries(pricingKeys.map(key => [key, '0'])),
    member_card_status: "1", svip_price_status: "1", integral_ratio_status: "1", integral_ratio: "0.01", integral_max_type: "1", integral_max_num: "50",
    newcomer_status: "1", first_order_status: "1", first_order_discount: "90", first_order_discount_limit: "100", newcomer_limit_status: "0",
  };
  // Tests changing pricing policy must update the actual SQL authority, not only
  // a KV substitute. Direct config mutations remain available for stale-KV tests.
  const setConfig = async (values: Record<string, string>) => {
    for (const [menuName, value] of Object.entries(values)) {
      if (!pricingKeys.includes(menuName)) continue;
      const rows = await fixture.db.update(systemConfig).set({ value })
        .where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, 0))).returning({ id: systemConfig.id });
      if (!rows.length) await fixture.db.insert(systemConfig).values({ menuName, value });
    }
    Object.assign(config, values);
  };
  const writes: Array<{ key: string; ttl?: number }> = [];
  // Only this in-memory KV subset is used by the real quote path. Never inherit host bindings/secrets.
  const env = { CONFIG_KV: {
    get: async (key: string) => key.startsWith("cfg_") ? config[key.slice(4)] ?? "0" : cache.get(key) ?? null,
    put: async (key: string, value: string, options?: KVNamespacePutOptions) => { cache.set(key, value); writes.push({ key, ttl: options?.expirationTtl }); },
    delete: async (key: string) => { cache.delete(key); },
  } } as Env;
  try {
    await fixture.db.insert(systemConfig).values(pricingKeys.map(menuName => ({ menuName, value: config[menuName] })));
    await fixture.db.insert(user).values({ uid: 11, account: "local-qa", nickname: "本地报价测试", isEverLevel: 1, integral: 100 });
    await fixture.db.insert(userAddress).values([
      { id: 11, uid: 11, realName: "本地地址甲", phone: "00000000000", province: "本地省", city: "测试甲市", district: "测试甲区", cityId: 101, detail: "隔离样本一号", isDefault: 1 },
      { id: 12, uid: 11, realName: "本地地址乙", phone: "00000000000", province: "本地省", city: "测试乙市", district: "测试乙区", cityId: 102, detail: "隔离样本二号" },
    ]);
    await fixture.db.insert(storeProduct).values({ id: 70, storeName: "完整报价隔离样本", stock: 8, price: "10.00", isShow: 1, isVerify: 1, isVip: 1, freight: 3, tempId: 10, image: "/api/qa/image.svg" });
    await fixture.db.insert(storeProductAttrValue).values({ id: 1, productId: 70, type: 0, unique: "qared001", suk: "红色,大号", stock: 8, price: "10.00", vipPrice: "9.00", image: "/api/qa/image.svg" });
    await fixture.db.insert(storeCart).values({ id: 1, uid: 11, productId: 70, productAttrUnique: "qared001", cartNum: 2, isNew: 1, status: 1 });
    await fixture.db.insert(memberRight).values([{ id: 1, rightType: "vip_price", number: 1, status: 1 }, { id: 2, rightType: "express", number: 50, status: 1 }]);
    await fixture.db.insert(shippingTemplates).values({ id: 10, name: "本地运费", type: 1 });
    await fixture.db.insert(shippingTemplatesRegion).values([
      { id: 1, templateId: 10, regionId: 101, regionName: "测试甲市", first: "2.00", firstPrice: "6.00", continue: "1.00", continuePrice: "1.00" },
      { id: 2, templateId: 10, regionId: 102, regionName: "测试乙市", first: "2.00", firstPrice: "12.00", continue: "1.00", continuePrice: "1.00" },
    ]);
    await fixture.db.insert(cityArea).values([
      { id: 901, name: '本地省', path: '/', parentId: 0 },
      { id: 902, name: '测试甲市', path: '/901/', parentId: 901 },
      { id: 903, name: '测试乙市', path: '/901/', parentId: 901 },
      { id: 101, name: '测试甲区', path: '/901/902/', parentId: 902 },
      { id: 102, name: '测试乙区', path: '/901/903/', parentId: 903 },
    ]);
    await fixture.db.insert(systemStore).values({ id: 1, name: "隔离自提门店", address: "本地测试地址", isShow: 1, isDel: 0 });
  } catch (error) { await fixture.close(); throw error; }
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("container", container);
    c.set("uid", ["11", "22"].includes(c.req.header("x-fixture-user") ?? "") ? Number(c.req.header("x-fixture-user")) : 0);
    await next();
  });
  app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
  app.post("/api/order/confirm", orderConfirm);
  app.post("/api/order/computed/:key", orderComputed);
  const readItems = () => new StoreCartService(container, env).list(11, { mode: "buy", ids: [1] });
  const snapshot = async () => ({
    carts: await fixture.db.select().from(storeCart), products: await fixture.db.select().from(storeProduct),
    skus: await fixture.db.select().from(storeProductAttrValue), users: await fixture.db.select().from(user),
    orders: await fixture.db.select().from(storeOrder), bills: await fixture.db.select().from(userBill),
  });
  return { ...fixture, container, app, env, cache, config, setConfig, writes, readItems, snapshot };
}
