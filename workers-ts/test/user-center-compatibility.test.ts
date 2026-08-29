import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { BaseDao, type DB } from "../src/dao/BaseDao";
import { userAddress } from "../src/models/schema";
import { signDayWindow } from "../src/utils/sign";
import { USER_CENTER_COMPATIBILITY_INDEX_SQL } from "../src/migrations/userCenterCompatibility";

const baseDaoSource = readFileSync("src/dao/BaseDao.ts", "utf8");
const routesSource = readFileSync("src/routes/v1/index.ts", "utf8");
const controllerSource = readFileSync(
  "src/controllers/api/v1/UserActivityController.ts",
  "utf8",
);
const userCenterSource = readFileSync(
  "src/services/user/UserCenterService.ts",
  "utf8",
);
const userCenterDaoSource = readFileSync(
  "src/dao/user/UserCenterDaos.ts",
  "utf8",
);
const signCompatSource = readFileSync(
  "src/services/user/UserSignCompatibilityService.ts",
  "utf8",
);
const collectCompatSource = readFileSync(
  "src/services/user/UserCollectCompatibilityService.ts",
  "utf8",
);
const userCenterSchemaSource = readFileSync("src/models/schema/user_center.ts", "utf8");
const externalIndexMigration = readFileSync(
  "migrations/0105_user_center_compatibility_indexes.sql",
  "utf8",
);

function sourceBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`Missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

class FailClosedAddressDao extends BaseDao<typeof userAddress> {
  constructor(db: DB) {
    super(db, userAddress);
  }
}

function failIfQueriedDb() {
  return {
    select: vi.fn(() => {
      throw new Error("empty filters must not issue SELECT");
    }),
    update: vi.fn(() => {
      throw new Error("empty filters must not issue UPDATE");
    }),
    delete: vi.fn(() => {
      throw new Error("empty filters must not issue DELETE");
    }),
  } as unknown as DB;
}

describe("USER-CENTER-COMPAT migration", () => {
  describe("BaseDao fail-closed filters", () => {
    it("does not read a first row for empty, unknown, or all-empty filters", async () => {
      const db = failIfQueriedDb();
      const dao = new FailClosedAddressDao(db);

      await expect(dao.get({})).resolves.toBeNull();
      await expect(dao.getOne({ unknown_runtime_key: 1 })).resolves.toBeNull();
      await expect(dao.get({ uid: null, phone: "" })).resolves.toBeNull();
      await expect(dao.get(null as never)).resolves.toBeNull();
      await expect(dao.get("1" as never)).resolves.toBeNull();
      await expect(dao.get([] as never)).resolves.toBeNull();
      await expect(dao.be({ unknown_runtime_key: 1 })).resolves.toBe(false);

      expect(db.select).not.toHaveBeenCalled();
    });

    it("rejects unscoped update, delete, increment, and decrement before SQL", async () => {
      const db = failIfQueriedDb();
      const dao = new FailClosedAddressDao(db);

      await expect(dao.update({}, { phone: "13000000000" }))
        .rejects.toThrow("Refusing unscoped update");
      await expect(dao.update({ unknown_runtime_key: 1 }, { phone: "13000000000" }))
        .rejects.toThrow("Refusing unscoped update");
      await expect(dao.delete({ uid: undefined }))
        .rejects.toThrow("Refusing unscoped delete");
      await expect(dao.delete(null as never))
        .rejects.toThrow("Refusing unscoped delete");
      await expect(dao.inc({}, "uid", 1))
        .rejects.toThrow("Refusing unscoped increment");
      await expect(dao.dec({ unknown_runtime_key: 1 }, "uid", 1))
        .rejects.toThrow("Refusing unscoped decrement");

      expect(db.update).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });

    it("keeps unfiltered reads explicit and separate from fail-closed CRUD", () => {
      expect(baseDaoSource).toContain("async count(where: WhereInput = {})");
      expect(baseDaoSource).toContain("const cond = opts.where ? this.buildWhere(opts.where) : undefined");
      expect(baseDaoSource).toContain("if (!cond) return false");
      expect(baseDaoSource).not.toMatch(/async get[\s\S]*?\.where\(where \?\? sql`true`\)/);
    });
  });

  it("registers all nine PHP compatibility routes behind forced authentication", () => {
    const routes = [
      ["get", "/address/detail/:id", "addressDetail"],
      ["post", "/address/default/set", "addressDefaultSet"],
      ["post", "/collect/all", "collectAll"],
      ["get", "/sign/config", "signConfig"],
      ["get", "/sign/list", "signList"],
      ["get", "/sign/month", "signMonth"],
      ["post", "/sign/user", "signUser"],
      ["get", "/sign/remind/:status", "signRemind"],
      ["get", "/sign/calendar", "signCalendar"],
    ] as const;

    for (const [method, path, handler] of routes) {
      expect(routesSource).toContain(
        `v1Routes.${method}("${path}", authMiddleware({ force: true }), UserActivityController.${handler});`,
      );
      expect(controllerSource).toContain(`export async function ${handler}(`);
    }
  });

  describe("address compatibility and ownership", () => {
    it("maps every persisted camelCase address field to the PHP snake_case response", () => {
      const mapper = sourceBlock(
        userCenterSource,
        "function legacyAddress(",
        "function collectCategory(",
      );
      const mappings = [
        ["real_name", "realName"],
        ["city_id", "cityId"],
        ["post_code", "postCode"],
        ["is_default", "isDefault"],
        ["is_del", "isDel"],
        ["add_time", "addTime"],
      ] as const;
      for (const [legacy, model] of mappings) {
        expect(mapper).toContain(`${legacy}: row.${model}`);
      }
      expect(userCenterSource).toContain(".map(legacyAddress)");
      expect(userCenterSource).toContain("return row ? legacyAddress(row) : []");
      expect(controllerSource).toContain('Array.isArray(address) ? "empty" : "ok"');
    });

    it("owner-scopes detail, edit, and delete in SQL instead of post-query checks", () => {
      const detail = sourceBlock(
        userCenterSource,
        "async addressDetail(",
        "/** 原子设置默认地址",
      );
      const save = sourceBlock(
        userCenterSource,
        "async addressSave(",
        "/** 删除地址",
      );
      const remove = sourceBlock(
        userCenterSource,
        "async addressDel(",
        "// ─── 收藏",
      );

      for (const block of [detail, save, remove]) {
        expect(block).toContain("eq(userAddress.id, id)");
        expect(block).toContain("eq(userAddress.uid, uid)");
        expect(block).toContain("eq(userAddress.isDel, 0)");
      }
      expect(detail).not.toContain("userAddressDao.get(");
      expect(remove).not.toContain("userAddressDao.get(");
    });

    it("validates the target before clearing defaults and keeps save/default in one transaction", () => {
      const helper = sourceBlock(
        userCenterSource,
        "async function setDefaultAddressInTransaction(",
        "function assertUid(",
      );
      const setDefault = sourceBlock(
        userCenterSource,
        "async addressSetDefault(",
        "/** 新增/编辑地址",
      );
      const save = sourceBlock(
        userCenterSource,
        "async addressSave(",
        "/** 删除地址",
      );

      expect(helper).toContain('.for("update")');
      expect(helper).toContain("eq(userAddress.uid, uid)");
      expect(helper).toContain("eq(userAddress.isDel, 0)");
      expect(helper.indexOf("if (!target[0])")).toBeLessThan(
        helper.indexOf(".set({ isDefault: 0 })"),
      );
      expect(helper).toContain(".returning({ id: userAddress.id })");

      for (const block of [setDefault, save]) {
        expect(block).toContain("withTx(this.container");
        expect(block).toContain("pg_advisory_xact_lock");
        expect(block).toContain("setDefaultAddressInTransaction(tx, uid");
      }
      expect(save).toContain("isDefault: 0");
      expect(save).toContain("normalizedDefault === 0 ? { ...values, isDefault: 0 } : values");
      expect(save).not.toContain("{ ...values, isDefault: normalizedDefault }");
      expect(save).not.toContain("this.addressSetDefault(");
    });

    it("normalizes municipality segments and refuses unresolved zero city ids", () => {
      expect(userCenterSource).toContain("function normalizedAddressSegments(");
      expect(userCenterSource).toContain("segment !== raw[index - 1]");
      expect(userCenterSource).toContain("eq(cityArea.parentId, 0)");
      expect(userCenterSource).toContain("resolved.matched !== addressSegments.length");
      expect(userCenterSource).toContain("suppliedCityId !== resolved.id");
      expect(userCenterSource).toContain("收货地址区域与省市区不一致");
      expect(userCenterSource).toContain('throw new ValidateException("收货地址区域不存在")');
    });
  });

  describe("collection side effects", () => {
    const explicitRelationConflict = /\.onConflictDoNothing\(\{\s*target:\s*\[\s*userRelation\.uid,\s*userRelation\.relationId,\s*userRelation\.type,\s*userRelation\.category,?\s*\],?\s*\}\)/s;

    it("uses an explicit logical conflict target at every collection insert", () => {
      for (const source of [userCenterSource, userCenterDaoSource]) {
        expect(source).not.toContain(".onConflictDoNothing()");
        expect(source).toMatch(explicitRelationConflict);
      }
    });

    it("logs only returned inserts and recomputes counters under product locks", () => {
      const add = sourceBlock(
        userCenterSource,
        "async collectAdd(",
        "/** 取消收藏 */",
      );
      const remove = sourceBlock(
        userCenterSource,
        "async collectDel(",
        "/** 收藏列表",
      );
      const counter = sourceBlock(
        userCenterSource,
        "async function syncProductCollectCounts(",
        "async function lockCollectProducts(",
      );
      const lock = sourceBlock(
        userCenterSource,
        "async function lockCollectProducts(",
        "async function lockExistingCollectProducts(",
      );

      expect(add).toContain(".returning({ relationId: userRelation.relationId })");
      expect(add).toContain("insertedIds.map((productId)");
      expect(add).toContain("tx.insert(storeProductLog)");
      expect(add).toContain('type: "collect"');
      expect(add).toContain("collectNum: 1");
      expect(add).toContain("syncProductCollectCounts(tx, insertedIds)");
      expect(add.indexOf("lockCollectProducts(tx, ids)")).toBeLessThan(
        add.indexOf(".insert(userRelation)"),
      );

      expect(remove).toContain("eq(userRelation.uid, uid)");
      expect(remove).toContain("eq(userRelation.type, \"collect\")");
      expect(remove).toContain("eq(userRelation.category, category)");
      expect(remove).toContain("syncProductCollectCounts(tx, ids)");

      expect(counter).toContain("COUNT(*)::integer");
      expect(counter).toContain("relation.type = 'collect'");
      expect(counter).toContain("relation.category = 'product'");
      expect(counter).toContain("UPDATE store_product product");
      expect(counter).toContain("SET collect = COALESCE(actual.count, 0)");
      expect(lock).toContain(".sort((left, right) => left - right)");
      expect(lock).toContain('.for("update")');
    });

    it("keeps unavailable products removable and implements video collection shape", () => {
      expect(collectCompatSource).toContain("storeProduct.isDel");
      expect(collectCompatSource).toContain("storeProduct.isShow");
      expect(collectCompatSource).toContain("product_id: id");
      expect(collectCompatSource).toContain("is_fail:");
      expect(collectCompatSource).toContain("promotions:");
      expect(collectCompatSource).toContain("activity_frame: []");
      expect(collectCompatSource).toContain("activity_background: []");
      expect(collectCompatSource).toContain("decorateCatalogProducts(list)");
      expect(collectCompatSource).toContain('priceType === "member"');
      expect(collectCompatSource).toContain("level_price:");
      expect(collectCompatSource).toContain("video_id: id");
      expect(collectCompatSource).toContain("video_func_status");
      expect(collectCompatSource).toContain("return { list, count:");
      expect(userCenterSource).toContain("syncVideoCollectCounts(tx, insertedIds)");
      expect(userCenterSource).toContain("syncVideoCollectCounts(tx, ids)");
    });

    it("ships the explicit conflict target indexes in schema and migration DDL", () => {
      const names = [
        "ua_uid_idx",
        "ur_uid_rel_type_cat_idx",
        "ur_uid_type_idx",
        "ur_collect_category_relation_idx",
        "us_uid_time_idx",
        "us_uid_shanghai_day_uq",
      ];
      for (const name of names) {
        expect(USER_CENTER_COMPATIBILITY_INDEX_SQL).toContain(`"${name}"`);
        expect(externalIndexMigration).toContain(`"${name}"`);
        expect(userCenterSchemaSource).toContain(`"${name}"`);
      }
      expect(USER_CENTER_COMPATIBILITY_INDEX_SQL).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
      expect(USER_CENTER_COMPATIBILITY_INDEX_SQL)
        .toContain('((("add_time"::bigint + 28800) / 86400))');
      const beforeShanghaiMidnight = Math.floor(Date.parse("2026-08-29T15:59:59.000Z") / 1000);
      const atShanghaiMidnight = beforeShanghaiMidnight + 1;
      const shanghaiDayBucket = (timestamp: number) => Math.floor((timestamp + 28_800) / 86_400);
      expect(shanghaiDayBucket(atShanghaiMidnight))
        .toBe(shanghaiDayBucket(beforeShanghaiMidnight) + 1);
      const externalExecutableSql = externalIndexMigration
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim();
      const embeddedExecutableSql = USER_CENTER_COMPATIBILITY_INDEX_SQL
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim();
      expect(externalExecutableSql).toBe(embeddedExecutableSql);
    });
  });

  describe("sign-in compatibility calendar", () => {
    it("preserves the PHP response keys for config, calendar, history, and user stats", () => {
      const requiredKeys = [
        "signList",
        "continuousSignDays",
        "cumulativeSignDays",
        "nextContinuousDays",
        "nextCumulativeDays",
        "checkSign",
        "signMode",
        "signRemindStatus",
        "signRemindSwitch",
        "signStatus",
        "signData",
        "sign_point",
        "sign_exp",
        "today",
        "w",
        "exp_num",
        "exp_balance",
        "add_time",
        "sum_sgin_day",
        "is_day_sgin",
        "is_YesterDay_sgin",
        "sum_integral",
        "deduction_integral",
        "today_integral",
        "frozen_integral",
      ];
      for (const key of requiredKeys) expect(signCompatSource).toContain(key);
    });

    it("uses one request timestamp and explicit Asia/Shanghai SQL projection", () => {
      const config = sourceBlock(
        signCompatSource,
        "async config(uid: number)",
        "async calendar(uid: number",
      );
      const calendar = sourceBlock(
        signCompatSource,
        "async calendar(uid: number",
        "async list(uid: number",
      );

      for (const block of [config, calendar]) {
        expect(block).toContain("const now = Math.floor(Date.now() / 1000)");
        expect(block).toContain(", now)");
      }
      expect(signCompatSource).toContain("AT TIME ZONE 'Asia/Shanghai'");
      expect(signCompatSource).toContain("gte(userSign.addTime, window.start)");
      expect(signCompatSource).toContain("lt(userSign.addTime, window.end)");
    });

    it("keeps personalized user-center responses private and only multiplies active SVIP rewards", () => {
      const handlerNames = [
        "addressList",
        "addressDefault",
        "addressDetail",
        "addressDefaultSet",
        "addressEdit",
        "addressDel",
        "collectAdd",
        "collectDel",
        "collectList",
        "collectAll",
        "signDo",
        "signStatus",
        "signConfig",
        "signList",
        "signMonth",
        "signUser",
        "signRemind",
        "signCalendar",
      ];
      expect(controllerSource).toContain('c.header("Cache-Control", "private, no-store")');
      for (const name of handlerNames) {
        const start = controllerSource.indexOf(`export async function ${name}(c: C)`);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(controllerSource.slice(start, start + 160)).toContain("privateNoStore(c)");
      }
      expect(userCenterSource).toContain("account.isEverLevel > 0");
      expect(userCenterSource).toContain("account.overdueTime > now");
      expect(userCenterSource).toContain("签到奖励(SVIP+");
      expect(userCenterSource).toContain("POSTGRES_INT_MAX");
      expect(userCenterSource).toContain('isUniqueIndexViolation(error, "us_uid_shanghai_day_uq")');
      expect(userCenterSource).toContain('throw new ValidateException("今日已签到")');
      expect(signCompatSource).toContain("displayPoint(point, multiplier)");
      expect(signCompatSource).toContain("effectiveContinuousSignDays");
      expect(signCompatSource).toContain("daysFromToday + (signedToday ? 0 : 1)");
      expect(signCompatSource).toContain("MAX_REWARD_RULES_PER_TYPE = 200");
      expect(signCompatSource).toContain('throw new ValidateException("积分统计超出安全范围")');
      expect(signCompatSource).toContain('row.addTime ? dateKey(row.addTime) : ""');
    });

    it("enforces strict, int4-safe YYYY-MM input and correct Shanghai midnight", () => {
      const month = sourceBlock(
        signCompatSource,
        "function monthWindow(",
        "function currentWeekWindow(",
      );
      expect(month).toContain("/^(\\d{4})-(0?[1-9]|1[0-2])$/");
      expect(month).toContain('throw new ValidateException("月份格式错误")');
      expect(month).toContain("year < 1970 || year > 2037");
      expect(month).toContain("- BUSINESS_OFFSET_SECONDS");

      const beforeMidnight = Math.floor(Date.parse("2026-08-29T15:59:59.000Z") / 1000);
      const midnight = beforeMidnight + 1;
      expect(signDayWindow(beforeMidnight).todayStart)
        .toBe(Math.floor(Date.parse("2026-08-28T16:00:00.000Z") / 1000));
      expect(signDayWindow(midnight)).toMatchObject({
        todayStart: midnight,
        tomorrowStart: midnight + 86_400,
        weekday: 0,
        dayOfMonth: 30,
      });
    });
  });
});
