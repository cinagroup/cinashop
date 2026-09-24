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
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { search: "", pathname: "/user/groups", href: "" } }));
  const result = await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root,
      contents: `
        export { default as Page } from './src/pages/user/UserGroups.vue';
        export { default as request } from './src/utils/request';
        export * as groups from './src/api/userGroups';
        export { createRenderer, h, nextTick } from 'vue';
        export { createPinia } from 'pinia';
        export * as dialog from 'element-plus';
      `,
    },
    alias: { "@": resolve(root, "src") },
    define: { "import.meta.env.DEV": "false" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    plugins: [{ name: "user-group-page", setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, "utf8"), { filename: path }).descriptor, { id: "user-groups" }).content,
        loader: "ts",
      }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: "dialogs", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export const state = { messages: [], confirm: async () => {} };
        export const ElMessage = {
          success: (message) => state.messages.push(['success', message]),
          warning: (message) => state.messages.push(['warning', message]),
          error: (message) => state.messages.push(['error', message]),
        };
        export const ElMessageBox = { confirm: (...args) => state.confirm(...args) };
      ` }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

const envelope = (data: unknown, status = 200, msg = "ok") => ({ status, msg, data });
const rows = (page = 1) => ({
  list: page === 1 ? [{ id: 3, group_name: "普通用户" }, { id: 2, group_name: "VIP" }] : [{ id: 1, group_name: "历史用户" }],
  count: 21, page, limit: 10,
});
const flush = async () => { for (let index = 0; index < 12; index++) { await new Promise((done) => setTimeout(done, 1)); await runtime.nextTick(); } };

function login(permissions: string[]) {
  localStorage.setItem("admin_token", "group-token-a");
  localStorage.setItem("admin_session", JSON.stringify({
    userInfo: { id: 20, account: "operator", level: 1, roles: "" }, menus: [], uniqueAuth: permissions,
  }));
}

beforeEach(() => {
  const values = new Map<string, string>();
  browser = new EventTarget();
  vi.stubGlobal("window", Object.assign(browser, { location: { search: "", pathname: "/user/groups", href: "" } }));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  runtime.dialog.state.messages = [];
  runtime.dialog.state.confirm = async () => {};
});
afterEach(() => vi.unstubAllGlobals());

async function mount(permissions = ["user.view", "user.manage"], respond: (config: any) => unknown = () => undefined) {
  login(permissions);
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    return { config, data: custom ?? envelope(rows(config.params?.page ?? 1)), status: 200, statusText: "frontend fixture", headers: {} };
  };
  let view: any;
  const component = { setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } };
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

it("validates the real list and mutation contracts", () => {
  expect(runtime.groups.parseUserGroupPage(rows(2)).list[0].id).toBe(1);
  expect(() => runtime.groups.parseUserGroupPage({ ...rows(), count: -1 })).toThrow("分组列表格式错误");
  expect(() => runtime.groups.parseUserGroupPage({ ...rows(), list: [{ id: 3, group_name: "A" }, { id: 3, group_name: "B" }] })).toThrow("分组记录格式错误");
  expect(runtime.groups.normalizedUserGroupName("  VIP  ")).toBe("VIP");
  expect(() => runtime.groups.normalizedUserGroupName(" ")).toThrow("请输入分组名称");
  expect(() => runtime.groups.normalizedUserGroupName("x".repeat(65))).toThrow("64");
  expect(requiredAdminPermission("GET", "/adminapi/user_group/list")).toBe("user.view");
  expect(requiredAdminPermission("POST", "/adminapi/user_group/save")).toBe("user.manage");
  expect(requiredAdminPermission("DELETE", "/adminapi/user_group/del/:id")).toBe("user.manage");
});

it("applies search and pagination to server results without giving a view-only role write access", async () => {
  const fixture = await mount(["user.view"]);
  try {
    expect(fixture.view.canView.value).toBe(true);
    expect(fixture.view.canManage.value).toBe(false);
    expect(fixture.view.count.value).toBe(21);
    fixture.view.searchDraft.value = " VIP ";
    fixture.view.search();
    await flush();
    expect(fixture.calls.at(-1).params).toMatchObject({ page: 1, limit: 10, group_name: "VIP" });
    await fixture.view.load(2);
    expect(fixture.view.list.value).toEqual([{ id: 1, group_name: "历史用户" }]);
    fixture.view.openCreate();
    expect(fixture.view.dialogOpen.value).toBe(false);
    fixture.view.dialogOpen.value = true;
    await fixture.view.save();
    await fixture.view.remove(fixture.view.list.value[0]);
    expect(fixture.calls.every((call) => call.method === "get")).toBe(true);
  } finally { fixture.close(); }
});

it("creates, edits, and refuses occupied deletion while keeping the row visible", async () => {
  const fixture = await mount(undefined, (config) => {
    if (config.url === "/user_group/save") return envelope({ id: JSON.parse(config.data).id || 4 });
    if (config.url === "/user_group/del/3") return envelope(null, 400, "该分组仍有用户，不能删除");
    return undefined;
  });
  try {
    fixture.view.openCreate();
    fixture.view.formName.value = " 新用户 ";
    await fixture.view.save();
    expect(JSON.parse(fixture.calls.find((call) => call.url === "/user_group/save").data)).toEqual({ id: 0, group_name: "新用户" });
    expect(fixture.view.dialogOpen.value).toBe(false);
    fixture.view.openEdit(fixture.view.list.value[0]);
    fixture.view.formName.value = "普通会员";
    await fixture.view.save();
    expect(JSON.parse(fixture.calls.filter((call) => call.url === "/user_group/save").at(-1).data)).toEqual({ id: 3, group_name: "普通会员" });
    await fixture.view.remove(fixture.view.list.value[0]);
    expect(fixture.view.list.value[0].id).toBe(3);
    expect(runtime.dialog.state.messages.at(-1)).toEqual(["warning", "该分组仍有用户，不能删除。请先调整关联用户的分组。"]);
  } finally { fixture.close(); }
});

it("blocks direct reads without user.view and returns to the preceding page after deleting its last row", async () => {
  const denied = await mount([]);
  try {
    expect(denied.view.canView.value).toBe(false);
    expect(denied.calls).toEqual([]);
    await denied.view.load(1);
    expect(denied.calls).toEqual([]);
  } finally { denied.close(); }

  const fixture = await mount(undefined, (config) => {
    if (config.url === "/user_group/del/11") return envelope(null);
    if (config.params?.page === 2) return envelope({ list: [{ id: 11, group_name: "末页分组" }], count: 11, page: 2, limit: 10 });
    return envelope({ list: [{ id: 3, group_name: "普通用户" }], count: 10, page: 1, limit: 10 });
  });
  try {
    await fixture.view.load(2);
    expect(fixture.view.page.value).toBe(2);
    await fixture.view.remove(fixture.view.list.value[0]);
    expect(fixture.calls.at(-1).params.page).toBe(1);
    expect(fixture.view.page.value).toBe(1);
    expect(fixture.view.list.value[0].id).toBe(3);
  } finally { fixture.close(); }
});

it("ignores an old list response after a newer search and aborts on session replacement", async () => {
  let resolveOld!: (value: unknown) => void;
  const old = new Promise((done) => { resolveOld = done; });
  const fixture = await mount(undefined, (config) => config.params?.group_name === "OLD" ? old : undefined);
  try {
    fixture.view.searchDraft.value = "OLD";
    fixture.view.search();
    await flush();
    const oldRequest = fixture.calls.at(-1);
    fixture.view.searchDraft.value = "NEW";
    fixture.view.search();
    await flush();
    expect(oldRequest.signal.aborted).toBe(true);
    expect(fixture.view.list.value[0].group_name).toBe("普通用户");
    resolveOld(envelope({ list: [{ id: 99, group_name: "过期结果" }], count: 1, page: 1, limit: 10 }));
    await flush();
    expect(fixture.view.list.value[0].id).toBe(3);

    localStorage.setItem("admin_token", "group-token-b");
    localStorage.setItem("admin_session", JSON.stringify({ userInfo: { id: 21, level: 1 }, menus: [], uniqueAuth: [] }));
    browser.dispatchEvent(new Event("admin-session-changed"));
    await flush();
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.view.list.value).toEqual([]);
  } finally { fixture.close(); }
});
