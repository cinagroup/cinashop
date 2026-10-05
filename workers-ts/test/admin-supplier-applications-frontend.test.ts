import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(root, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");
const versionA = "a".repeat(64);
const versionB = "b".repeat(64);
const envelope = (data: unknown, status = 200, msg = "ok") => ({ status, msg, data });
const row = (id = 1, status = 0, version = versionA) => ({
  id, uid: 80 + id, relation_id: status === 1 ? 20 : 0, phone: "13800000001",
  system_name: `供应商${id}`, name: `联系人${id}`,
  images: ["https://example.test/first.jpg", "https://example.test/second.jpg"],
  mark: "原备注", status, status_label: status === 0 ? "待审核" : status === 1 ? "已通过" : "已拒绝",
  fail_msg: status === 2 ? "资料不全" : "", status_time: 0, add_time: 1786323600,
  account: status === 1 ? "13800000001" : "", activation_required: status === 1,
  activated: false, version,
});
let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    location: { search: "", pathname: "/supplier/applications", href: "" },
  }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/supplier/SupplierApplications.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/supplierApplication';
    export * as messages from 'element-plus';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
  ` }, alias: { "@": resolve(root, "src") }, define: { "import.meta.env.DEV": "false" },
  bundle: true, write: false, platform: "browser", format: "esm",
  plugins: [{ name: "supplier-applications-runtime", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
      contents: compileScript(parse(readFileSync(path, "utf8"), { filename: path }).descriptor,
        { id: "supplier-applications-runtime" }).content,
      loader: "ts",
    }));
    builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: "messages", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export const state = { warnings: [], errors: [], successes: [], confirmations: [],
        confirm: () => Promise.resolve(), closed: 0 };
      export const ElMessage = {
        warning: value => state.warnings.push(value),
        error: value => state.errors.push(value),
        success: value => state.successes.push(value),
      };
      export const ElMessageBox = {
        confirm(...args) { state.confirmations.push(args); return state.confirm(...args); },
        close() { state.closed++; },
      };`,
    }));
  } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, {
    location: { search: "", pathname: "/supplier/applications", href: "" },
  }));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  runtime.messages.state.warnings = [];
  runtime.messages.state.errors = [];
  runtime.messages.state.successes = [];
  runtime.messages.state.confirmations = [];
  runtime.messages.state.confirm = () => Promise.resolve();
  runtime.messages.state.closed = 0;
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const grants = ["supplier_application.view", "supplier_application.manage"];
function login(permissions = grants, token = "supplier-application-a", id = 20): void {
  values.set("admin_token", token);
  values.set("admin_session", JSON.stringify({
    userInfo: { id, account: "operator", level: 1, roles: "" }, menus: [], uniqueAuth: permissions,
  }));
}
const flush = async () => {
  for (let index = 0; index < 8; index++) {
    await new Promise((done) => setTimeout(done, 1));
    await runtime.nextTick();
  }
};
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => { resolve = done; });
  return { promise, resolve };
}
async function mount(permissions = grants, respond: (config: any) => unknown = () => undefined) {
  login(permissions);
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    const data = custom ?? envelope(config.method === "get"
      ? { list: [row(config.params.page)], count: 21 }
      : config.method === "delete" ? { id: Number(config.url.split("/").at(-1)) }
        : config.url.includes("/mark/") ? { id: Number(config.url.split("/").at(-1)), mark: JSON.parse(config.data).mark }
          : { id: Number(config.url.split("/").at(-1)), status: JSON.parse(config.data).status });
    return { config, data, status: 200, statusText: "supplier application fixture", headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({
    createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null,
    patchProp() {}, setText() {}, setElementText() {},
  });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) {
    view = runtime.Page.setup(props, context); return () => null;
  } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}
const writes = (calls: any[]) => calls.filter((call) => call.method !== "get");

it("validates the material version and Shanghai date range, and exposes every image for review", () => {
  const query = { page: 1, limit: 20 };
  expect(runtime.api.parseSupplierApplicationPage({ list: [row()], count: 1 }, query).list[0].version).toBe(versionA);
  for (const invalid of [null, { list: [], count: -1 }, { list: [row(), row()], count: 2 },
    { list: [{ ...row(), version: "" }], count: 1 }, { list: [{ ...row(), images: "bad" }], count: 1 }]) {
    expect(() => runtime.api.parseSupplierApplicationPage(invalid, query)).toThrow();
  }
  expect(runtime.api.supplierApplicationTimeRange(["2024-02-29 12:00:00", "2024-02-29 12:00:00"]))
    .toEqual({ start_time: "2024-02-29 12:00:00", end_time: "2024-02-29 12:00:00" });
  expect(() => runtime.api.supplierApplicationTimeRange(["2026-02-30 00:00:00", "2026-03-01 00:00:00"])).toThrow();
  expect(() => runtime.api.supplierApplicationTimeRange(["2026-09-29 00:00:00", "2026-09-28 00:00:00"])).toThrow();
  const source = readFileSync(resolve(root, "src/pages/supplier/SupplierApplications.vue"), "utf8");
  expect(source.match(/v-for="\(image, index\) in row\.images"/gu)).toHaveLength(2);
  expect(source).toContain(':preview-src-list="row.images"');
  expect(source).toContain('v-if="canManage"');
});

it("gates direct reads and writes, and sends the old 20-row status/keyword/date contract", async () => {
  const denied = await mount(["supplier_extract.view"]);
  try { expect(denied.view.canView.value).toBe(false); expect(denied.calls).toEqual([]); }
  finally { denied.close(); }
  const viewer = await mount(["supplier_application.view"]);
  try {
    expect(viewer.view.canManage.value).toBe(false);
    const item = viewer.view.list.value[0];
    await viewer.view.approve(item); viewer.view.openReject(item);
    viewer.view.openMark(item); await viewer.view.remove(item);
    expect(writes(viewer.calls)).toEqual([]);
    expect(runtime.messages.state.confirmations).toEqual([]);
    viewer.view.draftStatus.value = 0;
    viewer.view.draftKeyword.value = " UID 81 ";
    viewer.view.draftDateRange.value = ["2026-08-01 00:00:00", "2026-08-31 23:59:59"];
    viewer.view.search(); await flush();
    expect(viewer.calls.at(-1).params).toMatchObject({ page: 1, limit: 20, status: 0,
      keyword: "UID 81", start_time: "2026-08-01 00:00:00", end_time: "2026-08-31 23:59:59" });
    viewer.view.reset(); await flush();
    expect(viewer.calls.at(-1).params).toMatchObject({ status: "all", keyword: "", start_time: "", end_time: "" });
    expect(viewer.view.formatTime(1786323600)).toMatch(/^2026-\d\d-\d\d \d\d:\d\d:\d\d$/u);
  } finally { viewer.close(); }
});

it("requires a confirmation and sends the displayed version with approval, remark and deletion", async () => {
  let status = 0, mark = "原备注", version = versionA;
  const mounted = await mount(grants, (config) => {
    if (config.method === "post" && config.url.includes("/verify/")) {
      status = 1; version = versionB; return envelope({ id: 1, status: 1 });
    }
    if (config.method === "post" && config.url.includes("/mark/")) {
      mark = JSON.parse(config.data).mark; return envelope({ id: 1, mark });
    }
    return envelope({ list: [{ ...row(1, status, version), mark }], count: 1 });
  });
  try {
    await mounted.view.approve(mounted.view.list.value[0]);
    const review = mounted.calls.find((call) => call.url.endsWith("/verify/1"));
    expect(JSON.parse(review.data)).toEqual({ status: 1, expected_version: versionA });
    expect(runtime.messages.state.confirmations[0][0]).toContain("2 张资质图片");
    mounted.view.openMark(mounted.view.list.value[0]);
    mounted.view.markText.value = " 复核完成 ";
    await mounted.view.confirmMark();
    const remark = mounted.calls.find((call) => call.url.endsWith("/mark/1"));
    expect(JSON.parse(remark.data)).toEqual({ mark: "复核完成", expected_version: versionB });
  } finally { mounted.close(); }

  let removed = false;
  const deleted = await mount(grants, (config) => {
    if (config.method === "delete") { removed = true; return envelope({ id: 2 }); }
    if (config.params.page === 2) return envelope({ list: removed ? [] : [row(2, 2)], count: removed ? 20 : 21 });
    return envelope({ list: [row(1, 2)], count: removed ? 20 : 21 });
  });
  try {
    await deleted.view.load(2);
    await deleted.view.remove(deleted.view.list.value[0]);
    const request = deleted.calls.find((call) => call.method === "delete");
    expect(request.url).toBe("/supplier/apply/del/2");
    expect(request.params.expected_version).toBe(versionA);
    expect(deleted.view.page.value).toBe(1);
    expect(deleted.view.list.value[0].id).toBe(1);
    expect(deleted.calls.slice(-2).map((call) => call.params.page)).toEqual([2, 1]);
  } finally { deleted.close(); }
});

it("refreshes after a version conflict without replaying the write", async () => {
  let attempted = false;
  const mounted = await mount(grants, (config) => {
    if (config.method === "post") { attempted = true; return envelope(null, 409, "申请材料已变化"); }
    return envelope({ list: [row(1, 0, attempted ? versionB : versionA)], count: 1 });
  });
  try {
    await mounted.view.approve(mounted.view.list.value[0]);
    expect(writes(mounted.calls)).toHaveLength(1);
    expect(mounted.calls.at(-1).method).toBe("get");
    expect(mounted.view.list.value[0].version).toBe(versionB);
    expect(mounted.view.actionNotice.value).toContain("已重新读取");
    expect(runtime.messages.state.successes).toEqual([]);
  } finally { mounted.close(); }
});

it("aborts the old account's pending read and mutation, ignoring their late responses", async () => {
  const lateRead = deferred();
  let pauseRead = false;
  const reading = await mount(grants, (config) => pauseRead && config.method === "get" ? lateRead.promise : undefined);
  try {
    pauseRead = true;
    const pending = reading.view.load(1); await flush();
    const oldRequest = reading.calls.at(-1);
    login(["supplier_extract.view"], "supplier-application-b", 21);
    browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    expect(oldRequest.signal.aborted).toBe(true);
    lateRead.resolve(envelope({ list: [row(99)], count: 1 }));
    await pending;
    expect(reading.view.canView.value).toBe(false);
    expect(reading.view.list.value).toEqual([]);
  } finally { reading.close(); }

  const lateWrite = deferred();
  const writing = await mount(grants, (config) => config.method === "post" ? lateWrite.promise : undefined);
  try {
    const pending = writing.view.approve(writing.view.list.value[0]); await flush();
    const request = writes(writing.calls)[0];
    login(["supplier_extract.view"], "supplier-application-c", 22);
    browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    expect(request.signal.aborted).toBe(true);
    lateWrite.resolve(envelope({ id: 1, status: 1 }));
    await pending;
    expect(writing.view.list.value).toEqual([]);
    expect(runtime.messages.state.successes).toEqual([]);
  } finally { writing.close(); }
});
