import { describe, expect, it } from 'vitest';
import { normalizeAdminDiseJson, parseAdminDiseSaveInput } from '@/controllers/api/v1/AdminCrudController';
import { canonicalDiyPageBackground, DIY_PAGE_BACKGROUND_MAX_CHARS, normalizeDiyPageColour } from '@/services/content/DiyPageAppearancePolicy';

describe('row-level page settings author DTO without changing component/value contracts', () => {
  it('accepts the complete explicit metadata edit while preserving independent value/content and canonicalizing only the actual row background', () => {
    const value = JSON.stringify([{ name: 'unknown', timestamp: 17, bg_pic: '/api/assets/8?expires=1', link: '/api/assets/9?signature=old' }]);
    expect(parseAdminDiseSaveInput({ id: 2, title: '作者微页面', is_show: 1, is_bg_color: 1, is_bg_pic: 1,
      color_picker: '#663399', bg_pic: '/api/assets/7?expires=1&signature=old', bg_tab_val: 2, value, content: '<b>independent</b>' }))
      .toEqual({ mode: 'update', id: 2, name: undefined, title: '作者微页面', value, content: '<b>independent</b>', status: undefined,
        isShow: 1, isBgColor: 1, isBgPic: 1, colorPicker: '#663399', bgPic: '/api/assets/7', bgTabVal: 2 });
  });
  it('keeps every appearance key absent for an old caller instead of overwriting existing row metadata with defaults', () => {
    const parsed = parseAdminDiseSaveInput({ id: 2, title: '只改标题' });
    expect(parsed).toEqual({ mode: 'update', id: 2, name: undefined, title: '只改标题', value: undefined, content: undefined, status: undefined });
    for (const key of ['isShow', 'isBgColor', 'isBgPic', 'colorPicker', 'bgPic', 'bgTabVal']) expect(parsed).not.toHaveProperty(key);
  });
  it('accepts a metadata-only appearance update without fabricating a component document or touching title/status', () => {
    expect(parseAdminDiseSaveInput({ id: 2, is_bg_pic: 0 })).toEqual({ mode: 'update', id: 2, name: undefined,
      title: undefined, value: undefined, content: undefined, status: undefined, isBgPic: 0 });
    expect(parseAdminDiseSaveInput({ id: 2, bg_pic: '', color_picker: '' })).toMatchObject({ bgPic: '', colorPicker: '' });
  });
  it('allows authored create metadata while retaining the existing hidden and stopped creation entrance', () => {
    expect(parseAdminDiseSaveInput({ create_kind: 'diy_page', name: '新页面', value: '[]', status: 0, is_show: 0,
      is_bg_pic: 1, bg_pic: '/api/assets/7?signature=copied', bg_tab_val: 1 }))
      .toEqual({ mode: 'create', createKind: 'diy_page', name: '新页面', title: undefined, value: '[]', content: undefined,
        isShow: 0, isBgPic: 1, bgPic: '/api/assets/7', bgTabVal: 1 });
    expect(() => parseAdminDiseSaveInput({ create_kind: 'diy_page', name: '新页面', value: '[]', is_show: 1 })).toThrow('隐藏');
    expect(() => parseAdminDiseSaveInput({ create_kind: 'diy_page', name: '新页面', value: '[]', status: 1 })).toThrow('停用');
  });
  it.each(['is_show', 'is_bg_color', 'is_bg_pic'])('accepts only explicit numeric0/1 for %s, without truthy coercion', key => {
    for (const good of [0, 1]) expect(() => parseAdminDiseSaveInput({ id: 2, [key]: good })).not.toThrow();
    for (const bad of ['0', '1', false, true, null, [], {}, 2, -1, NaN, Infinity]) expect(() => parseAdminDiseSaveInput({ id: 2, [key]: bad })).toThrow();
  });
  it('admits only actual numeric image modes0/1/2 rather than loose equality, arrays or arbitrary smallints', () => {
    for (const bg_tab_val of [0, 1, 2]) expect(parseAdminDiseSaveInput({ id: 2, bg_tab_val })).toMatchObject({ bgTabVal: bg_tab_val });
    for (const bad of ['0', '1', '2', false, null, [], {}, 3, -1, NaN, Infinity]) expect(() => parseAdminDiseSaveInput({ id: 2, bg_tab_val: bad })).toThrow();
  });
  it('keeps immutable fields, unknown aliases, dedicated type settings and the value/content independence entrance closed', () => {
    for (const key of ['type', 'template_name', 'is_diy', 'isShow', 'background', 'bgPic', 'pageTitle']) expect(() => parseAdminDiseSaveInput({ id: 2, [key]: 0 })).toThrow('不支持');
    expect(() => parseAdminDiseSaveInput({ id: 2, value: '[]', content: '[]', is_show: 1 })).toThrow('独立');
    expect(() => parseAdminDiseSaveInput({ id: 2 })).toThrow('没有可更新');
  });
  it('bounds canonical storage by256 characters after removing a long copied ticket, without truncating legitimate external paths', () => {
    expect(DIY_PAGE_BACKGROUND_MAX_CHARS).toBe(256);
    expect(canonicalDiyPageBackground('/api/assets/7?signature=' + 'a'.repeat(1000))).toBe('/api/assets/7');
    const prefix = 'https://images.example.test/', exact = prefix + 'a'.repeat(256 - prefix.length);
    expect(canonicalDiyPageBackground(exact)).toBe(exact); expect(() => canonicalDiyPageBackground(exact + 'a')).toThrow('256');
    const unicode = '/static/' + '图'.repeat(248); expect([...unicode]).toHaveLength(256); expect(canonicalDiyPageBackground(unicode)).toBe(unicode);
    expect(() => canonicalDiyPageBackground('/api/assets/7?signature=' + 'a'.repeat(4096))).toThrow();
  });
  it('never interprets a foreign asset-shaped URL, numeric HTML entity or doubly encoded JSON value as a local asset authority', () => {
    const foreign = 'https://images.example.test/api/assets/7?expires=1&signature=external';
    expect(canonicalDiyPageBackground(foreign)).toBe(foreign);
    for (const bad of ['&#47;api/assets/7', '&amp;#47;api/assets/7', '/api/assets/&#55;', '/api/assets/&amp;#55;', '/api/assets/%37']) expect(() => canonicalDiyPageBackground(bad)).toThrow();
    const original = [{ name: 'unknown', bg_pic: '/api/assets/7?expires=old' }]; expect(JSON.parse(normalizeAdminDiseJson(JSON.stringify(original)))).toEqual(original);
  });
  it('rejects unsafe URLs and malformed local IDs before any persistence while retaining HTTPS/static literals', () => {
    for (const good of ['', '/static/logo.png', '/api/assets/2147483647', 'https://images.example.test/a.png?x=1&y=2']) expect(canonicalDiyPageBackground(good)).toBe(good);
    for (const bad of [null, 7, {}, [], 'javascript:alert(1)', 'data:image/png;base64,a', 'http://images.example.test/a.png', '//images.example.test/a.png', 'https://user:pass@images.example.test/a.png',
      '/api/assets/0', '/api/assets/2147483648', '/api/assets/2147483648?expires=1&signature=old', '/api/assets/9007199254740991', '/api/assets/7/../8', '/api/assets/7suffix', '/static/x\\.png', '/static/a\n.png', '/static/a".png']) expect(() => canonicalDiyPageBackground(bad)).toThrow();
  });
  it('accepts actual bounded picker colour literals including alpha and rejects executable or malformed CSS', () => {
    for (const good of ['', '#abc', '#abcd', '#aabbcc', '#aabbccdd', 'rgb(0, 255, 3)', 'rgba(20,30,40,.5)', 'hsl(-20,50%,40%)', 'hsla(20,50%,40%,50%)', 'transparent', 'white', 'black']) expect(normalizeDiyPageColour(good)).toBe(good);
    for (const bad of [null, 0, {}, [], '#abcde', 'red; background:url(/api/assets/7)', 'var(--view-theme)', 'url(/api/assets/7)', 'rgba(1,2,3,2)', 'rgb(256,0,0)', 'rgb(10%,2,3)', 'hsl(10,101%,40%)', 'hsl(Infinity,50%,50%)', 'a'.repeat(51)]) expect(() => normalizeDiyPageColour(bad)).toThrow();
  });
  it('preserves the global2MB UTF8,100000-node and64-depth JSON checks for appearance-only and combined edits', () => {
    const exact = JSON.stringify({ note: '界' + 'a'.repeat(2_000_000 - Buffer.byteLength(JSON.stringify({ note: '界' }))) });
    expect(Buffer.byteLength(exact)).toBe(2_000_000); expect(parseAdminDiseSaveInput({ id: 2, value: exact, is_bg_color: 0 })).toMatchObject({ value: exact });
    expect(() => parseAdminDiseSaveInput({ id: 2, value: exact + ' ', is_bg_pic: 1 })).not.toThrow();
    const tooLarge = JSON.stringify({ note: JSON.parse(exact).note + 'a' });
    for (const value of [tooLarge, JSON.stringify(Array(100001).fill(0)), JSON.stringify(Array.from({ length: 65 }).reduce<unknown>(next => ({ next }), ''))]) expect(() => parseAdminDiseSaveInput({ id: 2, value, bg_tab_val: 2 })).toThrow();
  });
});
