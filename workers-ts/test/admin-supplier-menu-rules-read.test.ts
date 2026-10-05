import { afterEach, beforeEach, expect, it } from "vitest";
import { createContainerFromDb } from "../src/lib/di";
import { systemMenus, systemRole } from "../src/models/schema";
import { AdminSupplierMenuRuleService } from "../src/services/admin/AdminSupplierMenuRuleService";
import { financePostgres } from "./helpers/financePostgres";

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const service = () => new AdminSupplierMenuRuleService(createContainerFromDb(fixture.db));

beforeEach(async () => {
  fixture = await financePostgres([systemMenus, systemRole]);
  await fixture.db.insert(systemMenus).values([
    { id: 1, type: 1, authType: 1, menuName: "平台菜单", menuPath: "/admin/system" },
    { id: 11, type: 4, authType: 1, menuName: "供应商根", menuPath: "/products", sort: 30 },
    { id: 12, type: 4, authType: 2, pid: 11, menuName: "商品查看", methods: "GET",
      apiUrl: "product/product/list", sort: 20 },
    { id: 13, type: 4, authType: 1, pid: 11, menuName: "隐藏页面", isShow: 0, sort: 10 },
    { id: 14, type: 4, authType: 2, pid: 999, menuName: "停用接口", methods: "POST",
      apiUrl: "product/product/save", access: 0, sort: 5 },
    { id: 15, type: 4, authType: 1, menuName: "已删", isDel: 1 },
  ]);
  await fixture.db.insert(systemRole).values([
    { id: 31, type: 4, roleName: "生效角色", rules: "12,12,14" },
    { id: 32, type: 4, roleName: "停用角色", status: 0, rules: "12" },
    { id: 33, type: 1, roleName: "平台角色", rules: "12" },
  ]);
}, 30_000);

afterEach(async () => { await fixture?.close(); });

it("returns only live type-4 rows as an ordered tree with exact role references and actual capability mapping", async () => {
  const result = await service().list(new URLSearchParams());
  expect(result.count).toBe(4);
  expect(result.list.map((row) => row.id)).toEqual([11, 14]);
  expect(result.list[0].children.map((row) => row.id)).toEqual([12, 13]);
  expect(result.list[0].children[0]).toMatchObject({ type: 4, auth_type: 2,
    role_reference_count: 2, role_reference_ids: [31, 32],
    effective_permissions: ["supplier.product.view"] });
  expect(result.list[1]).toMatchObject({ role_reference_count: 1, effective_permissions: [] });
  expect(result.list[0].revision).toMatch(/^\d+$/);
  expect((await service().detail(12)).revision).toMatch(/^\d+$/);
  await expect(service().detail(1)).rejects.toThrow("不存在");
  await expect(service().detail(15)).rejects.toThrow("不存在");
});

it("filters hidden nodes and six legacy fields, rejecting duplicate and unknown parameters", async () => {
  expect((await service().list(new URLSearchParams("is_show=0"))).list.map((row) => row.id))
    .toEqual([13]);
  expect((await service().list(new URLSearchParams("keyword=12"))).list.map((row) => row.id))
    .toEqual([12]);
  expect((await service().list(new URLSearchParams("keyword=product/product/list"))).list.map((row) => row.id))
    .toEqual([12]);
  for (const input of ["is_show=2", "type=1", "keyword=a&keyword=b", "is_show=0&is_show=1"]) {
    await expect(service().list(new URLSearchParams(input))).rejects.toThrow();
  }
});

it("reports fixed Supplier navigation separately from legacy tree", async () => {
  const catalog = await service().catalog();
  expect(catalog.write_ready).toBe(false);
  expect(catalog.navigation).toEqual(expect.arrayContaining([
    { path: "/products", name: "商品管理", permission: "supplier.product.view" },
  ]));
  expect(catalog.permissions).toEqual(expect.arrayContaining([
    { key: "product", label: "商品管理", manage: true },
  ]));
});
