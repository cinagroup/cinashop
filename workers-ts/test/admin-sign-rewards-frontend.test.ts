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
const pageFile = resolve(root, "src/pages/marketing/SignRewards.vue");
const pageSource = readFileSync(pageFile, "utf8");

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    location: { search: "", pathname: "/marketing/sign-rewards", href: "" },
  }));
  const result = await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root,
      contents: `
        export { default as Page } from './src/pages/marketing/SignRewards.vue';
        export { default as request } from './src/utils/request';
        export * as signRewards from './src/api/signRewards';
        export { createRenderer, nextTick } from 'vue';
        export { createPinia } from 'pinia';
      `,
    },
    alias: { "@": resolve(root, "src") },
    define: { "import.meta.env.DEV": "false" },
    bundle: true, write: false, platform: "browser", format: "esm",
    plugins: [{ name: "sign-rewards-page", setup(builder) {
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: "element-plus", namespace: "sign-test" }));
      builder.onLoad({ filter: /.*/, namespace: "sign-test" }, () => ({
        contents: `export const ElMessage = { success() {}, error() {} };
          export const ElMessageBox = { confirm() { return Promise.resolve(); } };`,
        loader: "js",
      }));
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, "utf8"), { filename: path }).descriptor, { id: "sign-rewards" }).content,
        loader: "ts",
      }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

const envelope = (data: unknown) => ({ status: 200, msg: "ok", data });
const reward = (id: number, type: number, days: number) => ({ id, type, days, point: 8, exp: 3 });
const rewardPage = (type: number, page: number) => ({
  list: page === 1 ? [reward(type + 1, type, 7)] : [reward(type + 3, type, 14)],
  count: 16, page, limit: 15,
});
const rewardForm = (id: number, type: number) => ({
  info: id ? reward(id, type, 7) : { id: 0, type, days: 0, point: 0, exp: 0 },
  rules: [{ field: "days", props: { min: 1, max: 30 } }],
});
const flush = async () => {
  for (let index = 0; index < 12; index++) {
    await new Promise((done) => setTimeout(done, 1));
    await runtime.nextTick();
  }
};

function login(permissions: string[], token = "sign-token-a", id = 20) {
  localStorage.setItem("admin_token", token);
  localStorage.setItem("admin_session", JSON.stringify({
    userInfo: { id, account: "operator", level: 1, roles: "" }, menus: [], uniqueAuth: permissions,
  }));
}

beforeEach(() => {
  const values = new Map<string, string>();
  browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, {
    location: { search: "", pathname: "/marketing/sign-rewards", href: "" },
  }));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

async function mount(permissions: string[], respond?: (config: any) => unknown) {
  login(permissions);
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const id = Number(config.url?.match(/\/(\d+)$/u)?.[1] ?? 0);
    const data = (await respond?.(config)) ?? (config.url === "/setting/sign/rewards"
      ? rewardPage(config.params.type, config.params.page)
      : config.url === "/setting/sign/add_rewards"
        ? rewardForm(0, config.params.type)
        : config.url?.startsWith("/setting/sign/edit_rewards/")
          ? rewardForm(id, 0)
          : config.url?.startsWith("/setting/sign/save_rewards/") ? { id: id || 5 } : null);
    return { config, data: envelope(data), status: 200, statusText: "fixture", headers: {} };
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

it("uses config view/manage for all five existing endpoints and parses their exact fields", () => {
  for (const path of ["rewards", "add_rewards", "edit_rewards/:id"]) {
    expect(requiredAdminPermission("GET", `/adminapi/setting/sign/${path}`)).toBe("config.view");
  }
  expect(requiredAdminPermission("POST", "/adminapi/setting/sign/save_rewards/:id")).toBe("config.manage");
  expect(requiredAdminPermission("DELETE", "/adminapi/setting/sign/del_rewards/:id")).toBe("config.manage");
  expect(runtime.signRewards.parseSignRewardPage(rewardPage(0, 1)).list[0]).toEqual(reward(1, 0, 7));
  expect(runtime.signRewards.parseSignRewardForm(rewardForm(0, 1))).toMatchObject({
    info: { id: 0, type: 1 }, maxDays: 30,
  });
  expect(() => runtime.signRewards.parseSignRewardPage({ ...rewardPage(0, 1), list: [reward(2, 2, 7)] })).toThrow();
  expect(() => runtime.signRewards.parseSignRewardForm({ ...rewardForm(0, 0), rules: [] })).toThrow();
  const template = parse(pageSource, { filename: pageFile }).descriptor.template?.content ?? "";
  expect(template).toContain("连续签到奖励");
  expect(template).toContain("累积签到奖励");
  expect(template).toContain("@click=\"remove(row)\"");
});

it("keeps an unrelated marketing role out of direct reads and edits", async () => {
  const fixture = await mount(["integral_log.view"]);
  try {
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.calls).toEqual([]);
    await fixture.view.loadList(1);
    await fixture.view.openForm(0);
    expect(fixture.calls).toEqual([]);
  } finally { fixture.close(); }
});

it("separates view from manage and requests each 15-row tab/page explicitly", async () => {
  const fixture = await mount(["config.view"]);
  try {
    expect(fixture.view.canView.value).toBe(true);
    expect(fixture.view.canManage.value).toBe(false);
    expect(fixture.calls[0]).toMatchObject({ method: "get", url: "/setting/sign/rewards", params: { type: 0, page: 1, limit: 15 } });
    await fixture.view.openForm(0);
    expect(fixture.calls).toHaveLength(1);
    fixture.view.tab.value = "1";
    await flush();
    expect(fixture.calls.at(-1)).toMatchObject({ method: "get", url: "/setting/sign/rewards", params: { type: 1, page: 1, limit: 15 } });
    await fixture.view.loadList(2);
    expect(fixture.calls.at(-1)).toMatchObject({ method: "get", url: "/setting/sign/rewards", params: { type: 1, page: 2, limit: 15 } });
    expect(fixture.view.rows.value[0].id).toBe(4);
    expect(fixture.calls.every((call) => call.method === "get")).toBe(true);
  } finally { fixture.close(); }
});

it("loads server form bounds for managers and discards old account data", async () => {
  const fixture = await mount(["config.view", "config.manage"]);
  try {
    await fixture.view.openForm(0);
    expect(fixture.calls.at(-1)).toMatchObject({ method: "get", url: "/setting/sign/add_rewards", params: { type: 0 } });
    expect(fixture.view.form.value).toMatchObject({ id: 0, type: 0, days: 0, maxDays: 30 });
    await fixture.view.openForm(1);
    expect(fixture.calls.at(-1)).toMatchObject({ method: "get", url: "/setting/sign/edit_rewards/1" });
    expect(fixture.view.form.value).toMatchObject({ id: 1, days: 7 });
    login([], "sign-token-b", 21);
    browser.dispatchEvent(new Event("admin-session-changed"));
    await flush();
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.view.rows.value).toEqual([]);
    expect(fixture.view.form.value).toBeNull();
  } finally { fixture.close(); }
});

it("submits only the four approved fields for add/edit, confirms delete, then refreshes", async () => {
  const fixture = await mount(["config.view", "config.manage"]);
  try {
    await fixture.view.openForm(0);
    fixture.view.form.value.days = 7;
    fixture.view.form.value.point = 12;
    fixture.view.form.value.exp = 4;
    await fixture.view.save();
    const added = fixture.calls.find((call) => call.method === "post");
    expect(added.url).toBe("/setting/sign/save_rewards/0");
    expect(JSON.parse(added.data)).toEqual({ type: 0, days: 7, point: 12, exp: 4 });
    expect(fixture.calls.at(-1).url).toBe("/setting/sign/rewards");

    await fixture.view.openForm(1);
    fixture.view.form.value.point = 20;
    await fixture.view.save();
    const edited = fixture.calls.filter((call) => call.method === "post").at(-1);
    expect(edited.url).toBe("/setting/sign/save_rewards/1");
    expect(JSON.parse(edited.data)).toEqual({ type: 0, days: 7, point: 20, exp: 3 });

    await fixture.view.remove(reward(1, 0, 7));
    expect(fixture.calls.at(-2)).toMatchObject({ method: "delete", url: "/setting/sign/del_rewards/1" });
    expect(fixture.calls.at(-1).url).toBe("/setting/sign/rewards");
  } finally { fixture.close(); }
});

it("lists historical out-of-bound integers but requires correction before saving", async () => {
  const historical = { id: 9, type: 0, days: 0, point: -1, exp: 1000 };
  const fixture = await mount(["config.view", "config.manage"], (config) => {
    if (config.url === "/setting/sign/rewards") {
      return { list: [historical], count: 1, page: config.params.page, limit: 15 };
    }
    if (config.url === "/setting/sign/edit_rewards/9") {
      return { info: historical, rules: [{ field: "days", props: { min: 1, max: 30 } }] };
    }
    return undefined;
  });
  try {
    expect(fixture.view.rows.value).toEqual([historical]);
    await fixture.view.openForm(9);
    expect(fixture.view.form.value).toMatchObject(historical);
    await fixture.view.save();
    expect(fixture.calls.filter((call) => call.method === "post")).toHaveLength(0);
    fixture.view.form.value.days = 1;
    fixture.view.form.value.point = 0;
    fixture.view.form.value.exp = 999;
    await fixture.view.save();
    const saved = fixture.calls.find((call) => call.method === "post");
    expect(saved.url).toBe("/setting/sign/save_rewards/9");
    expect(JSON.parse(saved.data)).toEqual({ type: 0, days: 1, point: 0, exp: 999 });
    await fixture.view.remove(historical);
    expect(fixture.calls.some((call) => call.method === "delete" &&
      call.url === "/setting/sign/del_rewards/9")).toBe(true);
  } finally { fixture.close(); }
});

it("retries the failed requested page instead of the last successful page", async () => {
  let failPageTwo = true;
  const fixture = await mount(["config.view"], (config) => {
    if (config.url === "/setting/sign/rewards" && config.params.page === 2 && failPageTwo) {
      failPageTwo = false;
      throw new Error("page two transient");
    }
    return undefined;
  });
  try {
    await fixture.view.loadList(2);
    expect(fixture.view.page.value).toBe(1);
    expect(fixture.view.requestedPage.value).toBe(2);
    expect(fixture.view.listError.value).toContain("page two transient");
    expect(pageSource).toContain('@click="loadList(requestedPage)"');
    await fixture.view.loadList(fixture.view.requestedPage.value);
    expect(fixture.calls.at(-1).params.page).toBe(2);
    expect(fixture.view.page.value).toBe(2);
    expect(fixture.view.listError.value).toBe("");
  } finally { fixture.close(); }
});

it("keeps a newly opened editor when an older save finishes after its dialog closed", async () => {
  let releaseSave!: () => void;
  const delayedSave = new Promise<void>((done) => { releaseSave = done; });
  const fixture = await mount(["config.view", "config.manage"], async (config) => {
    if (config.url === "/setting/sign/save_rewards/1") {
      await delayedSave;
      return { id: 1 };
    }
    return undefined;
  });
  try {
    expect(pageSource).toContain(':close-on-press-escape="!saving"');
    await fixture.view.openForm(1);
    const pending = fixture.view.save();
    await flush();
    expect(fixture.view.saving.value).toBe(true);
    fixture.view.dialogOpen.value = false;
    fixture.view.onDialogClosed();
    await fixture.view.openForm(2);
    expect(fixture.view.form.value.id).toBe(2);
    fixture.view.onDialogClosed();
    expect(fixture.view.form.value.id).toBe(2);
    releaseSave();
    await pending;
    expect(fixture.view.dialogOpen.value).toBe(true);
    expect(fixture.view.form.value.id).toBe(2);
    expect(fixture.view.saving.value).toBe(false);
  } finally { fixture.close(); }
});

it("aborts a pending tab read and ignores its late data after account replacement", async () => {
  let release!: () => void;
  const delayed = new Promise<void>((done) => { release = done; });
  const fixture = await mount(["config.view"], async (config) => {
    if (config.url === "/setting/sign/rewards" && config.params.page === 2) {
      await delayed;
      return rewardPage(0, 2);
    }
    return undefined;
  });
  try {
    const pending = fixture.view.loadList(2);
    await flush();
    const oldCall = fixture.calls.at(-1);
    login([], "sign-token-b", 21);
    browser.dispatchEvent(new Event("admin-session-changed"));
    await flush();
    expect(oldCall.signal.aborted).toBe(true);
    release();
    await pending;
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.view.rows.value).toEqual([]);
    expect(fixture.view.count.value).toBe(0);
  } finally { fixture.close(); }
});
