import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";

let runtime: any;
let browser: EventTarget;
const root = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(root, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { search: "", pathname: "/marketing/point-statistic", href: "" } }));
  const result = await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root,
      contents: `
        export { default as Page } from './src/pages/marketing/PointStatistic.vue';
        export { default as request } from './src/utils/request';
        export * as point from './src/api/pointStatistic';
        export * as charts from 'echarts';
        export { createRenderer, nextTick } from 'vue';
        export { createPinia } from 'pinia';
      `,
    },
    alias: { "@": resolve(root, "src") },
    define: { "import.meta.env.DEV": "false" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    plugins: [{ name: "point-statistic-page", setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, "utf8"), { filename: path }).descriptor, { id: "point-statistic" }).content,
        loader: "ts",
      }));
      builder.onResolve({ filter: /^echarts$/ }, () => ({ path: "charts", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export const state = { instances: [] };
        export function init(element) {
          const chart = { element, disposed: false, setOption() {}, resize() {}, dispose() { this.disposed = true; } };
          state.instances.push(chart);
          return chart;
        }
      ` }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

const envelope = (data: unknown) => ({ status: 200, msg: "ok", data });
const basic = (total = "109") => ({ now_point: total, all_point: "31.00", pay_point: "17.00" });
const trend = () => ({ xAxis: ["2026-09-21"], series: [
  { name: "积分积累", type: "line", data: [31] },
  { name: "积分消耗", type: "line", data: [17] },
] });
const distribution = () => {
  const names = ["订单赠送", "商品赠送", "后台赠送", "签到获得", "九宫格抽奖"];
  return {
    bing_xdata: names,
    bing_data: names.map((name, index) => ({ name, value: index + 1, itemStyle: { color: "#64a1f4" } })),
    list: names.map((name, index) => ({ name, value: index + 1, percent: 20 })),
  };
};
const flush = async () => {
  for (let index = 0; index < 12; index++) {
    await new Promise((done) => setTimeout(done, 1));
    await runtime.nextTick();
  }
};

function login(permissions: string[], token = "point-token-a", id = 20) {
  localStorage.setItem("admin_token", token);
  localStorage.setItem("admin_session", JSON.stringify({
    userInfo: { id, account: "operator", level: 1, roles: "" }, menus: [], uniqueAuth: permissions,
  }));
}

beforeEach(() => {
  const values = new Map<string, string>();
  browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, { location: { search: "", pathname: "/marketing/point-statistic", href: "" } }));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  runtime.charts.state.instances = [];
});
afterEach(() => vi.unstubAllGlobals());

async function mount(permissions = ["point_statistic.view"], respond: (config: any) => unknown = () => undefined) {
  login(permissions);
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    const data = custom ?? envelope(config.url.endsWith("/get_basic") ? basic()
      : config.url.endsWith("/get_trend") ? trend() : distribution());
    return { config, data, status: 200, statusText: "frontend fixture", headers: {} };
  };
  let view: any;
  const component = { setup(props: unknown, context: unknown) {
    view = runtime.Page.setup(props, context);
    return () => null;
  } };
  const renderer = runtime.createRenderer({
    createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {},
  });
  const app = renderer.createApp(component);
  app.use(runtime.createPinia());
  app.mount({ children: [] });
  await flush();
  return { view, calls, close: () => app.unmount() };
}

it("validates four projections and keeps the point-statistics ACL independent", () => {
  expect(runtime.point.parsePointBasic(basic()).now_point).toBe("109");
  expect(runtime.point.parsePointTrend(trend()).series[1].data).toEqual([17]);
  const longAxis = Array.from({ length: 121 }, (_, index) => `2020-${index}`);
  expect(runtime.point.parsePointTrend({ xAxis: longAxis, series: [
    { name: "积分积累", type: "line", data: Array(121).fill(0) },
    { name: "积分消耗", type: "line", data: Array(121).fill(0) },
  ] }).xAxis).toHaveLength(121);
  expect(() => runtime.point.parsePointTrend({ xAxis: Array(133).fill("2020-01"), series: [
    { name: "积分积累", type: "line", data: Array(133).fill(0) },
    { name: "积分消耗", type: "line", data: Array(133).fill(0) },
  ] })).toThrow("积分趋势响应格式错误");
  expect(runtime.point.parsePointDistribution(distribution()).list).toHaveLength(5);
  expect(() => runtime.point.parsePointBasic({ ...basic(), pay_point: "seventeen" })).toThrow("积分统计响应格式错误");
  expect(() => runtime.point.parsePointTrend({ ...trend(), series: [trend().series[0]] })).toThrow("积分趋势响应格式错误");
  expect(() => runtime.point.parsePointDistribution({ ...distribution(), list: [] })).toThrow("积分分布响应格式错误");
  for (const path of ["get_basic", "get_trend", "get_channel", "get_type"])
    expect(requiredAdminPermission("GET", `/adminapi/marketing/point/${path}`)).toBe("point_statistic.view");
});

it("makes four GET reads only for a viewer and passes the same Shanghai date range", async () => {
  const denied = await mount(["integral_log.view"]);
  try {
    expect(denied.view.canView.value).toBe(false);
    expect(denied.calls).toEqual([]);
    await denied.view.load();
    expect(denied.calls).toEqual([]);
  } finally { denied.close(); }
  const allowed = await mount();
  try {
    expect(allowed.view.canView.value).toBe(true);
    expect(allowed.calls.map((call) => call.url)).toEqual([
      "/marketing/point/get_basic", "/marketing/point/get_trend",
      "/marketing/point/get_channel", "/marketing/point/get_type",
    ]);
    expect(allowed.calls.every((call) => call.method === "get")).toBe(true);
    expect(new Set(allowed.calls.map((call) => call.params.time)).size).toBe(1);
    expect(allowed.view.basic.value.now_point).toBe("109");
  } finally { allowed.close(); }
});

it("disposes charts and clears data when a replacement session loses the grant", async () => {
  const fixture = await mount();
  try {
    fixture.view.trendEl.value = {};
    fixture.view.channelEl.value = {};
    fixture.view.typeEl.value = {};
    await fixture.view.load();
    expect(runtime.charts.state.instances).toHaveLength(3);
    expect(runtime.charts.state.instances.every((chart: any) => !chart.disposed)).toBe(true);
    login([], "point-token-b", 21);
    browser.dispatchEvent(new Event("admin-session-changed"));
    await flush();
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.view.basic.value).toBeNull();
    expect(fixture.view.trend.value).toBeNull();
    expect(runtime.charts.state.instances.every((chart: any) => chart.disposed)).toBe(true);
    const count = fixture.calls.length;
    await fixture.view.load();
    expect(fixture.calls).toHaveLength(count);
    fixture.view.trendEl.value = { new: "trend" };
    fixture.view.channelEl.value = { new: "channel" };
    fixture.view.typeEl.value = { new: "type" };
    login(["point_statistic.view"], "point-token-c", 22);
    browser.dispatchEvent(new Event("admin-session-changed"));
    await flush();
    expect(fixture.view.canView.value).toBe(true);
    expect(fixture.view.basic.value.now_point).toBe("109");
    expect(runtime.charts.state.instances).toHaveLength(6);
    expect(runtime.charts.state.instances.slice(3).every((chart: any) => !chart.disposed)).toBe(true);
    expect(runtime.charts.state.instances[3].element).toEqual({ new: "trend" });
  } finally { fixture.close(); }
});
