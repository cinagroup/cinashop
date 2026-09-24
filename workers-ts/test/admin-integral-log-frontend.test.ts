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
  // The bundled auth store reads localStorage during module evaluation.
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { search: "", pathname: "/marketing/user-point", href: "" } }));
  const result = await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root,
      contents: `
        export { default as Page } from './src/pages/marketing/IntegralLog.vue';
        export { default as request } from './src/utils/request';
        export * as integralLog from './src/api/integralLog';
        export { createRenderer, nextTick } from 'vue';
        export { createPinia } from 'pinia';
        export * as message from 'element-plus';
      `,
    },
    alias: { "@": resolve(root, "src") },
    define: { "import.meta.env.DEV": "false" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    plugins: [{ name: "integral-log-page", setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, "utf8"), { filename: path }).descriptor, { id: "integral-log" }).content,
        loader: "ts",
      }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: "messages", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export const state = { errors: [] };
        export const ElMessage = { error: (message) => state.errors.push(message) };
      ` }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

const envelope = (data: unknown, status = 200, msg = "ok") => ({ status, msg, data });
const row = (id: number) => ({
  id, uid: 22, title: "签到积分", type: "sign", pm: 1,
  number: "5", balance: "100", mark: "每日签到", nickname: "会员甲", add_time: 1_700_000_000,
});
const rows = (page = 1) => ({ list: [row(page === 1 ? 3 : 1)], count: 21, page, limit: 15 });
const stats = (total = "100") => ({ total_integral: total, sign_count: "3", sign_integral: "15", used_integral: "7" });
const flush = async () => {
  for (let index = 0; index < 12; index++) {
    await new Promise((done) => setTimeout(done, 1));
    await runtime.nextTick();
  }
};

function login(permissions: string[], token = "integral-token-a", id = 20) {
  localStorage.setItem("admin_token", token);
  localStorage.setItem("admin_session", JSON.stringify({
    userInfo: { id, account: "operator", level: 1, roles: "" }, menus: [], uniqueAuth: permissions,
  }));
}

beforeEach(() => {
  const values = new Map<string, string>();
  browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, { location: { search: "", pathname: "/marketing/user-point", href: "" } }));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  runtime.message.state.errors = [];
});
afterEach(() => vi.unstubAllGlobals());

async function mount(permissions = ["integral_log.view"], respond: (config: any) => unknown = () => undefined) {
  login(permissions);
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    const data = custom ?? (config.url.endsWith("/statistics")
      ? envelope(stats()) : envelope(rows(config.params?.page ?? 1)));
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

it("validates the real read-only client contracts and independent ACL", () => {
  expect(runtime.integralLog.parseIntegralLogPage(rows()).list[0].uid).toBe(22);
  expect(runtime.integralLog.parseIntegralLogStats(stats()).sign_integral).toBe("15");
  expect(() => runtime.integralLog.parseIntegralLogPage({ ...rows(), count: -1 })).toThrow("积分日志格式错误");
  expect(() => runtime.integralLog.parseIntegralLogPage({ ...rows(), list: [row(3), row(3)] })).toThrow("积分日志记录格式错误");
  expect(() => runtime.integralLog.parseIntegralLogPage({ ...rows(), list: [{ ...row(3), number: "5.5" }] })).toThrow("积分日志记录格式错误");
  expect(() => runtime.integralLog.parseIntegralLogStats({ ...stats(), used_integral: "seven" })).toThrow("积分统计格式错误");
  expect(requiredAdminPermission("GET", "/adminapi/marketing/user-point/logs")).toBe("integral_log.view");
  expect(requiredAdminPermission("GET", "/adminapi/marketing/user-point/statistics")).toBe("integral_log.view");
});

it("rejects direct reads without integral_log.view even when another marketing grant exists", async () => {
  const fixture = await mount(["marketing.view"]);
  try {
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.calls).toEqual([]);
    await fixture.view.loadList(1);
    await fixture.view.loadStats();
    expect(fixture.calls).toEqual([]);
  } finally { fixture.close(); }
});

it("loads server statistics and filters, then changes only the list page", async () => {
  const fixture = await mount(["integral_log.view"], (config) => {
    if (config.url.endsWith("/statistics")) return envelope(stats(config.params?.keyword === "VIP" ? "88" : "100"));
    return envelope(rows(config.params?.page ?? 1));
  });
  try {
    expect(fixture.view.canView.value).toBe(true);
    expect(fixture.calls.map((call) => call.url)).toEqual([
      "/marketing/user-point/logs", "/marketing/user-point/statistics",
    ]);
    expect(fixture.view.list.value[0].id).toBe(3);
    expect(fixture.view.cards.value.map((card: { value: string }) => card.value)).toEqual(["100", "3", "15", "7"]);

    fixture.view.draftKeyword.value = " VIP ";
    fixture.view.draftType.value = " sign ";
    fixture.view.draftRange.value = ["2026-09-24 09:30", "2026-09-24 10:00"];
    fixture.view.search();
    await flush();
    const start = Date.UTC(2026, 8, 24, 9, 30) / 1000 - 8 * 3600;
    const stop = Date.UTC(2026, 8, 24, 10, 0) / 1000 - 8 * 3600 + 59;
    const filtered = fixture.calls.slice(-2);
    expect(filtered.map((call) => call.url)).toEqual([
      "/marketing/user-point/logs", "/marketing/user-point/statistics",
    ]);
    expect(filtered[0].params).toMatchObject({ page: 1, limit: 15, keyword: "VIP", type: "sign", start, stop });
    expect(filtered[1].params).toMatchObject({ keyword: "VIP", type: "sign", start, stop });
    expect(filtered[1].params).not.toHaveProperty("page");
    expect(fixture.view.cards.value[0].value).toBe("88");

    const callCount = fixture.calls.length;
    await fixture.view.loadList(2);
    expect(fixture.calls).toHaveLength(callCount + 1);
    expect(fixture.calls.at(-1).url).toBe("/marketing/user-point/logs");
    expect(fixture.calls.at(-1).params).toMatchObject({ page: 2, limit: 15, keyword: "VIP" });
    expect(fixture.view.page.value).toBe(2);
    expect(fixture.view.list.value[0].id).toBe(1);
    expect(fixture.view.cards.value[0].value).toBe("88");
    expect(fixture.calls.every((call) => call.method === "get")).toBe(true);
  } finally { fixture.close(); }
});

it("keeps the previous filters when type or date inputs are invalid", async () => {
  const fixture = await mount();
  try {
    const initialCalls = fixture.calls.length;
    fixture.view.draftType.value = "sign;DELETE";
    fixture.view.search();
    await flush();
    expect(fixture.calls).toHaveLength(initialCalls);
    expect(runtime.message.state.errors.at(-1)).toContain("流水类型");

    fixture.view.draftType.value = "sign";
    fixture.view.draftRange.value = ["2026-02-30 09:30", "2026-03-01 10:00"];
    fixture.view.search();
    await flush();
    expect(fixture.calls).toHaveLength(initialCalls);
    expect(runtime.message.state.errors.at(-1)).toContain("时间范围");
  } finally { fixture.close(); }
});

it("ignores stale list and statistics responses and clears both on account replacement", async () => {
  let resolveOldList!: (value: unknown) => void;
  let resolveOldStats!: (value: unknown) => void;
  const oldList = new Promise((done) => { resolveOldList = done; });
  const oldStats = new Promise((done) => { resolveOldStats = done; });
  const fixture = await mount(undefined, (config) => {
    if (config.params?.keyword === "OLD") return config.url.endsWith("/statistics") ? oldStats : oldList;
    if (config.params?.keyword === "NEW") return config.url.endsWith("/statistics")
      ? envelope(stats("88")) : envelope({ ...rows(), list: [row(44)] });
    return undefined;
  });
  try {
    fixture.view.draftKeyword.value = "OLD";
    fixture.view.search();
    await flush();
    const oldCalls = fixture.calls.slice(-2);
    fixture.view.draftKeyword.value = "NEW";
    fixture.view.search();
    await flush();
    expect(oldCalls.every((call) => call.signal.aborted)).toBe(true);
    expect(fixture.view.list.value[0].id).toBe(44);
    expect(fixture.view.stats.value.total_integral).toBe("88");
    resolveOldList(envelope({ ...rows(), list: [row(99)] }));
    resolveOldStats(envelope(stats("999")));
    await flush();
    expect(fixture.view.list.value[0].id).toBe(44);
    expect(fixture.view.stats.value.total_integral).toBe("88");

    login([], "integral-token-b", 21);
    browser.dispatchEvent(new Event("admin-session-changed"));
    await flush();
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.view.list.value).toEqual([]);
    expect(fixture.view.stats.value).toBeNull();
    expect(fixture.view.count.value).toBe(0);
    const callsAfterReplacement = fixture.calls.length;
    await fixture.view.loadList(1);
    await fixture.view.loadStats();
    expect(fixture.calls).toHaveLength(callsAfterReplacement);
  } finally { fixture.close(); }
});
