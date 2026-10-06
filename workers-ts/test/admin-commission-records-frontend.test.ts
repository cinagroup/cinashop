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
const endpoint = "/finance/commissions";
const envelope = (data: unknown) => ({ status: 200, msg: "ok", data });
const row = (uid = 7) => ({ uid, nickname: `用户${uid}`, phone: "13800000007", display_name: `用户${uid}|13800000007|${uid}`,
  now_money: "5.00", brokerage_price: "8.00", extract_price: "2.00", sum_number: "10.00",
  time: 1790557200, user_deleted: false, issues: [] });
const detail = (uid = 7) => ({ uid, nickname: `用户${uid}`, spread_name: "上级", number: "12.00", now_money: "5.00",
  brokerage_price: "8.00", add_time: 1790557200, user_deleted: false, issues: [] });
const record = (id = 31) => ({ id, number: "3.00", add_time: 1790557200, mark: "佣金", pm: 0, type: "refund", status: -1, issues: [] });

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { innerWidth: 1280, location: { pathname: "/finance/commissions", href: "" } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/finance/CommissionRecords.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/commissionRecords';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
  ` }, alias: { "@": resolve(root, "src") }, define: { "import.meta.env.DEV": "false" }, bundle: true,
    write: false, platform: "browser", format: "esm", plugins: [{ name: "commission-records-runtime", setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8"), { filename: path }).descriptor,
        { id: "commission-records-runtime" }).content, loader: "ts" }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

let values: Map<string, string>;
function login(permissions = ["commission.view"], token = "commission-token-a", id = 20) {
  values.set("admin_token", token);
  values.set("admin_session", JSON.stringify({ userInfo: { id, account: "operator", level: 1, roles: "" }, menus: [], uniqueAuth: permissions }));
}
beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, { innerWidth: 1280, location: { pathname: "/finance/commissions", href: "" } }));
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function mount(permissions = ["commission.view"], respond: (config: any) => Promise<unknown> | unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    const data = custom ?? envelope(config.url.endsWith("/records")
      ? { list: [record()], count: 21, page: config.params.page, limit: 20 }
      : config.url === `${endpoint}/7` ? detail()
      : { list: [row()], count: 21, page: config.params.page, limit: 20 });
    return { config, data, status: 200, statusText: "commission fixture", headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it("keeps an independent view role and only GET routes for the new finance screen", async () => {
  const denied = await mount(["distribution.view"]);
  try { expect(denied.view.canView.value).toBe(false); expect(denied.calls).toEqual([]); } finally { denied.close(); }
  const viewer = await mount();
  try {
    expect(viewer.calls.map(call => call.url)).toEqual([endpoint]);
    expect(viewer.calls.every(call => call.method === "get")).toBe(true);
    expect(viewer.view.list.value[0]).toMatchObject({ display_name: "用户7|13800000007|7", sum_number: "10.00", extract_price: "2.00" });
    expect(readFileSync(resolve(root, "src/router/index.ts"), "utf8")).toContain('path: "finance/commissions"');
    expect(readFileSync(resolve(root, "src/layouts/AdminLayout.vue"), "utf8")).toContain("canMenu('/finance/commissions')");
    expect(readFileSync(resolve(root, "src/pages/finance/CommissionRecords.vue"), "utf8")).toContain("导出待迁移");
  } finally { viewer.close(); }
});

it("filters nickname, current brokerage balance and Shanghai time, with matching pagination", async () => {
  const f = await mount();
  try {
    f.view.draftKeyword.value = " 用户 "; f.view.draftMin.value = "1.50"; f.view.draftMax.value = "9";
    f.view.draftDates.value = ["2026-09-28 09:00", "2026-09-28 10:30"];
    f.view.search(); await flush();
    expect(f.calls.at(-1)).toMatchObject({ url: endpoint, params: { page: 1, limit: 20, keyword: "用户", price_min: "1.50",
      price_max: "9", start_time: "2026-09-28 09:00", end_time: "2026-09-28 10:30" } });
    await f.view.load(2);
    expect(f.calls.at(-1).params.page).toBe(2);
    expect(f.view.page.value).toBe(2);
    f.view.reset(); await flush();
    expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 20, keyword: "", price_min: "", price_max: "", start_time: "", end_time: "" });
  } finally { f.close(); }
});

it("opens detail and signed-status ledger, filters it by day and never posts writes", async () => {
  const f = await mount();
  try {
    await f.view.openDetail(f.view.list.value[0]);
    expect(f.calls.slice(-2).map(call => call.url).sort()).toEqual([`${endpoint}/7`, `${endpoint}/7/records`]);
    expect(f.view.detail.value).toMatchObject({ spread_name: "上级", number: "12.00" });
    expect(f.view.records.value[0]).toMatchObject({ number: "3.00", status: -1, pm: 0 });
    f.view.recordDates.value = ["2026-09-01", "2026-09-28"];
    await f.view.loadRecords(2);
    expect(f.calls.at(-1).params).toEqual({ page: 2, limit: 20, start_time: "2026-09-01", end_time: "2026-09-28" });
    expect(f.calls.every(call => call.method === "get")).toBe(true);
  } finally { f.close(); }
});

it("rejects invalid price and dates before requesting, including Shanghai pre-epoch and int32 overflow", async () => {
  const f = await mount();
  try {
    const before = f.calls.length;
    f.view.draftMin.value = "9.99"; f.view.draftMax.value = "8.00"; f.view.search(); await flush();
    expect(f.calls).toHaveLength(before); expect(f.view.filterError.value).toContain("无效");
    f.view.draftMin.value = f.view.draftMax.value = "";
    f.view.draftDates.value = ["1970-01-01 00:00", "1970-01-01 00:01"]; f.view.search(); await flush();
    expect(f.calls).toHaveLength(before); expect(f.view.filterError.value).toContain("范围");
    f.view.draftDates.value = ["2038-01-19 11:14", "2038-01-19 11:14"]; f.view.search(); await flush();
    expect(f.calls).toHaveLength(before);
    expect(() => runtime.api.normalizeCommissionRecordsQuery({ page: 1, limit: 20, start_time: "2026-09-28", end_time: "2026-09-28 10:00" })).toThrow();
  } finally { f.close(); }
});

it("aborts and discards late list, detail and records after an account switch", async () => {
  const listDelay = deferred<unknown>(), detailDelay = deferred<unknown>(), recordsDelay = deferred<unknown>();
  let delayList = false;
  const f = await mount(["commission.view"], config => {
    if (config.url === endpoint && delayList) return listDelay.promise;
    if (config.url === `${endpoint}/7`) return detailDelay.promise;
    if (config.url.endsWith("/records")) return recordsDelay.promise;
    return undefined;
  });
  try {
    const pendingDetail = f.view.openDetail(f.view.list.value[0]);
    delayList = true; const pendingList = f.view.load(2);
    login(["bill.view"], "commission-token-b", 22); browser.dispatchEvent(new Event("admin-session-changed"));
    expect(f.view.list.value).toEqual([]); expect(f.view.detail.value).toBeNull(); expect(f.view.records.value).toEqual([]);
    const stale = f.calls.slice(1);
    expect(stale.every(call => call.signal.aborted)).toBe(true);
    listDelay.resolve(envelope({ list: [row()], count: 21, page: 2, limit: 20 }));
    detailDelay.resolve(envelope(detail())); recordsDelay.resolve(envelope({ list: [record()], count: 21, page: 1, limit: 20 }));
    await Promise.all([pendingList, pendingDetail]); await flush();
    expect(f.view.canView.value).toBe(false); expect(f.view.list.value).toEqual([]);
    expect(f.view.detail.value).toBeNull(); expect(f.view.records.value).toEqual([]);
  } finally { f.close(); }
});
