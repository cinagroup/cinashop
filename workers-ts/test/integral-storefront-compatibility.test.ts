import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createContainerFromDb, type DbClient } from "../src/lib/di";
import { legacyCategory, systemGroup, systemGroupData, systemAttachment, user } from "../src/models/schema";
import { PublicCatalogService } from "../src/services/product/PublicCatalogService";
import { financeMemoryPostgres } from "./helpers/financePostgres";
import {
  ActivityService,
  parseIntegralRange,
} from "../src/services/activity/ActivityService";

type ReadMode = { isolation: string; readonly: string };
/** Observe the original SQL transaction after the service read; never replace
 * its callback, SQL, options or result with a transaction passthrough. */
function observeReadMode(db: DbClient, modes: ReadMode[], afterRead?: (tx: DbClient) => Promise<void>): DbClient {
  return new Proxy(db, { get(database, property) {
    const method: unknown=Reflect.get(database,property);
    if(typeof method!=='function')return method;
    if(property!=='transaction')return method.bind(database);
    return (work:(tx:DbClient)=>Promise<unknown>,...options:unknown[])=>Reflect.apply(method,database,[async(tx:DbClient)=>{
      const result=await work(tx);
      const [mode]=await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only') AS readonly`);
      modes.push({isolation:String(mode.isolation),readonly:String(mode.readonly)});
      await afterRead?.(tx);
      return result;
    },...options]);
  } });
}
async function homeFixture() {
  const fixture=await financeMemoryPostgres([systemGroup,systemGroupData,systemAttachment,user]);
  try {
    await fixture.db.insert(systemGroup).values({id:4,configName:'integral_shop_banner'});
    await fixture.db.insert(systemGroupData).values({id:3,gid:4,value:JSON.stringify({
      img:{value:'/api/assets/9'},comment:{value:'积分活动'},link:{value:'javascript:alert(1)'},
    }),addTime:1,sort:10,status:1});
    await fixture.db.insert(systemAttachment).values({attId:9,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,
      name:'attachments/admin/1/2026/10/integral.png',attDir:'/api/assets/9',attType:'image/png'});
    await fixture.db.insert(user).values({uid:12,account:'integral-home-reader',integral:321});
    return fixture;
  }catch(error){await fixture.close();throw error;}
}

describe("legacy integral storefront compatibility", () => {
  it("parses bounded integral ranges and preserves reverse ranges as empty queries", () => {
    expect(parseIntegralRange("100 - 500")).toEqual({ minimum: 100, maximum: 500 });
    expect(parseIntegralRange("500-100")).toEqual({ minimum: 500, maximum: 100 });
    expect(parseIntegralRange("全部")).toBeUndefined();
    expect(parseIntegralRange("-1-100")).toBeUndefined();
    expect(parseIntegralRange(`0-${2_147_483_648}`)).toBeUndefined();
  });

  it("forwards the PHP list filters, returns brand names, and signs canonical assets", async () => {
    const list = vi.fn().mockResolvedValue([{
      id: 14,
      productId: 104,
      storeName: "积分商品",
      image: "/api/assets/7",
      integral: 300,
      price: "1.50",
      sales: 4,
      stock: 7,
      brandName: "示例品牌",
    }]);
    const service = new ActivityService(
      { storeIntegralDao: { list } } as never,
      { APP_KEY: "test-integral-app-key" } as never,
    );

    const result = await service.integralList(0, 999, {
      storeName: "  商品\u0000名称  ",
      priceOrder: "DESC",
      salesOrder: "asc",
      range: "100-500",
    });

    expect(list).toHaveBeenCalledWith(1, 50, {
      storeName: "商品名称",
      priceOrder: "desc",
      salesOrder: "asc",
      range: { minimum: 100, maximum: 500 },
      isHost: false,
    });
    expect(result).toEqual([expect.objectContaining({
      id: 14,
      product_id: 104,
      title: "积分商品",
      integral: 300,
      price: 1.5,
      brand_name: "示例品牌",
      image: expect.stringMatching(/^\/api\/assets\/7\?expires=\d+&signature=/),
    })]);
  });

  it("returns the PHP home envelope with recommended products and optional user points", async () => {
    const list = vi.fn().mockResolvedValue([{
      id: 8,
      productId: 18,
      storeName: "推荐商品",
      image: "/recommended.png",
      integral: 88,
      price: "0.00",
      sales: 9,
      stock: 2,
      brandName: "",
    }]);
    const fixture=await homeFixture(),modes:ReadMode[]=[];
    try {
      // The list mapper remains the explicit DAO double; group, attachment and
      // account reads execute actual SQL, including the production transaction.
      const service = new ActivityService(
        { db: observeReadMode(fixture.db,modes), storeIntegralDao: { list } } as never,
        { APP_KEY: "test-integral-app-key" } as never,
      );

      const result = await service.integralHome(12, 2, 5);

      expect(list).toHaveBeenCalledWith(2, 5, expect.objectContaining({ isHost: true }));
      expect(result.integral).toBe(321);
      expect(result.list).toEqual([expect.objectContaining({ title: "推荐商品" })]);
      expect(result.banner).toEqual([expect.objectContaining({
        comment: "积分活动",
        link: "",
        img: expect.stringMatching(/^\/api\/assets\/9\?expires=\d+&signature=/),
      })]);
      expect(modes).toEqual([{isolation:'repeatable read',readonly:'on'}]);
    }finally{await fixture.close();}
  },30_000);

  it('enforces the real group snapshot READ ONLY mode and rolls back an attempted setter',async()=>{
    const fixture=await homeFixture(),modes:ReadMode[]=[];
    try{
      const before=await fixture.db.select().from(user);
      const db=observeReadMode(fixture.db,modes,async tx=>{
        await tx.update(user).set({integral:0}).where(eq(user.uid,12));
      });
      const catalog=new PublicCatalogService(createContainerFromDb(db),{APP_KEY:'test-integral-app-key'} as never);
      await expect(catalog.groupDataMany(['integral_shop_banner'])).rejects.toMatchObject({cause:{code:'25006'}});
      expect(modes).toEqual([{isolation:'repeatable read',readonly:'on'}]);
      expect(await fixture.db.select().from(user)).toEqual(before);
    }finally{await fixture.close();}
  },30_000);

  it("maps visible group-5 categories to the legacy label/value contract", async () => {
    const fixture=await financeMemoryPostgres([legacyCategory]);
    try {
      await fixture.db.insert(legacyCategory).values([
        {id:1,group:5,name:'低积分',integralMin:0,integralMax:100,sort:2,isShow:1},
        {id:2,group:5,name:'高积分',integralMin:101,integralMax:500,sort:1,isShow:1},
        {id:3,group:5,name:'隐藏积分',integralMin:501,integralMax:600,sort:100,isShow:0},
        {id:4,group:1,name:'其他分类域',integralMin:0,integralMax:1000,sort:100,isShow:1},
      ]);
      const service = new ActivityService(createContainerFromDb(fixture.db));

      await expect(service.integralCategories()).resolves.toEqual([
        { label: "低积分", value: "0-100" },
        { label: "高积分", value: "101-500" },
      ]);
    }finally{await fixture.close();}
  },30_000);

  it("registers all four browse routes behind StationOpen and optional auth", () => {
    const routes = readFileSync(
      resolve(import.meta.dirname, "../src/routes/v1/index.ts"),
      "utf8",
    );
    for (const path of [
      "/store_integral/index",
      "/store_integral/category",
      "/store_integral/list",
      "/store_integral/detail/:id",
    ]) {
      const start = routes.indexOf(`\"${path}\"`);
      expect(start).toBeGreaterThan(-1);
      const block = routes.slice(start, start + 260);
      expect(block).toContain("stationOpenMiddleware()");
      expect(block).toContain("authMiddleware({ force: false })");
    }
  });
});
