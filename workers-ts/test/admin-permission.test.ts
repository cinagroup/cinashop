import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADMIN_PERMISSION_GROUPS,
  AdminPermissionService,
  assertDelegablePermissions,
  normalizeAdminRoute,
  normalizeRoleRules,
  requiredAdminPermission,
  isAdminAuthorityRecoveryRoute,
  isAdminProductEditorRecoveryRoute,
  isAdminProductVideoRecoveryRoute,
  isAdminProfileRoute,
  isAdminPlatformMenuRecoveryRoute,
  isAdminExpressRecoveryRoute,
  isAdminLevelRecoveryRoute,
  isAdminUserLabelRecoveryRoute,
  isAdminStoreRecoveryRoute,
  isAdminStaffRecoveryRoute,
  isAdminDeliveryRecoveryRoute,
  isAdminGroupRecoveryRoute,
  isAdminUnitRecoveryRoute,
  isAdminEnsureRecoveryRoute,
  isAdminRuleRecoveryRoute,
  isAdminParameterRecoveryRoute,
  isAdminHotwordRecoveryRoute,
  isAdminPcBaseRecoveryRoute,
  isAdminWechatOpenRecoveryRoute,
  isAdminWechatAppRecoveryRoute,
  isAdminWechatRoutineRecoveryRoute,
  isAdminWechatBaseRecoveryRoute,
  isAdminProductLabelRecoveryRoute,
} from "@/services/admin/AdminPermissionService";
import { createContainerFromDb } from "@/lib/di";
import { systemMenus, systemRole } from "@/models/schema";
import { financePostgres } from "./helpers/financePostgres";

function registeredAdminRoutes(
  file: string,
  routeVariable: string,
  mountPrefix: string,
): Array<{ method: string; path: string }> {
  const source = readFileSync(file, "utf8");
  const pattern = new RegExp(
    `${routeVariable}\\.(get|post|put|delete|patch)\\(\\s*[\"']([^\"']+)[\"']\\s*,\\s*adminAuth\\b`,
    "g",
  );
  return [...source.matchAll(pattern)].map((match) => ({
    method: match[1].toUpperCase(),
    path: `${mountPrefix}${match[2]}`,
  }));
}

describe("admin permission catalog", () => {
  it("keeps city delivery record reads in their own view domain", () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      for (const path of ["city_delivery/records", "city_delivery/records/17", "city_delivery/stores"]) {
        expect(requiredAdminPermission("GET", `${prefix}/${path}`)).toBe("city_delivery_record.view");
        expect(requiredAdminPermission("HEAD", `${prefix}/${path}`)).toBe("city_delivery_record.view");
      }
    }
    const group = ADMIN_PERMISSION_GROUPS.find(group => group.key === "city_delivery_record");
    expect(group).toMatchObject({ path: "/setting/city-delivery-records", manage: false });
    expect(() => normalizeRoleRules("city_delivery_record.manage")).toThrow("未知权限规则");
    expect(() => assertDelegablePermissions(new Set(["order.view", "config.view", "store.view", "shipping_settings.view"]), ["city_delivery_record.view"]))
      .toThrow("不能授予超出当前管理员范围");
  });

  it("covers every route guarded by adminAuth in both compatibility surfaces", () => {
    const routes = [
      ...registeredAdminRoutes("src/routes/adminapi.ts", "adminapiRoutes", "/adminapi"),
      ...registeredAdminRoutes("src/routes/v1/index.ts", "v1Routes", "/api"),
      { method: "GET", path: "/api/ws/kefu" },
    ];
    expect(routes.length).toBeGreaterThan(200);
    const prefixes = ["/adminapi", "/api/admin"];
    const pair = (method: string, path: string) => ({ method, path });
    const ordered = (entries: typeof routes) => [...entries].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
    // These are explicit registered owner-recovery contracts, not a blanket
    // exemption for any URL containing receipt/resolve or a namespace prefix.
    const recoveryContracts = [
      { matches: isAdminAuthorityRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/setting/admin-authority/receipt/:operationId`),
        pair("POST", `${prefix}/setting/admin-authority/resolve`),
        pair("GET", `${prefix}/setting/role-authority/receipt/:operationId`),
        pair("POST", `${prefix}/setting/role-authority/resolve`),
        pair("GET", `${prefix}/system/authority/receipt/:operationId`),
        pair("POST", `${prefix}/system/authority/resolve`),
      ]) },
      { matches: isAdminProductEditorRecoveryRoute, expected: [
        pair("GET", "/adminapi/product/editor/operations/:operationId"),
        pair("POST", "/adminapi/product/editor/operations/:operationId/resolve"),
      ] },
      { matches: isAdminProductVideoRecoveryRoute, expected: [
        pair("GET", "/adminapi/file/video_uploads/:uploadId"),
        pair("POST", "/adminapi/file/video_uploads/:uploadId/cancel"),
      ] },
      { matches: isAdminPlatformMenuRecoveryRoute, expected: prefixes.map(prefix =>
        pair("GET", `${prefix}/system/menu-rules/receipt/:requestId`)) },
      { matches: isAdminExpressRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("POST", `${prefix}/express/author/resolve`), pair("GET", `${prefix}/express/author/receipt/:operationId`),
      ]) },
      { matches: isAdminLevelRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("POST", `${prefix}/level/author/resolve`), pair("GET", `${prefix}/level/author/receipt/:operationId`),
      ]) },
      { matches: isAdminUserLabelRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/user_label/author/receipt/:operationId`), pair("POST", `${prefix}/user_label/author/resolve`),
      ]) },
      { matches: isAdminStoreRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/merchant/store/author/receipt/:operationId`), pair("POST", `${prefix}/merchant/store/author/resolve`),
      ]) },
      { matches: isAdminStaffRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/merchant/store_staff/author/receipt/:operationId`), pair("POST", `${prefix}/merchant/store_staff/author/resolve`),
      ]) },
      { matches: isAdminGroupRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/user/group/author/receipt/:operationId`), pair("POST", `${prefix}/user/group/author/resolve`),
      ]) },
      { matches: isAdminUnitRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/product/unit/author/receipt/:operationId`), pair("POST", `${prefix}/product/unit/author/resolve`),
      ]) },
      { matches: isAdminEnsureRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/product/ensure/author/receipt/:operationId`), pair("POST", `${prefix}/product/ensure/author/resolve`),
      ]) },
      { matches: isAdminRuleRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/product/rule/author/receipt/:operationId`), pair("POST", `${prefix}/product/rule/author/resolve`),
      ]) },
      { matches: isAdminParameterRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/product/specs/author/receipt/:operationId`), pair("POST", `${prefix}/product/specs/author/resolve`),
      ]) },
      { matches: isAdminPcBaseRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/config/pc/operations/:operationId`), pair("POST", `${prefix}/config/pc/operations/:operationId/resolve`),
      ]) },
      { matches: isAdminWechatOpenRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/wechat/open/operations/:operationId`), pair("POST", `${prefix}/wechat/open/operations/:operationId/resolve`),
      ]) },
      { matches: isAdminWechatAppRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/wechat/app/operations/:operationId`), pair("POST", `${prefix}/wechat/app/operations/:operationId/resolve`),
      ]) },
      { matches: isAdminWechatRoutineRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/wechat/routine/operations/:operationId`), pair("POST", `${prefix}/wechat/routine/operations/:operationId/resolve`),
      ]) },
      { matches: isAdminWechatBaseRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/wechat/base/operations/:operationId`), pair("POST", `${prefix}/wechat/base/operations/:operationId/resolve`),
      ]) },
      { matches: isAdminHotwordRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/product/words/author/receipt/:operationId`), pair("POST", `${prefix}/product/words/author/resolve`),
      ]) },
      { matches: isAdminProductLabelRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/product/label/author/receipt/:operationId`), pair("POST", `${prefix}/product/label/author/resolve`),
      ]) },
      { matches: isAdminDeliveryRecoveryRoute, expected: prefixes.flatMap(prefix => [
        pair("GET", `${prefix}/order/delivery/author/receipt/:operationId`), pair("POST", `${prefix}/order/delivery/author/resolve`),
      ]) },
    ];
    for (const contract of recoveryContracts) {
      const owned = routes.filter(route => contract.matches(route.method, route.path));
      expect(ordered(owned)).toEqual(ordered(contract.expected));
      for (const route of owned) expect(requiredAdminPermission(route.method, route.path)).toBeNull();
    }
    // The service authorizes self profile independently of management grants.
    // Its two old setting URLs retain their classifier values; modern profile
    // URLs have no generic role permission. None accepts an arbitrary target.
    const profile = prefixes.flatMap(prefix => [
      pair("GET", `${prefix}/setting/info`), pair("PUT", `${prefix}/setting/update_admin`),
      pair("POST", `${prefix}/system/profile/commit`), pair("GET", `${prefix}/system/profile/receipt/:operationId`),
      pair("POST", `${prefix}/system/profile/resolve`), pair("PUT", `${prefix}/system/profile/avatar/:avatarId`),
      pair("GET", `${prefix}/system/profile/avatar/:avatarId`), pair("POST", `${prefix}/system/profile/challenge`),
      pair("GET", `${prefix}/system/profile/challenge/status`), pair("POST", `${prefix}/system/profile/sms`),
    ]);
    expect(ordered(routes.filter(route => isAdminProfileRoute(route.method, route.path)))).toEqual(ordered(profile));
    for (const route of profile) {
      const normalized = normalizeAdminRoute(route.path);
      expect(requiredAdminPermission(route.method, route.path)).toBe(normalized === "setting/info" ? "config.view"
        : normalized === "setting/update_admin" ? "config.manage" : null);
    }
    const missing = routes.filter(route => !isAdminProfileRoute(route.method, route.path)
      && !recoveryContracts.some(contract => contract.matches(route.method, route.path))
      && !requiredAdminPermission(route.method, route.path));
    expect(missing).toEqual([]);
  });

  it('keeps App grants bound to legacy menu composition and separates owner recovery from fresh view and save permissions', () => {
    for (const permission of ['wechat_app.view', 'wechat_app.manage'])
      expect(() => normalizeRoleRules(permission)).toThrow('原生App权限须通过完整的旧菜单组合授予');
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect(requiredAdminPermission('GET', `${prefix}/wechat/app`)).toBe('wechat_app.view');
      expect(requiredAdminPermission('POST', `${prefix}/wechat/app`)).toBe('wechat_app.manage');
      const receipt = `${prefix}/wechat/app/operations/:operationId`;
      expect(isAdminWechatAppRecoveryRoute('GET', receipt)).toBe(true);
      expect(isAdminWechatAppRecoveryRoute('POST', receipt)).toBe(false);
      expect(isAdminWechatAppRecoveryRoute('POST', receipt + '/resolve')).toBe(true);
      expect(isAdminWechatAppRecoveryRoute('GET', receipt + '/resolve')).toBe(false);
      expect(requiredAdminPermission('GET', receipt)).toBeNull();
      expect(requiredAdminPermission('POST', receipt + '/resolve')).toBeNull();
    }
  });

  it('keeps Routine grants bound to the fixed leaf/save selection and limits owner recovery to its exact endpoints', () => {
    for (const permission of ['wechat_routine.view', 'wechat_routine.manage'])
      expect(() => normalizeRoleRules(permission)).toThrow('小程序权限须通过完整的旧菜单组合授予');
    expect(normalizeRoleRules('1346,315')).toBe('315,1346');
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect(requiredAdminPermission('GET', `${prefix}/wechat/routine`)).toBe('wechat_routine.view');
      expect(requiredAdminPermission('HEAD', `${prefix}/setting/config/edit_new_build/routine`)).toBe('wechat_routine.view');
      expect(requiredAdminPermission('POST', `${prefix}/wechat/routine`)).toBe('wechat_routine.manage');
      const receipt = `${prefix}/wechat/routine/operations/:operationId`;
      expect(isAdminWechatRoutineRecoveryRoute('GET', receipt)).toBe(true);
      expect(isAdminWechatRoutineRecoveryRoute('HEAD', receipt)).toBe(true);
      expect(isAdminWechatRoutineRecoveryRoute('POST', receipt + '/resolve')).toBe(true);
      expect(requiredAdminPermission('GET', receipt)).toBeNull();
      expect(requiredAdminPermission('POST', receipt + '/resolve')).toBeNull();
      for (const [method, path] of [['POST', receipt], ['GET', receipt + '/resolve'],
        ['POST', receipt + '/resolve/extra'], ['GET', receipt + '/extra'],
        ['POST', `${prefix}/wechat/routine/resolve`], ['GET', `${prefix}/wechat/routine/operations`]]) {
        expect(isAdminWechatRoutineRecoveryRoute(method, path)).toBe(false);
        expect(requiredAdminPermission(method, path)).toBeNull();
      }
    }
    const permissions = new AdminPermissionService(createContainerFromDb({} as never));
    expect(permissions.permissionTree().some(group => group.key === 'wechat_routine')).toBe(false);
  });

  it('limits video recovery to owned query and cancellation while keeping publication and previews capability gated', () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      const base = `${prefix}/file/video_uploads/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa`;
      for (const [method,path] of [['GET',base],['HEAD',base],['POST',base+'/cancel']]) {
        expect(isAdminProductVideoRecoveryRoute(method,path)).toBe(true);
        expect(requiredAdminPermission(method,path)).toBeNull();
      }
      for (const [method,path,permission] of [
        ['POST',base,'attachment.manage'],['PUT',base+'/parts/1','attachment.manage'],
        ['POST',base+'/complete','attachment.manage'],['GET',base+'/preview','attachment.view'],
      ]) {
        expect(isAdminProductVideoRecoveryRoute(method,path)).toBe(false);
        expect(requiredAdminPermission(method,path)).toBe(permission);
      }
      for (const [method,path] of [['DELETE',base],['GET',base+'/cancel'],['POST',base+'/cancel/extra'],['POST',base+'/resolve']])
        expect(isAdminProductVideoRecoveryRoute(method,path)).toBe(false);
    }
  });

  it("keeps route aliases in the same permission domain", () => {
    expect(requiredAdminPermission("POST", "/adminapi/product/add")).toBe("product.manage");
    expect(requiredAdminPermission("POST", "/api/admin/product/create")).toBe("product.manage");
    expect(requiredAdminPermission("GET", "/adminapi/order/outbox")).toBe("outbox.view");
    expect(requiredAdminPermission("GET", "/adminapi/order/chart")).toBe("order.view");
    expect(requiredAdminPermission("GET", "/api/admin/order/chart")).toBe("order.view");
    expect(requiredAdminPermission("GET", "/api/admin/order/list")).toBe("order.view");
    expect(requiredAdminPermission("GET", "/adminapi/merchant/store")).toBe("store.view");
    expect(requiredAdminPermission("PUT", "/api/admin/merchant/store_staff/set_show/:id/:status"))
      .toBe("store.manage");
    expect(normalizeAdminRoute("/API/Admin/Agent/Division/Detail/:uid")).toBe("agent/division/detail/:uid");
  });

  it("separates platform cash-flow reads from remark edits on both admin route surfaces", () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      expect(requiredAdminPermission("GET", `${prefix}/flow/get_list`)).toBe("capital_flow.view");
      expect(requiredAdminPermission("POST", `${prefix}/flow/set_mark/7`)).toBe("capital_flow.manage");
      expect(requiredAdminPermission("GET", `${prefix}/bill/list`)).toBe("bill.view");
    }
  });

  it("keeps user-money ledger reads and export independent of other finance grants", async () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      expect(requiredAdminPermission("GET", `${prefix}/finance/user-money-ledger`)).toBe("bill.view");
      expect(requiredAdminPermission("HEAD", `${prefix}/finance/user-money-ledger/types`)).toBe("bill.view");
      expect(requiredAdminPermission("GET", `${prefix}/finance/user-money-ledger/export`)).toBe("bill.export");
      expect(requiredAdminPermission("HEAD", `${prefix}/finance/user-money-ledger/export`)).toBe("bill.export");
      expect(requiredAdminPermission("GET", `${prefix}/bill/list`)).toBe("bill.view");
    }
    expect(requiredAdminPermission("GET", "/adminapi/finance/finance/list")).toBe("bill.view");
    expect(requiredAdminPermission("GET", "/adminapi/finance/finance/bill_type")).toBe("bill.view");
    expect(requiredAdminPermission("GET", "/adminapi/export/userFinance")).toBe("bill.export");
    expect(() => assertDelegablePermissions(new Set(["bill.view"]), ["bill.export"]))
      .toThrow("不能授予超出当前管理员范围");
    expect(() => assertDelegablePermissions(new Set(["capital_flow.view", "integral_log.export"]), ["bill.export"]))
      .toThrow("不能授予超出当前管理员范围");
    expect(normalizeRoleRules("bill.view,bill.export")).toContain("bill.export");

    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 41, type: 1, authType: 1, access: 1,
          menuPath: "/admin/finance/finance/bill", uniqueAuth: "finance-finance-bill" },
        { id: 8711, type: 1, authType: 1, access: 1,
          menuPath: "/admin/finance/finance/bill", uniqueAuth: "wrong-rule" },
        { id: 311, type: 1, authType: 2, access: 1,
          apiUrl: "finance/finance/bill_type", methods: "GET" },
        { id: 312, type: 1, authType: 2, access: 1,
          apiUrl: "finance/finance/list", methods: "GET" },
        { id: 617, type: 1, authType: 2, access: 1,
          apiUrl: "export/userFinance", methods: "GET", uniqueAuth: "export-userFinance" },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      expect(await service.resolveManyRulePermissionKeys(["41", "8711", "311", "312", "617"]))
        .toEqual([["bill.view"], [], ["bill.view"], ["bill.view"], ["bill.export"]]);
      expect(service.permissionTree().find(group => group.key === "bill")?.children)
        .toEqual(expect.arrayContaining([expect.objectContaining({ key: "bill.export" })]));
      await fixture.db.insert(systemRole).values({ id: 8712, roleName: "ledger-reader", rules: "41" });
      const reader = { level: 1, roles: "8712", id: 8712, account: "reader", realName: "", divisionId: 0 };
      await expect(service.assertAuthorized(reader, "GET", "/adminapi/finance/user-money-ledger"))
        .resolves.toBeUndefined();
      await expect(service.assertAuthorized(reader, "GET", "/adminapi/finance/user-money-ledger/export"))
        .rejects.toThrow("暂时没有权限访问");
    } finally { await fixture.close(); }
  });

  it("maps the exact legacy page-only capital menu to view without granting remark writes", async () => {
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 1384, type: 1, authType: 1, access: 1, menuPath: "/admin/statistic/capital", uniqueAuth: "admin-statistic-capital" },
        { id: 1385, type: 1, authType: 1, access: 1, menuPath: "/admin/statistic/capital", uniqueAuth: "unrelated-page" },
      ]);
      await fixture.db.insert(systemRole).values({ id: 7, roleName: "legacy-cash-reader", rules: "1384" });
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      const admin = { level: 1, roles: "7", id: 21, account: "reader", realName: "", divisionId: 0 };
      const keys = await service.resolveAdminPermissionKeys(admin);
      expect([...keys]).toEqual(["capital_flow.view"]);
      expect(service.buildMenus(keys)).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/finance/capital-flow" })]));
      await expect(service.assertAuthorized(admin, "GET", "/adminapi/flow/get_list")).resolves.toBeUndefined();
      await expect(service.assertAuthorized(admin, "POST", "/adminapi/flow/set_mark/1")).rejects.toThrow("暂时没有权限访问");
      expect(await service.resolveRulePermissionKeys("1385")).toEqual([]);
      expect(await service.resolveManyRulePermissionKeys(["1384", "1385"]))
        .toEqual([["capital_flow.view"], []]);
    } finally {
      await fixture.close();
    }
  });

  it("maps only the audited supplier and agreement page rules to read grants", async () => {
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 1580, type: 1, authType: 1, access: 1, menuPath: "/admin/supplier/apply", uniqueAuth: "admin-supplier-apply" },
        { id: 1581, type: 1, authType: 1, access: 1, menuPath: "/admin/supplier/apply", uniqueAuth: "wrong-rule" },
        { id: 1582, type: 1, authType: 1, access: 1, menuPath: "/admin/supplier/menu/list", uniqueAuth: "admin-supplier-menu-list" },
        { id: 1583, type: 1, authType: 1, access: 1, menuPath: "/admin/supplier/supplier/index", uniqueAuth: "admin-supplier-menu-list" },
        { id: 1385, type: 1, authType: 1, access: 1, menuPath: "/admin/agent/agreement", uniqueAuth: "agent-agreement" },
        { id: 1386, type: 1, authType: 1, access: 1, menuPath: "/admin/agent/agreement", uniqueAuth: "wrong-rule" },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      expect(await service.resolveManyRulePermissionKeys(["1580", "1581", "1582", "1583", "1385", "1386"]))
        .toEqual([["supplier_application.view"], [], ["supplier_directory.view"], [], ["agent_agreement.view"], []]);
      for (const [path, key] of [
        ["supplier/apply/list", "supplier_application"],
        ["supplier/supplier", "supplier_directory"],
        ["agent/get_agent_agreement", "agent_agreement"],
      ]) {
        expect(requiredAdminPermission("GET", `/adminapi/${path}`)).toBe(`${key}.view`);
      }
      expect(requiredAdminPermission("POST", "/adminapi/supplier/apply/verify/4")).toBe("supplier_application.manage");
      expect(requiredAdminPermission("POST", "/adminapi/agent/set_agent_agreement/2")).toBe("agent_agreement.manage");
      expect(requiredAdminPermission("GET", "/adminapi/supplier/supplier/login/4")).toBeNull();
    } finally { await fixture.close(); }
  });

  it("separates lottery claimant records and feedback from broader activity and service grants", async () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      expect(requiredAdminPermission("GET", `${prefix}/lottery/list`)).toBe("lottery.view");
      expect(requiredAdminPermission("GET", `${prefix}/lottery/record/list`)).toBe("lottery_record.view");
      expect(requiredAdminPermission("GET", `${prefix}/lottery/record/detail/9`)).toBe("lottery_record.manage");
      expect(requiredAdminPermission("POST", `${prefix}/lottery/record/deliver`)).toBe("lottery_record.manage");
      expect(requiredAdminPermission("GET", `${prefix}/feedback`)).toBe("feedback.view");
      expect(requiredAdminPermission("PUT", `${prefix}/feedback/9`)).toBe("feedback.manage");
      expect(requiredAdminPermission("DELETE", `${prefix}/feedback/9`)).toBe("feedback.manage");
      expect(requiredAdminPermission("GET", `${prefix}/service/list`)).toBe("service.view");
    }
    expect(() => assertDelegablePermissions(new Set(["lottery.view", "service.view"]),
      ["lottery_record.view", "feedback.view"])).toThrow("不能授予超出当前管理员范围");
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 8701, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/lottery/recording_list", uniqueAuth: "admin-marketing-lottery-recording_list" },
        { id: 8702, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/lottery/recording_list", uniqueAuth: "lottery-wrong" },
        { id: 8703, type: 1, authType: 1, access: 1,
          menuPath: "/admin/setting/store_service/feedback", uniqueAuth: "admin-setting-store_service-feedback" },
        { id: 8704, type: 1, authType: 1, access: 1,
          menuPath: "/admin/setting/store_service/feedback", uniqueAuth: "feedback-wrong" },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      expect(await service.resolveManyRulePermissionKeys(["8701", "8702", "8703", "8704"]))
        .toEqual([["lottery_record.view"], [], ["feedback.view"], []]);
    } finally { await fixture.close(); }
  });

  it("keeps activity-frame reads and writes behind its audited legacy menu rules", async () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      expect(requiredAdminPermission("GET", `${prefix}/marketing/activity-frame`)).toBe("activity_frame.view");
      expect(requiredAdminPermission("GET", `${prefix}/marketing/activity-frame/products`)).toBe("activity_frame.view");
      expect(requiredAdminPermission("GET", `${prefix}/marketing/activity-frame/7`)).toBe("activity_frame.view");
      expect(requiredAdminPermission("POST", `${prefix}/marketing/activity-frame`)).toBe("activity_frame.manage");
      expect(requiredAdminPermission("PUT", `${prefix}/marketing/activity-frame/7`)).toBe("activity_frame.manage");
      expect(requiredAdminPermission("PATCH", `${prefix}/marketing/activity-frame/7/status`)).toBe("activity_frame.manage");
      expect(requiredAdminPermission("DELETE", `${prefix}/marketing/activity-frame/7`)).toBe("activity_frame.manage");
    }
    expect(requiredAdminPermission("GET", "/adminapi/marketing/activity_frame/set_status/7/1"))
      .toBe("activity_frame.manage");
    expect(() => assertDelegablePermissions(new Set(["activity.manage"]), ["activity_frame.view"]))
      .toThrow("不能授予超出当前管理员范围");

    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 1541, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/activity_frame", uniqueAuth: "admin-marketing-activity_frame" },
        { id: 1543, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/activity_frame/create", uniqueAuth: "marketing-activity_frame-create" },
        { id: 8713, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/activity_frame", uniqueAuth: "wrong-rule" },
        { id: 8714, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/activity_frame/create", uniqueAuth: "wrong-rule" },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      expect(await service.resolveManyRulePermissionKeys(["1541", "1543", "8713", "8714"]))
        .toEqual([["activity_frame.view"], ["activity_frame.manage", "activity_frame.view"], [], []]);
      await fixture.db.insert(systemRole).values({ id: 8715, roleName: "frame-reader", rules: "1541" });
      const reader = { level: 1, roles: "8715", id: 8715, account: "reader", realName: "", divisionId: 0 };
      await expect(service.assertAuthorized(reader, "GET", "/adminapi/marketing/activity-frame"))
        .resolves.toBeUndefined();
      await expect(service.assertAuthorized(reader, "POST", "/adminapi/marketing/activity-frame"))
        .rejects.toThrow("暂时没有权限访问");
    } finally { await fixture.close(); }
  });

  it("isolates activity-background reads and writes from frame and generic activity grants", async () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      for (const suffix of ["", "/products", "/brands", "/labels", "/7"]) {
        expect(requiredAdminPermission("GET", `${prefix}/marketing/activity-background${suffix}`)).toBe("activity_background.view");
      }
      for (const [method, suffix] of [["POST", ""], ["PUT", "/7"], ["PATCH", "/7/status"], ["DELETE", "/7"]]) {
        expect(requiredAdminPermission(method, `${prefix}/marketing/activity-background${suffix}`)).toBe("activity_background.manage");
      }
      expect(requiredAdminPermission("GET", `${prefix}/marketing/activity_background/set_status/7/1`))
        .toBe("activity_background.manage");
    }
    for (const grant of ["activity.manage", "activity_frame.manage"]) {
      expect(() => assertDelegablePermissions(new Set([grant]), ["activity_background.view"]))
        .toThrow("不能授予超出当前管理员范围");
    }
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 1542, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/activity_background", uniqueAuth: "admin-marketing-activity_background" },
        { id: 1546, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/activity_background/create", uniqueAuth: "marketing-activity_background-create" },
        { id: 8731, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/activity_background", uniqueAuth: "admin-marketing-activity_frame" },
        { id: 8732, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/activity_frame/create", uniqueAuth: "marketing-activity_background-create" },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      expect(await service.resolveManyRulePermissionKeys(["1542", "1546", "8731", "8732"]))
        .toEqual([["activity_background.view"], ["activity_background.manage", "activity_background.view"], [], []]);
      await fixture.db.insert(systemRole).values({ id: 8733, roleName: "background-reader", rules: "1542" });
      const reader = { level: 1, roles: "8733", id: 8733, account: "reader", realName: "", divisionId: 0 };
      for (const prefix of ["/adminapi", "/api/admin"]) {
        await expect(service.assertAuthorized(reader, "GET", `${prefix}/marketing/activity-background`)).resolves.toBeUndefined();
        await expect(service.assertAuthorized(reader, "POST", `${prefix}/marketing/activity-background`)).rejects.toThrow("暂时没有权限访问");
        await expect(service.assertAuthorized(reader, "GET", `${prefix}/marketing/activity-frame`)).rejects.toThrow("暂时没有权限访问");
      }
    } finally { await fixture.close(); }
  });

  it("isolates the ten time-discount routes behind exact legacy list and add rules", async () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      for (const suffix of ["", "/products", "/brands", "/labels", "/user-labels", "/7"]) {
        expect(requiredAdminPermission("GET", `${prefix}/marketing/time-discounts${suffix}`))
          .toBe("time_discount.view");
      }
      for (const [method, suffix] of [["POST", ""], ["PUT", "/7"],
        ["PATCH", "/7/status"], ["DELETE", "/7"]]) {
        expect(requiredAdminPermission(method, `${prefix}/marketing/time-discounts${suffix}`))
          .toBe("time_discount.manage");
      }
    }
    for (const grant of ["activity.manage", "activity_background.manage", "activity_frame.manage"]) {
      expect(() => assertDelegablePermissions(new Set([grant]), ["time_discount.view"]))
        .toThrow("不能授予超出当前管理员范围");
    }
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 1394, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/list", uniqueAuth: "marketing-discount-list" },
        { id: 1398, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/add", uniqueAuth: "marketing-discount-add" },
        { id: 8741, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/list", uniqueAuth: "marketing-discount-add" },
        { id: 8742, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/add", uniqueAuth: "marketing-discount-list" },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      expect(await service.resolveManyRulePermissionKeys(["1394", "1398", "8741", "8742"]))
        .toEqual([["time_discount.view"], ["time_discount.manage", "time_discount.view"], [], []]);
      await fixture.db.insert(systemRole).values([
        { id: 8743, roleName: "time-discount-reader", rules: "1394" },
        { id: 8744, roleName: "time-discount-manager", rules: "1398" },
        { id: 8745, roleName: "adjacent-activity", rules: "activity.manage,8741,8742" },
      ]);
      const actor = (role: number) => ({ level: 1, roles: String(role), id: role,
        account: "reader", realName: "", divisionId: 0 });
      for (const prefix of ["/adminapi", "/api/admin"]) {
        await expect(service.assertAuthorized(actor(8743), "GET", `${prefix}/marketing/time-discounts`))
          .resolves.toBeUndefined();
        await expect(service.assertAuthorized(actor(8743), "POST", `${prefix}/marketing/time-discounts`))
          .rejects.toThrow("暂时没有权限访问");
        await expect(service.assertAuthorized(actor(8744), "POST", `${prefix}/marketing/time-discounts`))
          .resolves.toBeUndefined();
        await expect(service.assertAuthorized(actor(8745), "GET", `${prefix}/marketing/time-discounts`))
          .rejects.toThrow("暂时没有权限访问");
      }
    } finally { await fixture.close(); }
  });

  it("isolates full-discount routes and accepts only paired legacy list and add rules", async () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      for (const suffix of ["", "/products", "/brands", "/labels", "/user-labels", "/7"]) {
        expect(requiredAdminPermission("GET", `${prefix}/marketing/full-discounts${suffix}`))
          .toBe("full_discount.view");
      }
      for (const [method, suffix] of [["POST", ""], ["PUT", "/7"],
        ["PATCH", "/7/status"], ["DELETE", "/7"]]) {
        expect(requiredAdminPermission(method, `${prefix}/marketing/full-discounts${suffix}`))
          .toBe("full_discount.manage");
      }
    }
    for (const grant of ["time_discount.manage", "activity.manage", "activity_background.manage"]) {
      expect(() => assertDelegablePermissions(new Set([grant]), ["full_discount.view"]))
        .toThrow("不能授予超出当前管理员范围");
    }
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 1396, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/full_discount", uniqueAuth: "marketing-discount-full_discount" },
        { id: 1400, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/add_discount", uniqueAuth: "marketing-discount-add_discount" },
        { id: 8751, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/full_discount", uniqueAuth: "marketing-discount-add_discount" },
        { id: 8752, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/add_discount", uniqueAuth: "marketing-discount-full_discount" },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      expect(await service.resolveManyRulePermissionKeys(["1396", "1400", "8751", "8752"]))
        .toEqual([["full_discount.view"], ["full_discount.manage", "full_discount.view"], [], []]);
      await fixture.db.insert(systemRole).values([
        { id: 8753, roleName: "full-discount-reader", rules: "1396" },
        { id: 8754, roleName: "full-discount-manager", rules: "1400" },
        { id: 8755, roleName: "adjacent-discount", rules: "time_discount.manage,8751,8752" },
      ]);
      const actor = (role: number) => ({ level: 1, roles: String(role), id: role,
        account: "reader", realName: "", divisionId: 0 });
      for (const prefix of ["/adminapi", "/api/admin"]) {
        await expect(service.assertAuthorized(actor(8753), "GET", `${prefix}/marketing/full-discounts`))
          .resolves.toBeUndefined();
        await expect(service.assertAuthorized(actor(8753), "POST", `${prefix}/marketing/full-discounts`))
          .rejects.toThrow("暂时没有权限访问");
        await expect(service.assertAuthorized(actor(8754), "POST", `${prefix}/marketing/full-discounts`))
          .resolves.toBeUndefined();
        await expect(service.assertAuthorized(actor(8755), "GET", `${prefix}/marketing/full-discounts`))
          .rejects.toThrow("暂时没有权限访问");
      }
    } finally { await fixture.close(); }
  });

  it("isolates nth-discount routes and accepts only paired legacy list and add rules", async () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      for (const suffix of ["", "/products", "/brands", "/labels", "/user-labels", "/7"]) {
        expect(requiredAdminPermission("GET", `${prefix}/marketing/nth-discounts${suffix}`))
          .toBe("nth_discount.view");
      }
      for (const [method, suffix] of [["POST", ""], ["PUT", "/7"],
        ["PATCH", "/7/status"], ["DELETE", "/7"]]) {
        expect(requiredAdminPermission(method, `${prefix}/marketing/nth-discounts${suffix}`))
          .toBe("nth_discount.manage");
      }
    }
    for (const grant of ["time_discount.manage", "full_discount.manage", "activity.manage", "activity_background.manage"]) {
      expect(() => assertDelegablePermissions(new Set([grant]), ["nth_discount.view"]))
        .toThrow("不能授予超出当前管理员范围");
    }
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 1397, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/pieces_discount", uniqueAuth: "marketing-discount-pieces_discount" },
        { id: 1401, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/add_pieces", uniqueAuth: "marketing-discount-add_pieces" },
        { id: 8761, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/pieces_discount", uniqueAuth: "marketing-discount-add_pieces" },
        { id: 8762, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/add_pieces", uniqueAuth: "marketing-discount-pieces_discount" },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      expect(await service.resolveManyRulePermissionKeys(["1397", "1401", "8761", "8762"]))
        .toEqual([["nth_discount.view"], ["nth_discount.manage", "nth_discount.view"], [], []]);
      await fixture.db.insert(systemRole).values([
        { id: 8763, roleName: "nth-discount-reader", rules: "1397" },
        { id: 8764, roleName: "nth-discount-manager", rules: "1401" },
        { id: 8765, roleName: "adjacent-discount", rules: "time_discount.manage,8761,8762" },
      ]);
      const actor = (role: number) => ({ level: 1, roles: String(role), id: role,
        account: "reader", realName: "", divisionId: 0 });
      for (const prefix of ["/adminapi", "/api/admin"]) {
        await expect(service.assertAuthorized(actor(8763), "GET", `${prefix}/marketing/nth-discounts`))
          .resolves.toBeUndefined();
        await expect(service.assertAuthorized(actor(8763), "POST", `${prefix}/marketing/nth-discounts`))
          .rejects.toThrow("暂时没有权限访问");
        await expect(service.assertAuthorized(actor(8764), "POST", `${prefix}/marketing/nth-discounts`))
          .resolves.toBeUndefined();
        await expect(service.assertAuthorized(actor(8765), "GET", `${prefix}/marketing/nth-discounts`))
          .rejects.toThrow("暂时没有权限访问");
      }
    } finally { await fixture.close(); }
  });

  it("isolates full-gift routes and accepts only paired legacy list and add rules", async () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      for (const suffix of ["", "/products", "/coupons", "/brands", "/labels", "/user-labels", "/7"]) {
        expect(requiredAdminPermission("GET", `${prefix}/marketing/full-gifts${suffix}`))
          .toBe("full_gift.view");
      }
      for (const [method, suffix] of [["POST", ""], ["PUT", "/7"],
        ["PATCH", "/7/status"], ["DELETE", "/7"]]) {
        expect(requiredAdminPermission(method, `${prefix}/marketing/full-gifts${suffix}`))
          .toBe("full_gift.manage");
      }
    }
    for (const grant of ["time_discount.manage", "full_discount.manage", "nth_discount.manage", "activity.manage", "activity_background.manage"]) {
      expect(() => assertDelegablePermissions(new Set([grant]), ["full_gift.view"]))
        .toThrow("不能授予超出当前管理员范围");
    }
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 1395, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/give", uniqueAuth: "marketing-discount-give" },
        { id: 1399, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/add_give", uniqueAuth: "marketing-discount-add_give" },
        { id: 8771, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/give", uniqueAuth: "marketing-discount-add_give" },
        { id: 8772, type: 1, authType: 1, access: 1,
          menuPath: "/admin/marketing/discount/add_give", uniqueAuth: "marketing-discount-give" },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      expect(await service.resolveManyRulePermissionKeys(["1395", "1399", "8771", "8772"]))
        .toEqual([["full_gift.view"], ["full_gift.manage", "full_gift.view"], [], []]);
      await fixture.db.insert(systemRole).values([
        { id: 8773, roleName: "full-gift-reader", rules: "1395" },
        { id: 8774, roleName: "full-gift-manager", rules: "1399" },
        { id: 8775, roleName: "adjacent-discount", rules: "time_discount.manage,8771,8772" },
      ]);
      const actor = (role: number) => ({ level: 1, roles: String(role), id: role,
        account: "reader", realName: "", divisionId: 0 });
      for (const prefix of ["/adminapi", "/api/admin"]) {
        await expect(service.assertAuthorized(actor(8773), "GET", `${prefix}/marketing/full-gifts`))
          .resolves.toBeUndefined();
        await expect(service.assertAuthorized(actor(8773), "POST", `${prefix}/marketing/full-gifts`))
          .rejects.toThrow("暂时没有权限访问");
        await expect(service.assertAuthorized(actor(8774), "POST", `${prefix}/marketing/full-gifts`))
          .resolves.toBeUndefined();
        await expect(service.assertAuthorized(actor(8775), "GET", `${prefix}/marketing/full-gifts`))
          .rejects.toThrow("暂时没有权限访问");
      }
    } finally { await fixture.close(); }
  });

  it("keeps speechcraft management and point-log export separate from adjacent read grants", async () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      expect(requiredAdminPermission("GET", `${prefix}/wechat/speechcraft`)).toBe("speechcraft.view");
      expect(requiredAdminPermission("GET", `${prefix}/wechat/speechcraft/categories`)).toBe("speechcraft.view");
      expect(requiredAdminPermission("POST", `${prefix}/wechat/speechcraft/categories`)).toBe("speechcraft.manage");
      expect(requiredAdminPermission("PUT", `${prefix}/wechat/speechcraft/categories/9`)).toBe("speechcraft.manage");
      expect(requiredAdminPermission("DELETE", `${prefix}/wechat/speechcraft/9`)).toBe("speechcraft.manage");
      expect(requiredAdminPermission("GET", `${prefix}/marketing/user-point/logs`)).toBe("integral_log.view");
      expect(requiredAdminPermission("GET", `${prefix}/marketing/user-point/export`)).toBe("integral_log.export");
      expect(requiredAdminPermission("GET", `${prefix}/service/list`)).toBe("service.view");
    }
    expect(normalizeRoleRules("integral_log.view,integral_log.export"))
      .toContain("integral_log.export");
    expect(() => assertDelegablePermissions(new Set(["integral_log.view"]), ["integral_log.export"]))
      .toThrow("不能授予超出当前管理员范围");
    expect(() => assertDelegablePermissions(new Set(["service.manage"]), ["speechcraft.manage"]))
      .toThrow("不能授予超出当前管理员范围");

    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 8705, type: 1, authType: 1, access: 1,
          menuPath: "/admin/setting/store_service/speechcraft", uniqueAuth: "admin-setting-store_service-speechcraft" },
        { id: 8706, type: 1, authType: 1, access: 1,
          menuPath: "/admin/setting/store_service/speechcraft", uniqueAuth: "speechcraft-wrong" },
        { id: 616, type: 1, authType: 2, access: 1,
          apiUrl: "export/userPoint", methods: "GET", uniqueAuth: "export-userPoint" },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      expect(await service.resolveManyRulePermissionKeys(["8705", "8706", "616"]))
        .toEqual([["speechcraft.view"], [], ["integral_log.export"]]);
      expect(service.permissionTree().find((group) => group.key === "integral_log")?.children)
        .toEqual(expect.arrayContaining([expect.objectContaining({ key: "integral_log.export" })]));
    } finally { await fixture.close(); }
  });

  it("fails closed for unregistered management routes", () => {
    expect(requiredAdminPermission("GET", "/adminapi/not-registered/list")).toBeNull();
  });

  it("separates coupon templates, publication and existing issue management on both surfaces", () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      for (const path of ["", "/options", "/products", "/7", "/7/issues"])
        expect(requiredAdminPermission("GET", `${prefix}/marketing/coupon-templates${path}`)).toBe("coupon_template.view");
      expect(requiredAdminPermission("POST", `${prefix}/marketing/coupon-templates`)).toBe("coupon_template.manage");
      expect(requiredAdminPermission("POST", `${prefix}/marketing/coupon-templates/7/invalidate`)).toBe("coupon_template.manage");
      expect(requiredAdminPermission("DELETE", `${prefix}/marketing/coupon-templates/7`)).toBe("coupon_template.manage");
      expect(requiredAdminPermission("POST", `${prefix}/marketing/coupon-template-issues`)).toBe("coupon_template_issue.manage");
      expect(requiredAdminPermission("POST", `${prefix}/coupon/save`)).toBe("coupon.manage");
    }
    expect(normalizeRoleRules("coupon_template.manage,coupon.manage"))
      .toBe("coupon.view,coupon.manage,coupon_template.view,coupon_template.manage");
    expect(() => assertDelegablePermissions(new Set(["coupon_template.view", "coupon_template.manage"]), ["coupon_template_issue.manage"]))
      .toThrow("不能授予超出当前管理员范围");
  });

  it("maps template page visibility without silently granting publication", async () => {
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 3381, type: 1, authType: 2, access: 1, menuPath: "/marketing/coupon-templates", uniqueAuth: "legacy-template" },
        { id: 3382, type: 1, authType: 2, access: 1, menuPath: "/admin/marketing/store_coupon/index", uniqueAuth: "old-template" },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      expect(await service.resolveManyRulePermissionKeys(["3381", "3382", "coupon_template_issue.manage"]))
        .toEqual([["coupon_template.view"], ["coupon_template.view"], ["coupon_template_issue.manage", "coupon_template_issue.view"]]);
      const keys = new Set(await service.resolveRulePermissionKeys("3381"));
      expect(keys.has("coupon_template_issue.manage")).toBe(false);
    } finally { await fixture.close(); }
  });

  it("keeps all eight combination reads in three independent domains on both surfaces", () => {
    const routes = [
      ["activity/combinations/export", "combination_export.view"],
      ["activity/combination-groups/head", "combination_group.view"],
      ["activity/combination-groups", "combination_group.view"],
      ["activity/combination-groups/37/members", "combination_group.view"],
      ["activity/combination-statistics/91/head", "combination_statistics.view"],
      ["activity/combination-statistics/91/groups", "combination_statistics.view"],
      ["activity/combination-statistics/91/groups/37/members", "combination_statistics.view"],
      ["activity/combination-statistics/91/orders", "combination_statistics.view"],
    ];
    for (const prefix of ["/adminapi", "/api/admin"]) for (const [route, key] of routes) {
      expect(requiredAdminPermission("GET", `${prefix}/${route}`)).toBe(key);
      expect(requiredAdminPermission("HEAD", `${prefix}/${route}`)).toBe(key);
    }
  });

  it("does not make combination management imply independent export or statistics grants", () => {
    expect(normalizeRoleRules("combination.manage,activity.manage")).toBe("combination.view,combination.manage,activity.view,activity.manage");
    for (const permission of ["combination_export.view", "combination_group.view", "combination_statistics.view"]) {
      expect(() => assertDelegablePermissions(new Set(["combination.manage", "combination.view", "activity.manage", "activity.view"]), [permission]))
        .toThrow("不能授予超出当前管理员范围");
    }
    for (const key of ["combination_export", "combination_group", "combination_statistics"])
      expect(() => normalizeRoleRules(`${key}.manage`)).toThrow("未知权限规则");
  });

  it("keeps a legacy catalog menu fallback from silently granting the new export capability", async () => {
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values({ id: 2386, type: 1, authType: 2, access: 1,
        apiUrl: "", uniqueAuth: "legacy-combination-catalog", menuPath: "/activity/combinations" });
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      expect(await service.resolveRulePermissionKeys("2386")).toEqual(["combination.view"]);
      expect(await service.resolveManyRulePermissionKeys(["2386", "combination_export.view"]))
        .toEqual([["combination.view"], ["combination_export.view"]]);
      expect(service.buildMenus(new Set(["combination_export.view"]))).toEqual([
        expect.objectContaining({ path: "/activity/combinations", name: "拼团商品导出" }),
      ]);
    } finally { await fixture.close(); }
  });

  it("normalizes role rules and makes manage imply view", () => {
    expect(normalizeRoleRules("division.manage,42,division.manage")).toBe("division.view,division.manage,42");
    expect(() => normalizeRoleRules("division.root")).toThrow("未知权限规则");
  });

  it("prevents restricted administrators from delegating permissions they do not hold", () => {
    const granted = new Set(["dashboard.view", "division.view", "division.manage"]);
    expect(() => assertDelegablePermissions(granted, ["division.view", "division.manage"])).not.toThrow();
    expect(() => assertDelegablePermissions(granted, ["system.manage"])).toThrow("不能授予超出当前管理员范围");
  });

  it("publishes a unique view permission for every menu group", () => {
    const keys = ADMIN_PERMISSION_GROUPS.map((group) => group.key);
    expect(new Set(keys).size).toBe(keys.length);
    const routes = [
      ...registeredAdminRoutes("src/routes/adminapi.ts", "adminapiRoutes", "/adminapi"),
      ...registeredAdminRoutes("src/routes/v1/index.ts", "v1Routes", "/api"),
      { method: "GET", path: "/api/ws/kefu" },
    ];
    // Literal witnesses come from registered routes, not matches[0] + list.
    // Coupon publication intentionally has only a POST management producer.
    const witnesses: Record<string, { method: string; path: string }> = {
      "dashboard": { method: "GET", path: "/adminapi/home/header" },
      "outbox": { method: "GET", path: "/adminapi/order/outbox" },
      "legacy_runtime": { method: "GET", path: "/adminapi/system/timer/task" },
      "enterprise_wechat": { method: "GET", path: "/adminapi/work/summary" },
      "live_broadcast": { method: "GET", path: "/adminapi/live/room/list" },
      "external_api": { method: "GET", path: "/adminapi/system_out/index" },
      "product": { method: "GET", path: "/adminapi/product/list" },
      "category": { method: "GET", path: "/adminapi/product/category" },
      "brand": { method: "GET", path: "/adminapi/product/brand" },
      "store": { method: "GET", path: "/adminapi/merchant/store/author/catalog" },
      "writeoff_order": { method: "GET", path: "/adminapi/merchant/verify_order" },
      "invoice": { method: "GET", path: "/adminapi/order/invoices" },
      "recharge_order": { method: "GET", path: "/adminapi/finance/recharge-orders" },
      "commission": { method: "GET", path: "/adminapi/finance/commissions" },
      "order": { method: "GET", path: "/adminapi/order/chart" },
      "refund": { method: "GET", path: "/adminapi/refund/list" },
      "user": { method: "GET", path: "/adminapi/user/list" },
      "paid_membership": { method: "GET", path: "/adminapi/member_batch/index" },
      "level": { method: "GET", path: "/adminapi/level/list" },
      "coupon": { method: "GET", path: "/adminapi/coupon/list" },
      "coupon_template": { method: "GET", path: "/adminapi/marketing/coupon-templates" },
      "coupon_template_issue": { method: "POST", path: "/adminapi/marketing/coupon-template-issues" },
      "coupon_record": { method: "GET", path: "/adminapi/marketing/coupon-records/list" },
      "seckill_statistics": { method: "GET", path: "/adminapi/activity/seckill-statistics/:id/head" },
      "seckill_time": { method: "GET", path: "/adminapi/activity/seckill-times" },
      "seckill_activity": { method: "GET", path: "/adminapi/activity/seckill-activities" },
      "bargain_record": { method: "GET", path: "/adminapi/activity/bargain-records" },
      "bargain_statistics": { method: "GET", path: "/adminapi/activity/bargain-statistics/:id/head" },
      "combination_export": { method: "GET", path: "/adminapi/activity/combinations/export" },
      "combination_group": { method: "GET", path: "/adminapi/activity/combination-groups/head" },
      "combination_statistics": { method: "GET", path: "/adminapi/activity/combination-statistics/:id/head" },
      "combination": { method: "GET", path: "/adminapi/activity/combinations" },
      "integral_category": { method: "GET", path: "/adminapi/marketing/integral-categories" },
      "integral_batch": { method: "GET", path: "/adminapi/activity/integral-batch/products" },
      "recharge_quota": { method: "GET", path: "/adminapi/marketing/recharge-quotas" },
      "sign_day_config": { method: "GET", path: "/adminapi/marketing/sign-day-config" },
      "activity_frame": { method: "GET", path: "/adminapi/marketing/activity-frame/products" },
      "activity_background": { method: "GET", path: "/adminapi/marketing/activity-background/products" },
      "time_discount": { method: "GET", path: "/adminapi/marketing/time-discounts/products" },
      "full_discount": { method: "GET", path: "/adminapi/marketing/full-discounts/products" },
      "nth_discount": { method: "GET", path: "/adminapi/marketing/nth-discounts/products" },
      "full_gift": { method: "GET", path: "/adminapi/marketing/full-gifts/products" },
      "activity": { method: "GET", path: "/adminapi/activity/seckill" },
      "feedback": { method: "GET", path: "/adminapi/feedback" },
      "speechcraft": { method: "GET", path: "/adminapi/wechat/speechcraft" },
      "service": { method: "GET", path: "/adminapi/service/sessions" },
      "reply": { method: "GET", path: "/adminapi/product/reply" },
      "community": { method: "GET", path: "/adminapi/community/settings" },
      "attachment": { method: "GET", path: "/adminapi/file/file" },
      "shipping_settings": { method: "GET", path: "/adminapi/config/shipping" },
      "city_delivery_settings": { method: "GET", path: "/adminapi/config/city-delivery" },
      "city_delivery_record": { method: "GET", path: "/adminapi/city_delivery/records" },
      "pc_home_banner": { method: "GET", path: "/adminapi/setting/pc-banners" },
      "operational_group": { method: "GET", path: "/adminapi/setting/group_data/header" },
      "erp.connection": { method: "GET", path: "/adminapi/erp/connections" },
      "fab_settings": { method: "GET", path: "/adminapi/setting/fab" },
      "theme_settings": { method: "GET", path: "/adminapi/setting/theme-style" },
      "product_category_style": { method: "GET", path: "/adminapi/config/product-category-style" },
      "product_detail_design": { method: "GET", path: "/adminapi/config/product-detail-design" },
      "user_center_design": { method: "GET", path: "/adminapi/config/user-center-design" },
      "config": { method: "GET", path: "/adminapi/config/user/register/products" },
      "print": { method: "GET", path: "/adminapi/print/list" },
      "waybill": { method: "GET", path: "/adminapi/waybill/jobs" },
      "supplier_application": { method: "GET", path: "/adminapi/supplier/apply/list" },
      "supplier_menu_rules": { method: "GET", path: "/adminapi/supplier/menu-rules" },
      "supplier_directory": { method: "GET", path: "/adminapi/supplier/supplier" },
      "supplier_order_statistics": { method: "GET", path: "/adminapi/supplier/order-statistics-screen/suppliers" },
      "supplier_capital": { method: "GET", path: "/adminapi/supplier/capital-screen/suppliers" },
      "supplier_bill": { method: "GET", path: "/adminapi/supplier/bill-screen/suppliers" },
      "system": { method: "GET", path: "/adminapi/system_admin/list" },
      "system_menu_rules": { method: "GET", path: "/adminapi/system/menu-rules/catalog" },
      "extract": { method: "GET", path: "/adminapi/extract/notifications/socket" },
      "supplier_extract": { method: "GET", path: "/adminapi/supplier/extract/suppliers" },
      "bill": { method: "GET", path: "/adminapi/bill/list" },
      "integral_log": { method: "GET", path: "/adminapi/marketing/user-point/logs" },
      "point_statistic": { method: "GET", path: "/adminapi/marketing/point/get_basic" },
      "capital_flow": { method: "GET", path: "/adminapi/flow/get_list" },
      "shipping": { method: "GET", path: "/adminapi/shipping_template/list" },
      "express": { method: "GET", path: "/adminapi/express/list" },
      "statistic": { method: "GET", path: "/adminapi/statistic/overview" },
      "label": { method: "GET", path: "/adminapi/product/label_cate" },
      "article": { method: "GET", path: "/adminapi/article/list" },
      "wechat_member_card": { method: "GET", path: "/adminapi/wechat/card" },
      "pc_base": { method: "GET", path: "/adminapi/config/pc" },
      "wechat_open": { method: "GET", path: "/adminapi/wechat/open" },
      "wechat_app": { method: "GET", path: "/adminapi/wechat/app" },
      "wechat_routine": { method: "GET", path: "/adminapi/wechat/routine" },
      "wechat_base": { method: "GET", path: "/adminapi/wechat/base" },
      "wechat_menu": { method: "GET", path: "/adminapi/wechat/menu" },
      "wechat_content": { method: "GET", path: "/adminapi/wechat/reply" },
      "wechat_qrcode": { method: "GET", path: "/adminapi/wechat_qrcode/cate/list" },
      "dise": { method: "GET", path: "/adminapi/dise/list" },
      "lottery_record": { method: "GET", path: "/adminapi/lottery/record/list" },
      "lottery": { method: "GET", path: "/adminapi/lottery/list" },
      "log": { method: "GET", path: "/adminapi/log/list" },
      "agent_level": { method: "GET", path: "/adminapi/agent/levels" },
      "agent_level_task": { method: "GET", path: "/adminapi/agent/level-tasks" },
      "distribution": { method: "GET", path: "/adminapi/spread/list" },
      "agent_agreement": { method: "GET", path: "/adminapi/agent/get_agent_agreement" },
      "division_statistics": { method: "GET", path: "/adminapi/agent/division/statistics-screen/summary" },
      "division": { method: "GET", path: "/adminapi/agent/division/list" },
      "notification": { method: "GET", path: "/adminapi/notification/list" },
    };
    expect(Object.keys(witnesses).sort()).toEqual([...keys].sort());
    for (const group of ADMIN_PERMISSION_GROUPS) {
      const witness = witnesses[group.key];
      expect(witness, group.key).toBeDefined();
      if (!witness) throw Error(`Missing registered permission witness: ${group.key}`);
      expect(routes, group.key).toContainEqual(witness);
      if (group.key === "coupon_template_issue") {
        expect(witness.method).toBe("POST");
        expect(requiredAdminPermission(witness.method, witness.path)).toBe("coupon_template_issue.manage");
        expect(routes).not.toContainEqual({ method: "GET", path: witness.path });
        expect(routes.filter(route => route.method === "GET"
          && requiredAdminPermission(route.method, route.path) === "coupon_template_issue.view")).toEqual([]);
      } else {
        expect(witness.method, group.key).toBe("GET");
        expect(requiredAdminPermission(witness.method, witness.path), group.key).toBe(`${group.key}.view`);
      }
    }
    for (const prefix of ["/adminapi", "/api/admin"]) {
      expect(requiredAdminPermission("POST", `${prefix}/wechat/menu/operations/123/resolve-missing`)).toBe("wechat_menu.manage");
      expect(requiredAdminPermission("GET", `${prefix}/wechat/menu/operations/123/resolve-missing`)).toBeNull();
      expect(requiredAdminPermission("GET", `${prefix}/system/menu-rules`)).toBeNull();
      expect(routes).not.toContainEqual({ method: "GET", path: `${prefix}/system/menu-rules` });
    }
  });
});
