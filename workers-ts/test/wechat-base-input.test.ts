import { normalizeAdminConfigBatch } from '../src/services/system/AdminConfigBatchService';
import { describe, expect, it, vi } from 'vitest';
import { parseWechatBaseSave, WECHAT_BASE_KEYS, WECHAT_BASE_CALLBACK_AUTHORITY_KEY, wechatBasePending, type WechatBaseSave } from '../../view/common/wechatBase';
import { SystemConfigService } from '../src/services/system/SystemConfigService';
import type { Container } from '../src/lib/di';

const draft = (): WechatBaseSave => ({ request_id: '5ce45c99-c614-4912-a631-837f1138fac4', revision: 'a'.repeat(64),
  settings: { wechat_appid: 'wx1234567890abcdef', wechat_encode: 2, share_qrcode: 1, spread_share_forever: 1, wechat_qrcode: '/api/assets/9', create_wechat_user: 1 },
  secrets: { wechat_appsecret: { action: 'keep' }, wechat_encodingaeskey: { action: 'keep' }, wechat_token: { action: 'keep' } }, database_callback: true, confirmed: true });
describe('complete official-account base author input and credential-free recovery', () => {
  it('covers the nine active stored keys and all three original callback modes', () => {
    expect(new Set(WECHAT_BASE_KEYS).size).toBe(9);
    for (const mode of [0, 1, 2] as const) expect(parseWechatBaseSave({ ...draft(), settings: { ...draft().settings, wechat_encode: mode } }).settings.wechat_encode).toBe(mode);
  });
  it('rejects every complete-domain compatibility batch before SQL/KV, including mixed ordinary keys', () => {
    for (const key of [...WECHAT_BASE_KEYS, WECHAT_BASE_CALLBACK_AUTHORITY_KEY]) {
      expect(() => normalizeAdminConfigBatch({ [key]: 'owned-bypass-secret' })).toThrow('/wechat/base');
      expect(() => normalizeAdminConfigBatch({ site_name: 'must-not-write', [key]: 'owned-bypass-secret' })).toThrow('/wechat/base');
    }
    expect(normalizeAdminConfigBatch({ site_name: 'ordinary-site' })).toEqual([['site_name', 'ordinary-site']]);
  });
  it('keeps source and each credential intent separate from public fields', () => {
    const value = draft(); value.secrets.wechat_appsecret = { action: 'replace', value: 'OwnedSecret123' }; value.secrets.wechat_token = { action: 'clear' };
    expect(parseWechatBaseSave(value)).toEqual(value); expect(parseWechatBaseSave({ ...value, database_callback: false }).database_callback).toBe(false);
  });
  it.each(['request_id', 'revision', 'settings', 'secrets', 'database_callback', 'confirmed'])('requires the complete original save field %s', key => {
    const value = draft() as unknown as Record<string, unknown>; delete value[key]; expect(() => parseWechatBaseSave(value)).toThrow();
  });
  it.each(['api', 'site_url', 'wechat_share_img', 'routine_appsecret', 'is_store'])('does not expand generic configuration writes through %s', key => {
    expect(() => parseWechatBaseSave({ ...draft(), [key]: 'owned-value' })).toThrow();
    expect(() => parseWechatBaseSave({ ...draft(), settings: { ...draft().settings, [key]: 'owned-value' } })).toThrow();
  });
  it.each([null, [], '1', 4, true])('rejects an unknown callback mode %j', mode => {
    expect(() => parseWechatBaseSave({ ...draft(), settings: { ...draft().settings, wechat_encode: mode } })).toThrow();
  });
  it.each(['share_qrcode', 'spread_share_forever', 'create_wechat_user'])('does not coerce historical %s values into a selected switch', key => {
    for (const value of ['0', '1', null, true, 2]) expect(() => parseWechatBaseSave({ ...draft(), settings: { ...draft().settings, [key]: value } })).toThrow();
  });
  it.each(['keep', 'clear'])('does not hide replacement material behind %s', action => {
    expect(() => parseWechatBaseSave({ ...draft(), secrets: { ...draft().secrets, wechat_appsecret: { action, value: 'OwnedSecret123' } } })).toThrow();
  });
  it.each(['wechat_appsecret', 'wechat_encodingaeskey', 'wechat_token'])('requires an explicit intent for %s and does not echo rejected material', key => {
    const sensitive = 'owned-sensitive\nnever-return';
    expect(() => parseWechatBaseSave({ ...draft(), secrets: { ...draft().secrets, [key]: { action: 'replace', value: sensitive } } })).toThrow();
    try { parseWechatBaseSave({ ...draft(), secrets: { ...draft().secrets, [key]: { action: 'replace', value: sensitive } } }); }
    catch (error) { expect(String(error)).not.toContain('owned-sensitive'); }
  });
  it('validates Token, EncodingAESKey and app identifier independently', () => {
    for (const token of ['ab', 'x'.repeat(33), 'a-b', 'a b', '中文A']) expect(() => parseWechatBaseSave({ ...draft(), secrets: { ...draft().secrets, wechat_token: { action: 'replace', value: token } } })).toThrow();
    for (const aes of ['A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + '/', 'A'.repeat(42) + '+']) expect(() => parseWechatBaseSave({ ...draft(), secrets: { ...draft().secrets, wechat_encodingaeskey: { action: 'replace', value: aes } } })).toThrow();
    expect(parseWechatBaseSave({ ...draft(), secrets: { ...draft().secrets, wechat_encodingaeskey: { action: 'replace', value: 'A'.repeat(43) } } }).secrets.wechat_encodingaeskey).toEqual({ action: 'replace', value: 'A'.repeat(43) });
    expect(() => parseWechatBaseSave({ ...draft(), settings: { ...draft().settings, wechat_appid: 'legacy-arbitrary-app' } })).toThrow();
    expect(parseWechatBaseSave({ ...draft(), settings: { ...draft().settings, wechat_appid: '' }, database_callback: false }).settings.wechat_appid).toBe('');
  });
  it('never puts replacement values, fingerprints or other draft fields into a durable browser journal', () => {
    const value = draft(); value.secrets.wechat_appsecret = { action: 'replace', value: 'OwnedSecret123' }; value.secrets.wechat_token = { action: 'replace', value: 'OwnedToken123' };
    expect(wechatBasePending(value, 77)).toEqual({ version: 1, actor_id: 77, request_id: value.request_id });
    expect(JSON.stringify(wechatBasePending(value, 77))).not.toMatch(/OwnedSecret|OwnedToken|revision|settings|secrets|hash/);
  });
});

describe('general configuration access after official credential rotation', () => {
  it('bypasses poisoned credential KV on single reads without refilling it', async () => {
    const dao = { getValue: vi.fn(async () => '"fresh-owned-secret"') }, env = { CONFIG_KV: { get: vi.fn(async () => 'stale-secret'), put: vi.fn(), delete: vi.fn() } };
    const service = new SystemConfigService({ systemConfigDao: dao } as unknown as Container, env);
    expect(await service.get('wechat_appsecret')).toBe('fresh-owned-secret'); expect(await service.get('wechat_appid')).toBe('fresh-owned-secret');
    expect(env.CONFIG_KV.get).not.toHaveBeenCalled(); expect(env.CONFIG_KV.put).not.toHaveBeenCalled(); expect(dao.getValue).toHaveBeenCalledTimes(2);
  });
  it('reads credential misses together and preserves ordinary public cache behavior', async () => {
    const dao = { getValues: vi.fn(async () => ({ wechat_appid: '"fresh-app"', wechat_appsecret: '"fresh-secret"', site_name: '"fresh-site"' })) };
    const env = { CONFIG_KV: { get: vi.fn(async (_key: string) => null), put: vi.fn(async (_key: string, _value: string, _options?: unknown) => {}), delete: vi.fn() } };
    const service = new SystemConfigService({ systemConfigDao: dao } as unknown as Container, env);
    expect(await service.getMany(['wechat_appid', 'site_name', 'wechat_appsecret'])).toEqual({ wechat_appid: 'fresh-app', site_name: 'fresh-site', wechat_appsecret: 'fresh-secret' });
    expect(env.CONFIG_KV.get.mock.calls).toEqual([['cfg_site_name']]); expect(env.CONFIG_KV.put).toHaveBeenCalledOnce(); expect(env.CONFIG_KV.put.mock.calls[0][0]).toBe('cfg_site_name');
  });
});
