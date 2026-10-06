import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(root, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");
const base = "/supplier/extract";
const envelope = (data: unknown) => ({ status: 200, msg: "ok", data });
const statistics = () => ({ pending_review: "100.00", pending_transfer: "200.00",
  paid: "300.00", rejected: "20.00", withdrawable: "500.00" });
const row = (id = 8) => ({ id, supplierId: 3, supplierName: "供应商甲", contactName: "联系人",
  phone: "13800000000", extractType: "bank", bankCode: "123", bankAddress: "银行", alipayAccount: "",
  wechat: "", qrcodeUrl: "", extractPrice: "100.00", balance: "500.00", mark: "",
  supplierMark: "原备注", status: 0, payStatus: 0, adminId: 0, adminName: "", failMsg: "",
  failTime: 0, voucherImage: "", voucherTitle: "", payTime: 0, addTime: 1786240000 });

let runtime: any, browser: EventTarget, values: Map<string, string>;
beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { search: "", pathname: "/finance/supplier-extract", href: "" } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/finance/SupplierExtractList.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/finance';
    export * as messages from 'element-plus';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
  ` }, alias: { "@": resolve(root, "src") }, define: { "import.meta.env.DEV": "false" },
  bundle: true, write: false, platform: "browser", format: "esm",
  plugins: [{ name: "supplier-extract-runtime", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8"),
      { filename: path }).descriptor, { id: "supplier-extract-runtime" }).content, loader: "ts" }));
    builder.onResolve({ filter: /^element-plus$/ }, ({ path }) => ({ path, namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export const state = { errors: [], warnings: [], successes: [], confirms: [] };
      export const ElMessage = { error: value => state.errors.push(value),
        warning: value => state.warnings.push(value), success: value => state.successes.push(value) };
      export const ElMessageBox = { confirm: (...args) => { state.confirms.push(args); return Promise.resolve(); } };
    ` }));
  } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, { location: { search: "", pathname: "/finance/supplier-extract", href: "" } }));
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.messages.state.errors = []; runtime.messages.state.warnings = [];
  runtime.messages.state.successes = []; runtime.messages.state.confirms = [];
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 9; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function login(permissions = ["supplier_extract.view"], token = "supplier-extract-a", id = 20) {
  values.set("admin_token", token);
  values.set("admin_session", JSON.stringify({ userInfo: { id, account: "operator", level: 1, roles: "" },
    menus: [], uniqueAuth: permissions }));
}
async function mount(permissions = ["supplier_extract.view"], respond: (config: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await respond(config);
    const data = custom ?? envelope(config.url.endsWith("/suppliers") ? { list: [{ id: 3, supplierName: "供应商甲" }] }
      : config.url.endsWith("/list") ? { list: [row()], count: 1, page: config.params.page,
        limit: config.params.limit, extract_statistics: statistics() }
      : config.url.includes("/mark/") ? { id: Number(config.url.split("/").at(-1)),
        supplierMark: JSON.parse(config.data).mark } : null);
    return { config, data, status: 200, statusText: "supplier extract fixture", headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it("requires supplier extract view, loads its own options and 15-row page, and shows the old four-card amounts", async () => {
  const denied = await mount(["supplier_application.view"]);
  try { expect(denied.view.canView.value).toBe(false); expect(denied.calls).toEqual([]); }
  finally { denied.close(); }
  const allowed = await mount();
  try {
    expect(allowed.view.canView.value).toBe(true);
    expect(allowed.view.canManage.value).toBe(false);
    expect(allowed.calls.map(call => call.url).sort()).toEqual([`${base}/suppliers`, `${base}/list`].sort());
    expect(allowed.calls.find(call => call.url.endsWith("/list")).params).toMatchObject({
      supplier_id: "", start_time: "", end_time: "", page: 1, limit: 15,
    });
    expect(allowed.view.suppliers.value).toEqual([{ id: 3, supplierName: "供应商甲" }]);
    expect(allowed.view.statistics.value).toEqual(statistics());
    const page = readFileSync(resolve(root, "src/pages/finance/SupplierExtractList.vue"), "utf8");
    expect(page).toContain("可提现金额");
    expect(page).toContain("statistics.withdrawable");
    expect(page).toContain("共享备注");
    expect(page).not.toContain("申请后余额");
    expect(page).toContain('v-if="canManage"');
  } finally { allowed.close(); }
});

it("combines independent supplier, Shanghai date, review and transfer filters and pages by 15", async () => {
  const mounted = await mount();
  try {
    mounted.view.supplierId.value = 3;
    mounted.view.dateRange.value = ["2026/09/27 00:00:00", "2026/09/28 00:00:00"];
    mounted.view.statusFilter.value = 0;
    mounted.view.payStatusFilter.value = 1;
    mounted.view.extractType.value = "bank";
    mounted.view.keyword.value = "联系人";
    await mounted.view.load(2);
    expect(mounted.calls.at(-1).params).toEqual({ supplier_id: 3,
      start_time: "2026/09/27 00:00:00", end_time: "2026/09/28 00:00:00",
      status: 0, pay_status: 1, extract_type: "bank", keyword: "联系人", page: 2, limit: 15 });
    expect(mounted.view.page.value).toBe(2);
    expect(runtime.api.supplierExtractTimeRange(["2024/02/29 12:00:00", "2024/02/29 12:00:00"]))
      .toEqual({ start_time: "2024/02/29 12:00:00", end_time: "2024/02/29 12:00:00" });
    expect(() => runtime.api.supplierExtractTimeRange(["2026/02/30 00:00:00", "2026/03/01 00:00:00"]))
      .toThrow();
    expect(() => runtime.api.supplierExtractTimeRange(["2026/09/29 00:00:00", "2026/09/28 00:00:00"]))
      .toThrow();
    expect(mounted.view.formatTime(1786240000)).toMatch(/^2026-\d\d-\d\d \d\d:\d\d:\d\d$/u);
  } finally { mounted.close(); }
});

it("a view-only role cannot invoke review, transfer or shared-remark writes even directly", async () => {
  const mounted = await mount();
  try {
    const item = mounted.view.list.value[0];
    await mounted.view.approve(item);
    mounted.view.openReject(item); await mounted.view.confirmReject();
    mounted.view.openTransfer({ ...item, status: 1 }); await mounted.view.confirmTransfer();
    mounted.view.openRemark(item); await mounted.view.saveRemark();
    expect(mounted.calls.filter(call => call.method !== "get")).toEqual([]);
    expect(mounted.view.rejectVisible.value).toBe(false);
    expect(mounted.view.transferVisible.value).toBe(false);
    expect(mounted.view.remarkVisible.value).toBe(false);
  } finally { mounted.close(); }
});

it("requires the 30-character transfer title but permits an empty voucher image", async () => {
  const mounted = await mount(["supplier_extract.view", "supplier_extract.manage"]);
  try {
    const item = mounted.view.list.value[0];
    item.status = 1;
    mounted.view.openTransfer(item);
    expect(mounted.view.transferVisible.value).toBe(true);
    mounted.view.transferForm.voucher_image = "https://example.invalid/voucher.png";
    await mounted.view.confirmTransfer();
    expect(mounted.calls.filter(call => call.url.includes("/save_transfer/"))).toEqual([]);
    mounted.view.transferForm.voucher_title = "转账说明";
    mounted.view.transferForm.voucher_image = "";
    await mounted.view.confirmTransfer();
    const transfer = mounted.calls.find(call => call.url.endsWith("/save_transfer/8"));
    expect(transfer?.method).toBe("post");
    expect(JSON.parse(transfer.data)).toEqual({ voucher_title: "转账说明", voucher_image: "" });
    expect(runtime.messages.state.successes).toContain("实际转账已登记");
    const page = readFileSync(resolve(root, "src/pages/finance/SupplierExtractList.vue"), "utf8");
    expect(page).toContain('v-model="transferForm.voucher_title" maxlength="30"');
    expect(page).toContain("凭证地址（选填）");
  } finally { mounted.close(); }
});

it("saves the shared remark with the displayed old value and rereads on conflict", async () => {
  const mounted = await mount(["supplier_extract.view", "supplier_extract.manage"]);
  try {
    mounted.view.openRemark(mounted.view.list.value[0]);
    mounted.view.remarkDraft.value = "人工核对";
    await mounted.view.saveRemark();
    const write = mounted.calls.find(call => call.url.endsWith("/mark/8"));
    expect(write.method).toBe("post");
    expect(JSON.parse(write.data)).toEqual({ mark: "人工核对", expected_supplier_mark: "原备注" });
    expect(mounted.view.remarkVisible.value).toBe(false);
    expect(runtime.messages.state.successes).toContain("备注已保存");
  } finally { mounted.close(); }
  const conflict = await mount(["supplier_extract.view", "supplier_extract.manage"], config =>
    config.url.endsWith("/mark/8") ? { status: 409, msg: "备注已变更", data: null } : undefined);
  try {
    conflict.view.openRemark(conflict.view.list.value[0]);
    conflict.view.remarkDraft.value = "旧窗口内容";
    await conflict.view.saveRemark();
    expect(conflict.calls.filter(call => call.url.endsWith("/mark/8"))).toHaveLength(1);
    expect(conflict.calls.filter(call => call.url.endsWith("/list"))).toHaveLength(2);
    expect(conflict.view.remarkVisible.value).toBe(false);
    expect(runtime.messages.state.warnings.at(-1)).toContain("重新填写");
  } finally { conflict.close(); }
});

it("aborts and discards a prior account's late supplier list and withdrawal page", async () => {
  const lateOptions = deferred<unknown>(), lateList = deferred<unknown>(); let block = false;
  const mounted = await mount(["supplier_extract.view"], config => {
    if (!block) return undefined;
    return config.url.endsWith("/suppliers") ? lateOptions.promise : lateList.promise;
  });
  try {
    block = true;
    const options = mounted.view.loadSuppliers(), listing = mounted.view.load(1); await flush();
    const stale = mounted.calls.slice(-2);
    login(["supplier_bill.view"], "supplier-extract-b", 21);
    browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    expect(stale.every(call => call.signal.aborted)).toBe(true);
    lateOptions.resolve(envelope({ list: [{ id: 7, supplierName: "旧账户供应商" }] }));
    lateList.resolve(envelope({ list: [row(99)], count: 1, page: 1, limit: 15,
      extract_statistics: statistics() }));
    await Promise.all([options, listing]); await flush();
    expect(mounted.view.canView.value).toBe(false);
    expect(mounted.view.list.value).toEqual([]);
    expect(mounted.view.suppliers.value).toEqual([]);
    expect(mounted.view.statistics.value.withdrawable).toBe("0.00");
  } finally { mounted.close(); }
});

it("cancels a late shared-remark save when the admin account changes", async () => {
  const lateMark = deferred<unknown>();
  const mounted = await mount(["supplier_extract.view", "supplier_extract.manage"], config =>
    config.url.endsWith("/mark/8") ? lateMark.promise : undefined);
  try {
    mounted.view.openRemark(mounted.view.list.value[0]);
    mounted.view.remarkDraft.value = "旧账户编辑";
    const saving = mounted.view.saveRemark(); await flush();
    const write = mounted.calls.find(call => call.url.endsWith("/mark/8"));
    expect(write?.signal.aborted).toBe(false);
    login(["supplier_bill.view"], "supplier-extract-b", 21);
    browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    expect(write.signal.aborted).toBe(true);
    lateMark.resolve(envelope({ id: 8, supplierMark: "旧账户编辑" }));
    await saving; await flush();
    expect(mounted.view.canManage.value).toBe(false);
    expect(mounted.view.remarkVisible.value).toBe(false);
    expect(mounted.view.list.value).toEqual([]);
    expect(runtime.messages.state.successes).toEqual([]);
  } finally { mounted.close(); }
});
