import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(root, "package.json"));
const { parse, compileScript, compileTemplate } = require("@vue/compiler-sfc");
const { compile } = require("@vue/compiler-dom");
let runtime: any;
let browser: EventTarget;
let storage: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { pathname: "/system", href: "", search: "" } }));
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  const result = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, contents: `
      export { default as Page } from './src/pages/system/SystemList.vue';
      export { default as request } from './src/utils/request';
      export { createRenderer, nextTick } from 'vue';
      export * as vue from 'vue';
      export { createPinia } from 'pinia';
      export { useAuthStore } from './src/stores/auth';
      export * as messages from 'element-plus';
    ` },
    alias: { "@": resolve(root, "src") },
    define: { "import.meta.env.DEV": "false" },
    bundle: true, write: false, platform: "browser", format: "esm",
    plugins: [{ name: "system-directory-page", setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, "utf8"), { filename: path }).descriptor, { id: "system-directory" }).content,
        loader: "ts",
      }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: "messages", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export const state = { errors: [], warnings: [], success: [], confirmations: [], confirm: async () => {}, closed: 0 };
        export const ElMessage = { error: value => state.errors.push(value), warning: value => state.warnings.push(value), success: value => state.success.push(value) };
        export const ElMessageBox = { confirm: async (...args) => { state.confirmations.push(args); return state.confirm(...args); }, close: () => { state.closed++; } };
      ` }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(`${result.outputFiles[0].text}\n//# sourceURL=admin-system-directory-fixture.mjs`).toString("base64")}`);
});

beforeEach(() => {
  storage = new Map(); receipts.clear();
  browser = Object.assign(new EventTarget(), { location: { pathname: "/system", href: "", search: "" } });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("StorageEvent", class extends Event {
    key: string | null;
    storageArea: unknown;
    constructor(type: string, options: { key?: string | null; storageArea?: unknown } = {}) {
      super(type); this.key = options.key ?? null; this.storageArea = options.storageArea ?? localStorage;
    }
  });
  Object.assign(runtime.messages.state, { errors: [], warnings: [], success: [], confirmations: [], confirm: async () => {}, closed: 0 });
});
afterEach(() => vi.unstubAllGlobals());

const flush = async () => {
  for (let i = 0; i < 6; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); }
};
function login(permissions = ["system.view", "system.manage"], token = "system-token-a", id = 20) {
  storage.set("admin_token", token);
  storage.set("admin_session", JSON.stringify({ userInfo: { id, account: "operator", level: 1, roles: "2" }, menus: [], uniqueAuth: permissions }));
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const adminRow = (id = 20) => ({ id, account: `operator${id}`, realName: `管理员 ${id}`, phone: "13800000000", roles: "2", level: 1, status: 1, lastTime: 1790557200 });
const roleRow = (id = 2) => ({ id, roleName: `角色 ${id}`, rules: "system.view", permissionKeys: ["system.view"], level: 1, status: 1 });
const tree = [{ key: "system", label: "系统", path: "/system", children: [{ key: "system.view", label: "查看" }, { key: "system.manage", label: "管理" }] }];
const directory = (rows: unknown[], page = 1, limit = 20, total = 21) => ({ list: rows, total, page, limit });
const receipts = new Map<string, any>();
const hash = "a".repeat(64), revision = "b".repeat(64);
const ownerOf = (config: any) => Number(String(config.headers["Authori-zation"]).match(/system-token-(\d+)/)?.[1] ?? 20);
const parsedBody = (config: any) => typeof config.data === "string" ? JSON.parse(config.data) : config.data;
function previewFor(config: any) {
  const envelope = parsedBody(config), payload = envelope.payload, admin = envelope.operation === "admin-save";
  const action = envelope.operation === "role-delete" ? "delete" : payload.id ? "update" : "create";
  return { operation_id: envelope.operation_id, actor_id: ownerOf(config), operation: envelope.operation,
    request_hash: hash, revision, expires_at: Math.floor(Date.now()/1000)+300, requires_confirmation: true,
    summary: { target_id: payload.id ?? 0, target_name: payload.account ?? payload.role_name ?? "待删除角色", action,
      before: action === "create" ? null : admin ? { roles: "2", level: 1, status: 1 } : { role_name: "原角色", rules: "system.view", level: 1, status: 1 },
      after: admin ? { roles: payload.roles ?? "2", level: payload.level ?? 1, status: payload.status ?? 1 }
        : { role_name: payload.role_name ?? "原角色", rules: payload.rules ?? "system.view", level: payload.level ?? 1, status: action === "delete" ? -1 : payload.status ?? 1 } },
    affected_accounts: [40,41,42].map(id => ({ id, account: "affected-"+id, real_name: "受影响账号", level: 1, status: id===41?0:1, is_del: id===42?1:0 })) };
}
function receiptFor(config: any) {
  const envelope = parsedBody(config);
  return { operation_id: envelope.operation_id, actor_id: ownerOf(config), operation: envelope.operation,
    state: "committed", request_hash: hash, result: envelope.operation === "role-delete"
      ? { id: envelope.payload.id, deleted: true } : { id: envelope.payload.id ?? 30, created: !envelope.payload.id } };
}
function standardResponse(config: any) {
  if (config.url === "/system/authority/preview") return previewFor(config);
  if (config.url === "/system/authority/commit") { const value=receiptFor(config); receipts.set(value.operation_id,value); return value; }
  if (config.url.startsWith("/system/authority/receipt/")) {
    const id=config.url.split("/").at(-1); return receipts.get(id) ?? { operation_id:id,actor_id:ownerOf(config),operation:config.params.operation,state:"unknown",request_hash:null,result:null };
  }
  if (config.url === "/system/authority/resolve") {
    const body=parsedBody(config), value=receipts.get(body.operation_id) ?? { ...body,actor_id:ownerOf(config),state:"not_applied",request_hash:null,result:null };
    receipts.set(body.operation_id,value); return value;
  }
  return config.url === "/system_menus/tree" ? tree
    : config.url === "/system_admin/directory" ? directory([adminRow()], config.params.page, config.params.limit)
    : config.url === "/system_role/directory" ? directory([roleRow()], config.params.page, config.params.limit) : { id:30 };
}

async function mount(permissions = ["system.view", "system.manage"], respond?: (config: any) => unknown) {
  login(permissions);
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const data = respond ? await respond(config) : standardResponse(config);
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
  const pinia = runtime.createPinia(); app.use(pinia);
  const session = JSON.parse(storage.get("admin_session")!);
  runtime.useAuthStore(pinia).$patch({ token: storage.get("admin_token"), userInfo: session.userInfo, menus: session.menus, uniqueAuth: session.uniqueAuth });
  app.mount({ children: [] });
  await flush();
  return { view, calls, auth: runtime.useAuthStore(pinia), close: () => app.unmount() };
}

// Behavior cases below bind the public setup actions of the actual SystemList SFC.
const writes = (calls: any[]) => calls.filter(call => ["/system/authority/commit", "/system/authority/resolve"].includes(call.url));
async function confirmOperation(view: any) { view.previewDialog.confirmed = true; await view.confirmOperation(); }
function adminDraft(view: any) {
  view.openAdminForm();
  Object.assign(view.adminDialog, { account: "new-operator", real_name: "新管理员", phone: "13800000000", pwd: "synthetic-password-123", roles: "2", level: 1 });
}
async function roleDraft(view: any) {
  view.permissionTreeRef.value = { setCheckedKeys() {}, getCheckedKeys: () => ["system.view"] };
  await view.openRoleForm();
  Object.assign(view.roleDialog, { role_name: "新角色", level: 1 });
}

it("uses both directory contracts and server totals while initial reads send no mutation", async () => {
  const fixture = await mount();
  try {
    expect(fixture.calls.filter(call => call.url.includes("directory")).map(call => call.url).sort()).toEqual(["/system_admin/directory", "/system_role/directory"]);
    expect(fixture.calls.every(call => call.method === "get" && call.signal)).toBe(true);
    expect(fixture.view.adminList.value).toEqual([adminRow()]);
    expect(fixture.view.roleList.value).toEqual([roleRow()]);
    expect(fixture.view.adminTotal.value).toBe(21);
    expect(fixture.view.roleTotal.value).toBe(21);
    expect(fixture.view.adminReady.value).toBe(true);
    expect(fixture.view.roleReady.value).toBe(true);
    expect(writes(fixture.calls)).toEqual([]);
  } finally { fixture.close(); }
});

it("neither reads nor opens or submits mutation actions without system.view", async () => {
  const fixture = await mount(["order.view"]);
  try {
    expect(fixture.view.canView.value).toBe(false);
    await fixture.view.loadAdmin(); await fixture.view.loadRoles(); await fixture.view.loadPermissionTree();
    fixture.view.openAdminForm(); await fixture.view.openRoleForm();
    await fixture.view.saveAdmin(); await fixture.view.saveRole(); await fixture.view.delRole(roleRow());
    expect(fixture.calls).toEqual([]);
    expect(fixture.view.adminList.value).toEqual([]); expect(fixture.view.roleList.value).toEqual([]);
    expect(fixture.view.adminDialog.show).toBe(false); expect(fixture.view.roleDialog.show).toBe(false);
  } finally { fixture.close(); }
});

it("system.view permits reads but direct action calls cannot bypass the hidden write buttons", async () => {
  const fixture = await mount(["system.view"]);
  try {
    expect(fixture.view.canView.value).toBe(true); expect(fixture.view.canManage.value).toBe(false);
    fixture.view.openAdminForm(); await fixture.view.openRoleForm();
    await fixture.view.saveAdmin(); await fixture.view.saveRole(); await fixture.view.delRole(roleRow());
    expect(writes(fixture.calls)).toEqual([]);
    expect(runtime.messages.state.confirmations).toEqual([]);
    expect(fixture.view.adminDialog.show).toBe(false); expect(fixture.view.roleDialog.show).toBe(false);
  } finally { fixture.close(); }
});

it("keeps independent pagination and resets only the searched directory to page one", async () => {
  const fixture = await mount();
  try {
    await fixture.view.loadAdmin(3); await fixture.view.loadRoles(2);
    expect(fixture.view.adminQuery.page).toBe(3); expect(fixture.view.roleQuery.page).toBe(2);
    Object.assign(fixture.view.adminQuery, { keyword: "  操作员  ", status: 0 });
    await fixture.view.searchAdmin(); await flush();
    const admin = fixture.calls.filter(call => call.url === "/system_admin/directory").at(-1);
    expect(admin.params).toMatchObject({ keyword: "操作员", status: 0, page: 1, limit: 20 });
    expect(fixture.view.roleQuery.page).toBe(2);
    Object.assign(fixture.view.roleQuery, { keyword: "  财务  ", status: 1, limit: 50 });
    await fixture.view.searchRoles(); await flush();
    const roles = fixture.calls.filter(call => call.url === "/system_role/directory").at(-1);
    expect(roles.params).toMatchObject({ keyword: "财务", status: 1, page: 1, limit: 50 });
    fixture.view.resetAdmin(); fixture.view.resetRoles(); await flush();
    expect(fixture.view.adminQuery).toMatchObject({ keyword: "", status: "", page: 1 });
    expect(fixture.view.roleQuery).toMatchObject({ keyword: "", status: "", page: 1 });
    expect(writes(fixture.calls)).toEqual([]);
  } finally { fixture.close(); }
});

it("shows failed reads and retains rows without allowing stale-row editing or advancing pagination", async () => {
  let fail = false;
  const fixture = await mount(undefined, config => {
    if (fail && config.url.includes("directory")) throw Error("directory unavailable");
    return standardResponse(config);
  });
  try {
    fail = true; await fixture.view.loadAdmin(2); await fixture.view.loadRoles(2);
    expect(fixture.view.adminError.value).toContain("directory unavailable");
    expect(fixture.view.roleError.value).toContain("directory unavailable");
    expect(fixture.view.adminList.value).toEqual([adminRow()]); expect(fixture.view.roleList.value).toEqual([roleRow()]);
    expect(fixture.view.adminReady.value).toBe(false); expect(fixture.view.roleReady.value).toBe(false);
    expect(fixture.view.adminQuery.page).toBe(1); expect(fixture.view.roleQuery.page).toBe(1);
    fixture.view.openAdminForm(); await fixture.view.openRoleForm(); await fixture.view.delRole(fixture.view.roleList.value[0]);
    expect(fixture.view.adminDialog.show).toBe(false); expect(fixture.view.roleDialog.show).toBe(false);
    expect(writes(fixture.calls)).toEqual([]);
    fail = false; await fixture.view.loadAdmin(); await fixture.view.loadRoles();
    expect(fixture.view.adminError.value).toBe(""); expect(fixture.view.roleError.value).toBe("");
    expect(fixture.view.adminReady.value).toBe(true); expect(fixture.view.roleReady.value).toBe(true);
  } finally { fixture.close(); }
});

it("a failed permission tree is visible and cannot silently save empty role rules", async () => {
  const fixture = await mount(undefined, config => {
    if (config.url === "/system_menus/tree") throw Error("permission tree unavailable");
    return standardResponse(config);
  });
  try {
    expect(fixture.view.permissionTreeReady.value).toBe(false);
    expect(fixture.view.permissionTreeError.value).toContain("permission tree unavailable");
    await fixture.view.openRoleForm(roleRow());
    Object.assign(fixture.view.roleDialog, { role_name: "不能清空权限", id: 2 });
    await fixture.view.saveRole();
    expect(writes(fixture.calls)).toEqual([]);
  } finally { fixture.close(); }
});

it("preserves an unresolved historical permission rule by blocking a lossy role save", async () => {
  const fixture = await mount(undefined, config => config.url === "/system_role/directory"
    ? directory([{ ...roleRow(), rules: "system.view,99999" }], config.params.page, config.params.limit) : standardResponse(config));
  try {
    fixture.view.permissionTreeRef.value = { setCheckedKeys() {}, getCheckedKeys: () => ["system.view"] };
    await fixture.view.openRoleForm(fixture.view.roleList.value[0]);
    expect(fixture.view.roleDialog.permissionError).toBeTruthy();
    await fixture.view.saveRole();
    expect(writes(fixture.calls)).toEqual([]);
  } finally { fixture.close(); }
});

it("discards superseded directory responses within the same session", async () => {
  const stale = deferred<unknown>();
  const fixture = await mount(undefined, config => config.url === "/system_admin/directory" && config.params.page === 2
    ? stale.promise : config.url === "/system_admin/directory" && config.params.page === 3
      ? directory([adminRow(33)], 3) : standardResponse(config));
  try {
    const old = fixture.view.loadAdmin(2); await flush();
    const oldCall = fixture.calls.at(-1);
    await fixture.view.loadAdmin(3);
    expect(oldCall.signal.aborted).toBe(true);
    stale.resolve(directory([adminRow(22)], 2)); await old; await flush();
    expect(fixture.view.adminList.value.map((row: any) => row.id)).toEqual([33]);
    expect(fixture.view.adminQuery.page).toBe(3); expect(fixture.view.adminError.value).toBe("");
  } finally { fixture.close(); }
});

it("session loss clears PII passwords drafts and trees and fences delayed old reads", async () => {
  const stale = deferred<unknown>(); let hold = false;
  const fixture = await mount(undefined, config => hold && config.url.includes("directory") ? stale.promise : standardResponse(config));
  try {
    adminDraft(fixture.view); await roleDraft(fixture.view);
    hold = true; const oldAdmin = fixture.view.loadAdmin(2), oldRoles = fixture.view.loadRoles(2); await flush();
    const oldCalls = fixture.calls.filter(call => call.params?.page === 2);
    storage.clear(); browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    expect(oldCalls.every(call => call.signal.aborted)).toBe(true);
    expect(fixture.view.adminList.value).toEqual([]); expect(fixture.view.roleList.value).toEqual([]);
    expect(fixture.view.permissionTree.value).toEqual([]);
    expect(fixture.view.adminDialog.show).toBe(false); expect(fixture.view.adminDialog.pwd).toBe("");
    expect(fixture.view.adminDialog.account).toBe(""); expect(fixture.view.adminDialog.phone).toBe("");
    expect(fixture.view.roleDialog.show).toBe(false); expect(fixture.view.roleDialog.role_name).toBe("");
    stale.resolve(directory([adminRow(99)], 2)); await Promise.all([oldAdmin, oldRoles]); await flush();
    expect(fixture.view.adminList.value).toEqual([]); expect(fixture.view.roleList.value).toEqual([]);
    expect(runtime.messages.state.errors).toEqual([]); expect(runtime.messages.state.success).toEqual([]);
  } finally { fixture.close(); }
});

it("account replacement only displays the replacement directory and ignores late old-account results", async () => {
  const old = deferred<unknown>();
  const fixture = await mount(undefined, config => {
    if (config.headers["Authori-zation"] === "Bearer system-token-a") return old.promise;
    return config.url === "/system_admin/directory" ? directory([adminRow(30)])
      : config.url === "/system_role/directory" ? directory([roleRow(30)]) : tree;
  });
  try {
    const oldCalls = [...fixture.calls];
    login(["system.view"], "system-token-b", 30); browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    expect(oldCalls.every(call => call.signal.aborted)).toBe(true);
    expect(fixture.view.canManage.value).toBe(false);
    expect(fixture.view.adminList.value.map((row: any) => row.id)).toEqual([30]);
    expect(fixture.view.roleList.value.map((row: any) => row.id)).toEqual([30]);
    old.resolve(directory([adminRow(20)])); await flush();
    expect(fixture.view.adminList.value.map((row: any) => row.id)).toEqual([30]);
    expect(fixture.view.roleList.value.map((row: any) => row.id)).toEqual([30]);
  } finally { fixture.close(); }
});

it("an A to B to A session change cannot revive the original A response", async () => {
  const old = deferred<unknown>(); let switched = false;
  const fixture = await mount(undefined, config => {
    if (config.url !== "/system_admin/directory") return standardResponse(config);
    if (!switched) return old.promise;
    return directory([adminRow(config.headers["Authori-zation"] === "Bearer system-token-a" ? 23 : 30)]);
  });
  try {
    const original = fixture.calls.find(call => call.url === "/system_admin/directory"); switched = true;
    login(["system.view"], "system-token-b", 30); browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    login(["system.view", "system.manage"], "system-token-a", 20); browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    expect(original.signal.aborted).toBe(true);
    expect(fixture.view.adminList.value.map((row: any) => row.id)).toEqual([23]);
    old.resolve(directory([adminRow(22)])); await flush();
    expect(fixture.view.adminList.value.map((row: any) => row.id)).toEqual([23]);
    expect(fixture.view.adminError.value).toBe("");
  } finally { fixture.close(); }
});

it("storage-based grant revocation clears the surface and prevents further writes", async () => {
  const fixture = await mount();
  try {
    adminDraft(fixture.view);
    login(["order.view"], "system-token-b", 30);
    browser.dispatchEvent(Object.assign(new Event("storage"), { key: "admin_session", storageArea: localStorage })); await flush();
    expect(fixture.view.canView.value).toBe(false);
    expect(fixture.view.adminList.value).toEqual([]); expect(fixture.view.roleList.value).toEqual([]);
    expect(fixture.view.adminDialog.pwd).toBe("");
    await fixture.view.saveAdmin(); await fixture.view.delRole(roleRow());
    expect(writes(fixture.calls)).toEqual([]);
  } finally { fixture.close(); }
});

it("Pinia-only grant revocation or actor change never restores stale persisted authority", async () => {
  for (const change of ["manage", "actor"] as const) {
    const fixture = await mount();
    try {
      adminDraft(fixture.view); await roleDraft(fixture.view);
      const originalStorage = storage.get("admin_session");
      if (change === "manage") fixture.auth.$patch({ uniqueAuth: ["system.view"] });
      else fixture.auth.$patch({ userInfo: { ...fixture.auth.userInfo, id: 30, account: "replacement" } });
      await flush();
      expect(storage.get("admin_session")).toBe(originalStorage);
      expect(fixture.view.canManage.value).toBe(false);
      expect(fixture.view.adminDialog.show).toBe(false); expect(fixture.view.adminDialog.pwd).toBe("");
      expect(fixture.view.adminDialog.account).toBe(""); expect(fixture.view.adminDialog.phone).toBe("");
      expect(fixture.view.roleDialog.show).toBe(false); expect(fixture.view.roleDialog.role_name).toBe("");
      if (change === "manage") expect(fixture.auth.uniqueAuth).toEqual(["system.view"]);
      else {
        expect(fixture.auth.userInfo.id).toBe(30);
        expect(fixture.view.canView.value).toBe(false);
        expect(fixture.view.adminList.value).toEqual([]); expect(fixture.view.roleList.value).toEqual([]);
      }
      await fixture.view.saveAdmin(); await fixture.view.saveRole();
      expect(writes(fixture.calls)).toEqual([]);
    } finally { fixture.close(); }
  }
});

it("permission-directory retry closes old editing and requires reopening the original role keys", async () => {
  let failTree = false;
  const fixture = await mount(undefined, config => {
    if (config.url === "/system_menus/tree" && failTree) throw Error("permission directory offline");
    return standardResponse(config);
  });
  try {
    let checked: string[] = [];
    const control = { setCheckedKeys: (keys: string[]) => { checked = [...keys]; }, getCheckedKeys: () => checked };
    fixture.view.permissionTreeRef.value = control;
    await fixture.view.openRoleForm(fixture.view.roleList.value[0]);
    expect(checked).toEqual(["system.view"]);
    failTree = true; await fixture.view.loadPermissionTree();
    expect(fixture.view.permissionTreeReady.value).toBe(false);
    expect(fixture.view.roleDialog.show).toBe(false); expect(fixture.view.roleDialog.permissionKeys).toEqual([]);
    failTree = false; checked = []; await fixture.view.loadPermissionTree();
    expect(fixture.view.permissionTreeReady.value).toBe(true);
    await fixture.view.saveRole(); expect(writes(fixture.calls)).toEqual([]);
    fixture.view.permissionTreeRef.value = control;
    await fixture.view.openRoleForm(fixture.view.roleList.value[0]);
    expect(checked).toEqual(["system.view"]);
    expect(fixture.view.roleDialog.permissionKeys).toEqual(["system.view"]);
    await fixture.view.saveRole();
    expect(fixture.view.previewDialog.show).toBe(true); await confirmOperation(fixture.view);
    expect(writes(fixture.calls)).toHaveLength(1);
    expect(JSON.parse(writes(fixture.calls)[0].data).payload.rules).toBe("system.view");
  } finally { fixture.close(); }
});

it("canceling role deletion preview sends no commit while a real commit failure remains visible", async () => {
  const fixture = await mount(undefined, config => {
    if (config.url === "/system/authority/commit") throw Error("role deletion unavailable");
    if (config.url === "/system_role/directory") return directory([roleRow(3)], config.params.page, config.params.limit);
    return standardResponse(config);
  });
  try {
    await fixture.view.delRole(fixture.view.roleList.value[0]); fixture.view.cancelPreview();
    expect(writes(fixture.calls)).toEqual([]); expect(runtime.messages.state.errors).toEqual([]);
    await fixture.view.delRole(fixture.view.roleList.value[0]); await confirmOperation(fixture.view);
    expect(writes(fixture.calls)).toHaveLength(1);
    expect([...runtime.messages.state.errors, fixture.view.recoveryMessage.value].join(" ")).toContain("role deletion unavailable");
    expect(runtime.messages.state.success).toEqual([]);
  } finally { fixture.close(); }
});

it("confirmation rechecks permissions before issuing a role deletion", async () => {
  const fixture = await mount(undefined, config => config.url === "/system_role/directory"
    ? directory([roleRow(3)], config.params.page, config.params.limit) : standardResponse(config));
  try {
    await fixture.view.delRole(fixture.view.roleList.value[0]);
    expect(fixture.view.previewDialog.show).toBe(true);
    login(["system.view"], "system-token-b", 30); browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    await confirmOperation(fixture.view);
    expect(writes(fixture.calls)).toEqual([]);
  } finally { fixture.close(); }
});

it("pending admin and role saves cannot be submitted twice", async () => {
  for (const kind of ["admin", "role"] as const) {
    const gate = deferred<unknown>();
    const fixture = await mount(undefined, config => config.url === "/system/authority/commit" ? gate.promise : standardResponse(config));
    try {
      if (kind === "admin") adminDraft(fixture.view); else await roleDraft(fixture.view);
      const save = kind === "admin" ? fixture.view.saveAdmin : fixture.view.saveRole;
      await save(); fixture.view.previewDialog.confirmed = true;
      const first = fixture.view.confirmOperation(); await flush(); await save(); await fixture.view.confirmOperation();
      expect(writes(fixture.calls)).toHaveLength(1);
      expect(fixture.view.busy.value).toBeTruthy();
      gate.resolve(receiptFor(writes(fixture.calls)[0])); await first;
      expect(writes(fixture.calls)).toHaveLength(1);
    } finally { fixture.close(); }
  }
});

it("unknown admin save outcome retains the draft and blocks blind repeats even after directory reread", async () => {
  const fixture = await mount(undefined, config => {
    if (config.url === "/system/authority/commit") throw Error("response lost");
    return standardResponse(config);
  });
  try {
    adminDraft(fixture.view); await fixture.view.saveAdmin(); await confirmOperation(fixture.view);
    expect(fixture.view.adminDialog.show).toBe(true);
    expect(fixture.view.adminDialog.account).toBe("new-operator");
    expect(fixture.view.writeBlocked.value).toBe(true);
    expect([...runtime.messages.state.errors, fixture.view.recoveryMessage.value].join(" ")).toContain("response lost");
    await fixture.view.loadAdmin(); expect(fixture.view.writeBlocked.value).toBe(true);
    await fixture.view.saveAdmin(); expect(writes(fixture.calls)).toHaveLength(1);
    expect(runtime.messages.state.success).toEqual([]);
  } finally { fixture.close(); }
});

it("late successful mutation cannot close or toast for a replacement session", async () => {
  const late = deferred<unknown>();
  const fixture = await mount(undefined, config => config.url === "/system/authority/commit" ? late.promise : standardResponse(config));
  try {
    adminDraft(fixture.view); await fixture.view.saveAdmin(); fixture.view.previewDialog.confirmed = true;
    const pending = fixture.view.confirmOperation(); await flush();
    const posted = writes(fixture.calls)[0];
    login(["system.view"], "system-token-b", 30); browser.dispatchEvent(new Event("admin-session-changed")); await flush();
    expect(posted.signal.aborted).toBe(true);
    expect(fixture.view.adminDialog.pwd).toBe("");
    late.resolve(receiptFor(posted)); await pending; await flush();
    expect(runtime.messages.state.success).toEqual([]); expect(runtime.messages.state.errors).toEqual([]);
    expect(fixture.view.adminDialog.show).toBe(false);
  } finally { fixture.close(); }
});

it("unmount aborts pending reads and disposes all retained PII", async () => {
  const old = deferred<unknown>();
  const fixture = await mount(undefined, () => old.promise);
  const calls = [...fixture.calls]; fixture.close();
  expect(calls.every(call => call.signal.aborted)).toBe(true);
  old.resolve(directory([adminRow(99)])); await flush();
  expect(fixture.view.adminList.value).toEqual([]); expect(fixture.view.roleList.value).toEqual([]);
  expect(fixture.view.adminDialog.pwd).toBe("");
  expect(runtime.messages.state.success).toEqual([]); expect(runtime.messages.state.errors).toEqual([]);
});

it("the actual SFC script and template compile with both independent server paginations", () => {
  const file = resolve(root, "src/pages/system/SystemList.vue"), parsed = parse(readFileSync(file, "utf8"), { filename: file });
  expect(parsed.errors).toEqual([]);
  const script = compileScript(parsed.descriptor, { id: "system-directory-template" });
  expect(compileTemplate({ source: parsed.descriptor.template.content, filename: file, id: "system-directory-template", compilerOptions: { bindingMetadata: script.bindings } }).errors).toEqual([]);
});

it("the actual template hides mutation controls from read-only users and renders server pagination totals", async () => {
  const fixture = await mount(["system.view"]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const file = resolve(root, "src/pages/system/SystemList.vue"), descriptor = parse(readFileSync(file, "utf8"), { filename: file }).descriptor;
    const components = new Map<string, object>();
    const templateVue = new Proxy(runtime.vue, { get: (value, key) => key === "resolveComponent" ? (name: string) => {
      if (!components.has(name)) components.set(name, { name }); return components.get(name);
    } : value[key] });
    const render = new Function("Vue", compile(descriptor.template.content, { mode: "function", prefixIdentifiers: true }).code)(templateVue);
    const context = new Proxy(fixture.view, { get: (value, key) => runtime.vue.unref(value[key]) });
    const vnode = render(context, []), nodes: any[] = [];
    function collect(value: any) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(collect); return; }
      nodes.push(value);
      if (value.children && typeof value.children === "object" && !Array.isArray(value.children)) {
        for (const slot of Object.values(value.children)) if (typeof slot === "function") collect(slot({ row: roleRow() }));
      } else collect(value.children);
    }
    collect(vnode);
    const text = nodes.map(node => typeof node.children === "string" ? node.children : "").join(" ");
    expect(text).not.toContain("新增管理员"); expect(text).not.toContain("新增角色");
    const pagination = nodes.filter(node => node.type?.name?.toLowerCase().replace(/-/g, "") === "elpagination");
    expect(pagination).toHaveLength(2);
    expect(pagination.map(node => node.props.total)).toEqual([21, 21]);
    expect(writes(fixture.calls)).toEqual([]);
  } finally { warn.mockRestore(); fixture.close(); }
});
