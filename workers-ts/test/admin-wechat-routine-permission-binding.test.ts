import { describe, expect, it, vi } from 'vitest';
import {
  WECHAT_ROUTINE_PERMISSION_FIELDS,
  WECHAT_ROUTINE_VIEW_SEED as view,
  WECHAT_ROUTINE_SAVE_SEED as save,
  wechatRoutineMenuBinding as binding,
  wechatRoutinePermissionsFromMenus as grants,
} from '@/services/admin/AdminWechatRoutinePermissionBinding';

/** Pure tuple composition only. These tests do not authenticate a live actor,
 * inspect PostgreSQL ACLs or establish the HTTP/SQL writer's readiness. */
describe('Routine exact historical leaf/save permission binding', () => {
  it('composes manage only from the complete leaf1346 and shared315 selection', () => {
    expect(grants([view, save])).toEqual(['wechat_routine.view', 'wechat_routine.manage']);
    expect(grants([save, view])).toEqual(['wechat_routine.view', 'wechat_routine.manage']);
    expect(grants([view])).toEqual(['wechat_routine.view']);
    expect(grants([save])).toEqual([]);
    expect(grants([])).toEqual([]);
  });

  it.each(WECHAT_ROUTINE_PERMISSION_FIELDS)('rejects view seed drift or omission of %s', field => {
    const changed = typeof view[field] === 'number' ? Number(view[field]) + 1 : String(view[field]) + ' ';
    expect(grants([{ ...view, [field]: changed }, save])).toEqual([]);
    const omitted: Record<string, unknown> = { ...view };
    delete omitted[field];
    expect(grants([omitted, save])).toEqual([]);
  });

  it.each(WECHAT_ROUTINE_PERMISSION_FIELDS)('does not compose manage after shared save drift or omission of %s', field => {
    const changed = typeof save[field] === 'number' ? Number(save[field]) + 1 : String(save[field]) + ' ';
    expect(grants([view, { ...save, [field]: changed }])).toEqual(['wechat_routine.view']);
    const omitted: Record<string, unknown> = { ...save };
    delete omitted[field];
    expect(grants([view, omitted])).toEqual(['wechat_routine.view']);
  });

  it('rejects duplicate identities instead of choosing the convenient seed', () => {
    expect(grants([view, { ...view }, save])).toEqual([]);
    expect(grants([view, { ...view, pid: 135 }, save])).toEqual([]);
    expect(grants([view, save, { ...save }])).toEqual(['wechat_routine.view']);
    expect(grants([view, save, { ...save, methods: 'GET' }])).toEqual(['wechat_routine.view']);
  });

  it.each([1345, 1347, 1348, 991346])('does not grant the author through neighbouring or copied ID %s', id => {
    expect(grants([{ ...view, id }, save])).toEqual([]);
  });

  it('does not compose parent/download/shared selections into writer authority', () => {
    const parent = { ...view, id: 1345, pid: 135, uniqueAuth: 'admin-routine' };
    const info = { ...view, id: 1347, authType: 2, menuPath: '', uniqueAuth: '', apiUrl: 'app/routine/info', methods: 'GET' };
    const download = { ...view, id: 1348, authType: 2, menuPath: '', uniqueAuth: '', apiUrl: 'app/routine/download', methods: 'POST' };
    expect(grants([parent, info, download, save])).toEqual([]);
    for (const row of [parent, info, download]) expect(binding(row).protected).toBe(true);
  });

  it.each(['wechat_routine.view', 'wechat_routine.manage', 'routine-download', 'admin-routine'])('never grants an opaque %s claim', claim => {
    expect(grants([claim, save])).toEqual([]);
    expect(binding(claim)).toEqual({ protected: true, view: false, sharedSave: false });
    expect(grants([{ ...view, id: 991346, uniqueAuth: claim }, save])).toEqual([]);
  });

  it('protects copied normalized path/auth/API claims without granting their authority', () => {
    for (const claim of [
      { menuPath: ' /ADMIN/APP/ROUTINE/download ' },
      { menuPath: '/content/wechat-routine' },
      { uniqueAuth: ' ROUTINE-DOWNLOAD ' },
      { uniqueAuth: ' WECHAT_ROUTINE.MANAGE ' },
      { apiUrl: '/adminapi/wechat/routine' },
      { apiUrl: '/api/admin/setting/config/edit_new_build/routine' },
      { apiUrl: 'app/routine/download' },
      { apiUrl: 'setting/config/save_basics' },
    ]) {
      const row = { ...view, id: 991346, ...claim };
      expect(binding(row)).toEqual({ protected: true, view: false, sharedSave: false });
      expect(grants([row, save])).toEqual([]);
    }
  });

  it('rejects inherited tuples, wrong scalar types and accessor projections without invoking them', () => {
    const getter = vi.fn(() => { throw Error('getter must not execute'); });
    const accessor = Object.defineProperty({ ...view }, 'id', { get: getter });
    for (const row of [Object.create(view), { ...view, id: '1346' }, accessor, null, [], 1346])
      expect(grants([row, save])).toEqual([]);
    expect(getter).not.toHaveBeenCalled();
  });
});
