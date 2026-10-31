/** Pure historical menu identity checks. Fresh active-role selection, current
 * administrator authority and the runtime SQL contract remain caller duties. */
export const WECHAT_ROUTINE_PERMISSION_FIELDS = [
  'id', 'pid', 'type', 'module', 'controller', 'action',
  'authType', 'menuPath', 'uniqueAuth', 'apiUrl', 'methods',
] as const;

export type WechatRoutineMenuIdentity = {
  id: number; pid: number; type: number; module: string; controller: string; action: string;
  authType: number; menuPath: string; uniqueAuth: string; apiUrl: string; methods: string;
};
export type WechatRoutinePermission = 'wechat_routine.view' | 'wechat_routine.manage';
export type WechatRoutineMenuBinding = { protected: boolean; view: boolean; sharedSave: boolean };

/** Fixed PHP 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5,
 * public/install/crmeb.sql:9447 and :8880. The SPA route at
 * view/admin/src/router/modules/app.js:180 requires routine-download.
 * Parent1345, source download1348 and shared315 alone do not grant this author. */
export const WECHAT_ROUTINE_VIEW_SEED: Readonly<WechatRoutineMenuIdentity> = Object.freeze({
  id: 1346, pid: 1345, type: 1, module: 'admin', controller: '', action: '',
  authType: 1, menuPath: '/admin/app/routine/download', uniqueAuth: 'routine-download', apiUrl: '', methods: '',
});
export const WECHAT_ROUTINE_SAVE_SEED: Readonly<WechatRoutineMenuIdentity> = Object.freeze({
  id: 315, pid: 23, type: 1, module: 'admin', controller: '', action: '',
  authType: 2, menuPath: '', uniqueAuth: '', apiUrl: 'setting/config/save_basics', methods: 'POST',
});

function menuRecord(value: unknown): Partial<WechatRoutineMenuIdentity> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  for (const key of WECHAT_ROUTINE_PERMISSION_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && ('get' in descriptor || 'set' in descriptor)) return null;
  }
  return value as Partial<WechatRoutineMenuIdentity>;
}
function exact(row: Partial<WechatRoutineMenuIdentity>, seed: Readonly<WechatRoutineMenuIdentity>): boolean {
  return WECHAT_ROUTINE_PERMISSION_FIELDS.every(key => Object.hasOwn(row, key) && row[key] === seed[key]);
}
const compact = (value: unknown) => typeof value === 'string' ? value.toLowerCase().replace(/\s+/gu, '') : '';
function route(value: unknown): string {
  return compact(value).replace(/^\/(?:api\/admin|adminapi)\//u, '').replace(/^\/+|\/+$/gu, '');
}

/** Normalized claims identify protected input only. A copied path/auth/API,
 * partial projection or parent cannot replace the byte-exact leaf tuple. */
export function wechatRoutineMenuBinding(value: unknown): WechatRoutineMenuBinding {
  const row = menuRecord(value);
  if (!row) return { protected: /^wechat_routine\./u.test(compact(value))
    || ['routine-download', 'admin-routine'].includes(compact(value)), view: false, sharedSave: false };
  const path = compact(row.menuPath), auth = compact(row.uniqueAuth), api = route(row.apiUrl);
  const claimed = [1345, 1346, 1347, 1348, 315].some(id => row.id === id)
    || /^\/(?:admin\/app\/routine|content\/wechat-routine)(?:\/|$)/u.test(path)
    || auth === 'admin-routine' || auth === 'routine-download' || auth.startsWith('wechat_routine.')
    || /^(?:wechat\/routine|app\/routine)(?:\/|$)/u.test(api)
    || /^setting\/config\/edit_new_build\/routine(?:\/|$)/u.test(api)
    || /^setting\/config\/save_basics(?:\/|$)/u.test(api);
  return { protected: claimed, view: claimed && exact(row, WECHAT_ROUTINE_VIEW_SEED),
    sharedSave: claimed && exact(row, WECHAT_ROUTINE_SAVE_SEED) };
}

/** Only the unique exact1346 leaf and unique exact315 selection compose manage.
 * Opaque strings, neighbouring IDs and duplicated identities confer nothing. */
export function wechatRoutinePermissionsFromMenus(rows: readonly unknown[]): WechatRoutinePermission[] {
  const records = rows.map(menuRecord);
  const views = records.filter(row => row?.id === WECHAT_ROUTINE_VIEW_SEED.id);
  if (views.length !== 1 || !wechatRoutineMenuBinding(views[0]).view) return [];
  const saves = records.filter(row => row?.id === WECHAT_ROUTINE_SAVE_SEED.id);
  return saves.length === 1 && wechatRoutineMenuBinding(saves[0]).sharedSave
    ? ['wechat_routine.view', 'wechat_routine.manage'] : ['wechat_routine.view'];
}
