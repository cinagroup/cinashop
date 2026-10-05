import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(root, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");
const listUrl = "/merchant/verify_order", storesUrl = `${listUrl}/stores`;
const spreadUrl = "/merchant/verify/spread_info/7";
const envelope = (data: unknown) => ({ status: 200, msg: "ok", data });
function order(id = 44) {
  return { id, order_id: `WX${id}`, uid: 7, nickname: "核销用户", spread_nickname: "推荐人", pay_price: "15.00",
    clerk_name: "店员", store_name: "中心店", pay_type_name: "微信已支付", status_name: "已核销",
    add_time: 1790557200, pay_time: 1790557260,
    goods: [{ name: "商品", spec: "红色", image: "/uploads/p.png", true_price: "5.00", cart_num: 3 }], issues: [] };
}
const stores = { list: [{ id: 3, name: "中心店" }] };
const spread = { spread: { uid: 9, nickname: "推荐人", avatar: "/uploads/u.png", now_money: "2.00",
  brokerage_price: "3.00", real_name: "王某", phone: "13800000009", integral: 7, mark: "备注",
  birthday: 0, last_time: 1790557260 } };
let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { innerWidth: 1280,
    location: { pathname: "/operations/writeoff-orders", href: "" } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/operations/WriteoffOrders.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/writeoffOrders';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
  ` }, alias: { "@": resolve(root, "src") }, define: { "import.meta.env.DEV": "false" },
    bundle: true, write: false, platform: "browser", format: "esm",
    plugins: [{ name: "writeoff-orders-runtime", setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8"),
        { filename: path }).descriptor, { id: "writeoff-orders-runtime" }).content, loader: "ts" }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});
beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, { innerWidth: 1280,
    location: { pathname: "/operations/writeoff-orders", href: "" } }));
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function login(permissions = ["writeoff_order.view"], token = "writeoff-token-a", id = 20) {
  values.set("admin_token", token);
  values.set("admin_session", JSON.stringify({ userInfo: { id, account: "operator", level: 1, roles: "" },
    menus: [], uniqueAuth: permissions }));
}
async function mount(permissions = ["writeoff_order.view"], respond: (config: any) => Promise<unknown> | unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    const data = custom ?? envelope(config.url === storesUrl ? stores : config.url === spreadUrl ? spread
      : { list: [order()], count: 16, page: config.params.page, limit: 15, badge: [] });
    return { config, data, status: 200, statusText: "isolated writeoff fixture", headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it("enforces the independent writeoff role and only the three GET read routes", async () => {
  const denied = await mount(["order.view", "store.view"]);
  try { expect(denied.view.canView.value).toBe(false); expect(denied.calls).toEqual([]); } finally { denied.close(); }
  const viewer = await mount();
  try {
    expect(viewer.calls.map(call => call.url).sort()).toEqual([listUrl, storesUrl].sort());
    expect(viewer.calls.every(call => call.method === "get")).toBe(true);
    expect(viewer.view.list.value[0]).toMatchObject({ order_id: "WX44", status_name: "已核销", goods: [{ name: "商品" }] });
    expect(viewer.view.stores.value).toEqual(stores.list);
    expect(runtime.api.writeoffTime(1790557206)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:06$/u);
    expect(runtime.api.writeoffTime(1790557206, true)).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    const page = readFileSync(resolve(root, "src/pages/operations/WriteoffOrders.vue"), "utf8");
    expect(page).toContain("订单创建时间（上海时间）");
    expect(page).not.toContain("v-html");
    expect(page).not.toContain("card_id");
    expect(page).toMatch(/prop="order_id"[^>]*sortable/);
    expect(page).toMatch(/prop="add_time"[^>]*sortable/);
    expect(readFileSync(resolve(root, "src/router/index.ts"), "utf8")).toContain('path: "operations/writeoff-orders"');
    expect(readFileSync(resolve(root, "src/layouts/AdminLayout.vue"), "utf8")).toContain("canMenu('/operations/writeoff-orders')");
  } finally { viewer.close(); }
});

it("passes old date presets, exact field keys, store scope and 15-row pagination", async () => {
  const f = await mount();
  try {
    f.view.draftPreset.value = "lately7"; f.view.choosePreset(); await flush();
    expect(f.calls.filter(call => call.url === listUrl).at(-1).params).toMatchObject({ data: "lately7", page: 1, limit: 15 });
    f.view.draftDates.value = ["2026/09/01", "2026/09/28"]; f.view.chooseDates();
    f.view.draftField.value = "title"; f.view.draftKeyword.value = " 商品 "; f.view.draftStore.value = 3;
    f.view.search(); await flush();
    expect(f.calls.filter(call => call.url === listUrl).at(-1).params).toEqual({
      page: 1, limit: 15, data: "2026/09/01-2026/09/28", real_name: "商品", field_key: "title", store_id: 3 });
    await f.view.load(2);
    expect(f.calls.filter(call => call.url === listUrl).at(-1).params.page).toBe(2);
    expect(f.view.page.value).toBe(2);
    f.view.reset(); await flush();
    expect(f.calls.filter(call => call.url === listUrl).at(-1).params).toEqual({
      page: 1, limit: 15, data: "", real_name: "", field_key: "all", store_id: "" });
  } finally { f.close(); }
});

it("reads only white-listed referrer details and rejects malformed page, snapshot and identity", async () => {
  const f = await mount();
  try {
    await f.view.openSpread(f.view.list.value[0]);
    expect(f.calls.at(-1).url).toBe(spreadUrl);
    expect(f.view.spread.value).toEqual({ ...spread.spread, integral: "7" });
    expect(f.calls.every(call => call.method === "get")).toBe(true);
  } finally { f.close(); }
  expect(() => runtime.api.parseWriteoffOrderPage({ list: [order(), order()], count: 2, page: 1, limit: 15, badge: [] },
    { page: 1, limit: 15, data: "", real_name: "", field_key: "all", store_id: "" })).toThrow("重复");
  expect(() => runtime.api.parseWriteoffOrder({ ...order(), goods: [{ ...order().goods[0], cart_num: "3" }] })).toThrow();
  expect(() => runtime.api.parseWriteoffSpread({ spread: { ...spread.spread, phone: null } })).toThrow();
  expect(() => runtime.api.parseWriteoffSpread({ spread: { ...spread.spread, integral: -1 } })).toThrow();
  expect(() => runtime.api.parseWriteoffSpread({ spread: { ...spread.spread, integral: 7.5 } })).toThrow();
  expect(() => runtime.api.parseWriteoffSpread({ spread: { ...spread.spread, integral: 2_147_483_648 } })).toThrow();
  expect(runtime.api.parseWriteoffSpread({ spread: { ...spread.spread, card_id: "must-not-escape" } }))
    .not.toHaveProperty("card_id");
  expect(() => runtime.api.parseWriteoffStores({ list: [stores.list[0], stores.list[0]] })).toThrow("重复");
});

it("rejects invalid Shanghai dates and query bounds before issuing requests", async () => {
  const f = await mount();
  try {
    const before = f.calls.length;
    f.view.draftDates.value = ["2026/02/30", "2026/03/01"]; f.view.search(); await flush();
    expect(f.calls).toHaveLength(before); expect(f.view.filterError.value).toContain("日期");
    for (const bad of ["2026/09/29-2026/09/28", "2038/01/19-2038/01/19", "2026/09/01-2027/09/02"])
      expect(() => runtime.api.normalizeWriteoffOrderQuery({ page: 1, limit: 15, data: bad,
        real_name: "", field_key: "all", store_id: "" })).toThrow();
    expect(() => runtime.api.normalizeWriteoffOrderQuery({ page: 668, limit: 15, data: "",
      real_name: "", field_key: "all", store_id: "" })).toThrow();
    expect(() => runtime.api.normalizeWriteoffOrderQuery({ page: 1, limit: 15, data: "",
      real_name: "x", field_key: "uid", store_id: "" })).toThrow();
  } finally { f.close(); }
});

it("aborts and discards late list and referrer responses on close or account switch", async () => {
  const lateSpread = deferred<unknown>(), lateList = deferred<unknown>(), lateStores = deferred<unknown>();
  let delay = false;
  const f = await mount(["writeoff_order.view"], config => {
    if (config.url === spreadUrl) return lateSpread.promise;
    if (config.url === listUrl && delay) return lateList.promise;
    if (config.url === storesUrl && delay) return lateStores.promise;
    return undefined;
  });
  try {
    const pendingSpread = f.view.openSpread(f.view.list.value[0]);
    await flush();
    const spreadCall = f.calls.find(call => call.url === spreadUrl);
    expect(spreadCall).toBeDefined();
    f.view.spreadVisible.value = false; await flush();
    expect(spreadCall.signal.aborted).toBe(true);
    lateSpread.resolve(envelope(spread)); await pendingSpread;
    expect(f.view.spread.value).toBeNull();
    delay = true; const start = f.calls.length;
    const pendingList = f.view.load(2), pendingStores = f.view.loadStores();
    await flush();
    login(["store.view"], "writeoff-token-b", 21); browser.dispatchEvent(new Event("admin-session-changed"));
    const stale = f.calls.slice(start);
    expect(stale.map(call => call.url).sort()).toEqual([listUrl, storesUrl].sort());
    expect(stale.every(call => call.signal.aborted)).toBe(true);
    lateList.resolve(envelope({ list: [order()], count: 16, page: 2, limit: 15, badge: [] }));
    lateStores.resolve(envelope(stores)); await Promise.all([pendingList, pendingStores]); await flush();
    expect(f.view.canView.value).toBe(false);
    expect(f.view.list.value).toEqual([]); expect(f.view.stores.value).toEqual([]); expect(f.view.spread.value).toBeNull();
  } finally { f.close(); }
});
