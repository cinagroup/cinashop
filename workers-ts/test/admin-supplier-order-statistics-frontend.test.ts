import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(root, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");
const base = "/supplier/order-statistics-screen";
const envelope = (data: unknown) => ({ status: 200, msg: "ok", data });
const summary = () => ({ payPrice: "900.20", payCount: 12, refundPrice: "30.10", refundCount: 2 });
const trend = () => ({ xAxis: ["2026-09-27", "2026-09-28"], series: [
  { name: "订单金额", type: "line", data: [100.5, 200.25] },
  { name: "订单量", type: "line", data: [2, 3] },
  { name: "退款金额", type: "line", data: [10.5, 20.25] },
  { name: "退款订单量", type: "line", data: [1, 1] },
] });
const channel = () => ({ items: Array.from({ length: 5 }, (_, key) =>
  ({ key, name: `来源${key}`, value: key + 1, percent: (key + 1) * 6.25 })), totalCount: 15 });
const type = () => ({ items: Array.from({ length: 9 }, (_, key) =>
  ({ key, name: `类型${key}`, value: `${key + 1}.00`, percent: (key + 1) * 2.25 })), totalPrice: "45.00" });
const row = (id = 3) => ({ id, supplierName: `供应商${id}`, orderPrice: "100.50", orderCount: 2,
  refundOrderPrice: "3.25", refundOrderCount: 1 });

let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { search: "", pathname: "/supplier/order-statistics", href: "" } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/supplier/SupplierOrderStatistics.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/supplierOrderStatistics';
    export * as charts from 'echarts';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
  ` }, alias: { "@": resolve(root, "src") }, define: { "import.meta.env.DEV": "false" },
  bundle: true, write: false, platform: "browser", format: "esm",
  plugins: [{ name: "supplier-order-statistics-runtime", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8"),
      { filename: path }).descriptor, { id: "supplier-order-statistics-runtime" }).content, loader: "ts" }));
    builder.onResolve({ filter: /^echarts$/ }, () => ({ path: "charts", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export const state = { instances: [] };
      export function init(element) {
        const chart = { element, disposed: false, option: null,
          setOption(value) { this.option = value; }, resize() {}, dispose() { this.disposed = true; } };
        state.instances.push(chart); return chart;
      }
    ` }));
  } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, { location: { search: "", pathname: "/supplier/order-statistics", href: "" } }));
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.charts.state.instances = [];
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 9; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function login(permissions = ["supplier_order_statistics.view"], token = "supplier-stats-a", id = 20) {
  values.set("admin_token", token);
  values.set("admin_session", JSON.stringify({ userInfo: { id, account: "operator", level: 1, roles: "" },
    menus: [], uniqueAuth: permissions }));
}
async function mount(permissions = ["supplier_order_statistics.view"], respond: (config: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    const data = custom ?? envelope(config.url.endsWith("/suppliers") ? { list: [{ id: 3, supplierName: "供应商3" }] }
      : config.url.endsWith("/summary") ? summary()
      : config.url.endsWith("/trend") ? trend()
      : config.url.endsWith("/channel") ? channel()
      : config.url.endsWith("/type") ? type()
      : { list: [row()], count: 45, page: config.params.page, limit: config.params.limit });
    return { config, data, status: 200, statusText: "supplier statistics fixture", headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it("uses an independent view permission and loads all six read endpoints with the shown Shanghai default range", async () => {
  const denied = await mount(["supplier_bill.view"]);
  try { expect(denied.view.canView.value).toBe(false); expect(denied.calls).toEqual([]); }
  finally { denied.close(); }
  const allowed = await mount();
  try {
    expect(allowed.view.canView.value).toBe(true);
    expect(allowed.calls.map(call => call.url).sort()).toEqual([
      "suppliers", "summary", "trend", "channel", "type", "supplier-table",
    ].map(path => `${base}/${path}`).sort());
    expect(allowed.calls.every(call => call.method === "get")).toBe(true);
    const time = allowed.view.dateRange.value.join("-");
    expect(runtime.api.supplierOrderStatisticsTime(allowed.view.dateRange.value)).toBe(time);
    expect(allowed.calls.filter(call => !call.url.endsWith("/suppliers")).every(call =>
      call.params.time === time && call.params.supplier_id === "")).toBe(true);
    expect(allowed.calls.find(call => call.url.endsWith("/supplier-table")).params)
      .toMatchObject({ page: 1, limit: 20 });
    expect(allowed.view.summary.value).toEqual(summary());
    expect(allowed.view.cards.map((card: any) => card.label)).toEqual(["订单金额", "订单数", "退款金额", "退款订单数"]);
    expect(allowed.view.channel.value.items).toHaveLength(5);
    expect(allowed.view.typeDistribution.value.items.map((item: any) => item.key)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(readFileSync(resolve(root, "src/router/index.ts"), "utf8")).toContain('path: "supplier/order-statistics"');
    expect(readFileSync(resolve(root, "src/layouts/AdminLayout.vue"), "utf8")).toContain("canMenu('/supplier/order-statistics')");
    expect(readFileSync(resolve(root, "src/api/system.ts"), "utf8")).toContain("supplier_order_statistics.view");
    expect(readFileSync(resolve(root, "src/pages/supplier/SupplierOrderStatistics.vue"), "utf8")).not.toMatch(/导出 CSV|导出 Excel/u);
  } finally { allowed.close(); }
});

it("applies supplier and custom date to every panel, and pages only the table", async () => {
  const mounted = await mount();
  try {
    mounted.view.supplierId.value = 3;
    mounted.view.dateRange.value = ["2026/09/01", "2026/09/28"];
    await mounted.view.loadAll(); await flush();
    const last = mounted.calls.slice(-5);
    expect(last.map(call => call.url).sort()).toEqual([
      "summary", "trend", "channel", "type", "supplier-table",
    ].map(path => `${base}/${path}`).sort());
    expect(last.every(call => call.params.supplier_id === 3 && call.params.time === "2026/09/01-2026/09/28")).toBe(true);
    const before = mounted.calls.length;
    await mounted.view.loadTable(2);
    expect(mounted.calls).toHaveLength(before + 1);
    expect(mounted.calls.at(-1).params).toEqual({ time: "2026/09/01-2026/09/28", supplier_id: 3, page: 2, limit: 20 });
    expect(mounted.view.page.value).toBe(2);
    expect(mounted.view.total.value).toBe(45);
    expect(mounted.view.rows.value[0].orderPrice).toBe("100.50");
  } finally { mounted.close(); }
});

it("supports seven date shortcuts and only the trend chart offers image download", async () => {
  const mounted = await mount();
  try {
    expect(mounted.view.shortcuts.map((item: any) => item.label)).toEqual([
      "今天", "昨天", "最近7天", "最近30天", "上月", "本月", "本年",
    ]);
    mounted.view.trendEl.value = {}; mounted.view.channelEl.value = {}; mounted.view.typeEl.value = {};
    mounted.view.selectShortcut("today"); await flush();
    expect(mounted.view.dateRange.value[0]).toBe(mounted.view.dateRange.value[1]);
    expect(runtime.charts.state.instances).toHaveLength(3);
    expect(runtime.charts.state.instances[0].option.toolbox.feature.saveAsImage.name).toBe("供应商营业趋势");
    expect(runtime.charts.state.instances[0].option.series.map((item: any) => item.yAxisIndex)).toEqual([0, 1, 0, 1]);
    expect(runtime.charts.state.instances[1].option.toolbox).toBeUndefined();
    expect(runtime.charts.state.instances[2].option.toolbox).toBeUndefined();
    expect(runtime.charts.state.instances[2].option.series[0].type).toBe("bar");
    expect(runtime.charts.state.instances[2].option.series[0].data).toHaveLength(9);
  } finally { mounted.close(); }
});

it("discards all pending data when the account loses its view permission", async () => {
  const held = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>(), deferred<unknown>(), deferred<unknown>()];
  let blocked = false;
  const mounted = await mount(["supplier_order_statistics.view"], config => {
    if (!blocked || config.url.endsWith("/suppliers")) return undefined;
    const index = ["/summary", "/trend", "/channel", "/type", "/supplier-table"]
      .findIndex(path => config.url.endsWith(path));
    return held[index].promise;
  });
  try {
    blocked = true; const before = mounted.calls.length;
    const pending = mounted.view.loadAll(); await flush();
    const stale = mounted.calls.slice(before);
    expect(stale).toHaveLength(5);
    login(["supplier_bill.view"], "supplier-stats-b", 21);
    browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    expect(stale.every(call => call.signal.aborted)).toBe(true);
    held[0].resolve(envelope(summary())); held[1].resolve(envelope(trend()));
    held[2].resolve(envelope(channel())); held[3].resolve(envelope(type()));
    held[4].resolve(envelope({ list: [row(99)], count: 1, page: 1, limit: 20 }));
    await pending; await flush();
    expect(mounted.view.canView.value).toBe(false);
    expect(mounted.view.summary.value).toBeNull(); expect(mounted.view.trend.value).toBeNull();
    expect(mounted.view.channel.value).toBeNull(); expect(mounted.view.rows.value).toEqual([]);
  } finally { mounted.close(); }
});

it("clears displayed statistics when another tab replaces the admin session", async () => {
  const mounted = await mount();
  try {
    expect(mounted.view.summary.value).toEqual(summary());
    login(["supplier_bill.view"], "supplier-stats-other-tab", 22);
    browser.dispatchEvent(Object.assign(new Event("storage"), { key: "admin_session" }));
    await flush();
    expect(mounted.view.canView.value).toBe(false);
    expect(mounted.view.summary.value).toBeNull();
    expect(mounted.view.rows.value).toEqual([]);
  } finally { mounted.close(); }
});

it("validates ranges and rejects malformed counts, missing type zero, or wrong page envelopes", async () => {
  expect(runtime.api.supplierOrderStatisticsTime(["2024/02/29", "2024/03/01"]))
    .toBe("2024/02/29-2024/03/01");
  for (const range of [[], ["2026/09/01"], ["2026/02/30", "2026/03/01"],
    ["2026/09/29", "2026/09/28"], ["2024/01/01", "2025/01/01"]]) {
    expect(() => runtime.api.supplierOrderStatisticsTime(range)).toThrow();
  }
  expect(() => runtime.api.parseSupplierOrderStatisticsSummary({ ...summary(), payCount: "12" })).toThrow();
  expect(runtime.api.parseSupplierOrderStatisticsSummary({ ...summary(), payPrice: "-1.23" }).payPrice).toBe("-1.23");
  const negativeTrend = trend(); negativeTrend.series[0].data[0] = -1.23;
  expect(runtime.api.parseSupplierOrderStatisticsTrend(negativeTrend).series[0].data[0]).toBe(-1.23);
  expect(() => runtime.api.parseSupplierOrderStatisticsChannel({ ...channel(), items: channel().items.slice(1) })).toThrow();
  expect(() => runtime.api.parseSupplierOrderStatisticsType({ ...type(), items: type().items.slice(1) })).toThrow();
  const negativeType = type(); negativeType.items[0].value = "-1.23"; negativeType.items[0].percent = -2.81;
  negativeType.totalPrice = "43.77";
  expect(runtime.api.parseSupplierOrderStatisticsType(negativeType).items[0].value).toBe("-1.23");
  expect(() => runtime.api.parseSupplierOrderStatisticsPage({ list: [row()], count: 1, page: 1, limit: 0 })).toThrow();
  const mounted = await mount();
  try {
    const before = mounted.calls.length;
    mounted.view.dateRange.value = ["2026/02/30", "2026/03/01"];
    await mounted.view.loadAll();
    expect(mounted.calls).toHaveLength(before);
    expect(mounted.view.filterError.value).toContain("日期");
  } finally { mounted.close(); }
});
