/** Pure historical menu identity checks; these functions grant no database
 * permissions. Callers must supply the current active, role-owned selection
 * after checking administrator/session authority and runtime SQL privileges. */
export const WECHAT_APP_PERMISSION_FIELDS = [
  'id', 'pid', 'type', 'module', 'controller', 'action',
  'authType', 'menuPath', 'uniqueAuth', 'apiUrl', 'methods',
] as const;

export type WechatAppMenuIdentity = {
  id: number; pid: number; type: number; module: string; controller: string; action: string;
  authType: number; menuPath: string; uniqueAuth: string; apiUrl: string; methods: string;
};
export type WechatAppPermission = 'wechat_app.view' | 'wechat_app.manage';
export type WechatAppMenuBinding = { protected: boolean; view: boolean; sharedSave: boolean };

/** Fixed PHP 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5,
 * public/install/crmeb.sql:9471 and :8880. Shared315 is not a child of1379. */
export const WECHAT_APP_VIEW_SEED: Readonly<WechatAppMenuIdentity> = Object.freeze({
  id: 1379, pid: 135, type: 1, module: 'admin', controller: '', action: '',
  authType: 1, menuPath: '/admin/app/app', uniqueAuth: 'app-app', apiUrl: '', methods: '',
});
export const WECHAT_APP_SAVE_SEED: Readonly<WechatAppMenuIdentity> = Object.freeze({
  id: 315, pid: 23, type: 1, module: 'admin', controller: '', action: '',
  authType: 2, menuPath: '', uniqueAuth: '', apiUrl: 'setting/config/save_basics', methods: 'POST',
});

function menuRecord(value: unknown): Partial<WechatAppMenuIdentity> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  for (const key of WECHAT_APP_PERMISSION_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && ('get' in descriptor || 'set' in descriptor)) return null;
  }
  return value as Partial<WechatAppMenuIdentity>;
}
function exact(row: Partial<WechatAppMenuIdentity>, seed: Readonly<WechatAppMenuIdentity>): boolean {
  return WECHAT_APP_PERMISSION_FIELDS.every(key => Object.hasOwn(row, key) && row[key] === seed[key]);
}
const compact = (value: unknown) => typeof value === 'string' ? value.toLowerCase().replace(/\s+/gu, '') : '';
function route(value: unknown): string {
  return compact(value).replace(/^\/(?:api\/admin|adminapi)\//u, '').replace(/^\/+|\/+$/gu, '');
}

/** Normalization identifies protected claims only. Authority always requires
 * the complete, byte-exact eleven-field historical tuple. */
export function wechatAppMenuBinding(value: unknown): WechatAppMenuBinding {
  const row = menuRecord(value);
  if (!row) return { protected: /^wechat_app\./u.test(compact(value)) || compact(value) === 'app-app', view: false, sharedSave: false };
  const path = compact(row.menuPath), auth = compact(row.uniqueAuth), api = route(row.apiUrl);
  const claimed = row.id === 1379 || row.id === 315
    || /^\/(?:admin\/app\/app|content\/wechat-app)(?:\/|$)/u.test(path)
    || auth === 'app-app' || auth.startsWith('wechat_app.')
    || /^wechat\/app(?:\/|$)/u.test(api)
    || /^setting\/config\/edit_new_build\/app(?:\/|$)/u.test(api)
    || /^setting\/config\/save_basics(?:\/|$)/u.test(api);
  return { protected: claimed, view: claimed && exact(row, WECHAT_APP_VIEW_SEED),
    sharedSave: claimed && exact(row, WECHAT_APP_SAVE_SEED) };
}

/** Only a unique exact1379 view plus a unique exact315 can compose App manage.
 * Copied metadata, partial projections and opaque permission strings confer
 * nothing. Active roles and fresh SQL authorization remain caller duties. */
export function wechatAppPermissionsFromMenus(rows: readonly unknown[]): WechatAppPermission[] {
  const records = rows.map(menuRecord);
  const views = records.filter(row => row?.id === WECHAT_APP_VIEW_SEED.id);
  if (views.length !== 1 || !wechatAppMenuBinding(views[0]).view) return [];
  const saves = records.filter(row => row?.id === WECHAT_APP_SAVE_SEED.id);
  return saves.length === 1 && wechatAppMenuBinding(saves[0]).sharedSave
    ? ['wechat_app.view', 'wechat_app.manage'] : ['wechat_app.view'];
}
