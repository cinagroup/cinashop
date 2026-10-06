import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(root, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");
const base = "/agent/division/statistics-screen";
const envelope = (data: unknown) => ({ status: 200, msg: "ok", data });
const summary = () => ({ divisionNum: 3, agentNum: 11, staffNum: 20, orderNum: 80,
  orderPrice: "1250.30", brokeragePrice: "36.25" });
const trend = (amount = 25) => ({ xAxis: ["2026-09-28"], series: [
  { name: "订单金额", type: "line", data: [amount] },
  { name: "订单量", type: "line", data: [2] },
] });
const ranking = () => ({ list: [
  { uid: 101, nickname: "一区", spreadAgent: 3, orderNum: 4, spreadStaff: 7,
    orderPrice: "51.00", brokeragePrice: "2.31" },
  { uid: 102, nickname: "二区", spreadAgent: 1, orderNum: 2, spreadStaff: 5,
    orderPrice: "100.00", brokeragePrice: "5.20" },
] });

let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { search: "", pathname: "/division/statistics", href: "" } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/agent/DivisionStatistics.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/divisionStatistics';
    export * as charts from 'echarts';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
  ` }, alias: { "@": resolve(root, "src") }, define: { "import.meta.env.DEV": "false" },
  bundle: true, write: false, platform: "browser", format: "esm",
  plugins: [{ name: "division-statistics-runtime", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8"),
      { filename: path }).descriptor, { id: "division-statistics-runtime" }).content, loader: "ts" }));
    builder.onResolve({ filter: /^echarts$/ }, () => ({ path: "charts", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export const state = { instances: [] };
      export function init(element) {
        const chart = { element, disposed: false, option: null,
          setOption(value) { this.option = value; }, clear() { this.option = null; },
          resize() {}, dispose() { this.disposed = true; } };
        state.instances.push(chart); return chart;
      }
    ` }));
  } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, { location: { search: "", pathname: "/division/statistics", href: "" } }));
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.charts.state.instances = [];
});
afterEach(() => vi.unstubAllGlobals());
const flush = async () => { for (let i = 0; i < 9; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function login(permissions = ["division_statistics.view"], token = "division-token-a", id = 20) {
  values.set("admin_token", token);
  values.set("admin_session", JSON.stringify({ userInfo: { id, account: "operator", level: 1, roles: "" },
    menus: [], uniqueAuth: permissions }));
}
async function mount(permissions = ["division_statistics.view"], respond: (config: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    const data = custom ?? envelope(config.url.endsWith("/summary") ? summary()
      : config.url.endsWith("/trend") ? trend() : ranking());
    return { config, data, status: 200, statusText: "division fixture", headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it("enforces an independent statistics role and renders the old six-card and seven-column contract", async () => {
  const denied = await mount(["division.view"]);
  try { expect(denied.view.canView.value).toBe(false); expect(denied.calls).toEqual([]); } finally { denied.close(); }
  const allowed = await mount();
  try {
    expect(allowed.calls.map(call => call.url).sort()).toEqual([`${base}/summary`, `${base}/trend`, `${base}/ranking`].sort());
    expect(allowed.calls.every(call => call.method === "get")).toBe(true);
    expect(allowed.calls.find(call => call.url.endsWith("/summary")).params).toBeUndefined();
    expect(allowed.calls.find(call => call.url.endsWith("/ranking")).params).toBeUndefined();
    expect(allowed.calls.find(call => call.url.endsWith("/trend")).params.time).toMatch(/^\d{4}\/\d{2}\/\d{2}-\d{4}\/\d{2}\/\d{2}$/u);
    expect(allowed.view.cards.map((card: any) => card.label)).toEqual([
      "区域代理数量", "代理商数量", "员工数量", "总订单数", "总订单金额", "获得佣金金额",
    ]);
    expect(allowed.view.ranking.value[0]).toMatchObject({ spreadAgent: 3, spreadStaff: 7, orderNum: 4 });
    expect(allowed.view.sortOrderPrice(allowed.view.ranking.value[0], allowed.view.ranking.value[1])).toBeLessThan(0);
    const closeAmounts = [
      { ...ranking().list[0], orderPrice: "9999999999999999.01", brokeragePrice: "-9999999999999999.02" },
      { ...ranking().list[1], orderPrice: "9999999999999999.02", brokeragePrice: "-9999999999999999.01" },
    ];
    expect(allowed.view.sortOrderPrice(closeAmounts[0], closeAmounts[1])).toBe(-1);
    expect(allowed.view.sortBrokerage(closeAmounts[0], closeAmounts[1])).toBe(-1);
    const page = readFileSync(resolve(root, "src/pages/agent/DivisionStatistics.vue"), "utf8");
    expect(["排行", "名称", "代理商数量", "订单数", "员工数量", "订单金额", "佣金"]
      .every(label => page.includes(`label="${label}"`))).toBe(true);
    expect(page).toContain('prop="orderPrice" label="订单金额"');
    expect(page).not.toContain("已支付订单数");
    expect(readFileSync(resolve(root, "src/router/index.ts"), "utf8")).toContain('path: "division/statistics"');
    expect(readFileSync(resolve(root, "src/layouts/AdminLayout.vue"), "utf8")).toContain("canMenu('/division/statistics')");
  } finally { allowed.close(); }
});

it("keeps overview and ranking date-independent while refreshing trend with old shortcuts or custom dates", async () => {
  const mounted = await mount();
  try {
    expect(mounted.view.dateRange.value).toHaveLength(2);
    expect(mounted.view.shortcuts.map((item: any) => item.label)).toEqual([
      "今天", "昨天", "最近7天", "最近30天", "上月", "本月", "本年",
    ]);
    mounted.view.selectShortcut("today"); await flush();
    expect(mounted.view.dateRange.value[0]).toBe(mounted.view.dateRange.value[1]);
    expect(mounted.calls.filter(call => call.url.endsWith("/summary"))).toHaveLength(1);
    expect(mounted.calls.filter(call => call.url.endsWith("/ranking"))).toHaveLength(1);
    expect(mounted.calls.filter(call => call.url.endsWith("/trend"))).toHaveLength(2);
    mounted.view.dateRange.value = ["2026/09/01", "2026/09/28"];
    await mounted.view.loadTrend();
    expect(mounted.calls.filter(call => call.url.endsWith("/trend")).at(-1).params).toEqual({ time: "2026/09/01-2026/09/28" });
    const before = mounted.calls.length;
    mounted.view.dateRange.value = []; await mounted.view.loadTrend();
    expect(mounted.calls).toHaveLength(before);
    expect(mounted.view.trendError.value).toContain("日期");
    expect(mounted.view.summary.value).toEqual(summary());
    expect(mounted.view.ranking.value).toHaveLength(2);
  } finally { mounted.close(); }
});

it("validates date bounds and rejects malformed or mixed ranking and trend payloads", () => {
  expect(runtime.api.divisionStatisticsTime(["2024/02/29", "2024/03/01"])).toBe("2024/02/29-2024/03/01");
  expect(runtime.api.divisionStatisticsTime(["2024/01/01", "2024/12/31"])).toContain("2024/12/31");
  for (const range of [[], ["2026/09/01"], ["2026/02/30", "2026/03/01"],
    ["2026/09/29", "2026/09/28"], ["2024/01/01", "2025/01/01"]]) {
    expect(() => runtime.api.divisionStatisticsTime(range)).toThrow();
  }
  expect(runtime.api.parseDivisionStatisticsSummary(summary())).toEqual(summary());
  expect(() => runtime.api.parseDivisionStatisticsSummary({ ...summary(), orderNum: "80" })).toThrow();
  expect(() => runtime.api.parseDivisionStatisticsSummary({ ...summary(), brokeragePrice: 36.25 })).toThrow();
  expect(runtime.api.parseDivisionStatisticsTrend(trend()).series[0].data).toEqual([25]);
  expect(runtime.api.parseDivisionStatisticsTrend(trend(-5)).series[0].data).toEqual([-5]);
  expect(() => runtime.api.parseDivisionStatisticsTrend({ xAxis: ["2026-09-28"], series: [
    { name: "订单金额", type: "line", data: [25] }, { name: "订单量", type: "line", data: [] },
  ] })).toThrow();
  expect(() => runtime.api.parseDivisionStatisticsRanking({ list: [ranking().list[0], ranking().list[0]] })).toThrow();
  expect(() => runtime.api.parseDivisionStatisticsRanking({ list: [{ ...ranking().list[0], spreadStaff: null }] })).toThrow();
  expect(runtime.api.parseDivisionStatisticsRanking(ranking())).toEqual(ranking().list);
});

it("discards old account responses and aborts all pending read requests on session switch", async () => {
  const delayed = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()];
  let blocked = false;
  const mounted = await mount(["division_statistics.view"], config => {
    if (!blocked) return undefined;
    return delayed[["/summary", "/ranking", "/trend"].findIndex(path => config.url.endsWith(path))].promise;
  });
  try {
    blocked = true;
    const first = mounted.calls.length;
    const pending = [mounted.view.loadSummary(), mounted.view.loadRanking(), mounted.view.loadTrend()];
    await flush();
    const stale = mounted.calls.slice(first);
    expect(stale).toHaveLength(3);
    login(["division.view"], "division-token-b", 21);
    browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    expect(stale.every(call => call.signal.aborted)).toBe(true);
    delayed[0].resolve(envelope(summary())); delayed[1].resolve(envelope(ranking())); delayed[2].resolve(envelope(trend(99)));
    await Promise.all(pending); await flush();
    expect(mounted.view.canView.value).toBe(false);
    expect(mounted.view.summary.value).toBeNull(); expect(mounted.view.ranking.value).toEqual([]);
    expect(mounted.view.trend.value).toBeNull();
  } finally { mounted.close(); }
});

it("keeps only the latest trend after rapid date changes and aborts on unmount", async () => {
  const late = deferred<unknown>(); let block = false;
  const mounted = await mount(["division_statistics.view"], config => block && config.url.endsWith("/trend") ? late.promise : undefined);
  block = true;
  mounted.view.dateRange.value = ["2026/09/01", "2026/09/02"];
  const pending = mounted.view.loadTrend(); await flush();
  const old = mounted.calls.at(-1);
  expect(old.params.time).toBe("2026/09/01-2026/09/02");
  block = false;
  mounted.view.dateRange.value = ["2026/09/03", "2026/09/04"];
  await mounted.view.loadTrend();
  expect(old.signal.aborted).toBe(true);
  late.resolve(envelope(trend(999))); await pending;
  expect(mounted.view.trend.value.series[0].data).toEqual([25]);
  const pendingUnmount = deferred<unknown>(); block = true;
  runtime.request.defaults.adapter = async (config: any) => {
    mounted.calls.push(config); return { config, data: await pendingUnmount.promise, status: 200, statusText: "late", headers: {} };
  };
  const unmounted = mounted.view.loadTrend(); await flush();
  const latest = mounted.calls.at(-1); mounted.close();
  expect(latest.signal.aborted).toBe(true);
  pendingUnmount.resolve(envelope(trend(888))); await unmounted;
});
