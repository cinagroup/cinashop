import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(root, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");
const base = "/supplier/capital-screen";
const envelope = (data: unknown) => ({ status: 200, msg: "ok", data });
const row = (id = 8, editable = true) => ({ id, order_id: `W${id}`, link_id: `O${id}`,
  trade_time: "2026-09-28 12:00:00", number: "100.20", pm: 1, uid: 20,
  user_nickname: "张三", supplier_name: "供货商甲", type_name: "支付订单",
  pay_type_name: "微信支付", remark: "原备注", remark_editable: editable });
const exportRows = () => ({ filename: "供应商资金流水", header: ["交易单号", "关联订单", "交易时间", "交易金额", "支出收入", "交易人", "交易类型", "支付方式"],
  filekey: ["order_id", "link_id", "trade_time", "number", "pm", "user_nickname", "type_name", "pay_type_name"],
  export: [{ order_id: "=danger", link_id: "O8", trade_time: "2026-09-28 12:00:00", number: "100.20",
    pm: "收入", user_nickname: "张三", type_name: "支付订单", pay_type_name: "微信支付" }], count: 1 });

let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { search: "", pathname: "/supplier/capital-flow", href: "" } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/supplier/SupplierCapitalFlow.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/supplierCapital';
    export * as messages from 'element-plus';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
  ` }, alias: { "@": resolve(root, "src") }, define: { "import.meta.env.DEV": "false" },
  bundle: true, write: false, platform: "browser", format: "esm",
  plugins: [{ name: "supplier-capital-runtime", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8"),
      { filename: path }).descriptor, { id: "supplier-capital-runtime" }).content, loader: "ts" }));
    builder.onResolve({ filter: /^element-plus$/ }, ({ path }) => ({ path, namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export const state = { errors: [], warnings: [], successes: [] };
      export const ElMessage = { error: value => state.errors.push(value),
        warning: value => state.warnings.push(value), success: value => state.successes.push(value) };
    ` }));
  } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, { location: { search: "", pathname: "/supplier/capital-flow", href: "" } }));
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.messages.state.errors = []; runtime.messages.state.warnings = []; runtime.messages.state.successes = [];
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const flush = async () => { for (let i = 0; i < 9; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function login(permissions = ["supplier_capital.view"], token = "supplier-capital-a", id = 20) {
  values.set("admin_token", token);
  values.set("admin_session", JSON.stringify({ userInfo: { id, account: "operator", level: 1, roles: "" },
    menus: [], uniqueAuth: permissions }));
}
async function mount(permissions = ["supplier_capital.view"], respond: (config: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await respond(config);
    const data = custom ?? envelope(config.url.endsWith("/suppliers") ? [{ id: 3, supplier_name: "供货商甲" }]
      : config.url.endsWith("/list") ? { list: [row()], count: 1, page: config.params.page, limit: 20 }
      : config.url.endsWith("/export") ? exportRows()
      : { id: Number(config.url.split("/").at(-1)), remark: JSON.parse(config.data).remark });
    return { config, data, status: 200, statusText: "supplier capital fixture", headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it("requires its independent view permission, lists 20 rows per page and routes to its own screen", async () => {
  const denied = await mount(["supplier_bill.view"]);
  try { expect(denied.view.canView.value).toBe(false); expect(denied.calls).toEqual([]); }
  finally { denied.close(); }
  const allowed = await mount();
  try {
    expect(allowed.view.canView.value).toBe(true);
    expect(allowed.view.canManage.value).toBe(false);
    expect(allowed.calls.map(call => call.url).sort()).toEqual([`${base}/suppliers`, `${base}/list`].sort());
    expect(allowed.calls.find(call => call.url.endsWith("/list")).params)
      .toMatchObject({ supplier_id: "", data: "", keyword: "", page: 1, limit: 20 });
    expect(readFileSync(resolve(root, "src/router/index.ts"), "utf8")).toContain('path: "supplier/capital-flow"');
    expect(readFileSync(resolve(root, "src/layouts/AdminLayout.vue"), "utf8")).toContain("canMenu('/supplier/capital-flow')");
  } finally { allowed.close(); }
});

it("binds export to the applied supplier, date and keyword across list pages", async () => {
  const mounted = await mount();
  try {
    mounted.view.supplierId.value = 3;
    mounted.view.timeRange.value = ["2026/09/27 00:00:00", "2026/09/28 00:00:00"];
    mounted.view.keyword.value = "张三"; await flush();
    expect(mounted.view.appliedScope.value).toBeNull();
    await mounted.view.load(2);
    const listing = mounted.calls.at(-1);
    expect(listing.params).toMatchObject({ supplier_id: 3,
      data: "2026/09/27 00:00:00-2026/09/28 00:00:00", keyword: "张三", page: 2, limit: 20 });
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: () => link, body: { appendChild: vi.fn() } });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:supplier-capital-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await mounted.view.download();
    const exportCall = mounted.calls.at(-1);
    expect(exportCall.url).toBe(`${base}/export`);
    expect(exportCall.params).toEqual({ supplier_id: 3,
      data: "2026/09/27 00:00:00-2026/09/28 00:00:00", keyword: "张三" });
    expect(link.download).toBe("供应商资金流水.csv");
    expect(link.click).toHaveBeenCalledOnce();
  } finally { mounted.close(); }
});

it("writes only editable platform remarks with the previously displayed value", async () => {
  const mounted = await mount(["supplier_capital.view", "supplier_capital.manage"], config =>
    config.url.endsWith("/list") ? envelope({ list: [row(8), row(9, false)], count: 2,
      page: config.params.page, limit: 20 }) : undefined);
  try {
    mounted.view.openRemark(mounted.view.list.value[1]);
    expect(mounted.view.remarkVisible.value).toBe(false);
    mounted.view.openRemark(mounted.view.list.value[0]);
    expect(mounted.view.remarkDraft.value).toBe("原备注");
    mounted.view.remarkDraft.value = "人工核对";
    await mounted.view.saveRemark();
    const write = mounted.calls.find(call => call.method === "put");
    expect(write.url).toBe(`${base}/remark/8`);
    expect(JSON.parse(write.data)).toEqual({ remark: "人工核对", expected_remark: "原备注" });
    expect(mounted.view.remarkVisible.value).toBe(false);
    expect(runtime.messages.state.successes).toContain("平台备注已保存");
  } finally { mounted.close(); }
});

it("on a 409 closes the edit and rereads before another explicit confirmation", async () => {
  const mounted = await mount(["supplier_capital.view", "supplier_capital.manage"], config =>
    config.method === "put" ? { status: 409, msg: "备注已变更，请刷新后重试", data: null } : undefined);
  try {
    mounted.view.openRemark(mounted.view.list.value[0]);
    mounted.view.remarkDraft.value = "旧窗口的内容";
    await mounted.view.saveRemark();
    expect(mounted.calls.filter(call => call.method === "put")).toHaveLength(1);
    expect(mounted.calls.filter(call => call.url.endsWith("/list"))).toHaveLength(2);
    expect(mounted.view.remarkVisible.value).toBe(false);
    expect(runtime.messages.state.warnings.at(-1)).toContain("重新填写");
  } finally { mounted.close(); }
});

it("aborts and discards list responses from a previous admin session", async () => {
  const late = deferred<unknown>(); let block = false;
  const mounted = await mount(["supplier_capital.view"], config => block && config.url.endsWith("/list") ? late.promise : undefined);
  try {
    block = true; const pending = mounted.view.load(1); await flush();
    const stale = mounted.calls.at(-1);
    login(["supplier_bill.view"], "supplier-capital-b", 21);
    browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    expect(stale.signal.aborted).toBe(true);
    late.resolve(envelope({ list: [row(20)], count: 1, page: 1, limit: 20 }));
    await pending; await flush();
    expect(mounted.view.canView.value).toBe(false);
    expect(mounted.view.list.value).toEqual([]);
  } finally { mounted.close(); }
});

it("validates Shanghai wall time and spreadsheet content", () => {
  expect(runtime.api.supplierCapitalDataRange(["2024/02/29 12:00:00", "2024/02/29 12:00:00"]))
    .toBe("2024/02/29 12:00:00-2024/02/29 12:00:00");
  for (const range of [["2026/02/30 00:00:00", "2026/03/01 00:00:00"],
    ["2026/09/29 00:00:00", "2026/09/28 00:00:00"],
    ["2024/01/01 00:00:00", "2025/01/02 00:00:00"]]) {
    expect(() => runtime.api.supplierCapitalDataRange(range)).toThrow();
  }
  expect(runtime.api.supplierCapitalCsv(exportRows())).toContain('"\'=danger"');
  expect(() => runtime.api.supplierCapitalCsv({ ...exportRows(), count: 2 })).toThrow();
});
