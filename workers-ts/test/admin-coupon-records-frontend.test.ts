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
const pageFile = resolve(root, "src/pages/marketing/CouponRecords.vue");
const pageSource = readFileSync(pageFile, "utf8");

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    location: { search: "", pathname: "/marketing/coupon-records", href: "" },
  }));
  const result = await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root,
      contents: `
        export { default as Page } from './src/pages/marketing/CouponRecords.vue';
        export { default as request } from './src/utils/request';
        export * as couponRecords from './src/api/couponRecords';
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
    plugins: [{ name: "coupon-records-page", setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, "utf8"), { filename: path }).descriptor, { id: "coupon-records" }).content,
        loader: "ts",
      }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

const envelope = (data: unknown, status = 200, msg = "ok") => ({ status, msg, data });
const row = (id: number, overrides: Record<string, unknown> = {}) => ({
  id, uid: 22, coupon_title: "八五折券", nickname: "会员甲", coupon_price: "85.00",
  use_min_price: "100.00", coupon_type: 2, start_time: "2026-09-01T00:00:00.000Z",
  end_time: "2026-09-30T23:59:59.000Z", receive_source: "send",
  receive_source_label: "后台发放", is_fail: 1, status: 0, status_label: "未使用",
  ...overrides,
});
const rows = (page = 1) => ({
  list: page === 1 ? [row(3), row(2, { status: 3, status_label: "未支付订单占用中", is_fail: 0 })] :
    [row(1, { coupon_type: 1, coupon_price: "10.00", status: 1, status_label: "已使用" })],
  count: 21, page, limit: 15,
});
const flush = async () => {
  for (let index = 0; index < 12; index++) {
    await new Promise((done) => setTimeout(done, 1));
    await runtime.nextTick();
  }
};

function login(permissions: string[], token = "record-token-a", id = 20) {
  localStorage.setItem("admin_token", token);
  localStorage.setItem("admin_session", JSON.stringify({
    userInfo: { id, account: "operator", level: 1, roles: "" }, menus: [], uniqueAuth: permissions,
  }));
}

beforeEach(() => {
  const values = new Map<string, string>();
  browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, {
    location: { search: "", pathname: "/marketing/coupon-records", href: "" },
  }));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

async function mount(permissions = ["coupon_record.view"], respond: (config: any) => unknown = () => undefined) {
  login(permissions);
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    return {
      config, data: custom ?? envelope(rows(config.params?.page ?? 1)),
      status: 200, statusText: "frontend fixture", headers: {},
    };
  };
  let view: any;
  const component = { setup(props: unknown, context: unknown) {
    view = runtime.Page.setup(props, context);
    return () => null;
  } };
  const renderer = runtime.createRenderer({
    createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null,
    patchProp() {}, setText() {}, setElementText() {},
  });
  const app = renderer.createApp(component);
  app.use(runtime.createPinia());
  app.mount({ children: [] });
  await flush();
  return { view, calls, close: () => app.unmount() };
}

it("uses the real read-only contract and keeps status separate from usability", () => {
  expect(requiredAdminPermission("GET", "/adminapi/marketing/coupon-records/list")).toBe("coupon_record.view");
  expect(requiredAdminPermission("GET", "/adminapi/coupon/list")).toBe("coupon.view");
  const parsed = runtime.couponRecords.parseCouponRecordPage(rows());
  expect(parsed.list[0]).toMatchObject({ status: 0, status_label: "未使用", is_fail: 1 });
  expect(parsed.list[1]).toMatchObject({ status: 3, status_label: "未支付订单占用中", is_fail: 0 });
  expect(() => runtime.couponRecords.parseCouponRecordPage({ ...rows(), count: -1 })).toThrow("领取记录格式错误");
  expect(() => runtime.couponRecords.parseCouponRecordPage({ ...rows(), list: [row(3), row(3)] })).toThrow("领取记录字段错误");
  expect(() => runtime.couponRecords.parseCouponRecordPage({ ...rows(), list: [row(3, { coupon_price: "invalid" })] })).toThrow("领取记录字段错误");
  const template = parse(pageSource, { filename: pageFile }).descriptor.template?.content ?? "";
  expect(template).toContain("row.is_fail === 0 ? '有效' : '失效'");
  expect(template).toContain("row.status_label");
  expect(template).not.toMatch(/@click="(?:save|grant|delete|remove)/u);
});

it("blocks direct reads with coupon management grants but without coupon_record.view", async () => {
  const fixture = await mount(["coupon.view", "coupon.manage"]);
  try {
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.calls).toEqual([]);
    await fixture.view.loadList(1);
    expect(fixture.calls).toEqual([]);
  } finally { fixture.close(); }
});

it("applies status, member and title filters to the server result with 15-row read-only pages", async () => {
  const fixture = await mount(["coupon_record.view"], (config) => {
    if (config.params?.status === 3) return envelope({
      list: config.params.page === 1 ? [row(2, { status: 3, status_label: "未支付订单占用中", is_fail: 0 })] :
        [row(1, { status: 3, status_label: "未支付订单占用中", is_fail: 1 })],
      count: 16, page: config.params.page, limit: 15,
    });
    return undefined;
  });
  try {
    expect(fixture.view.canView.value).toBe(true);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].params).toMatchObject({ page: 1, limit: 15 });
    expect(fixture.view.list.value[0]).toMatchObject({ status: 0, is_fail: 1 });
    expect(fixture.view.formatFace(fixture.view.list.value[0])).toBe("8.5折（85%）");
    expect(fixture.view.formatFace(row(8, { coupon_price: "85.50" }))).toBe("8.55折（85%）");
    expect(fixture.view.formatFace(row(1, { coupon_type: 1, coupon_price: "10.00" }))).toBe("10.00元");

    fixture.view.draftStatus.value = "3";
    fixture.view.draftNickname.value = " 会员甲 ";
    fixture.view.draftCouponTitle.value = " 八五折券 ";
    fixture.view.search();
    await flush();
    expect(fixture.calls.at(-1).params).toMatchObject({
      page: 1, limit: 15, status: 3, nickname: "会员甲", coupon_title: "八五折券",
    });
    expect(fixture.view.list.value[0]).toMatchObject({ status: 3, is_fail: 0 });
    expect(fixture.view.count.value).toBe(16);
    await fixture.view.loadList(2);
    expect(fixture.calls.at(-1).params).toMatchObject({
      page: 2, limit: 15, status: 3, nickname: "会员甲", coupon_title: "八五折券",
    });
    expect(fixture.view.page.value).toBe(2);
    expect(fixture.view.list.value[0]).toMatchObject({ status: 3, is_fail: 1 });
    expect(fixture.calls.every((call) => call.method === "get" && call.url === "/marketing/coupon-records/list")).toBe(true);
  } finally { fixture.close(); }
});

it("ignores old responses and clears private records after account replacement", async () => {
  let resolveOld!: (value: unknown) => void;
  let resolveAfterReplacement!: (value: unknown) => void;
  const old = new Promise((done) => { resolveOld = done; });
  const afterReplacement = new Promise((done) => { resolveAfterReplacement = done; });
  let oldSearches = 0;
  const fixture = await mount(undefined, (config) => config.params?.nickname === "OLD"
    ? (++oldSearches === 1 ? old : afterReplacement)
    : config.params?.nickname === "NEW" ? envelope({ ...rows(), list: [row(44)] }) : undefined);
  try {
    fixture.view.draftNickname.value = "OLD";
    fixture.view.search();
    await flush();
    const oldCall = fixture.calls.at(-1);
    fixture.view.draftNickname.value = "NEW";
    fixture.view.search();
    await flush();
    expect(oldCall.signal.aborted).toBe(true);
    expect(fixture.view.list.value[0].id).toBe(44);
    resolveOld(envelope({ ...rows(), list: [row(99)] }));
    await flush();
    expect(fixture.view.list.value[0].id).toBe(44);

    fixture.view.draftNickname.value = "OLD";
    fixture.view.search();
    await flush();
    const inFlight = fixture.calls.at(-1);
    login([], "record-token-b", 21);
    browser.dispatchEvent(new Event("admin-session-changed"));
    await flush();
    expect(inFlight.signal.aborted).toBe(true);
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.view.list.value).toEqual([]);
    expect(fixture.view.count.value).toBe(0);
    resolveAfterReplacement(envelope({ ...rows(), list: [row(100)] }));
    await flush();
    expect(fixture.view.list.value).toEqual([]);
    const count = fixture.calls.length;
    await fixture.view.loadList(1);
    expect(fixture.calls).toHaveLength(count);
  } finally { fixture.close(); }
});
