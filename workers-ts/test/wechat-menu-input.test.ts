import { describe, expect, it } from 'vitest';
import { normalizeWechatMenu, wechatMenuBytes, wechatMenuCanonical, wechatMenuProviderButtons } from '../../view/common/wechatMenu';
import { requiredAdminPermission } from '@/services/admin/AdminPermissionService';
const click = (name = '菜单') => ({ name, type: 'click', key: 'MENU_KEY' });
const mini = { name: '小程序', type: 'miniprogram', appid: 'wx1234567890abcdef', pagepath: 'pages/index?from=menu', url: 'https://example.test/fallback' };
describe('WeChat menu full author contract and exact HTTP capabilities', () => {
  it('preserves the complete ordered 3 by 5 author document and all three actions', () => {
    const buttons = [click('一'), { name: '二', sub_button: [click('子一'), { name: '子二', type: 'view', url: 'http://example.test/' }, mini, click('子四'), click('子五')] }, click('三')];
    expect(normalizeWechatMenu(buttons)).toEqual(buttons);
  });
  it('preserves inactive fields and PHP id:0 while projecting only active fields to the provider', () => {
    const raw = [{ ...click(), id: 0, url: 'https://old.example.test/', appid: '', pagepath: '', sub_button: [] }];
    const parsed = normalizeWechatMenu(raw);
    expect(parsed[0]).toEqual({ ...raw[0], id: undefined });
    expect(wechatMenuProviderButtons(parsed)).toEqual([click()]);
    expect(raw[0].id).toBe(0);
  });
  it('does not publish the inactive parent action and does not discard it locally', () => {
    const raw = [{ ...click(), key: '', url: '', sub_button: [mini] }], parsed = normalizeWechatMenu(raw);
    expect(parsed).toEqual(raw); expect(wechatMenuProviderButtons(parsed)).toEqual([{ name: '菜单', sub_button: [mini] }]);
  });
  it('allows a real empty draft but never interprets it as remote deletion', () => { expect(normalizeWechatMenu([], true)).toEqual([]); expect(() => normalizeWechatMenu([])).toThrow('空菜单不能发布'); });
  it.each([null, {}, [click(), click(), click(), click()], [{ name: '父', sub_button: Array.from({ length: 6 }, () => click()) }],
    [{ name: '父', sub_button: [{ name: '子', sub_button: [click()] }] }]])('rejects malformed or deeper/oversized structure %#', value => { expect(() => normalizeWechatMenu(value)).toThrow(); });
  it('uses UTF8 bytes rather than JavaScript character length for names', () => {
    expect(wechatMenuBytes('😀')).toBe(4); expect(normalizeWechatMenu([click('😀'.repeat(4))])[0].name).toBe('😀'.repeat(4));
    expect(() => normalizeWechatMenu([click('😀'.repeat(5))])).toThrow('16字节');
    expect(normalizeWechatMenu([{ name: '父', sub_button: [click('汉'.repeat(20))] }])[0].sub_button?.[0].name).toBe('汉'.repeat(20));
    expect(() => normalizeWechatMenu([{ name: '父', sub_button: [click('汉'.repeat(21))] }])).toThrow('60字节');
  });
  it('fences callback UTF16 length and official 128 byte key independently', () => {
    expect(normalizeWechatMenu([{ ...click(), key: 'a'.repeat(64) }])).toHaveLength(1);
    expect(() => normalizeWechatMenu([{ ...click(), key: 'a'.repeat(65) }])).toThrow('64');
    expect(normalizeWechatMenu([{ ...click(), key: '汉'.repeat(42) }])).toHaveLength(1);
    expect(() => normalizeWechatMenu([{ ...click(), key: '汉'.repeat(43) }])).toThrow('128');
  });
  it.each(['', ' ', '\u0000', '\ud800', '\udc00', 'test\n'])('refuses invalid/unpaired/control name %#', name => { expect(() => normalizeWechatMenu([click(name)])).toThrow(); });
  it.each(['javascript:alert(1)', '//example.test/', 'https://user:pass@example.test/', 'https://example.test/a b', 'https://example.test/\\foo'])('never admits unsafe link %#', url => { expect(() => normalizeWechatMenu([{ name: '网页', type: 'view', url }])).toThrow(); });
  it('enforces the official 1024 byte URL limit', () => {
    const prefix = 'https://example.test/';
    expect(normalizeWechatMenu([{ name: '网页', type: 'view', url: prefix + 'a'.repeat(1024 - prefix.length) }])).toHaveLength(1);
    expect(() => normalizeWechatMenu([{ name: '网页', type: 'view', url: prefix + 'a'.repeat(1025 - prefix.length) }])).toThrow();
  });
  it.each([{ ...mini, appid: 'wrong' }, { ...mini, pagepath: '' }, { ...mini, pagepath: '/pages/index' }, { ...mini, url: '' }, { ...mini, pagepath: 'https://example.test/' }])('requires the complete miniprogram with fallback %#', value => { expect(() => normalizeWechatMenu([value])).toThrow(); });
  it.each([{ ...click(), type: 'scancode_push' }, { ...click(), foreign: true }, { ...click(), id: 2 }])('rejects unsupported historical shapes without silently projecting a subset %#', value => { const copy = structuredClone(value); expect(() => normalizeWechatMenu([value])).toThrow(); expect(value).toEqual(copy); });
  it('canonicalizes keys without changing array order', () => { expect(wechatMenuCanonical({ b: 2, a: [3, 1] })).toBe('{"a":[3,1],"b":2}'); });
  for (const prefix of ['/adminapi', '/api/admin']) {
    it(`binds exact ${prefix} menu verbs independently of generic wechat content`, () => {
      for (const root of ['/wechat/menu', '/app/wechat/menu']) {
        expect(requiredAdminPermission('GET', prefix + root)).toBe('wechat_menu.view');
        expect(requiredAdminPermission('POST', prefix + root)).toBe('wechat_menu.manage');
        for (const method of ['PUT', 'DELETE', 'PATCH']) expect(requiredAdminPermission(method, prefix + root)).toBeNull();
      }
      expect(requiredAdminPermission('GET', prefix + '/wechat/menu/operations/:operationId')).toBe('wechat_menu.manage');
      expect(requiredAdminPermission('POST', prefix + '/wechat/menu/operations/:operationId/observe')).toBe('wechat_menu.manage');
      expect(requiredAdminPermission('GET', prefix + '/wechat/menu/operations/:operationId/observe')).toBeNull();
      expect(requiredAdminPermission('POST', prefix + '/wechat/menu/arbitrary')).toBeNull();
    });
  }
});
