import { describe, expect, it, vi } from 'vitest';
import { SystemConfigService } from '../src/services/system/SystemConfigService';
import type { Container } from '../src/lib/di';
import { parseWechatOpenSave, WECHAT_OPEN_KEYS, WECHAT_OPEN_AUTHORITY_KEY, wechatOpenPending, type WechatOpenSave } from '../../view/common/wechatOpen';
import { parseWechatBaseSave } from '../../view/common/wechatBase';
import { normalizeAdminConfigBatch } from '../src/services/system/AdminConfigBatchService';
import { requiredAdminPermission, isAdminWechatOpenRecoveryRoute, normalizeRoleRules } from '../src/services/admin/AdminPermissionService';
const draft = (): WechatOpenSave => ({ request_id: '11111111-1111-4111-8111-111111111111', revision: 'a'.repeat(64), settings: { wechat_open_app_id: 'wx1234567890abcdef' }, secrets: { wechat_open_app_secret: { action: 'keep' } }, database_credentials: false, confirmed: true });
describe('complete wxopen two-field author contract', () => {
  it('is disjoint from the complete official-account envelope and retains all explicit secret intents', () => {
    for (const action of ['keep','clear','replace'] as const) { const value = draft(); value.secrets.wechat_open_app_secret = action === 'replace' ? { action, value: 'owned-secret' } : { action }; expect(parseWechatOpenSave(value)).toEqual(value); expect(() => parseWechatBaseSave(value)).toThrow(); }
  });
  it.each(['request_id','revision','settings','secrets','database_credentials','confirmed'])('requires complete field %s', key => { const value = draft() as unknown as Record<string, unknown>; delete value[key]; expect(() => parseWechatOpenSave(value)).toThrow(); });
  it.each([null, [], true, 3, 'database'])('rejects non-object request %j', input => expect(() => parseWechatOpenSave(input)).toThrow());
  it.each(['wxshort','wx1234567890abcdef ','wx1234567890abcde\n',123, null])('rejects invalid AppID %j', value => expect(() => parseWechatOpenSave({ ...draft(), settings: { wechat_open_app_id: value } })).toThrow());
  it.each(['', 'with space', '\nSECRET', '\u0000', '\ud800', 'x'.repeat(257)])('rejects invalid replacement without echo %j', value => { const request = { ...draft(), secrets: { wechat_open_app_secret: { action: 'replace', value } } }; expect(() => parseWechatOpenSave(request)).toThrow('格式无效'); });
  it.each(['keep','clear'])('rejects hidden replacement in %s', action => expect(() => parseWechatOpenSave({ ...draft(), secrets: { wechat_open_app_secret: { action, value: 'hidden' } } })).toThrow());
  it.each(['wechat_open_app_id','wechat_open_app_secret',WECHAT_OPEN_AUTHORITY_KEY])('rejects whole generic mixed config batches for %s', key => { expect(() => normalizeAdminConfigBatch({ site_name: 'must-not-write', [key]: 'owned-secret' })).toThrow('/wechat/open'); });
  it('never journals credentials, draft, revision or secret hashes', () => { const value = draft(); value.secrets.wechat_open_app_secret = { action: 'replace', value: 'owned-secret' }; expect(wechatOpenPending(value, 17)).toEqual({ version: 1, actor_id: 17, request_id: value.request_id }); expect(WECHAT_OPEN_KEYS).toHaveLength(2); });
  it('rejects explicitly incomplete enabled credentials before a browser can journal or dispatch', () => {
    expect(() => parseWechatOpenSave({ ...draft(), database_credentials: true, settings: { wechat_open_app_id: '' } })).toThrow('启用数据库凭据');
    expect(() => parseWechatOpenSave({ ...draft(), database_credentials: true, secrets: { wechat_open_app_secret: { action: 'clear' } } })).toThrow('清空密钥前');
    expect(parseWechatOpenSave({ ...draft(), database_credentials: false, secrets: { wechat_open_app_secret: { action: 'clear' } } }).secrets.wechat_open_app_secret).toEqual({ action: 'clear' });
  });
  it('blocks all generic service reads before any SQL or KV and rejects mixed batches as a whole', async () => {
    const dao = { getValue: vi.fn(), getValues: vi.fn() }, kv = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
    const service = new SystemConfigService({ systemConfigDao: dao } as unknown as Container, { CONFIG_KV: kv });
    for (const key of [...WECHAT_OPEN_KEYS, WECHAT_OPEN_AUTHORITY_KEY]) {
      await expect(service.get(key)).rejects.toThrow('专用运行时解析器');
      await expect(service.getMany(['site_name', key])).rejects.toThrow('专用运行时解析器');
    }
    expect(dao.getValue).not.toHaveBeenCalled(); expect(dao.getValues).not.toHaveBeenCalled(); expect(kv.get).not.toHaveBeenCalled(); expect(kv.put).not.toHaveBeenCalled();
  });
  it('guards exact dual-prefix routes and only the two owner recovery shapes', () => {
    for (const prefix of ['/adminapi','/api/admin']) {
      expect(requiredAdminPermission('GET', prefix + '/setting/config/edit_new_build/wxopen')).toBe('wechat_open.view');
      expect(requiredAdminPermission('POST', prefix + '/wechat/open')).toBe('wechat_open.manage');
      expect(requiredAdminPermission('GET', prefix + '/wechat/open/unknown')).toBeNull();
      expect(isAdminWechatOpenRecoveryRoute('GET', prefix + '/wechat/open/operations/:operationId')).toBe(true);
      expect(isAdminWechatOpenRecoveryRoute('POST', prefix + '/wechat/open/operations/:operationId/resolve')).toBe(true);
      expect(isAdminWechatOpenRecoveryRoute('PUT', prefix + '/wechat/open/operations/17/resolve')).toBe(false);
      expect(isAdminWechatOpenRecoveryRoute('POST', prefix + '/wechat/open/operations/17/resolve/more')).toBe(false);
    }
    expect(normalizeRoleRules('wechat_open.view,wechat_open.manage')).toContain('wechat_open.manage');
  });
});
