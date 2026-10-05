import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(root, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");
let runtime: any;
let browser: EventTarget;

beforeAll(async () => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { pathname: "/system/log", href: "" } }));
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  const result = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, contents: `
      export { default as Page } from './src/pages/system/LogList.vue';
      export { default as request } from './src/utils/request';
      export { createRenderer, nextTick } from 'vue';
      export { createPinia } from 'pinia';
      export * as messages from 'element-plus';
    ` },
    alias: { "@": resolve(root, "src") },
    define: { "import.meta.env.DEV": "false" },
    bundle: true, write: false, platform: "browser", format: "esm",
    plugins: [{ name: "system-log-page", setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, "utf8"), { filename: path }).descriptor, { id: "system-log" }).content,
        loader: "ts",
      }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: "messages", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export const state = { errors: [] };
        export const ElMessage = { error: value => state.errors.push(value) };
      ` }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  browser = Object.assign(new EventTarget(), { location: { pathname: "/system/log", href: "" } });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  runtime.messages.state.errors = [];
});
afterEach(() => vi.unstubAllGlobals());

const flush = async () => {
  for (let i = 0; i < 6; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); }
};

function login(permissions = ["log.view"], token = "log-token-a", id = 20) {
  storage.set("admin_token", token);
  storage.set("admin_session", JSON.stringify({ userInfo: { id, account: "operator", level: 1, roles: "" }, menus: [], uniqueAuth: permissions }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const logRow = (id: number) => ({ id, admin_id: id, admin_name: `操作员 ${id}`, path: "/orders", page: "查看",
  action: "", ip: "10.0.0.3", type: "admin", add_time: 1790557200 });
const response = (id: number) => ({ list: [logRow(id)], total: 21, count: 21 });

async function mount(permissions = ["log.view"], respond?: (config: any) => unknown) {
  login(permissions);
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const data = respond ? await respond(config) : config.url === "/log/admin-options"
      ? { info: [{ id: 3, real_name: "操作员" }] } : response(config.params.page);
    return { config, data: { status: 200, msg: "ok", data }, status: 200, statusText: "fixture", headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({
    createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {},
  });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) {
    view = runtime.Page.setup(props, context);
    return () => null;
  } });
  app.use(runtime.createPinia());
  app.mount({ children: [] });
  await flush();
  return { view, calls, close: () => app.unmount() };
}

it("loads only log.view reads and keeps legacy columns, server total and options", async () => {
  const fixture = await mount();
  try {
    expect(fixture.calls.map(call => call.url).sort()).toEqual(["/log/admin-options", "/log/list"]);
    expect(fixture.calls.every(call => call.method === "get")).toBe(true);
    expect(fixture.view.admins.value).toEqual([{ id: 3, real_name: "操作员" }]);
    expect(fixture.view.total.value).toBe(21);
    expect(fixture.view.canView.value).toBe(true);
    expect(fixture.view.list.value[0]).toMatchObject({ path: "/orders", page: "查看", type: "admin" });
    expect(fixture.view.formatTime(1790557200)).toMatch(/^2026-09-28 /);
  } finally { fixture.close(); }
});

it("does not issue either GET or retain data without the current log.view grant", async () => {
  const fixture = await mount(["order.view"]);
  try {
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.calls).toEqual([]);
    await fixture.view.load(1);
    await fixture.view.loadOptions();
    expect(fixture.calls).toEqual([]);
    expect(fixture.view.list.value).toEqual([]);
    expect(fixture.view.admins.value).toEqual([]);
  } finally { fixture.close(); }
});

it("sends typed Shanghai time and admin/path/IP filters, then clears them on reset", async () => {
  const fixture = await mount();
  try {
    Object.assign(fixture.view.filters, { adminId: 3, path: " /orders ", ip: " 10.0.0.3 ",
      timeRange: ["2026-09-28 09:00:00", "2026-09-28 10:00:01"] });
    await fixture.view.load(2);
    expect(fixture.calls.at(-1).params).toEqual({ page: 2, limit: 20, admin_id: 3, path: "/orders", ip: "10.0.0.3",
      start_time: Math.floor(Date.parse("2026-09-28T09:00:00+08:00") / 1000),
      end_time: Math.floor(Date.parse("2026-09-28T10:00:01+08:00") / 1000) });
    expect(fixture.view.page.value).toBe(2);
    fixture.view.reset(); await flush();
    expect(fixture.calls.at(-1).params).toEqual({ page: 1, limit: 20 });
  } finally { fixture.close(); }
});

it("aborts old-account GETs and discards late list and admin-option results after switching accounts", async () => {
  const oldList = deferred<unknown>(), oldOptions = deferred<unknown>();
  const fixture = await mount(["log.view"], config => {
    const old = config.headers["Authori-zation"] === "Bearer log-token-a";
    if (old) return config.url === "/log/list" ? oldList.promise : oldOptions.promise;
    return config.url === "/log/list" ? response(30) : { info: [{ id: 30, real_name: "新账号管理员" }] };
  });
  try {
    const stale = [...fixture.calls];
    expect(stale.map(call => call.url).sort()).toEqual(["/log/admin-options", "/log/list"]);
    login(["log.view"], "log-token-b", 30);
    browser.dispatchEvent(new Event("admin-session-changed"));
    await flush();
    expect(stale.every(call => call.signal.aborted)).toBe(true);
    expect(fixture.view.list.value.map((row: any) => row.id)).toEqual([30]);
    expect(fixture.view.admins.value).toEqual([{ id: 30, real_name: "新账号管理员" }]);
    oldList.resolve(response(20));
    oldOptions.resolve({ info: [{ id: 20, real_name: "旧账号管理员" }] });
    await flush();
    expect(fixture.view.list.value.map((row: any) => row.id)).toEqual([30]);
    expect(fixture.view.admins.value).toEqual([{ id: 30, real_name: "新账号管理员" }]);
    expect(runtime.messages.state.errors).toEqual([]);
    const priorCalls = fixture.calls.length;
    login(["order.view"], "log-token-c", 40);
    browser.dispatchEvent(new Event("admin-session-changed"));
    await flush();
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.view.list.value).toEqual([]);
    expect(fixture.view.admins.value).toEqual([]);
    expect(fixture.calls).toHaveLength(priorCalls);
  } finally { fixture.close(); }
});

it("clears and aborts both requests when the page unmounts", async () => {
  const oldList = deferred<unknown>(), oldOptions = deferred<unknown>();
  const fixture = await mount(["log.view"], config => config.url === "/log/list" ? oldList.promise : oldOptions.promise);
  const stale = [...fixture.calls];
  fixture.close();
  expect(stale.every(call => call.signal.aborted)).toBe(true);
  oldList.resolve(response(20));
  oldOptions.resolve({ info: [{ id: 20, real_name: "旧账号管理员" }] });
  await flush();
  expect(fixture.view.list.value).toEqual([]);
  expect(fixture.view.admins.value).toEqual([]);
  expect(runtime.messages.state.errors).toEqual([]);
});
