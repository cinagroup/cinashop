import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(root, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");
const base = "/wechat/speechcraft";
const envelope = (data: unknown) => ({ status: 200, msg: "ok", data });
const phrase = (id = 21, cateId = 11) => ({ id, kefu_id: 0, cate_id: cateId,
  title: "售后话术", message: "订单 <安全> 信息", sort: 7, add_time: 1780000000 });
const category = (id = 11) => ({ id, name: "售后", sort: 8 });
let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { pathname: "/kefu/speechcraft", href: "" } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/kefu/Speechcraft.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/speechcraft';
    export * as messages from 'element-plus';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
  ` }, alias: { "@": resolve(root, "src") }, define: { "import.meta.env.DEV": "false" },
  bundle: true, write: false, platform: "browser", format: "esm",
  plugins: [{ name: "speechcraft-runtime", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8"),
      { filename: path }).descriptor, { id: "speechcraft-runtime" }).content, loader: "ts" }));
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
  vi.stubGlobal("window", Object.assign(browser, { location: { pathname: "/kefu/speechcraft", href: "" } }));
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.messages.state.successes = []; runtime.messages.state.confirmations = [];
  runtime.messages.state.confirm = () => Promise.resolve();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function login(permissions = ["speechcraft.view"], token = "speechcraft-token-a", id = 20) {
  values.set("admin_token", token); values.set("admin_session", JSON.stringify({
    userInfo: { id, account: "operator", level: 1, roles: "" }, menus: [], uniqueAuth: permissions,
  }));
}
async function mount(permissions = ["speechcraft.view"], respond: (config: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await respond(config);
    const data = custom ?? envelope(config.url === `${base}/categories` && config.method === "get"
      ? [category()] : config.url === base && config.method === "get"
        ? { list: [phrase()], count: 11, page: config.params.page, limit: 10 }
        : config.url === `${base}/21` && config.method === "get" ? phrase()
          : ["post", "put"].includes(config.method) ? { id: Number(config.url.split("/").at(-1)) || 30 } : null);
    return { config, data, status: 200, statusText: "speechcraft fixture", headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it("keeps speechcraft.view independent from chat, reads safely, and never offers writes to a reader", async () => {
  const denied = await mount(["service.view"]);
  try { expect(denied.view.canView.value).toBe(false); expect(denied.calls).toEqual([]); }
  finally { denied.close(); }
  const reader = await mount();
  try {
    expect(reader.view.canView.value).toBe(true); expect(reader.view.canManage.value).toBe(false);
    expect(reader.calls.map(call => `${call.method} ${call.url}`).sort()).toEqual([
      `get ${base}`, `get ${base}/categories`,
    ]);
    expect(reader.calls.find(call => call.url === base).params).toMatchObject({ page: 1, limit: 10, cate_id: "" });
    expect(reader.view.categoryName(99)).toBe("已删除分类 #99");
    await reader.view.openDetail(reader.view.list.value[0]);
    expect(reader.calls.at(-1)).toMatchObject({ method: "get", url: `${base}/21` });
    reader.view.openCreate(); reader.view.openCategoryCreate(); await reader.view.savePhrase();
    await reader.view.removePhrase(reader.view.list.value[0]);
    expect(reader.calls.every(call => call.method === "get")).toBe(true);
    const template = parse(readFileSync(resolve(root, "src/pages/kefu/Speechcraft.vue"), "utf8")).descriptor.template?.content ?? "";
    expect(template).not.toContain("v-html");
  } finally { reader.close(); }
});

it("sends legacy 10-row classification, title and exact content search with bounded inputs", async () => {
  const f = await mount();
  try {
    f.view.selectCategory(11); await flush();
    f.view.draftTitle.value = " 售后 "; f.view.draftMessage.value = "订单物流";
    f.view.search(); await flush();
    expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 10, cate_id: 11, title: "售后", message: "订单物流" });
    await f.view.load(2);
    expect(f.calls.at(-1).params.page).toBe(2);
    expect(() => runtime.api.normalizeSpeechcraftQuery({ page: 2_147_483_648, limit: 10,
      cate_id: "", title: "", message: "" })).toThrow();
    expect(() => runtime.api.parseSpeechcraftPage({ list: [phrase(), phrase()], count: 2, page: 1, limit: 10 },
      { page: 1, limit: 10, cate_id: "", title: "", message: "" })).toThrow("重复");
    expect(() => runtime.api.normalizeSpeechcraftInput({ cate_id: 0, title: "", message: "", sort: 0 })).toThrow();
    expect(() => runtime.api.normalizeSpeechcraftCategoryInput({ name: "", sort: 0 })).toThrow();
    expect(runtime.api.parseSpeechcraftRow({ ...phrase(55), sort: -1 }).sort).toBe(-1);
    expect(runtime.api.parseSpeechcraftCategories([{ ...category(55), sort: -1 }])[0].sort).toBe(-1);
  } finally { f.close(); }
});

it("moves to the preceding page when deleting its only phrase", async () => {
  let deleted = false;
  const f = await mount(["speechcraft.manage"], config => {
    if (config.url === `${base}/22` && config.method === "delete") { deleted = true; return envelope(null); }
    if (config.url === base && config.method === "get" && config.params.page === 2) {
      return envelope({ list: deleted ? [] : [phrase(22)], count: deleted ? 10 : 11,
        page: 2, limit: 10 });
    }
    return undefined;
  });
  try {
    await f.view.load(2);
    expect(f.view.page.value).toBe(2);
    await f.view.removePhrase(f.view.list.value[0]);
    expect(f.view.page.value).toBe(1);
    expect(f.calls.at(-1).params.page).toBe(1);
  } finally { f.close(); }
});

it("lets a manager create/edit categories and phrases, keeping a deleted category reference", async () => {
  const f = await mount(["speechcraft.manage"], config =>
    config.url === `${base}/21` && config.method === "get" ? envelope(phrase(21, 99)) : undefined);
  try {
    f.view.openCategoryCreate(); f.view.categoryEditor.name = "新增分类";
    f.view.categoryEditor.sort = 6; await f.view.saveCategory();
    const categoryPost = f.calls.find(call => call.method === "post" && call.url === `${base}/categories`);
    expect(JSON.parse(categoryPost.data)).toEqual({ name: "新增分类", sort: 6 });
    f.view.categoryCommand("edit", category()); f.view.categoryEditor.name = "改名";
    await f.view.saveCategory();
    const categoryPut = f.calls.find(call => call.method === "put" && call.url === `${base}/categories/11`);
    expect(JSON.parse(categoryPut.data)).toEqual({ name: "改名", sort: 8 });
    f.view.openCreate(); f.view.editor.message = "新增公共话术"; await f.view.savePhrase();
    const phrasePost = f.calls.find(call => call.method === "post" && call.url === base);
    expect(JSON.parse(phrasePost.data)).toEqual({ cate_id: 0, title: "", message: "新增公共话术", sort: 0 });
    await f.view.openDetail(f.view.list.value[0]);
    expect(f.view.editor.cate_id).toBe(99);
    f.view.editor.title = "保留旧分类"; await f.view.savePhrase();
    const phrasePut = f.calls.find(call => call.method === "put" && call.url === `${base}/21`);
    expect(JSON.parse(phrasePut.data)).toMatchObject({ cate_id: 99, title: "保留旧分类" });
    await f.view.removeCategory(category());
    expect(f.calls.find(call => call.method === "delete" && call.url === `${base}/categories/11`)).toBeTruthy();
    await f.view.removePhrase(f.view.list.value[0]);
    expect(f.calls.find(call => call.method === "delete" && call.url === `${base}/21`)).toBeTruthy();
  } finally { f.close(); }
});

it("discards late reads and stops a confirmed deletion after the account changes", async () => {
  const late = deferred<unknown>(); let block = false;
  const f = await mount(["speechcraft.manage"], config => block && config.url === base && config.method === "get" ? late.promise : undefined);
  try {
    block = true; const pending = f.view.load(2); await flush(); const oldCall = f.calls.at(-1);
    login(["service.view"], "speechcraft-token-b", 21); browser.dispatchEvent(new Event("admin-session-changed"));
    expect(oldCall.signal.aborted).toBe(true);
    late.resolve(envelope({ list: [phrase(88)], count: 1, page: 2, limit: 10 })); await pending; await flush();
    expect(f.view.canView.value).toBe(false); expect(f.view.list.value).toEqual([]);
  } finally { f.close(); }
  const manager = await mount(["speechcraft.manage"]);
  try {
    const pendingConfirm = deferred<void>(); runtime.messages.state.confirm = () => pendingConfirm.promise;
    const pending = manager.view.removeCategory(category()); await flush();
    login(["speechcraft.view"], "speechcraft-token-c", 22); browser.dispatchEvent(new Event("admin-session-changed"));
    pendingConfirm.resolve(); await pending;
    expect(manager.calls.every(call => call.method === "get")).toBe(true);
  } finally { manager.close(); }
});

it("does not let an old account's late write unlock the new account's pending write", async () => {
  const first = deferred<unknown>(), second = deferred<unknown>(); let writes = 0;
  const f = await mount(["speechcraft.manage"], config => {
    if (config.url === base && config.method === "post") return ++writes === 1 ? first.promise : second.promise;
    return undefined;
  });
  try {
    f.view.openCreate(); f.view.editor.message = "旧账号提交";
    const pendingFirst = f.view.savePhrase(); await flush();
    expect(f.view.busy.value).toBe(true);
    login(["speechcraft.manage"], "speechcraft-token-b", 22); browser.dispatchEvent(new Event("admin-session-changed"));
    await flush();
    f.view.openCreate(); f.view.editor.message = "新账号提交";
    const pendingSecond = f.view.savePhrase(); await flush();
    expect(f.view.busy.value).toBe(true);
    first.resolve(envelope({ id: 101 })); await pendingFirst;
    expect(f.view.busy.value).toBe(true);
    expect(runtime.messages.state.successes).toEqual([]);
    second.resolve(envelope({ id: 102 })); await pendingSecond;
    expect(f.view.busy.value).toBe(false);
    expect(runtime.messages.state.successes).toEqual(["话术已添加"]);
  } finally { f.close(); }
});
