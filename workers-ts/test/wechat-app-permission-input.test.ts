/** Pure menu/metadata checks; these cases do not prove database or HTTP authority. */
import { describe, expect, it } from 'vitest';
import { WECHAT_APP_KEYS } from '../../view/common/wechatApp';
import {
  WECHAT_APP_PERMISSION_FIELDS, WECHAT_APP_VIEW_SEED, WECHAT_APP_SAVE_SEED,
  wechatAppMenuBinding, wechatAppPermissionsFromMenus, type WechatAppMenuIdentity,
} from '../src/services/admin/AdminWechatAppPermissionBinding';
import { WECHAT_APP_INSERT_METADATA } from '../src/services/admin/AdminWechatAppMetadata';

function drift(row: Readonly<WechatAppMenuIdentity>, key: typeof WECHAT_APP_PERMISSION_FIELDS[number]): WechatAppMenuIdentity {
  return { ...row, [key]: typeof row[key] === 'number' ? Number(row[key]) + 1 : String(row[key]) + 'drift' };
}

describe('native App exact historical permission selection', () => {
  it('requires exact1379 for view and both exact1379 plus shared315 for manage', () => {
    expect(wechatAppPermissionsFromMenus([])).toEqual([]);
    expect(wechatAppPermissionsFromMenus([WECHAT_APP_SAVE_SEED])).toEqual([]);
    expect(wechatAppPermissionsFromMenus([WECHAT_APP_VIEW_SEED])).toEqual(['wechat_app.view']);
    expect(wechatAppPermissionsFromMenus([WECHAT_APP_VIEW_SEED, WECHAT_APP_SAVE_SEED]))
      .toEqual(['wechat_app.view', 'wechat_app.manage']);
    expect(WECHAT_APP_PERMISSION_FIELDS).toEqual([
      'id', 'pid', 'type', 'module', 'controller', 'action', 'authType', 'menuPath', 'uniqueAuth', 'apiUrl', 'methods',
    ]);
  });

  it.each(WECHAT_APP_PERMISSION_FIELDS)('denies the page tuple when %s differs', key => {
    const changed = drift(WECHAT_APP_VIEW_SEED, key);
    expect(wechatAppMenuBinding(changed).protected).toBe(true);
    expect(wechatAppPermissionsFromMenus([changed, WECHAT_APP_SAVE_SEED])).toEqual([]);
  });

  it.each(WECHAT_APP_PERMISSION_FIELDS)('denies shared save when %s differs while retaining exact view', key => {
    const changed = drift(WECHAT_APP_SAVE_SEED, key);
    expect(wechatAppMenuBinding(changed).protected).toBe(true);
    expect(wechatAppPermissionsFromMenus([WECHAT_APP_VIEW_SEED, changed])).toEqual(['wechat_app.view']);
  });

  it('denies copied full metadata under different IDs and shared315 reparented to App1379', () => {
    expect(wechatAppPermissionsFromMenus([{ ...WECHAT_APP_VIEW_SEED, id: 9999 }, WECHAT_APP_SAVE_SEED])).toEqual([]);
    expect(wechatAppPermissionsFromMenus([WECHAT_APP_VIEW_SEED, { ...WECHAT_APP_SAVE_SEED, id: 9999 }])).toEqual(['wechat_app.view']);
    expect(wechatAppPermissionsFromMenus([WECHAT_APP_VIEW_SEED, { ...WECHAT_APP_SAVE_SEED, pid: 1379 }])).toEqual(['wechat_app.view']);
  });

  it('protects aliases and normalized claims without promoting them to exact authority', () => {
    for (const row of [
      { id: 9999, uniqueAuth: 'wechat_app.manage' },
      { id: 9999, uniqueAuth: ' WECHAT_APP.VIEW ' },
      { ...WECHAT_APP_VIEW_SEED, id: 9999, menuPath: '/content/wechat-app' },
      { id: 9999, menuPath: '/content/wechat-app/operations' },
      { ...WECHAT_APP_VIEW_SEED, menuPath: '/ADMIN/APP/APP ' },
      { ...WECHAT_APP_SAVE_SEED, methods: 'post' },
      { ...WECHAT_APP_SAVE_SEED, apiUrl: '/adminapi/setting/config/save_basics' },
      { id: 9999, apiUrl: '/api/admin/wechat/app' },
      { id: 9999, apiUrl: '/adminapi/wechat/app/operations/id' },
      { id: 9999, apiUrl: 'setting/config/edit_new_build/app' },
    ]) {
      expect(wechatAppMenuBinding(row)).toEqual({ protected: true, view: false, sharedSave: false });
    }
  });

  it('cannot derive an App grant from opaque permission strings, IDs or partial projections', () => {
    expect(wechatAppPermissionsFromMenus(['wechat_app.view', 'wechat_app.manage', 'app-app', 1379, 315, null, []])).toEqual([]);
    expect(wechatAppMenuBinding('wechat_app.manage')).toEqual({ protected: true, view: false, sharedSave: false });
    expect(wechatAppPermissionsFromMenus([
      { id: 1379, menuPath: '/admin/app/app', uniqueAuth: 'app-app', authType: 1, apiUrl: '', methods: '' },
      WECHAT_APP_SAVE_SEED,
    ])).toEqual([]);
    expect(wechatAppPermissionsFromMenus([Object.create(WECHAT_APP_VIEW_SEED), WECHAT_APP_SAVE_SEED])).toEqual([]);
  });

  it('does not accept conflicting duplicate IDs as a fresh unique menu selection', () => {
    expect(wechatAppPermissionsFromMenus([
      WECHAT_APP_VIEW_SEED, { ...WECHAT_APP_VIEW_SEED, module: 'store' }, WECHAT_APP_SAVE_SEED,
    ])).toEqual([]);
    expect(wechatAppPermissionsFromMenus([
      WECHAT_APP_VIEW_SEED, WECHAT_APP_SAVE_SEED, { ...WECHAT_APP_SAVE_SEED, methods: 'GET' },
    ])).toEqual(['wechat_app.view']);
  });

  it('cannot borrow Open, official-account or PC page authority', () => {
    for (const row of [
      { ...WECHAT_APP_VIEW_SEED, id: 1360, menuPath: '/admin/app/wechat_open', uniqueAuth: 'app-wechat-open' },
      { ...WECHAT_APP_VIEW_SEED, id: 1362, pid: 69, menuPath: '/admin/app/wechat/base', uniqueAuth: 'app-wechat-base' },
      { ...WECHAT_APP_VIEW_SEED, id: 1361, menuPath: '/admin/app/pc', uniqueAuth: 'app-pc' },
    ]) expect(wechatAppPermissionsFromMenus([row, WECHAT_APP_SAVE_SEED])).toEqual([]);
  });
});

describe('native App missing-row PHP metadata', () => {
  it('covers only the two App keys and the twelve original metadata fields', () => {
    expect(Object.keys(WECHAT_APP_INSERT_METADATA)).toEqual([...WECHAT_APP_KEYS]);
    const fields = ['type', 'inputType', 'configTabId', 'parameter', 'uploadType', 'required',
      'width', 'high', 'info', 'desc', 'sort', 'status'];
    for (const key of WECHAT_APP_KEYS) expect(Object.keys(WECHAT_APP_INSERT_METADATA[key])).toEqual(fields);
  });

  it('retains the complete348/349 metadata without seed IDs, values or another domain tab', () => {
    expect(WECHAT_APP_INSERT_METADATA).toEqual({
      wechat_app_appid: {
        type: 'text', inputType: 'input', configTabId: 73, parameter: '', uploadType: 0,
        required: '', width: 100, high: 0, info: '移动应用APPID', desc: '公众平台开放移动应用的APPID', sort: 0, status: 1,
      },
      wechat_app_appsecret: {
        type: 'text', inputType: 'input', configTabId: 73, parameter: '', uploadType: 0,
        required: '', width: 100, high: 0, info: '移动应用AppSecret', desc: '公众平台开放移动应用的AppSecret', sort: 0, status: 1,
      },
    });
  });
});
