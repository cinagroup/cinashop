/** PREPARATION ONLY: pure metadata matrix, not service/HTTP authority proof. */
import { describe, expect, it } from 'vitest';
import {
  PC_BASE_PERMISSION_FIELDS, PC_BASE_VIEW_SEED, PC_BASE_SAVE_SEED,
  pcBaseMenuBinding, pcBasePermissionsFromMenus, type PcBaseMenuIdentity,
} from '../src/services/admin/AdminPcBasePermissionBinding';

function drift(row: Readonly<PcBaseMenuIdentity>, key: typeof PC_BASE_PERMISSION_FIELDS[number]): PcBaseMenuIdentity {
  return { ...row, [key]: typeof row[key] === 'number' ? Number(row[key]) + 1 : String(row[key]) + 'drift' };
}
describe('PC base exact historical permission input candidate', () => {
  it('gives the exact1361 view and requires exact315 as well for the PC writer', () => {
    expect(pcBasePermissionsFromMenus([])).toEqual([]);
    expect(pcBasePermissionsFromMenus([PC_BASE_SAVE_SEED])).toEqual([]);
    expect(pcBasePermissionsFromMenus([PC_BASE_VIEW_SEED])).toEqual(['pc_base.view']);
    expect(pcBasePermissionsFromMenus([PC_BASE_VIEW_SEED, PC_BASE_SAVE_SEED])).toEqual(['pc_base.view', 'pc_base.manage']);
  });
  it.each(PC_BASE_PERMISSION_FIELDS)('denies a view seed with drifted %s', key => {
    const changed = drift(PC_BASE_VIEW_SEED, key);
    expect(pcBaseMenuBinding(changed).protected).toBe(true);
    expect(pcBasePermissionsFromMenus([changed, PC_BASE_SAVE_SEED])).toEqual([]);
  });
  it.each(PC_BASE_PERMISSION_FIELDS)('denies a save seed with drifted %s while retaining proved view', key => {
    const changed = drift(PC_BASE_SAVE_SEED, key);
    expect(pcBaseMenuBinding(changed).protected).toBe(true);
    expect(pcBasePermissionsFromMenus([PC_BASE_VIEW_SEED, changed])).toEqual(['pc_base.view']);
  });
  it('rejects copied view and save tuples with different identities', () => {
    expect(pcBasePermissionsFromMenus([{ ...PC_BASE_VIEW_SEED, id: 9999 }, PC_BASE_SAVE_SEED])).toEqual([]);
    expect(pcBasePermissionsFromMenus([PC_BASE_VIEW_SEED, { ...PC_BASE_SAVE_SEED, id: 9999 }])).toEqual(['pc_base.view']);
  });
  it('keeps direct modern claims, aliases and method-normalized copies protected without granting them', () => {
    for (const row of [
      { id: 9999, uniqueAuth: 'pc_base.manage' },
      { ...PC_BASE_VIEW_SEED, id: 9999, menuPath: '/config/pc' },
      { ...PC_BASE_VIEW_SEED, menuPath: '/ADMIN/APP/PC ' },
      { ...PC_BASE_SAVE_SEED, methods: 'post' },
      { ...PC_BASE_SAVE_SEED, apiUrl: '/adminapi/setting/config/save_basics' },
      { id: 9999, apiUrl: '/adminapi/config/pc' },
      { id: 9999, apiUrl: 'setting/config/edit_new_build/pc' },
    ]) {
      expect(pcBaseMenuBinding(row).protected).toBe(true);
      expect(pcBaseMenuBinding(row).view).toBe(false);
      expect(pcBaseMenuBinding(row).sharedSave).toBe(false);
    }
  });
  it('never treats Open1360 plus shared315 or a PC-banner row as a PC author', () => {
    const open = { ...PC_BASE_VIEW_SEED, id: 1360, menuPath: '/admin/app/wechat_open', uniqueAuth: 'app-wechat-open' };
    const banner = { ...PC_BASE_VIEW_SEED, id: 9999, menuPath: '/admin/setting/system_group_data/pc/1', uniqueAuth: '' };
    expect(pcBasePermissionsFromMenus([open, PC_BASE_SAVE_SEED])).toEqual([]);
    expect(pcBasePermissionsFromMenus([banner, PC_BASE_SAVE_SEED])).toEqual([]);
    expect(pcBasePermissionsFromMenus([PC_BASE_VIEW_SEED, PC_BASE_SAVE_SEED]).some(permission => String(permission).startsWith('wechat_open.'))).toBe(false);
  });
  it('requires all tuple fields rather than trusting a partial metadata read', () => {
    const partial = { id: 1361, menuPath: '/admin/app/pc', uniqueAuth: 'app-pc', authType: 1, apiUrl: '', methods: '' };
    expect(pcBasePermissionsFromMenus([partial, PC_BASE_SAVE_SEED])).toEqual([]);
  });
});
