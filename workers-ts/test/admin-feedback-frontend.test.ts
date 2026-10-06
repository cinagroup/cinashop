import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(root, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");
const base = "/feedback";
const envelope = (data: unknown) => ({ status: 200, msg: "ok", data });
const row = (id = 7, status = 0) => ({ id, uid: 0, rela_name: "匿名访客", phone: "13800000000",
  content: "&lt;留言&gt;", make: "原备注", status, add_time: 1789819200 });
let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { pathname: "/kefu/feedback", href: "" } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/kefu/Feedback.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/feedback';
    export * as messages from 'element-plus';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
  ` }, alias: { "@": resolve(root, "src") }, define: { "import.meta.env.DEV": "false" },
  bundle: true, write: false, platform: "browser", format: "esm",
  plugins: [{ name: "feedback-runtime", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8"),
      { filename: path }).descriptor, { id: "feedback-runtime" }).content, loader: "ts" }));
    builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: "messages", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export const state = { successes: [], confirmations: [], confirm: () => Promise.resolve() };
      export const ElMessage = { success: value => state.successes.push(value) };
      export const ElMessageBox = { confirm(...args) { state.confirmations.push(args); return state.confirm(...args); } };
    ` }));
  } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});
beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, { location: { pathname: "/kefu/feedback", href: "" } }));
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.messages.state.successes = []; runtime.messages.state.confirmations = [];
  runtime.messages.state.confirm = () => Promise.resolve();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function login(permissions = ["feedback.view"], token = "feedback-token-a", id = 20) {
  values.set("admin_token", token); values.set("admin_session", JSON.stringify({
    userInfo: { id, account: "operator", level: 1, roles: "" }, menus: [], uniqueAuth: permissions,
  }));
}
async function mount(permissions = ["feedback.view"], respond: (config: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await respond(config);
    const data = custom ?? envelope(config.url === base && config.method === "get"
      ? { data: [row()], count: 16, page: config.params.page, limit: 15 }
      : config.url === `${base}/7` && config.method === "get" ? row() : null);
    return { config, data, status: 200, statusText: "feedback fixture", headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it("uses independent feedback.view/manage and preserves orphan/anonymous content as safe text", async () => {
  const denied = await mount(["service.view"]);
  try { expect(denied.view.canView.value).toBe(false); expect(denied.calls).toEqual([]); }
  finally { denied.close(); }
  const reader = await mount();
  try {
    expect(reader.view.canView.value).toBe(true); expect(reader.view.canManage.value).toBe(false);
    expect(reader.calls).toHaveLength(1); expect(reader.calls[0]).toMatchObject({ method: "get", url: base, baseURL: "/adminapi" });
    expect(reader.view.list.value[0]).toMatchObject({ uid: 0, rela_name: "匿名访客" });
    await reader.view.openDetail(reader.view.list.value[0]);
    expect(reader.calls.at(-1)).toMatchObject({ method: "get", url: `${base}/7` });
    await reader.view.save(); await reader.view.remove(reader.view.list.value[0]);
    expect(reader.calls.every(call => call.method === "get")).toBe(true);
    const template = parse(readFileSync(resolve(root, "src/pages/kefu/Feedback.vue"), "utf8")).descriptor.template?.content ?? "";
    expect(template).not.toContain("v-html");
    expect(runtime.api.feedbackText("&lt;script&gt;&amp;&#039;&quot;")).toBe("<script>&'\"");
  } finally { reader.close(); }
});

it("submits old 15-row, title, status and Shanghai date selectors with exact custom boundary", async () => {
  const f = await mount();
  try {
    f.view.draftTitle.value = " 匿名 "; f.view.draftStatus.value = 0;
    f.view.draftDates.value = ["2026/09/01", "2026/09/28"]; f.view.chooseDates(); f.view.search(); await flush();
    expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 15, title: "匿名", status: 0,
      time: "2026/09/01-2026/09/28" });
    await f.view.load(2);
    expect(f.calls.at(-1).params.page).toBe(2);
    f.view.draftPreset.value = "lately7"; f.view.choosePreset(); await flush();
    expect(f.calls.at(-1).params.time).toBe("lately7");
    f.view.reset(); await flush();
    expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 15, title: "", time: "", status: "" });
    expect(() => runtime.api.normalizeFeedbackQuery({ page: 1, limit: 15, title: "", status: "",
      time: "2026/02/30-2026/03/01" })).toThrow();
    expect(() => runtime.api.normalizeFeedbackQuery({ page: 668, limit: 15, title: "", status: "", time: "" })).toThrow();
    expect(() => runtime.api.parseFeedbackPage({ data: [row(), row()], count: 2, page: 1, limit: 15 },
      { page: 1, limit: 15, title: "", time: "", status: "" })).toThrow("重复");
  } finally { f.close(); }
});

it("manager saves note/one-way process and confirms delete; processed row sends note only", async () => {
  const f = await mount(["feedback.manage"]);
  try {
    expect(f.view.canView.value).toBe(true); expect(f.view.canManage.value).toBe(true);
    await f.view.openDetail(f.view.list.value[0]); f.view.draftMake.value = "已联系";
    f.view.markProcessed.value = true; await f.view.save();
    const update = f.calls.find(call => call.method === "put");
    expect(update.url).toBe(`${base}/7`); expect(JSON.parse(update.data)).toEqual({ make: "已联系", status: 1 });
    await f.view.remove(f.view.list.value[0]);
    expect(runtime.messages.state.confirmations).toHaveLength(1);
    expect(f.calls.find(call => call.method === "delete")?.url).toBe(`${base}/7`);
  } finally { f.close(); }
  const processed = await mount(["feedback.manage"], config =>
    config.url === `${base}/7` && config.method === "get" ? envelope(row(7, 1)) : undefined);
  try { await processed.view.openDetail(processed.view.list.value[0]);
    processed.view.draftMake.value = "补充"; await processed.view.save();
    expect(JSON.parse(processed.calls.find(call => call.method === "put").data)).toEqual({ make: "补充" });
  } finally { processed.close(); }
});

it("drops late detail/list results and cannot delete after account switch during confirmation", async () => {
  const lateList = deferred<unknown>(), lateConfirm = deferred<void>(); let block = false;
  const f = await mount(["feedback.manage"], config =>
    block && config.url === base && config.method === "get" ? lateList.promise : undefined);
  try {
    block = true; const pending = f.view.load(2); await flush();
    const oldCall = f.calls.at(-1);
    login(["service.view"], "feedback-token-b", 21); browser.dispatchEvent(new Event("admin-session-changed"));
    expect(oldCall.signal.aborted).toBe(true);
    lateList.resolve(envelope({ data: [row(99)], count: 1, page: 2, limit: 15 })); await pending; await flush();
    expect(f.view.canView.value).toBe(false); expect(f.view.list.value).toEqual([]);
  } finally { f.close(); }
  const manager = await mount(["feedback.manage"]);
  try { runtime.messages.state.confirm = () => lateConfirm.promise;
    const pending = manager.view.remove(manager.view.list.value[0]); await flush();
    login(["feedback.view"], "feedback-token-c", 22); browser.dispatchEvent(new Event("admin-session-changed"));
    lateConfirm.resolve(); await pending;
    expect(manager.calls.every(call => call.method === "get")).toBe(true);
  } finally { manager.close(); }
});
