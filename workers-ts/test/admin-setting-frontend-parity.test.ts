import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { createRequire } from 'node:module';
import ts from "typescript";
import { describe, expect, it } from "vitest";
const { parse: parseThemeSfc } = createRequire(import.meta.url)('../../view/admin-ts/node_modules/@vue/compiler-sfc') as typeof import('../../view/admin-ts/node_modules/@vue/compiler-sfc');

interface InventoryRoute {
  path: string;
  surface: string;
}

interface ReportRoute {
  legacy: { path: string };
  status: "candidate" | "partial" | "missing" | "retired" | "unreviewed";
  targetScreens: string[];
  targetApis: string[];
  covered: string[];
  remaining: string[];
  evidence: string[];
}

interface Report {
  methodology: { productionAccess: string; reviewBasis: string };
  summary: Record<string, number>;
  routes: ReportRoute[];
}

function source(file: string): string {
  return readFileSync(file, "utf8");
}

// Execute only the pure gates. Importing this standalone historical CLI
// would run its report writer, so product modules and the generator stay idle.
function themeAuditGates() {
  const code = source("scripts/admin-setting-frontend-parity-audit.ts");
  const tree = ts.createSourceFile("audit.ts", code, ts.ScriptTarget.Latest, true);
  const names = new Set(["classifyThemeStyleCoverage", "hasLegacyThemePresets", "hasRegisteredThemeHost"]);
  const functions = tree.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && statement.name && names.has(statement.name.text));
  expect(functions).toHaveLength(3);
  const output = ts.transpileModule(functions.map(statement => statement.getText(tree)).join("\n"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const scope = { exports: {}, ts, parseThemeSfc };
  runInNewContext(output, scope, { timeout: 1000 });
  return scope.exports as {
    classifyThemeStyleCoverage: (coverage: Record<string, boolean | number>) => ReportRoute["status"];
    hasLegacyThemePresets: (code: string) => boolean;
    hasRegisteredThemeHost: (page: string, merchantShell: string, deliveryShell?: string) => boolean;
  };
}

/** Historical JSON remains immutable. The current generator must preserve
 * every other field while proving the exact current registry's whole host
 * chain and emitting that current count, including the reviewed wrapper. */
function expectCurrentThemeHostIncrement(generated: string, historical: string) {
  const expected = JSON.parse(historical) as Report & { themeStyleContract: { coverage: Record<string, boolean | number> } };
  const registry = JSON.parse(source('../view/uniapp-ts/src/pages.json')) as { pages: {path: string}[]; subPackages?: {root: string; pages: {path: string}[]}[] };
  const paths = [...registry.pages.map(row => row.path), ...(registry.subPackages ?? []).flatMap(group => group.pages.map(row => `${group.root}/${row.path}`))];
  expect(new Set(paths).size).toBe(paths.length);
  const host = themeAuditGates().hasRegisteredThemeHost, shell = source('../view/uniapp-ts/src/components/merchantOrders/MerchantShell.vue'), deliveryShell = source('../view/uniapp-ts/src/components/deliveryWorkbench/DeliveryShell.vue');
  expect(paths.filter(path => !host(source(`../view/uniapp-ts/src/${path}.vue`), shell, deliveryShell))).toEqual([]);
  expected.themeStyleContract.coverage.registeredPages = paths.length;
  expected.themeStyleContract.coverage.themedPages = paths.length;
  expected.methodology.productionAccess = expected.methodology.productionAccess.replace(/all \d+ registered Uniapp page hosts/, `all ${paths.length} registered Uniapp page hosts`);
  const theme = expected.routes.find(row => row.legacy.path === '/admin/setting/theme_style');
  expect(theme).toBeDefined();
  theme!.targetScreens = theme!.targetScreens.map(screen => screen.replace(/Uniapp实际\d+页/, `Uniapp实际${paths.length}页`));
  theme!.covered = theme!.covered.map(text => text.replace(/实际\d+\/\d+注册页/, `实际${paths.length}/${paths.length}注册页`));
  const wrapper = 'view/uniapp-ts/src/components/merchantOrders/MerchantShell.vue';
  expect(theme!.evidence).not.toContain(wrapper);
  theme!.evidence.splice(theme!.evidence.indexOf('view/uniapp-ts/src/stores/theme.ts'), 0, wrapper);
  const deliveryWrapper = 'view/uniapp-ts/src/components/deliveryWorkbench/DeliveryShell.vue';
  expect(theme!.evidence).not.toContain(deliveryWrapper);
  theme!.evidence.splice(theme!.evidence.indexOf('view/uniapp-ts/src/stores/theme.ts'), 0, deliveryWrapper);
  expect(generated).toBe(`${JSON.stringify(expected, null, 2)}\n`);
}

function cityDeliveryAuditGates() {
  const code = source("scripts/admin-setting-frontend-parity-audit.ts");
  const tree = ts.createSourceFile("audit.ts", code, ts.ScriptTarget.Latest, true);
  const names = new Set(["classifyCityDeliverySettingsCoverage", "hasCityDeliveryTenKeys", "hasCityDeliveryMetadataOnlyDtos", "inspectCityDeliverySettingsCoverage"]);
  const functions = tree.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && statement.name && names.has(statement.name.text));
  expect(functions).toHaveLength(4);
  const output = ts.transpileModule(functions.map(statement => statement.getText(tree)).join("\n"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const scope = { exports: {} };
  runInNewContext(output, scope, { timeout: 1000 });
  return scope.exports as {
    classifyCityDeliverySettingsCoverage: (coverage: Record<string, boolean>) => ReportRoute["status"];
    hasCityDeliveryTenKeys: (code: string) => boolean;
    hasCityDeliveryMetadataOnlyDtos: (code: string) => boolean;
    inspectCityDeliverySettingsCoverage: (screens: string[], sources: Record<string, string>) => Record<string, boolean>;
  };
}

function cityDeliveryAuditSources(): Record<string, string> {
  const files = {
    contract: "../view/common/cityDeliverySettings.ts", page: "../view/admin-ts/src/pages/setting/CityDeliverySettings.vue",
    controller: "../view/admin-ts/src/pages/setting/cityDeliverySettingsController.ts", api: "../view/admin-ts/src/api/cityDeliverySettings.ts",
    input: "src/services/admin/AdminCityDeliverySettingsInput.ts", service: "src/services/admin/AdminCityDeliverySettingsService.ts",
    codec: "src/services/delivery/CityDeliverySecretCodec.ts", resolver: "src/services/delivery/CityDeliverySettingsResolver.ts",
    dada: "src/services/delivery/DadaCityDeliveryProvider.ts", uu: "src/services/delivery/UuCityDeliveryProvider.ts",
    callback: "src/services/delivery/CityDeliveryCallbackService.ts", picker: "src/services/store/StoreMobileOrderService.ts",
    permission: "src/services/admin/AdminPermissionService.ts", batch: "src/services/system/AdminConfigBatchService.ts",
    log: "src/services/admin/AdminSystemLogReadService.ts", config: "src/services/system/SystemConfigService.ts",
    crud: "src/controllers/api/v1/AdminCrudController.ts", routes: "src/routes/adminapi.ts", v1Routes: "src/routes/v1/index.ts",
  };
  return Object.fromEntries(Object.entries(files).map(([role, file]) => [role, source(file)]));
}

describe("legacy Admin setting route parity audit", () => {
  const inventory = JSON.parse(source("audit/admin-frontend-inventory.json")) as {
    legacy: { routes: InventoryRoute[] };
  };
  const report = JSON.parse(source("audit/admin-legacy-setting-route-parity.json")) as Report;
  const expectedPaths = inventory.legacy.routes
    .filter((route) => route.surface === "page" && route.path.startsWith("/admin/setting"))
    .map((route) => route.path);

  it("keeps city settings missing or partial until all ten-key consumers and secret write protections exist", () => {
    const gate = cityDeliveryAuditGates().classifyCityDeliverySettingsCoverage;
    const complete = { adminScreen: true, tenKeys: true, conditionalFlags: true, secretIntents: true,
      encryptedStorage: true, commonResolver: true, providerQueries: true, callbackIdentity: true,
      pickerConsumer: true, permissions: true, genericWriteProtection: true, atomicConfirm: true,
      recovery: true, safeProjection: true };
    expect(gate(complete)).toBe("candidate");
    for (const key of Object.keys(complete)) expect(gate({ ...complete, [key]: false }), key).toBe("partial");
    const absent = Object.fromEntries(Object.keys(complete).map(key => [key, false]));
    expect(gate(absent)).toBe("missing");
    expect(gate({ ...absent, adminScreen: true })).toBe("partial");
    expect(gate({ ...absent, commonResolver: true })).toBe("partial");
    expect(gate({ ...complete, commonResolver: false, providerQueries: false, callbackIdentity: false })).toBe("partial");
  });

  it("requires the real ten-key inventory, including the historical Dada sercret spelling", () => {
    const gate = cityDeliveryAuditGates().hasCityDeliveryTenKeys;
    const actual = source("../view/common/cityDeliverySettings.ts");
    expect(gate(actual)).toBe(true);
    for (const key of ["city_delivery_status", "self_delivery_status", "dada_source_id", "uupt_open_id"])
      expect(gate(actual.replace(`'${key}'`, "'unrelated_key'")), key).toBe(false);
    expect(gate(actual.replace("'dada_app_sercret'", "'dada_app_secret'"))).toBe(false);
    expect(gate(actual.replace("'uupt_open_id']", "'uupt_open_id', 'uupt_open_id']"))).toBe(false);
    expect(gate(actual.replace("'uupt_open_id']", "'uupt_open_id', 'provider_callback_token']"))).toBe(false);
    expect(gate(actual.replace(/^export const CITY_DELIVERY_CREDENTIAL_KEYS.*$/m, line => `// ${line}`))).toBe(false);
    expect(gate("// " + actual.replace(/export const CITY_DELIVERY_(?:FLAG|CREDENTIAL)_KEYS/g, "const OTHER_KEYS"))).toBe(false);
  });

  it("rejects adding secret material to credential metadata or committed receipts", () => {
    const gate = cityDeliveryAuditGates().hasCityDeliveryMetadataOnlyDtos;
    const actual = source("../view/common/cityDeliverySettings.ts");
    expect(gate(actual)).toBe(true);
    expect(gate(actual.replace("export interface CityDeliveryCredentialState {", "export interface CityDeliveryCredentialState {\n  value: string;"))).toBe(false);
    expect(gate(actual.replace("export interface CityDeliverySettingsReceipt {", "export interface CityDeliverySettingsReceipt {\n  ciphertext: string;"))).toBe(false);
    expect(gate(actual.replace("credentials: Record<CityDeliveryCredentialKey, CityDeliveryCredentialState>", "credentials: Record<CityDeliveryCredentialKey, string>"))).toBe(false);
  });

  it("detects disconnected live consumers, weakened encryption, write bypasses and unsafe recovery in real source mutants", () => {
    const gates = cityDeliveryAuditGates(), actual = cityDeliveryAuditSources();
    const screens = ["/setting/city-delivery-settings"];
    const complete = gates.inspectCityDeliverySettingsCoverage(screens, actual);
    expect(Object.values(complete).every(Boolean), JSON.stringify(complete)).toBe(true);
    expect(gates.classifyCityDeliverySettingsCoverage(complete)).toBe("candidate");
    const mutations = [
      ["callback", "settings.dada()", "settings.legacyEnv()", "providerQueries"],
      ["callback", "await lockCityConfigForRead(tx)", "await lockLegacyConfigForRead(tx)", "callbackIdentity"],
      ["resolver", "pg_advisory_xact_lock_shared", "pg_advisory_xact_lock", "callbackIdentity"],
      ["callback", "outboxes[0].status !== 'COMPLETED'", "outboxes[0].status !== 'FAILED'", "callbackIdentity"],
      ["controller", "this.state.draft.flags[key] = value", "this.state.draft.flags[key] = value; this.forgetInputs()", "conditionalFlags"],
      ["codec", "'AES-GCM'", "'AES-CBC'", "encryptedStorage"],
      ["resolver", "credential_authority_shadowed", "fallback_to_env", "encryptedStorage"],
      ["batch", "isCityConfigKey", "unprotectedConfigKey", "genericWriteProtection"],
      ["crud", "Object.keys(body ?? {}).some(isCityConfigKey)", "Object.keys(body ?? {}).some(unprotectedConfigKey)", "genericWriteProtection"],
      ["log", "systemLog.type} NOT IN", "systemLog.type} IN", "genericWriteProtection"],
      ["service", "cityDeliveryReconciliationCase", "unfencedReconciliation", "atomicConfirm"],
      ["controller", "scope.valid", "scope.ignored", "recovery"],
      ["permission", "resolved.add('city_delivery_settings.view')", "resolved.add('config.view')", "permissions"],
    ];
    for (const [role, token, replacement, failedGate] of mutations) {
      expect(actual[role].includes(token), `${role}:${token}`).toBe(true);
      const coverage = gates.inspectCityDeliverySettingsCoverage(screens, { ...actual, [role]: actual[role].replaceAll(token, replacement) });
      expect(coverage[failedGate], failedGate).toBe(false);
      expect(gates.classifyCityDeliverySettingsCoverage(coverage), failedGate).toBe("partial");
    }
    expect(gates.inspectCityDeliverySettingsCoverage([...screens, ...screens], actual).adminScreen).toBe(false);
    const unsafeDto = actual.contract.replace("export interface CityDeliveryCredentialState {", "export interface CityDeliveryCredentialState {\n  value: string;");
    expect(gates.inspectCityDeliverySettingsCoverage(screens, { ...actual, contract: unsafeDto }).safeProjection).toBe(false);
  });

  it("reproduces only the full ten-key city-settings increment and preserves every prior dated conclusion", () => {
    const prior = JSON.parse(source("audit/admin-legacy-setting-route-parity-theme-style-followup-20261001.json")) as Report;
    const file = "audit/admin-legacy-setting-route-parity-city-delivery-settings-followup-20261002.json";
    const latest = JSON.parse(source(file)) as Report & { generatedFrom: string; cityDeliverySettingsContract: {
      status: string; coverage: Record<string, boolean>; gaps: string[] } };
    const generated = execFileSync(process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/admin-setting-frontend-parity-audit.ts", "--city-delivery-settings-followup"],
      { cwd: process.cwd(), encoding: "utf8" });
    expectCurrentThemeHostIncrement(generated, source(file));
    expect(latest.generatedFrom).toBe("audit/admin-frontend-inventory-city-delivery-settings-followup-20261002.json");
    expect(latest.cityDeliverySettingsContract.status).toBe("candidate");
    expect(latest.cityDeliverySettingsContract.gaps).toEqual([]);
    expect(Object.values(latest.cityDeliverySettingsContract.coverage).every(Boolean)).toBe(true);
    expect(latest.summary).toEqual({ ...prior.summary, candidate: prior.summary.candidate + 1, missing: prior.summary.missing - 1 });
    expect(latest.routes.map(row => row.legacy.path)).toEqual(prior.routes.map(row => row.legacy.path));
    for (let index = 0; index < latest.routes.length; index++) {
      const row = latest.routes[index];
      if (row.legacy.path !== "/admin/setting/city/delivery/setting") { expect(row).toEqual(prior.routes[index]); continue; }
      expect(row.status).toBe("candidate");
      expect(row.targetScreens).toEqual(["/setting/city-delivery-settings"]);
      expect(row.targetApis).toHaveLength(5);
      expect(row.covered.join(" ")).toContain("四开关与六凭据");
      expect(row.covered.join(" ")).toContain("keep/replace/clear");
      expect(row.covered.join(" ")).toContain("city_delivery_settings.view/manage");
      expect(row.remaining.join(" ")).toContain("取消/收费/未知外部提交");
      expect(row.remaining.join(" ")).toContain("event.client_id");
      expect(row.remaining.join(" ")).toContain("非合作写入者");
      expect(row.remaining.join(" ")).toContain("正式发布");
    }
    expect(latest.routes.find(row => row.legacy.path === "/admin/setting/city/delivery/record")?.status).toBe("partial");
    expect(latest.methodology.productionAccess).toContain("Local PostgreSQL/JWT");
    expect(latest.methodology.productionAccess).toContain("production key/role migration");
  });

  it("requires the actual six role values, including contrasting prices and dark pink/gold buttons", () => {
    const gate = themeAuditGates().hasLegacyThemePresets;
    const actual = source("../view/common/theme.ts");
    expect(gate(actual)).toBe(true);
    for (const value of ["#FD502F", "rgba(9, 139, 243, 0.1)", "#282828", "#FFCD8C"])
      expect(gate(actual.replace(value, "#e93323")), value).toBe(false);
    expect(gate(actual.replace("status: 6", "status: 5"))).toBe(false);
  });

  it("keeps a page-only replacement partial and requires every complete theme consumer and protection gate", () => {
    const gate = themeAuditGates().classifyThemeStyleCoverage;
    const complete: Record<string, boolean | number> = { adminScreen: true, sixPresetTokens: true,
      registeredPages: 96, themedPages: 96, consumerStyles: true, lifecycle: true, diy: true, commonRead: true,
      dedicatedWrite: true, permissions: true, genericWriteProtection: true, recovery: true };
    expect(gate(complete)).toBe("candidate");
    for (const key of Object.keys(complete).filter(key => key !== "adminScreen"))
      expect(gate({ ...complete, [key]: typeof complete[key] === "number" ? 95 : false }), key).toBe("partial");
    const absent = Object.fromEntries(Object.keys(complete).map(key => [key, typeof complete[key] === "number" ? 0 : false]));
    expect(gate(absent)).toBe("missing");
    expect(gate({ ...absent, adminScreen: true })).toBe("partial");
  });

  it("promotes only the complete six-colour screen while preserving the integral and prior setting conclusions", () => {
    const prior = JSON.parse(source("audit/admin-legacy-setting-route-parity-integral-detail-followup-20261001.json")) as Report;
    const file = "audit/admin-legacy-setting-route-parity-theme-style-followup-20261001.json";
    const latest = JSON.parse(source(file)) as Report & { generatedFrom: string; themeStyleContract: {
      status: string; coverage: Record<string, boolean | number>; gaps: string[] } };
    const generated = execFileSync(process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/admin-setting-frontend-parity-audit.ts", "--theme-style-followup"],
      { cwd: process.cwd(), encoding: "utf8" });
    expectCurrentThemeHostIncrement(generated, source(file));
    expect(latest.generatedFrom).toBe("audit/admin-frontend-inventory-theme-style-followup-20261001.json");
    expect(latest.themeStyleContract.status).toBe("candidate");
    expect(latest.themeStyleContract.gaps).toEqual([]);
    expect(latest.themeStyleContract.coverage).toMatchObject({ registeredPages: 96, themedPages: 96, sixPresetTokens: true, diy: true, genericWriteProtection: true });
    expect(latest.summary).toEqual({ ...prior.summary, candidate: prior.summary.candidate + 1, missing: prior.summary.missing - 1 });
    expect(latest.routes.map(row => row.legacy.path)).toEqual(prior.routes.map(row => row.legacy.path));
    for (let index = 0; index < latest.routes.length; index++) {
      const row = latest.routes[index];
      if (row.legacy.path !== "/admin/setting/theme_style") { expect(row).toEqual(prior.routes[index]); continue; }
      expect(row.status).toBe("candidate");
      expect(row.covered.join(" ")).toMatch(/六token/);
      expect(row.covered.join(" ")).toMatch(/96\/96/);
      expect(row.covered.join(" ")).toContain("toneConfig");
      expect(row.covered.join(" ")).toContain("theme_settings.view/manage");
      expect(row.remaining.join(" ")).toMatch(/生产.*真机.*正式发布/);
    }
    expect(latest.methodology.productionAccess).toContain("Local PostgreSQL/JWT");
    expect(latest.methodology.productionAccess).toContain("production role migration");
  });

  it("records the dedicated integral consumer as a reproducible FAB increment without closing its release boundary", () => {
    const prior = JSON.parse(source("audit/admin-legacy-setting-route-parity-fab-settings-followup-20261001.json")) as Report;
    const file = "audit/admin-legacy-setting-route-parity-integral-detail-followup-20261001.json";
    const latest = JSON.parse(source(file)) as Report;
    const generated = execFileSync(process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/admin-setting-frontend-parity-audit.ts", "--integral-detail-followup"],
      { cwd: process.cwd(), encoding: "utf8" });
    expect(generated).toBe(source(file));
    expect(latest.summary).toEqual(prior.summary);
    expect(latest.routes.map(row => row.legacy.path)).toEqual(prior.routes.map(row => row.legacy.path));
    for (let index = 0; index < latest.routes.length; index++) {
      const row = latest.routes[index];
      if (row.legacy.path === "/admin/setting/pages/fab") {
        expect(row.status).toBe("partial");
        expect(row.covered.join(" ")).toContain("type4");
        expect(row.evidence.join(" ")).toContain("integralDetail.vue");
        expect(row.remaining.join(" ")).toMatch(/生产|真机|发布/);
      } else expect(row).toEqual(prior.routes[index]);
    }
  });

  it("records the city delivery read foundation as partial without closing provider cancellation", () => {
    const prior = JSON.parse(source("audit/admin-legacy-setting-route-parity-shipping-settings-followup-20261001.json")) as Report;
    const file = "audit/admin-legacy-setting-route-parity-city-delivery-records-followup-20261001.json";
    const latest = JSON.parse(source(file)) as Report & { generatedFrom: string };
    const generated = execFileSync(process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/admin-setting-frontend-parity-audit.ts", "--city-delivery-records-followup"],
      { cwd: process.cwd(), encoding: "utf8" });
    expect(generated).toBe(source(file));
    expect(latest.generatedFrom).toBe("audit/admin-frontend-inventory-city-delivery-records-followup-20261001.json");
    expect(latest.summary).toMatchObject({ legacyRoutes: 76, reviewed: 76, candidate: 20, partial: 24, missing: 27, retired: 5, unreviewed: 0 });
    expect(latest.routes.map(route => route.legacy.path)).toEqual(prior.routes.map(route => route.legacy.path));
    const changed = latest.routes.filter((route, index) => route.status !== prior.routes[index].status);
    expect(changed.map(route => route.legacy.path)).toEqual(["/admin/setting/city/delivery/record"]);
    expect(changed[0].status).toBe("partial");
    expect(changed[0].targetScreens).toEqual(["/setting/city-delivery-records"]);
    expect(changed[0].targetApis).toEqual(["GET /adminapi/city_delivery/records", "GET /adminapi/city_delivery/records/:id", "GET /adminapi/city_delivery/stores"]);
    expect(changed[0].covered.join(" ")).toContain("city_delivery_record.view");
    expect(changed[0].remaining.join(" ")).toMatch(/取消费用证据.*未知外部提交恢复.*原订单恢复/);
    expect(latest.routes.find(route => route.legacy.path === "/admin/setting/city/delivery/setting")?.status).toBe("missing");
    expect(latest.routes.find(route => route.legacy.path === "/admin/setting/distribution/deliver")?.status).toBe("candidate");
    expect(latest.methodology.productionAccess).toContain("No production Hyperdrive");
  });

  it("promotes exactly the complete shipping settings screen in a dated reproducible follow-up", () => {
    const prior = JSON.parse(source("audit/admin-legacy-setting-route-parity-speechcraft-followup-20260928.json")) as Report;
    const file = "audit/admin-legacy-setting-route-parity-shipping-settings-followup-20261001.json";
    const latest = JSON.parse(source(file)) as Report;
    const generated = execFileSync(process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/admin-setting-frontend-parity-audit.ts", "--shipping-settings-followup"],
      { cwd: process.cwd(), encoding: "utf8" });
    expect(generated).toBe(source(file));
    expect(latest.summary).toMatchObject({ legacyRoutes: 76, reviewed: 76, candidate: 20, partial: 23, missing: 28, retired: 5, unreviewed: 0 });
    const changed = latest.routes.filter((route, index) => route.status !== prior.routes[index].status);
    expect(changed.map(route => route.legacy.path)).toEqual(["/admin/setting/distribution/deliver"]);
    expect(changed[0].targetScreens).toEqual(["/setting/shipping"]);
    expect(changed[0].covered.join(" ")).toContain("shipping_settings.view/manage");
    expect(latest.routes.find(route => route.legacy.path === "/admin/setting/system_config")?.status).toBe("partial");
  });
  it("keeps every one of the 76 authoritative legacy setting routes in order", () => {
    expect(expectedPaths).toHaveLength(76);
    expect(report.routes.map((route) => route.legacy.path)).toEqual(expectedPaths);
    expect(report.summary).toMatchObject({
      legacyRoutes: 76,
      reviewed: 76,
      candidate: 17,
      partial: 24,
      missing: 30,
      retired: 5,
      unreviewed: 0,
    });
    expect(report.methodology.reviewBasis).toMatch(/code-only audit/);
    expect(report.methodology.productionAccess).toMatch(/READ ONLY transaction/);
    expect(report.methodology.productionAccess).toMatch(/no payment DDL\/DML ran/i);
    expect(report.methodology.productionAccess).toMatch(/idempotent second pass/);
    expect(report.methodology.productionAccess).toMatch(/no main Worker or frontend was deployed/i);
  });

  it("retains the first 15 print, notification, and commerce conclusions", () => {
    const status = Object.fromEntries(report.routes.map((route) => [route.legacy.path, route.status]));
    expect(status).toMatchObject({
      "/admin/setting/document": "candidate",
      "/admin/setting/document/config": "retired",
      "/admin/setting/document/content": "candidate",
      "/admin/setting/notification/index": "partial",
      "/admin/setting/notification/notificationEdit": "partial",
      "/admin/setting/system/create": "candidate",
      "/admin/setting/system_config": "partial",
      "/admin/setting/shop/base": "candidate",
      "/admin/setting/shop/product": "candidate",
      "/admin/setting/shop/trade": "candidate",
      "/admin/setting/shop/pay": "candidate",
      "/admin/setting/shop/agreemant": "candidate",
      "/admin/setting/shop/division": "candidate",
      "/admin/setting/system_form": "candidate",
      "/admin/setting/system_form/data": "candidate",
    });
    const retiredPrintConfig = report.routes.find((route) => route.legacy.path === "/admin/setting/document/config");
    expect(retiredPrintConfig?.evidence).toContain("cinashop-php/view/admin/src/pages/setting/document/config.vue:82");
    expect(retiredPrintConfig?.evidence).toContain("cinashop-php/view/admin/src/pages/setting/document/config.vue:192");
    expect(retiredPrintConfig?.evidence).toContain("cinashop-php/view/admin/src/pages/setting/document/config.vue:202");
    expect(retiredPrintConfig?.evidence).toContain("cinashop-php/view/admin/src/pages/setting/document/config.vue:215");
  });

  it("classifies all 61 newly reviewed routes with route-specific evidence", () => {
    const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
    expect(report.routes).toHaveLength(76);
    for (const route of report.routes) {
      expect(route.status).not.toBe("unreviewed");
      expect(route.evidence.length, route.legacy.path).toBeGreaterThan(0);
      expect(route.covered.length + route.remaining.length, route.legacy.path).toBeGreaterThan(0);
      if (route.status === "candidate") expect(route.targetScreens.length, route.legacy.path).toBeGreaterThan(0);
      if (route.status === "retired") expect(route.remaining).toEqual([]);
    }

    const groupData = report.routes.filter((route) =>
      route.legacy.path.startsWith("/admin/setting/system_group_data")
      && route.legacy.path !== "/admin/setting/system_group_data/kf_adv");
    expect(groupData).toHaveLength(17);
    expect(groupData.every((route) => route.status === "missing")).toBe(true);
    expect(byPath.get("/admin/setting/system_group_data/kf_adv")?.status).toBe("candidate");

    for (const path of [
      "/admin/setting/freight/shipping_templates/list",
      "/admin/setting/merchant/system_store/list",
      "/admin/setting/merchant/system_store_staff/index",
      "/admin/setting/delivery_service/index",
      "/admin/setting/userAgreement/index",
    ]) expect(byPath.get(path)?.status).toBe("candidate");

    for (const path of [
      "/admin/setting/platform/list/index",
      "/admin/setting/platform/order/index",
      "/admin/setting/platform/bill/index",
      "/admin/setting/platform/setting/index",
    ]) expect(byPath.get(path)?.status).toBe("retired");
    expect(byPath.get("/admin/setting/platform/index")?.status).toBe("partial");
    expect(byPath.get("/admin/setting/membership_level/index")?.status).toBe("missing");
    expect(byPath.get("/admin/setting/system_menus/index")?.status).toBe("missing");
    expect(byPath.get("/admin/setting/merchant/system_store/index")?.status).toBe("partial");
    expect(byPath.get("/admin/setting/freight/express/index")?.status).toBe("partial");
    expect(byPath.get("/admin/setting/system_visualization_data")?.status).toBe("partial");
    expect(byPath.get("/admin/setting/storage")?.status).toBe("partial");
    expect(byPath.get("/admin/setting/pages/fab")?.status).toBe("partial");
    expect(byPath.get("/admin/setting/city/delivery/setting")?.status).toBe("missing");
    expect(byPath.get("/admin/setting/city/delivery/record")?.status).toBe("missing");
  });

  it("keeps the generated ledger byte-for-byte aligned with the review source", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-setting-frontend-parity-audit.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-setting-route-parity.json"));
  });

  it("keeps the writeoff follow-up dated, byte reproducible, and limited to one of 274 screens", () => {
    const file = "audit/admin-legacy-setting-route-parity-writeoff-followup-20260928.json";
    const followup = JSON.parse(source(file)) as Report & { generatedFrom: string };
    const generated = execFileSync(process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/admin-setting-frontend-parity-audit.ts", "--writeoff-followup"],
      { cwd: process.cwd(), encoding: "utf8" });
    expect(generated).toBe(source(file));
    expect(followup.generatedFrom).toBe("audit/admin-frontend-inventory-writeoff-followup-20260928.json");
    expect(followup.summary).toMatchObject({ legacyRoutes: 76, reviewed: 76,
      candidate: 17, partial: 25, missing: 29, retired: 5, unreviewed: 0 });
    const path = "/admin/setting/merchant/system_verify_order/index";
    expect(followup.routes.map(route => route.legacy.path)).toEqual(report.routes.map(route => route.legacy.path));
    for (let index = 0; index < report.routes.length; index++) {
      const original = report.routes[index], latest = followup.routes[index];
      if (original.legacy.path === path) {
        expect(original.status).toBe("missing");
        expect(latest.status).toBe("partial");
        expect(latest.targetScreens).toEqual(["/operations/writeoff-orders"]);
        expect(latest.targetApis).toContain("GET /adminapi/merchant/verify_order");
        expect(latest.remaining.join(" ")).toMatch(/card_id/);
        expect(latest.remaining.join(" ")).toMatch(/排他上界/);
      } else expect(latest).toEqual(original);
    }

    const names = ["content", "product", "setting", "marketing", "work", "app", "system", "kefu",
      "cross-module", "user-order", "supplier-agent"] as const;
    const replacements: Record<string, string> = {
      setting: "admin-legacy-setting-route-parity-writeoff-followup-20260928.json",
      system: "admin-legacy-system-route-parity-read-followup-20260928.json",
      "cross-module": "admin-legacy-cross-module-route-parity-commission-followup-20260928.json",
      "user-order": "admin-legacy-user-order-route-parity-invoice-followup-20260928.json",
    };
    const statuses = new Map<string, string>();
    for (const name of names) {
      const snapshot = replacements[name] ?? `admin-legacy-${name}-route-parity.json`;
      const ledger = JSON.parse(source(`audit/${snapshot}`)) as { routes: Array<{
        legacyPath?: string; legacy?: { path: string }; status: string }> };
      for (const route of ledger.routes) {
        const key = route.legacyPath ?? route.legacy?.path;
        expect(key, name).toBeTruthy();
        expect(statuses.has(key!), key).toBe(false);
        statuses.set(key!, route.status);
      }
    }
    const datedInventory = JSON.parse(source("audit/admin-frontend-inventory-writeoff-followup-20260928.json")) as {
      legacy: { routes: InventoryRoute[] };
      target: { routes: InventoryRoute[] };
    };
    const authority = datedInventory.legacy.routes.filter(route => route.surface === "page").map(route => route.path);
    expect(authority).toHaveLength(274);
    expect([...statuses.keys()].sort()).toEqual(authority.sort());
    expect(datedInventory.target.routes.filter(route => route.surface === "page" &&
      route.path === "/operations/writeoff-orders")).toHaveLength(1);
    expect(Object.fromEntries(["candidate", "partial", "missing", "retired"]
      .map(status => [status, [...statuses.values()].filter(value => value === status).length])))
      .toEqual({ candidate: 59, partial: 117, missing: 91, retired: 7 });
  });

  it("closes the three system-form screens with a bounded editor and data viewer", () => {
    const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
    for (const path of [
      "/admin/setting/system/create",
      "/admin/setting/system_form",
      "/admin/setting/system_form/data",
    ]) {
      expect(byPath.get(path)?.status).toBe("candidate");
      expect(byPath.get(path)?.targetScreens.join(" ")).toContain("/config/forms");
    }
    expect(byPath.get("/admin/setting/system/create")?.covered.join(" ")).toContain("10类受控组件");
    expect(byPath.get("/admin/setting/system_form")?.covered.join(" ")).toContain("停用和删除前检查");
    expect(byPath.get("/admin/setting/system_form/data")?.covered.join(" ")).toContain("公式注入");
  });

  it("records the second core-settings batch with explicit safe targets and remaining gaps", () => {
    const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
    const systemForm = byPath.get("/admin/setting/system/create")!;
    const generic = byPath.get("/admin/setting/system_config")!;
    const basic = byPath.get("/admin/setting/shop/base")!;
    const product = byPath.get("/admin/setting/shop/product")!;
    const trade = byPath.get("/admin/setting/shop/trade")!;
    const payment = byPath.get("/admin/setting/shop/pay")!;
    const agreement = byPath.get("/admin/setting/shop/agreemant")!;
    const division = byPath.get("/admin/setting/shop/division")!;

    expect(systemForm.targetScreens.join(" ")).toContain("/config/forms");
    expect(generic.targetScreens).toContain("/config/commerce");
    expect(generic.remaining.join(" ")).toContain("任意键编辑器");
    expect(basic.covered.join(" ")).toContain("HTTPS");
    expect(basic.covered.join(" ")).toContain("Durable Object");
    expect(basic.covered.join(" ")).toContain("UniApp首页分享钩子");
    expect(basic.remaining.join(" ")).toContain("生产历史素材");
    expect(product.covered.join(" ")).toContain("is_police");
    expect(trade.status).toBe("candidate");
    expect(trade.covered.join(" ")).toContain("is_advent_sms");
    expect(trade.covered.join(" ")).toContain("平台顺序");
    expect(trade.remaining.join(" ")).toContain("生产当前无次卡行");
    expect(trade.remaining.join(" ")).toContain("真实短信");
    expect(payment.status).toBe("candidate");
    expect(payment.covered.join(" ")).toContain("实际可用状态");
    expect(payment.covered.join(" ")).toContain("商户API证书序列号");
    expect(payment.covered.join(" ")).toContain("共享一套APIv3商户凭据");
    expect(payment.covered.join(" ")).toContain("旧独立小程序商户号分支明确退休");
    expect(payment.remaining.join(" ")).toContain("全部微信部署Secret当前均未配置");
    expect(agreement.covered.join(" ")).toContain("五类协议");
    expect(division.covered.join(" ")).toContain("两个旧开关");
  });

  it("backs the print candidate with bounded writes, audit logs, legacy aliases, and UI parity", () => {
    const controller = source("src/controllers/system/PrintDocumentController.ts");
    const service = source("src/services/system/PrintDocumentManagementService.ts");
    const adminRoutes = source("src/routes/adminapi.ts");
    const supplierRoutes = source("src/routes/supplierapi.ts");
    const page = source("../view/admin-ts/src/pages/setting/PrintOperations.vue");
    const api = source("../view/admin-ts/src/api/printing.ts");

    expect(controller).toContain("readBoundedJsonObject(c.req.raw, MAX_PRINT_BODY_BYTES)");
    expect(controller).toContain('Cache-Control", "private, no-store');
    expect(service).toContain("SET LOCAL lock_timeout = '2s'");
    expect(service).toContain("SET LOCAL statement_timeout = '5s'");
    expect(service).toContain("tx.insert(systemLog)");
    expect(service).toContain("回读不一致");
    expect(adminRoutes).toContain('post("/print/set_status/:id/:status"');
    expect(adminRoutes).toContain('put("/print/set_status/:id/:status"');
    expect(supplierRoutes).toContain('post("/print/set_status/:id/:status"');
    expect(page).toContain("搜索打印机名称");
    expect(page).toContain('limit: 15');
    expect(page).toContain('aria-label="小票实时预览"');
    expect(page).toContain('maxlength="50"');
    expect(api).toContain("filtered.slice(start, start + limit)");
  });

  it("keeps notification parity partial until the old catalogs and enterprise channel are covered", () => {
    const page = source("../view/admin-ts/src/pages/setting/NotificationList.vue");
    const reviewed = report.routes.filter((route) => route.legacy.path.includes("/notification/"));
    expect(page).toContain("业务通知中心");
    expect(page).toContain("row.withdrawalId");
    expect(page).toContain("提现 #");
    expect(page).toContain("提供商模板");
    expect(reviewed).toHaveLength(2);
    expect(reviewed.every((route) => route.status === "partial")).toBe(true);
    expect(reviewed.flatMap((route) => route.remaining).join(" ")).toMatch(/type=1|会员消息目录/);
    expect(reviewed.flatMap((route) => route.remaining).join(" ")).toMatch(/type=2|平台消息目录/);
    expect(reviewed.flatMap((route) => route.remaining).join(" ")).toContain("企业微信");
    expect(reviewed.flatMap((route) => route.remaining).join(" ")).toContain("远端模板同步");
  });

  it("dates the feedback promotion on top of the writeoff follow-up without changing other screens", () => {
    const prior = JSON.parse(source("audit/admin-legacy-setting-route-parity-writeoff-followup-20260928.json")) as Report;
    const file = "audit/admin-legacy-setting-route-parity-feedback-followup-20260928.json";
    const latest = JSON.parse(source(file)) as Report & { generatedFrom: string };
    const generated = execFileSync(process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/admin-setting-frontend-parity-audit.ts", "--feedback-followup"],
      { cwd: process.cwd(), encoding: "utf8" });
    expect(generated).toBe(source(file));
    expect(latest.generatedFrom).toBe("audit/admin-frontend-inventory.json");
    expect(latest.summary).toMatchObject({ legacyRoutes: 76, reviewed: 76,
      candidate: 18, partial: 24, missing: 29, retired: 5, unreviewed: 0 });
    expect(latest.routes.map(route => route.legacy.path)).toEqual(prior.routes.map(route => route.legacy.path));
    const changed = latest.routes.filter((route, index) => route.status !== prior.routes[index].status);
    expect(changed.map(route => route.legacy.path)).toEqual(["/admin/setting/store_service/feedback"]);
    expect(changed[0].targetScreens).toEqual(["/kefu/feedback"]);
    expect(changed[0].targetApis).toEqual([
      "GET /adminapi/feedback", "GET /adminapi/feedback/:id",
      "PUT /adminapi/feedback/:id", "DELETE /adminapi/feedback/:id",
    ]);
    expect(changed[0].covered.join(" ")).toContain("feedback.view/manage");
  });
});
