import { communityTopic, storeProduct, storeProductLog, userRelation } from "@/models/schema";
import { communityVideoFixture } from "./communityVideoFixture";
import type { PgTable } from "drizzle-orm/pg-core";

export async function communityRelationsFixture(extraTables: PgTable[] = []) {
  const f = await communityVideoFixture(extraTables);
  await f.db.insert(communityTopic).values([10, 11, 12, 13, 14].map(id => ({ id, name: `生活话题${id}`, status: 1 })));
  await f.db.insert(storeProduct).values([
    ...Array.from({ length: 11 }, (_, i) => ({ id: 101 + i, storeName: `已购好物${101 + i}`, price: "19.90", isShow: 1, isVerify: 1, keyword: "家居" })),
    { id: 201, storeName: "收藏茶杯", price: "29.00", isShow: 1, isVerify: 1 },
    { id: 301, storeName: "浏览餐盘", price: "39.00", isShow: 1, isVerify: 1 },
    { id: 401, storeName: "他人商品", isShow: 1, isVerify: 1 },
    { id: 402, storeName: "未审核商品", isShow: 1, isVerify: 0 },
    { id: 403, storeName: "下架商品", isShow: 0, isVerify: 1 },
    { id: 404, storeName: "删除商品", isShow: 1, isVerify: 1, isDel: 1 },
    { id: 405, storeName: "已清除浏览", isShow: 1, isVerify: 1 },
  ]);
  await f.db.insert(storeProductLog).values([
    ...Array.from({ length: 11 }, (_, i) => ({ uid: 11, productId: 101 + i, type: "pay", addTime: 1000 + i })),
    { uid: 11, productId: 111, type: "pay", addTime: 500 },
    { uid: 11, productId: 301, type: "visit", addTime: 2000 },
    { uid: 11, productId: 405, type: "visit", addTime: 2001, deleteTime: new Date() },
    { uid: 22, productId: 401, type: "pay", addTime: 3000 },
    ...[402,403,404].map(productId => ({ uid: 11, productId, type: "pay", addTime: 4000 })),
  ]);
  await f.db.insert(userRelation).values([
    { uid: 11, relationId: 201, type: "collect", category: "product", addTime: 2000 },
    { uid: 22, relationId: 401, type: "collect", category: "product", addTime: 3000 },
    { uid: 11, relationId: 401, type: "collect", category: "article", addTime: 3001 },
    ...[402,403,404].map(relationId => ({ uid: 11, relationId, type: "collect", category: "product", addTime: 4000 })),
  ]);
  return f;
}
