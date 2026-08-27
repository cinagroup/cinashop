import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import {
  deliveryService,
  storeUser,
  systemStore,
  systemStoreStaff,
} from "../src/models/schema";
import {
  isLegacyMobile,
  normalizeDeliveryInput,
  normalizeStaffInput,
  normalizeStoreInput,
} from "../src/services/store/StoreOperationsService";

describe("store fulfillment identity migration", () => {
  it("preserves all four source tables and deterministic source keys", () => {
    expect(getTableName(systemStore)).toBe("system_store");
    expect(getTableName(systemStoreStaff)).toBe("system_store_staff");
    expect(getTableName(deliveryService)).toBe("delivery_service");
    expect(getTableName(storeUser)).toBe("store_user");
    expect(Object.keys(getTableColumns(systemStore))).toEqual([
      "id", "erpShopId", "name", "introduction", "phone", "address", "province", "city",
      "area", "street", "detailedAddress", "image", "oblongImage", "latitude", "longitude",
      "bankCode", "bankAddress", "alipayAccount", "alipayQrcodeUrl", "wechat",
      "wechatQrcodeUrl", "validTime", "validRange", "dayTime", "dayStart", "dayEnd",
      "addTime", "isShow", "isDel", "isStore",
    ]);
    expect(Object.keys(getTableColumns(systemStoreStaff))).toContain("pwd");
    expect(Object.keys(getTableColumns(deliveryService))).toEqual([
      "id", "uid", "type", "relationId", "avatar", "nickname", "phone", "addTime",
      "isDel", "status",
    ]);
    expect(Object.keys(getTableColumns(storeUser))).toEqual([
      "id", "storeId", "uid", "labelId", "status", "addTime",
    ]);
    for (const table of ["system_store", "system_store_staff", "delivery_service", "store_user"]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(["id"]);
    }
  });

  it("does not invent source relationship uniqueness or foreign keys", () => {
    const migration = readFileSync("migrations/0063_store_fulfillment_identity.sql", "utf8");
    expect(migration).not.toMatch(/UNIQUE/i);
    expect(migration).not.toMatch(/FOREIGN KEY|REFERENCES/i);
    expect(migration).toContain('"roles" VARCHAR(255) DEFAULT \'\'');
    expect(migration).toContain('"street" INTEGER DEFAULT 0,');
    expect(migration).toContain('"label_id" TEXT,');
  });

  it("normalizes legacy forms without accepting privileged staff fields", () => {
    const store = normalizeStoreInput({
      name: "Central",
      phone: "13800138000",
      address: ["广东省", "深圳市", "南山区"],
      detailed_address: "科技园",
      latlng: "22.5431,114.0579",
      day_time: ["09:00", "18:00"],
    });
    expect(store).toMatchObject({
      address: "广东省,深圳市,南山区",
      latitude: "22.5431",
      longitude: "114.0579",
      dayTime: "09:00 - 18:00",
    });
    const staff = normalizeStaffInput({
      store_id: 7,
      image: { uid: 9, image: "/avatar.png" },
      staff_name: "核销员",
      phone: "13800138000",
      verify_status: 1,
      status: 1,
      pwd: "must-not-be-used",
      is_admin: 1,
    });
    expect(staff).toEqual({
      storeId: 7,
      uid: 9,
      avatar: "/avatar.png",
      staffName: "核销员",
      phone: "13800138000",
      verifyStatus: 1,
      status: 1,
    });
    expect(isLegacyMobile("13800138000")).toBe(true);
    expect(isLegacyMobile("12345")).toBe(false);
    expect(() => normalizeDeliveryInput({}, {
      uid: 1,
      avatar: "",
      nickname: "配送员",
      phone: "12345",
    })).toThrow("手机号格式不正确");
  });

  it("keeps management secrets out of responses and serializes active identities", () => {
    const service = readFileSync("src/services/store/StoreOperationsService.ts", "utf8");
    const safeStaffList = service.match(/const safeSelection = \{([\s\S]*?)\};\s*const \[list/)?.[1] ?? "";
    expect(safeStaffList).not.toContain("pwd");
    expect(safeStaffList).not.toContain("lastIp");
    expect(service).toContain("pg_advisory_xact_lock(${STAFF_WRITE_LOCK}, 0)");
    expect(service).toContain("pg_advisory_xact_lock(${DELIVERY_WRITE_LOCK}, 0)");
    expect(service).toContain('.for("key share")');
    expect(service).toContain("配送员身份存在重复，请先清理历史数据");
  });

  it("mounts legacy and native admin routes and uses canonical delivery identity in fulfillment", () => {
    const legacyRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const nativeRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const admin = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    for (const route of [
      "/merchant/store",
      "/merchant/store_staff",
      "/order/delivery/index",
      "/order/delivery/list",
    ]) expect(legacyRoutes).toContain(route);
    expect(nativeRoutes).toContain("/admin/merchant/store");
    expect(nativeRoutes).toContain("/admin/order/delivery/index");
    expect(admin).toContain("requireActiveDelivery(deliveryUid)");
    expect(admin).toContain("deliveryUid,");
    expect(admin).toContain("fictitiousContent,");
    expect(admin).toContain("tx.insert(storeOrderStatus)");
    expect(admin).toContain('.for("update")');
  });
});
