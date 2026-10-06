import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(root, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");
const base = "/supplier/bill-screen";
const envelope = (data: unknown) => ({ status: 200, msg: "ok", data });
const group = (period = "2026-09-28") => ({ id: 1, period, day: period, title: "日账单",
  add_time: "2026/09/28", income_num: "100.20", exp_num: "2.10", entry_num: "98.10" });
const detail = () => ({ id: 8, order_id: "W8", link_id: "O8", trade_time: "2026/09/28 12:00:00",
  finish_time: "2026/09/29 12:00:00", number: "100.20", pm: 1,
  user_nickname: "张三", type_name: "支付", pay_type_name: "微信", remark: "" });
const exportRows = () => ({ filename: "2026-09-28账单", header: ["交易单号", "关联订单", "交易时间", "交易金额", "支出收入", "交易人", "交易类型", "支付方式"],
  filekey: ["order_id", "link_id", "trade_time", "number", "pm", "user_nickname", "type_name", "pay_type_name"],
  export: [{ order_id: "=danger", link_id: "O8", trade_time: "2026/09/28 12:00:00", number: "100.20",
    pm: "收入", user_nickname: "张三", type_name: "支付", pay_type_name: "微信" }], count: 1 });

let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { search: "", pathname: "/supplier/bills", href: "" } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/supplier/SupplierBills.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/supplierBill';
    export * as routing from 'vue-router';
    export * as messages from 'element-plus';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
  ` }, alias: { "@": resolve(root, "src") }, define: { "import.meta.env.DEV": "false" },
  bundle: true, write: false, platform: "browser", format: "esm",
  plugins: [{ name: "supplier-bill-runtime", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8"),
      { filename: path }).descriptor, { id: "supplier-bill-runtime" }).content, loader: "ts" }));
    builder.onResolve({ filter: /^(element-plus|vue-router)$/ }, ({ path }) => ({ path, namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ resolveDir: root, contents: path === "element-plus" ? `
      export const state = { errors: [] };
      export const ElMessage = { error: value => state.errors.push(value) };
    ` : `
      import { reactive } from 'vue';
      export const state = { route: reactive({ path: '/supplier/bills', query: {} }), pushes: [] };
      export function useRoute() { return state.route; }
      export function useRouter() { return { push: async value => {
        state.pushes.push(value); state.route.path = value.path; state.route.query = value.query;
      } }; }
    ` }));
  } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, { location: { search: "", pathname: "/supplier/bills", href: "" } }));
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.routing.state.route.query = {}; runtime.routing.state.pushes = [];
  runtime.messages.state.errors = [];
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const flush = async () => { for (let i = 0; i < 9; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function login(permissions = ["supplier_bill.view"], token = "supplier-bill-a", id = 20) {
  values.set("admin_token", token);
  values.set("admin_session", JSON.stringify({ userInfo: { id, account: "operator", level: 1, roles: "" },
    menus: [], uniqueAuth: permissions }));
}
async function mount(permissions = ["supplier_bill.view"], respond: (config: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await respond(config);
    const data = custom ?? envelope(config.url.endsWith("/suppliers") ? [{ id: 3, supplier_name: "停用但未删除供应商" }]
      : config.url.endsWith("/groups") ? { list: [group()], count: 1, page: config.params.page, limit: 15 }
      : config.url.endsWith("/details") ? { list: [detail()], count: 1, page: config.params.page, limit: 10 }
      : exportRows());
    return { config, data, status: 200, statusText: "supplier bill fixture", headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it("requires the independent read permission and opens the status deep link with 15 groups", async () => {
  runtime.routing.state.route.query = { status: "1" };
  const denied = await mount(["supplier_apply.view"]);
  try { expect(denied.view.canView.value).toBe(false); expect(denied.calls).toEqual([]); }
  finally { denied.close(); }
  const allowed = await mount();
  try {
    expect(allowed.calls.map(call => call.url).sort()).toEqual([`${base}/suppliers`, `${base}/groups`].sort());
    expect(allowed.calls.every(call => call.method === "get")).toBe(true);
    expect(allowed.calls.find(call => call.url.endsWith("/groups")).params).toMatchObject({
      timeType: "day", data: "", supplier_id: "", status: "1", page: 1, limit: 15,
    });
    expect(allowed.view.pageTotals.value).toEqual({ income: "100.20", expense: "2.10", entry: "98.10" });
    expect(allowed.view.suppliers.value[0].supplier_name).toContain("停用");
  } finally { allowed.close(); }
});

it("keeps detail and export bound to the selected period and supplier after filter changes", async () => {
  const mounted = await mount();
  try {
    mounted.view.supplierId.value = 3; await flush();
    expect(mounted.view.groups.value).toEqual([]);
    await mounted.view.loadGroups(1);
    const groupCall = mounted.calls.at(-1);
    expect(groupCall.params.supplier_id).toBe(3);
    mounted.view.openDetails(mounted.view.groups.value[0]); await flush();
    const detailCall = mounted.calls.at(-1);
    expect(detailCall.url).toBe(`${base}/details`);
    expect(detailCall.params).toMatchObject({ timeType: "day", period: "2026-09-28",
      supplier_id: 3, status: "", data: "", keyword: "", page: 1, limit: 10 });
    mounted.view.detailKeyword.value = "张三"; await mounted.view.loadDetails(1);
    expect(mounted.calls.at(-1).params.keyword).toBe("张三");
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: () => link, body: { appendChild: vi.fn() } });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:supplier-bill-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await mounted.view.download(mounted.view.groups.value[0]);
    const exportCall = mounted.calls.at(-1);
    expect(exportCall.url).toBe(`${base}/export`);
    expect(exportCall.params).toEqual({ timeType: "day", period: "2026-09-28",
      supplier_id: 3, status: "", data: "" });
    expect(link.download).toBe("2026-09-28账单.csv");
    expect(link.click).toHaveBeenCalledOnce();
    mounted.view.changeStatus("1");
    expect(mounted.view.groups.value).toEqual([]);
    expect(mounted.view.detailVisible.value).toBe(false);
    await flush();
    expect(mounted.calls.at(-1).params.status).toBe("1");
    expect(runtime.routing.state.pushes.at(-1)).toMatchObject({ path: "/supplier/bills", query: { status: "1" } });
    expect(readFileSync(resolve(root, "src/router/index.ts"), "utf8")).toContain('path: "supplier/bills"');
    expect(readFileSync(resolve(root, "src/layouts/AdminLayout.vue"), "utf8")).toContain("canMenu('/supplier/bills')");
  } finally { mounted.close(); }
});

it("aborts and discards old account group responses", async () => {
  const late = deferred<unknown>(); let block = false;
  const mounted = await mount(["supplier_bill.view"], config => block && config.url.endsWith("/groups") ? late.promise : undefined);
  try {
    block = true; const pending = mounted.view.loadGroups(1); await flush();
    const stale = mounted.calls.at(-1);
    login(["supplier_apply.view"], "supplier-bill-b", 21);
    browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    expect(stale.signal.aborted).toBe(true);
    late.resolve(envelope({ list: [group("2026-09-29")], count: 1, page: 1, limit: 15 }));
    await pending; await flush();
    expect(mounted.view.canView.value).toBe(false);
    expect(mounted.view.groups.value).toEqual([]);
  } finally { mounted.close(); }
});

it("validates Shanghai wall-time range and escapes untrusted spreadsheet content", () => {
  expect(runtime.api.supplierBillDataRange(["2024/02/29 12:00:00", "2024/02/29 12:00:00"]))
    .toBe("2024/02/29 12:00:00-2024/02/29 12:00:00");
  for (const range of [["2026/02/30 00:00:00", "2026/03/01 00:00:00"],
    ["2026/09/29 00:00:00", "2026/09/28 00:00:00"],
    ["2024/01/01 00:00:00", "2025/01/02 00:00:00"]]) {
    expect(() => runtime.api.supplierBillDataRange(range)).toThrow();
  }
  const csv = runtime.api.supplierBillCsv(exportRows());
  expect(csv).toContain('"\'=danger"');
  expect(csv).toContain('"交易单号"');
  expect(() => runtime.api.supplierBillCsv({ ...exportRows(), count: 2 })).toThrow();
});
