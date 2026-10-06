import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const adminRoot = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(adminRoot, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");
const path = "/finance/user-money-ledger";
const envelope = (data: unknown) => ({ status: 200, msg: "ok", data });
const row = (id = 11) => ({ id, uid: 5, nickname: "张三", pm: 0, number: "12.50",
  title: "平台扣款", type: "system_sub", mark: "备注", add_time: "2026-09-28 09:10:00" });
const exportRow = (uid: number) => ({ uid: String(uid), nickname: "张三", pm: "-12.50",
  title: "平台扣款", mark: "备注", add_time: "2026-09-28 09:10:00" });
let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { pathname: "/finance/bill", href: "" } }));
  const built = await build({ absWorkingDir: adminRoot, stdin: { resolveDir: adminRoot, contents: `
    export { default as Page } from './src/pages/finance/BillList.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/userMoneyLedger';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
  ` }, alias: { "@": resolve(adminRoot, "src") }, define: { "import.meta.env.DEV": "false" },
  bundle: true, write: false, platform: "browser", format: "esm",
  plugins: [{ name: "user-money-page-runtime", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path: file }) => ({ contents: compileScript(parse(readFileSync(file, "utf8"),
      { filename: file }).descriptor, { id: "user-money-page-runtime" }).content, loader: "ts" }));
  } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
});
beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, { location: { pathname: "/finance/bill", href: "" } }));
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function login(permissions = ["bill.view"], token = "money-a", id = 7) {
  values.set("admin_token", token); values.set("admin_session", JSON.stringify({
    userInfo: { id, account: "operator", level: 1, roles: "" }, menus: [], uniqueAuth: permissions,
  }));
}
function manifest(rows: ReturnType<typeof exportRow>[], page = 1, total = rows.length, snapshot = "a".repeat(64)) {
  const csv = runtime.api.buildUserMoneyCsv(rows);
  return { header: [...runtime.api.userMoneyExportHeaders], filekey: [...runtime.api.userMoneyExportKeys],
    export: rows, filename: "资金监控", count: total, page, limit: 1000,
    has_more: page * 1000 < total, snapshot, csv_bytes: new TextEncoder().encode(csv).byteLength,
    max_rows: 100000, max_bytes: 16777216, timezone: "Asia/Shanghai" };
}
async function mount(permissions = ["bill.view"], respond: (config: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await respond(config);
    const data = custom ?? envelope(config.url === `${path}/types`
      ? { list: [{ type: "", title: "空类型" }, { type: "system_sub", title: "平台扣款" }, { type: "gain", title: "历史类型" }] }
      : config.url === `${path}/export` ? manifest([exportRow(5)])
        : { list: [row()], count: 1, page: config.params.page, limit: 20 });
    return { config, data, status: 200, statusText: "money fixture", headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it("reads user_money through its own 20-row contract and preserves the legacy six columns", async () => {
  const denied = await mount(["service.view"]);
  try { expect(denied.view.canView.value).toBe(false); expect(denied.calls).toEqual([]); }
  finally { denied.close(); }
  const reader = await mount();
  try {
    expect(reader.view.canView.value).toBe(true);
    expect(reader.view.canExport.value).toBe(false);
    expect(reader.calls.map(call => call.url).sort()).toEqual([path, `${path}/types`].sort());
    expect(reader.calls.find(call => call.url === path).params).toEqual({
      keyword: "", type: "", start: 0, stop: 0, page: 1, limit: 20,
    });
    expect(reader.view.list.value[0]).toMatchObject(row());
    expect(reader.view.types.value.map((item: any) => item.type)).toEqual(["system_sub", "gain"]);
    const template = parse(readFileSync(resolve(adminRoot, "src/pages/finance/BillList.vue"), "utf8")).descriptor.template?.content ?? "";
    expect(template.match(/<el-table-column/g)).toHaveLength(6);
    expect(template).not.toContain("v-html");
    expect(template).not.toContain("balance");
    expect(template).not.toContain("category");
    expect(template).toContain("row.pm === 0 ? '-' : ''");
    expect(runtime.api.parseUserMoneyPage({ list: [{ ...row(30), number: "-5.00" }], count: 1, page: 1, limit: 20 },
      { ...runtime.api.normalizeUserMoneyFilters(), page: 1, limit: 20 }).list[0].number).toBe("-5.00");
    await reader.view.exportCsv();
    expect(reader.calls.every(call => call.url !== `${path}/export`)).toBe(true);
  } finally { reader.close(); }
});

it("sends nickname/ID, type and inclusive Shanghai time filters to paging and export", async () => {
  const f = await mount(["bill.view", "bill.export"], config =>
    config.url === path && config.params.page === 2
      ? envelope({ list: [row(22)], count: 21, page: 2, limit: 20 }) : undefined);
  try {
    f.view.draftKeyword.value = "  5  "; f.view.draftType.value = "system_sub";
    f.view.draftRange.value = ["2026-09-28 09:10", "2026-09-28 09:11"];
    f.view.search(); await flush();
    const start = Date.UTC(2026, 8, 28, 1, 10) / 1000;
    expect(f.calls.at(-1).params).toEqual({ keyword: "5", type: "system_sub", start, stop: start + 119, page: 1, limit: 20 });
    await f.view.load(2);
    expect(f.calls.at(-1).params.page).toBe(2);
    expect(f.view.page.value).toBe(2);
    await runtime.api.apiUserMoneyLedgerExport(f.view.filters.value, 1, new AbortController().signal);
    expect(f.calls.at(-1).params).toEqual({ keyword: "5", type: "system_sub", start,
      stop: start + 119, page: 1, limit: 1000 });
    f.view.draftRange.value = ["2026-09-28 09:11", "2026-09-28 09:10"];
    f.view.search();
    expect(f.view.filterError.value).toContain("结束时间");
    expect(f.view.filters.value).toMatchObject({ keyword: "5", type: "system_sub", start, stop: start + 119 });
    f.view.reset(); await flush();
    expect(f.calls.at(-1).params).toEqual({ keyword: "", type: "", start: 0, stop: 0, page: 1, limit: 20 });
  } finally { f.close(); }
});

it("downloads only a complete six-column CSV with matching snapshot and byte count", async () => {
  const clicked = vi.fn();
  vi.stubGlobal("document", { createElement: () => ({ href: "", download: "", style: {}, click: clicked, remove() {} }),
    body: { appendChild() {} } });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:money");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const f = await mount(["bill.view", "bill.export"]);
  try {
    await f.view.exportCsv();
    expect(f.calls.at(-1)).toMatchObject({ method: "get", url: `${path}/export` });
    expect(f.calls.at(-1).params).toMatchObject({ page: 1, limit: 1000, keyword: "" });
    expect(clicked).toHaveBeenCalledOnce();
    expect(f.view.exportError.value).toBe("");
    const csv = runtime.api.buildUserMoneyCsv([exportRow(5)]);
    expect(csv).toContain('"会员ID","昵称","金额","类型","备注","创建时间"\r\n');
    expect(csv).toContain('"5","张三","-12.50","平台扣款","备注","2026-09-28 09:10:00"');
  } finally { f.close(); }
});

it("rejects changed snapshots, mismatched byte counts and unprotected spreadsheet formulas", async () => {
  const allRows = Array.from({ length: 1001 }, (_, index) => exportRow(index + 1));
  const bytes = new TextEncoder().encode(runtime.api.buildUserMoneyCsv(allRows)).byteLength;
  const first = { ...manifest(allRows.slice(0, 1000), 1, 1001), csv_bytes: bytes };
  const second = { ...manifest(allRows.slice(1000), 2, 1001), csv_bytes: bytes };
  const f = await mount(["bill.view", "bill.export"], config => {
    if (config.url !== `${path}/export`) return undefined;
    return envelope(config.params.page === 1 ? first : second);
  });
  try {
    const progress: Array<[number, number]> = [];
    const result = await runtime.api.collectUserMoneyExport(runtime.api.normalizeUserMoneyFilters(), new AbortController().signal,
      (read: number, total: number) => progress.push([read, total]));
    expect(progress).toEqual([[1000, 1001], [1001, 1001]]);
    expect(f.calls.filter(call => call.url === `${path}/export`).at(-1).params.snapshot).toBe(first.snapshot);
    expect(new TextEncoder().encode(result.csv).byteLength).toBe(bytes);
  } finally { f.close(); }
  const wrongSnapshot = { ...second, snapshot: "b".repeat(64) };
  const changed = await mount(["bill.view", "bill.export"], config => config.url === `${path}/export`
    ? envelope(config.params.page === 1 ? first : wrongSnapshot) : undefined);
  try {
    await expect(runtime.api.collectUserMoneyExport(runtime.api.normalizeUserMoneyFilters(),
      new AbortController().signal, () => {})).rejects.toThrow("快照");
  } finally { changed.close(); }
  const one = exportRow(1);
  expect(() => runtime.api.parseUserMoneyPage({ list: [row(), row()], count: 2, page: 1, limit: 20 },
    { ...runtime.api.normalizeUserMoneyFilters(), page: 1, limit: 20 })).toThrow("记录");
  expect(() => runtime.api.normalizeUserMoneyFilters({ start: 1780000000, stop: 0 })).toThrow();
  const bad = await mount(["bill.view", "bill.export"], config => config.url === `${path}/export`
    ? envelope({ ...manifest([{ ...one, nickname: "=HYPERLINK(...)" }]), csv_bytes: 1 }) : undefined);
  try {
    await expect(runtime.api.collectUserMoneyExport(runtime.api.normalizeUserMoneyFilters(),
      new AbortController().signal, () => {})).rejects.toThrow("表格公式");
  } finally { bad.close(); }
  const wrongBytes = await mount(["bill.view", "bill.export"], config => config.url === `${path}/export`
    ? envelope({ ...manifest([one]), csv_bytes: 1 }) : undefined);
  try {
    await expect(runtime.api.collectUserMoneyExport(runtime.api.normalizeUserMoneyFilters(),
      new AbortController().signal, () => {})).rejects.toThrow("字节数");
  } finally { wrongBytes.close(); }
});

it("discards late list results and cancels export when the admin account changes", async () => {
  const lateList = deferred<unknown>(); let holdList = false;
  const f = await mount(["bill.view", "bill.export"], config => holdList && config.url === path ? lateList.promise : undefined);
  try {
    holdList = true; const pending = f.view.load(2); await flush();
    const oldCall = f.calls.at(-1);
    login(["service.view"], "money-b", 8); browser.dispatchEvent(new Event("admin-session-changed"));
    expect(oldCall.signal.aborted).toBe(true);
    lateList.resolve(envelope({ list: [row(22)], count: 21, page: 2, limit: 20 }));
    await pending; await flush();
    expect(f.view.canView.value).toBe(false);
    expect(f.view.list.value).toEqual([]);
  } finally { f.close(); }
  const lateExport = deferred<unknown>();
  const second = await mount(["bill.view", "bill.export"], config =>
    config.url === `${path}/export` ? lateExport.promise : undefined);
  try {
    const pending = second.view.exportCsv(); await flush();
    const exportCall = second.calls.at(-1);
    login(["bill.view"], "money-c", 9); browser.dispatchEvent(new Event("admin-session-changed"));
    expect(exportCall.signal.aborted).toBe(true);
    lateExport.resolve(envelope(manifest([exportRow(5)])));
    await pending; await flush();
    expect(second.view.canExport.value).toBe(false);
    expect(second.view.exporting.value).toBe(false);
  } finally { second.close(); }
});
