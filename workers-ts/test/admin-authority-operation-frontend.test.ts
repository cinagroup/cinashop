import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../view/admin-ts");
const require = createRequire(resolve(root, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");
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
    : config.url === "/system_role/directory" ? directory([roleRow(3)], config.params.page, config.params.limit) : { id:30 };
}

async function mount(permissions = ["system.view", "system.manage"], respond?: (config: any) => unknown, owner = 20) {
  login(permissions, `system-token-${owner}`, owner);
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const data = respond ? await respond(config) : standardResponse(config);
    return { config, data: data?.__envelope ?? { status: 200, msg: "ok", data: data?.__data ?? data }, status: data?.__http ?? 200, statusText: "fixture", headers: {} };
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
const previews = (calls: any[]) => calls.filter(call => call.url === "/system/authority/preview");
const pendingKey = "admin_authority_pending_v1:20";
async function confirm(view: any) { view.previewDialog.confirmed=true; await view.confirmOperation(); }
async function adminPreview(view: any) { adminDraft(view); await view.saveAdmin(); }
function adminDraft(view: any) {
  view.openAdminForm();
  Object.assign(view.adminDialog, { account: "new-operator", real_name: "新管理员", phone: "13800000000", pwd: "synthetic-password-123", roles: "2", level: 1 });
}
async function roleDraft(view: any) {
  view.permissionTreeRef.value = { setCheckedKeys() {}, getCheckedKeys: () => ["system.view"] };
  await view.openRoleForm();
  Object.assign(view.roleDialog, { role_name: "新角色", level: 1 });
}
function renderedNodes(view: any) {
  const file=resolve(root,"src/pages/system/SystemList.vue"),descriptor=parse(readFileSync(file,"utf8"),{filename:file}).descriptor;
  const components=new Map<string,object>();
  const templateVue=new Proxy(runtime.vue,{get:(value,key)=>key==="resolveComponent"?(name:string)=>{
    if(!components.has(name))components.set(name,{name});return components.get(name);
  }:value[key]});
  const render=new Function("Vue",compile(descriptor.template.content,{mode:"function",prefixIdentifiers:true}).code)(templateVue);
  const context=new Proxy(view,{get:(value,key)=>runtime.vue.unref(value[key])});
  const nodes:any[]=[];
  function collect(value:any){
    if(!value||typeof value!=="object")return;if(Array.isArray(value)){value.forEach(collect);return;}
    nodes.push(value);
    if(value.children&&typeof value.children==="object"&&!Array.isArray(value.children)){
      for(const slot of Object.values(value.children))if(typeof slot==="function")collect(slot({row:roleRow(3)}));
    }else collect(value.children);
  }
  collect(render(context,[]));return nodes;
}


it("previews all three operation kinds and requires explicit confirmation even for CREATE", async () => {
  for (const kind of ["admin-save","role-save","role-delete"]) {
    const fixture=await mount();
    try {
      if(kind==="admin-save") await adminPreview(fixture.view);
      else if(kind==="role-save") { await roleDraft(fixture.view); await fixture.view.saveRole(); }
      else await fixture.view.delRole(fixture.view.roleList.value[0]);
      expect(previews(fixture.calls)).toHaveLength(1); expect(writes(fixture.calls)).toEqual([]);
      expect(fixture.view.previewDialog.show).toBe(true); expect(runtime.messages.state.success).toEqual([]);
      await fixture.view.confirmOperation(); expect(writes(fixture.calls)).toEqual([]);
      await confirm(fixture.view); expect(writes(fixture.calls)).toHaveLength(1);
      const preview=parsedBody(previews(fixture.calls)[0]), commit=parsedBody(writes(fixture.calls)[0]);
      expect(commit).toMatchObject({ ...preview, revision, confirmed:true });
      expect(commit.operation_id).toMatch(/^[a-f0-9-]{36}$/);
      expect(fixture.view.pendingOperation.value).toBeNull();
      expect(storage.has(pendingKey)).toBe(false);
    } finally { fixture.close(); }
    runtime.messages.state.success=[]; receipts.clear();
  }
});

it("shows the full affected list and status/rule comparison before changing an assigned role", async () => {
  const fixture=await mount();
  try {
    fixture.view.permissionTreeRef.value={setCheckedKeys(){},getCheckedKeys:()=>["system.view","system.manage"]};
    await fixture.view.openRoleForm(fixture.view.roleList.value[0]); fixture.view.roleDialog.status=0;
    await fixture.view.saveRole();
    expect(fixture.view.operationPreview.value.affected_accounts.map((row:any)=>row.id)).toEqual([40,41,42]);
    expect(fixture.view.operationPreview.value.summary.before).toMatchObject({status:1,rules:"system.view"});
    expect(fixture.view.operationPreview.value.summary.after).toMatchObject({status:0,rules:"system.view,system.manage"});
    const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
    try {
      const nodes=renderedNodes(fixture.view),text=nodes.map(node=>typeof node.children==="string"?node.children:"").join(" ");
      expect(text).toContain("完整影响名单（3 个账号）");expect(text).toContain("system.view,system.manage");expect(text).toContain("禁用");
      expect(nodes.some(node=>node.props?.data===fixture.view.operationPreview.value.affected_accounts)).toBe(true);
    } finally {warn.mockRestore();}
    expect(writes(fixture.calls)).toEqual([]); await confirm(fixture.view);
    expect(parsedBody(writes(fixture.calls)[0]).payload.status).toBe(0);
  } finally { fixture.close(); }
});

it("preserves an existing legacy role level 10 until its level is explicitly changed", async () => {
  const fixture=await mount(undefined,config=>{
    if(config.url==="/system_role/directory")return directory([{...roleRow(3),level:10}],config.params.page,config.params.limit);
    if(config.url==="/system/authority/preview"){
      const value=previewFor(config);value.summary.before={...value.summary.before!,level:10};
      value.summary.after.level=parsedBody(config).payload.level ?? 10;return value;
    }
    return standardResponse(config);
  });
  try {
    expect(fixture.view.roleReady.value).toBe(true);expect(fixture.view.roleList.value[0].level).toBe(10);
    fixture.view.permissionTreeRef.value={setCheckedKeys(){},getCheckedKeys:()=>["system.view"]};
    await fixture.view.openRoleForm(fixture.view.roleList.value[0]);
    expect(fixture.view.roleDialog.level).toBe(10);expect(fixture.view.roleDialog.originalLevel).toBe(10);
    fixture.view.roleDialog.role_name="保留旧级别";await fixture.view.saveRole();
    expect(parsedBody(previews(fixture.calls)[0]).payload).not.toHaveProperty("level");
    expect(fixture.view.operationPreview.value.summary.before.level).toBe(10);expect(fixture.view.operationPreview.value.summary.after.level).toBe(10);
    fixture.view.changeLegacyRoleLevel(true);expect(fixture.view.operationPreview.value).toBeNull();
    fixture.view.roleDialog.level=4;await fixture.view.saveRole();
    expect(parsedBody(previews(fixture.calls)[1]).payload.level).toBe(4);expect(fixture.view.operationPreview.value.summary.after.level).toBe(4);
    await confirm(fixture.view);expect(parsedBody(writes(fixture.calls)[0]).payload.level).toBe(4);
  } finally {fixture.close();}
});

it("cancels preview without committing and invalidates preview when drafts, status or selected permissions change", async () => {
  const fixture=await mount();
  try {
    await adminPreview(fixture.view); fixture.view.cancelPreview();
    expect(fixture.view.operationPreview.value).toBeNull(); expect(writes(fixture.calls)).toEqual([]);
    await fixture.view.saveAdmin(); fixture.view.adminDialog.real_name="编辑后新名称";
    expect(fixture.view.previewDialog.show).toBe(false); await confirm(fixture.view); expect(writes(fixture.calls)).toEqual([]);
    await fixture.view.saveAdmin(); fixture.view.adminDialog.status=0;
    expect(fixture.view.operationPreview.value).toBeNull();
    await roleDraft(fixture.view); await fixture.view.saveRole(); fixture.view.roleDialog.status=0;
    expect(fixture.view.operationPreview.value).toBeNull();
    let keys=["system.view"]; fixture.view.permissionTreeRef.value={setCheckedKeys(){},getCheckedKeys:()=>keys};
    await fixture.view.saveRole(); keys=["system.manage"]; fixture.view.roleSelectionChanged();
    expect(fixture.view.operationPreview.value).toBeNull(); await confirm(fixture.view); expect(writes(fixture.calls)).toEqual([]);
  } finally { fixture.close(); }
});

it("rechecks preview expiry and the actual tree payload before the first commit", async () => {
  const fixture=await mount();
  try {
    await adminPreview(fixture.view); fixture.view.operationPreview.value.expires_at=1; await confirm(fixture.view);
    expect(writes(fixture.calls)).toEqual([]); expect(fixture.view.writeError.value).toContain("重新预览");
    let keys=["system.view"]; await roleDraft(fixture.view);
    fixture.view.permissionTreeRef.value={setCheckedKeys(){},getCheckedKeys:()=>keys};
    await fixture.view.saveRole(); keys=["system.manage"]; await confirm(fixture.view);
    expect(writes(fixture.calls)).toEqual([]); expect(storage.has(pendingKey)).toBe(false);
  } finally { fixture.close(); }
});

it("locks both preview and commit against double submission", async () => {
  const previewGate=deferred<any>(),commitGate=deferred<any>(); let seen:any;
  const fixture=await mount(undefined,config=>{
    if(config.url==="/system/authority/preview"){seen=config;return previewGate.promise;}
    if(config.url==="/system/authority/commit") return commitGate.promise;
    return standardResponse(config);
  });
  try {
    adminDraft(fixture.view); const preparing=fixture.view.saveAdmin(); await flush(); await fixture.view.saveAdmin();
    expect(previews(fixture.calls)).toHaveLength(1); previewGate.resolve(previewFor(seen)); await preparing;
    fixture.view.previewDialog.confirmed=true; const first=fixture.view.confirmOperation(); await flush();
    await fixture.view.confirmOperation(); await fixture.view.saveRole(); await fixture.view.delRole(fixture.view.roleList.value[0]);
    expect(writes(fixture.calls)).toHaveLength(1); expect(fixture.view.busy.value).toBe(true);
    commitGate.resolve(receiptFor(writes(fixture.calls)[0])); await first;
    expect(writes(fixture.calls)).toHaveLength(1);
  } finally { fixture.close(); }
});

it.each(["http","payload","owner","uuid","kind","hash","id","created","extra","unknown"])(
  "keeps pending and blocks every new write after an unreliable %s commit response", async issue=>{
  const fixture=await mount(undefined,config=>{
    if(config.url!=="/system/authority/commit") return standardResponse(config);
    const value: Omit<ReturnType<typeof receiptFor>, "request_hash" | "result"> & {
      request_hash: string | null; result: ReturnType<typeof receiptFor>["result"] | null;
    } = receiptFor(config);
    if(issue==="http") return {__http:500,__data:value};
    if(issue==="payload") return {id:30};
    if(issue==="owner") value.actor_id=30;
    if(issue==="uuid") value.operation_id="11111111-1111-4111-8111-111111111111";
    if(issue==="kind") value.operation="role-save";
    if(issue==="hash") value.request_hash="c".repeat(64);
    if(issue==="id") value.result!.id=0;
    if(issue==="created") value.result!.created=false;
    if(issue==="extra") value.result!.deleted=true;
    if(issue==="unknown"){value.state="unknown";value.request_hash=null;value.result=null;}
    return value;
  });
  try {
    await adminPreview(fixture.view); await confirm(fixture.view);
    expect(fixture.view.pendingOperation.value).toBeTruthy(); expect(fixture.view.writeBlocked.value).toBe(true);
    expect(storage.has(pendingKey)).toBe(true); expect(runtime.messages.state.success).toEqual([]);
    await fixture.view.loadAdmin(); await fixture.view.loadRoles(); expect(fixture.view.writeBlocked.value).toBe(true);
    await fixture.view.saveAdmin(); await fixture.view.saveRole(); await fixture.view.delRole(fixture.view.roleList.value[0]);
    expect(writes(fixture.calls)).toHaveLength(1);
    const local=storage.get(pendingKey)!;
    expect(Object.keys(JSON.parse(local)).sort()).toEqual(["action","actor_id","operation","operation_id","request_hash","target_id","version"]);
    expect(local).not.toContain("synthetic-password"); expect(local).not.toContain("system-token"); expect(local).not.toContain("new-operator");
  } finally { fixture.close(); }
});

it("GET unknown never unlocks; explicit resolve seals not_applied and then permits a new UUID", async () => {
  const fixture=await mount(undefined,config=>{
    if(config.url==="/system/authority/commit") throw Error("response lost before outcome proof");
    return standardResponse(config);
  });
  try {
    await adminPreview(fixture.view); await confirm(fixture.view);
    const oldId=fixture.view.pendingOperation.value.operation_id;
    await fixture.view.recoverOperation(); expect(fixture.view.pendingOperation.value.operation_id).toBe(oldId);
    expect(fixture.view.writeBlocked.value).toBe(true);
    const read=fixture.calls.find(call=>call.url.includes("/receipt/"));
    expect(read.params.operation).toBe("admin-save");
    await fixture.view.resolveOperation();
    expect(parsedBody(writes(fixture.calls).at(-1))).toEqual({operation_id:oldId,operation:"admin-save"});
    expect(fixture.view.pendingOperation.value).toBeNull(); expect(storage.has(pendingKey)).toBe(false);
    expect(receipts.get(oldId)).toMatchObject({state:"not_applied",request_hash:null,result:null});
    adminDraft(fixture.view); await fixture.view.saveAdmin();
    expect(fixture.view.operationPreview.value.operation_id).not.toBe(oldId);
  } finally { fixture.close(); }
});

it("recovers a committed CREATE from its matching receipt instead of reposting the original payload", async () => {
  const fixture=await mount(undefined,config=>{
    if(config.url==="/system/authority/commit"){standardResponse(config);throw Error("reply lost after commit");}
    return standardResponse(config);
  });
  try {
    await adminPreview(fixture.view); await confirm(fixture.view);
    expect(fixture.view.pendingOperation.value.action).toBe("create");
    await fixture.view.recoverOperation(); expect(fixture.view.pendingOperation.value).toBeNull();
    expect(writes(fixture.calls)).toHaveLength(1); expect(runtime.messages.state.success).toEqual(["创建成功"]);
  } finally { fixture.close(); }
});

it.each(["owner","uuid","kind","hash","result"])("keeps pending when receipt lookup returns a mismatched %s proof", async issue=>{
  let committed:any;
  const fixture=await mount(undefined,config=>{
    if(config.url==="/system/authority/commit"){committed=receiptFor(config);throw Error("reply lost");}
    if(config.url.startsWith("/system/authority/receipt/")){
      const value=JSON.parse(JSON.stringify(committed));
      if(issue==="owner")value.actor_id=30;
      if(issue==="uuid")value.operation_id="11111111-1111-4111-8111-111111111111";
      if(issue==="kind")value.operation="role-save";
      if(issue==="hash")value.request_hash="c".repeat(64);
      if(issue==="result")value.result.created=false;
      return value;
    }
    return standardResponse(config);
  });
  try {
    await adminPreview(fixture.view);await confirm(fixture.view);await fixture.view.recoverOperation();
    expect(fixture.view.pendingOperation.value).toBeTruthy();expect(fixture.view.writeBlocked.value).toBe(true);
    expect(storage.has(pendingKey)).toBe(true);expect(writes(fixture.calls)).toHaveLength(1);
    expect(runtime.messages.state.success).toEqual([]);expect(fixture.view.recoveryMessage.value).toContain("不匹配");
  } finally {fixture.close();}
});

it("persists pending across unmount and reload, hides it from a new owner and recovers after same-owner permission revocation", async () => {
  const respond=(config:any)=>{if(config.url==="/system/authority/commit")throw Error("unknown");return standardResponse(config);};
  const first=await mount(undefined,respond);
  await adminPreview(first.view); await confirm(first.view); const persisted=storage.get(pendingKey); first.close();
  expect(persisted).toBeTruthy(); expect(storage.get(pendingKey)).toBe(persisted);
  const foreign=await mount([],respond,30);
  try {expect(foreign.view.pendingOperation.value).toBeNull();expect(foreign.view.canView.value).toBe(false);expect(storage.get(pendingKey)).toBe(persisted);}
  finally {foreign.close();}
  const same=await mount([],respond,20);
  try {
    expect(same.view.canView.value).toBe(false);expect(same.view.canManage.value).toBe(false);
    expect(same.view.canRecover.value).toBe(true);expect(same.view.pendingOperation.value).toBeTruthy();
    expect(same.view.canRetryOperation.value).toBe(false);
    const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
    try {
      const nodes=renderedNodes(same.view),text=nodes.map(node=>typeof node.children==="string"?node.children:"").join(" ");
      expect(text).toContain("查询回执");expect(text).toContain("确认取消未执行操作");
      expect(nodes.some(node=>node.type?.name==="el-tabs")).toBe(false);
      expect(nodes.some(node=>node.props?.title==="上一笔操作结果待确认，暂不能提交新的操作")).toBe(true);
    } finally {warn.mockRestore();}
    await same.view.recoverOperation();expect(same.view.pendingOperation.value).toBeTruthy();
    await same.view.resolveOperation();expect(same.view.pendingOperation.value).toBeNull();
    expect(same.calls.every(call=>!call.url.includes("directory") && !call.url.endsWith("/commit"))).toBe(true);
  } finally {same.close();}
});

it("retries only by explicit confirmation with the same UUID and exact original request", async () => {
  let attempts=0;
  const fixture=await mount(undefined,config=>{
    if(config.url==="/system/authority/commit" && ++attempts===1)throw Error("unknown");
    return standardResponse(config);
  });
  try {
    await adminPreview(fixture.view);await confirm(fixture.view);
    const original=writes(fixture.calls)[0].data; fixture.view.adminDialog.real_name="另一新草稿";
    expect(fixture.view.canRetryOperation.value).toBe(true); await fixture.view.retryOperation();
    expect(writes(fixture.calls)).toHaveLength(2);expect(writes(fixture.calls)[1].data).toBe(original);
    expect(runtime.messages.state.confirmations).toHaveLength(1);
    expect(fixture.view.pendingOperation.value).toBeNull();
  } finally {fixture.close();}
});

it("auth-expiry clearing cannot forget an unknown own-password write; same owner can look up after fresh login", async () => {
  const fixture=await mount(undefined,config=>{
    if(config.url==="/system/authority/commit"){standardResponse(config);return {__envelope:{status:410001,msg:"old password version",data:null}};}
    return standardResponse(config);
  });
  try {
    fixture.view.openAdminForm(fixture.view.adminList.value[0]);fixture.view.adminDialog.pwd="synthetic-password-123";
    await fixture.view.saveAdmin();await confirm(fixture.view);
    expect(parsedBody(writes(fixture.calls)[0]).payload.id).toBe(20);
    expect(storage.has("admin_token")).toBe(false);expect(storage.has(pendingKey)).toBe(true);
    expect(fixture.view.pendingOperation.value).toBeNull();
    login([],"system-token-20-new",20);browser.dispatchEvent(new Event("admin-session-changed"));await flush();
    expect(fixture.view.canManage.value).toBe(false);expect(fixture.view.canRecover.value).toBe(true);
    expect(fixture.view.pendingOperation.value).toBeTruthy();await fixture.view.recoverOperation();
    expect(fixture.view.pendingOperation.value).toBeNull();expect(writes(fixture.calls)).toHaveLength(1);
  } finally {fixture.close();}
});

it("keeps the pending record when explicit resolve is canceled or its response is malformed", async () => {
  const fixture=await mount(undefined,config=>{
    if(config.url==="/system/authority/commit")throw Error("unknown");
    if(config.url==="/system/authority/resolve")return {state:"not_applied"};
    return standardResponse(config);
  });
  try {
    await adminPreview(fixture.view);await confirm(fixture.view);
    runtime.messages.state.confirm=async()=>{throw "cancel";};await fixture.view.resolveOperation();
    expect(writes(fixture.calls)).toHaveLength(1);expect(storage.has(pendingKey)).toBe(true);
    runtime.messages.state.confirm=async()=>{};await fixture.view.resolveOperation();
    expect(writes(fixture.calls)).toHaveLength(2);expect(fixture.view.pendingOperation.value).toBeTruthy();
    expect(runtime.messages.state.success).toEqual([]);
  } finally {fixture.close();}
});

it("does not commit unless recovery metadata was durably saved before sending", async () => {
  const fixture=await mount();
  try {
    await adminPreview(fixture.view);
    const original=localStorage.setItem;
    localStorage.setItem=(key:string,value:string)=>{if(key===pendingKey)throw Error("storage unavailable");original(key,value);};
    await confirm(fixture.view);
    expect(writes(fixture.calls)).toEqual([]);expect(fixture.view.recoveryError.value).toContain("storage unavailable");
    expect(fixture.view.writeBlocked.value).toBe(true);expect(runtime.messages.state.success).toEqual([]);
  } finally {fixture.close();}
});

it.each(["owner","partial","duplicate","oversized","hash","level","status"])("rejects an incomplete or mismatched %s preview without a success or commit", async issue=>{
  const fixture=await mount(undefined,config=>{
    if(config.url!=="/system/authority/preview")return standardResponse(config);
    const value=previewFor(config);
    if(issue==="owner")value.actor_id=30;
    if(issue==="partial")value.summary.after={status:1} as any;
    if(issue==="duplicate")value.affected_accounts.push(value.affected_accounts[0]);
    if(issue==="oversized")value.affected_accounts=Array.from({length:1001},(_,i)=>({...value.affected_accounts[0],id:i+1}));
    if(issue==="hash")value.request_hash="invalid";
    if(issue==="level")value.summary.after.level=10;
    if(issue==="status")value.summary.after.status=2;
    return value;
  });
  try {
    await adminPreview(fixture.view);expect(fixture.view.operationPreview.value).toBeNull();
    expect(fixture.view.writeError.value).toBeTruthy();expect(writes(fixture.calls)).toEqual([]);
    expect(fixture.view.pendingOperation.value).toBeNull();expect(runtime.messages.state.success).toEqual([]);
  } finally {fixture.close();}
});
