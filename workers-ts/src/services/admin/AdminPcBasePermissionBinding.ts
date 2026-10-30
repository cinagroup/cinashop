/** PREPARATION ONLY. These pure helpers confer nothing until explicitly
 * integrated after the new accepted baseline and reviewed root wiring.
 * Fresh DB authorization, active-role filters and owner recovery are still
 * responsibilities of the future AdminPermissionService/service integration.
 */
export const PC_BASE_PERMISSION_FIELDS = [
  'id', 'pid', 'type', 'module', 'controller', 'action',
  'authType', 'menuPath', 'uniqueAuth', 'apiUrl', 'methods',
] as const;
export type PcBaseMenuIdentity = {
  id: number; pid: number; type: number; module: string; controller: string; action: string;
  authType: number; menuPath: string; uniqueAuth: string; apiUrl: string; methods: string;
};
export const PC_BASE_VIEW_SEED: Readonly<PcBaseMenuIdentity> = Object.freeze({
  id: 1361, pid: 135, type: 1, module: 'admin', controller: '', action: '',
  authType: 1, menuPath: '/admin/app/pc', uniqueAuth: 'app-pc', apiUrl: '', methods: '',
});
export const PC_BASE_SAVE_SEED: Readonly<PcBaseMenuIdentity> = Object.freeze({
  id: 315, pid: 23, type: 1, module: 'admin', controller: '', action: '',
  authType: 2, menuPath: '', uniqueAuth: '', apiUrl: 'setting/config/save_basics', methods: 'POST',
});
function exact(row: Partial<PcBaseMenuIdentity>, seed: Readonly<PcBaseMenuIdentity>): boolean {
  return PC_BASE_PERMISSION_FIELDS.every(key => row[key] === seed[key]);
}
const compact = (value: unknown) => typeof value === 'string' ? value.toLowerCase().replace(/\s/gu, '') : '';
function route(value: unknown): string {
  return compact(value).replace(/^\/(?:api\/admin|adminapi)\//u, '').replace(/^\/+|\/+$/gu, '');
}
export function pcBaseMenuBinding(row: Partial<PcBaseMenuIdentity>): {
  protected: boolean; view: boolean; sharedSave: boolean;
} {
  const path = compact(row.menuPath), auth = compact(row.uniqueAuth), api = route(row.apiUrl);
  const claimed = row.id === 1361 || row.id === 315
    || ['/admin/app/pc', '/config/pc'].includes(path)
    || auth === 'app-pc' || auth.startsWith('pc_base.')
    || /^config\/pc(?:\/|$)/u.test(api)
    || api === 'setting/config/edit_new_build/pc' || api === 'setting/config/save_basics';
  return { protected: claimed, view: claimed && exact(row, PC_BASE_VIEW_SEED),
    sharedSave: claimed && exact(row, PC_BASE_SAVE_SEED) };
}
/** Consumes only a fresh, active, role-owned menu selection. An exact315
 * can participate in multiple explicit config domains; it is not a generic
 * permission to invoke any one domain's writer. No direct claim strings. */
export function pcBasePermissionsFromMenus(rows: readonly Partial<PcBaseMenuIdentity>[]): Array<'pc_base.view' | 'pc_base.manage'> {
  const bindings = rows.map(pcBaseMenuBinding);
  if (!bindings.some(binding => binding.view)) return [];
  return bindings.some(binding => binding.sharedSave) ? ['pc_base.view', 'pc_base.manage'] : ['pc_base.view'];
}
