import { describe, expect, it } from 'vitest';
import { themeCanonical, readThemeBody, ThemeSettingsRejected, ThemeSettingsStaleVersion } from '../src/services/admin/AdminThemeSettingsInput';
import { DISE_TEMPLATE_TRIM_CHARACTERS, normalizeDiseTemplateName, projectThemeCatalog, themeHash } from '../src/services/content/ThemeReadService';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { adminDiseDeletionProtectionReason } from '../src/controllers/api/v1/AdminCrudController';

const revision = 'a'.repeat(64), nonce = '00000000-0000-4000-8000-000000000001';
const row = { id: 88, templateName: 'color_change', type: 3, isDel: 0, status: 0, isShow: 0, version: 'legacy', updateTime: 1,
  value: '1', valueBytes: 1, rowVersion: '123' };

describe('theme settings transport, authority and permission boundaries', () => {
  it('hashes the normalized single-choice intent independently of nonce and key order', async () => {
    const a = themeCanonical({ request_id: nonce, revision, status: 6 });
    const b = themeCanonical({ status: 6, revision, request_id: '00000000-0000-4000-8000-000000000002' });
    expect(a.canonical).toEqual({ operation: 'update', revision, status: 6 });
    expect(await themeHash(a.canonical)).toBe(await themeHash(b.canonical));
    expect(await themeHash(a.canonical)).not.toBe(await themeHash(themeCanonical({ request_id: nonce, revision, status: 1 }).canonical));
    expect(await themeHash(themeCanonical({ request_id: nonce, revision, status: 2 }).canonical)).toBe('32dfcf5630c93a8b6615392e6ab6112e9e12c46c5f445201a2926191e0ae95bc');
  });
  it('keeps raw transport failures outside the two proven rollback classes', () => {
    for (const status of [0, 7, -1, '3', 1.5, null, true, NaN, Infinity]) {
      try { themeCanonical({ request_id: nonce, revision, status }); throw Error('Expected transport rejection'); }
      catch (error) { expect(error).not.toBeInstanceOf(ThemeSettingsRejected); expect(error).not.toBeInstanceOf(ThemeSettingsStaleVersion); expect(String(error)).toContain('主题方案'); }
    }
    for (const input of [{ request_id: nonce, revision, status: 3, actor: 7 }, { request_id: nonce, status: 3 },
      { request_id: 'not-uuid', revision, status: 3 }, { request_id: nonce, revision: 'A'.repeat(64), status: 3 }, null, []]) expect(() => themeCanonical(input)).toThrow();
  });
  it('rejects duplicate decoded members and bounded-body overflow before deriving an intent', async () => {
    const valid = JSON.stringify({ request_id: nonce, revision, status: 3 });
    expect(themeCanonical(await readThemeBody(new Request('https://owned.local', { method: 'POST', body: valid }))).canonical.status).toBe(3);
    for (const body of ['{bad', valid.replace('"status":3', '"status":3,"stat\\u0075s":4'), ' '.repeat(4097)]) {
      await expect(readThemeBody(new Request('https://owned.local', { method: 'POST', body }))).rejects.toThrow();
    }
    await expect(readThemeBody(new Request('https://owned.local', { method: 'POST', body: valid, headers: { 'Content-Length': '4097' } }))).rejects.toThrow();
  });
  it('distinguishes seed blue, explicit missing and repairable scalar damage without table-level switch authority', () => {
    expect(projectThemeCatalog({ rows: [row], revision })).toEqual({ revision, status: 1, configured: true, editable: true, issues: [] });
    expect(projectThemeCatalog({ rows: [], revision })).toEqual({ revision, status: null, configured: false, editable: true, issues: ['theme_missing'] });
    expect(projectThemeCatalog({ rows: [{ ...row, value: ' 3 ', valueBytes: 3 }], revision })).toEqual({ revision, status: null, configured: false, editable: true, issues: ['theme_status_invalid'] });
  });
  it('never chooses a winner among duplicates or normalizes a damaged identity into a writable singleton', () => {
    expect(projectThemeCatalog({ rows: [row, { ...row, id: 99 }], revision })).toMatchObject({ status: null, configured: false, editable: false, issues: ['theme_duplicate'] });
    for (const patch of [{ templateName: ' COLOR_CHANGE ' }, { type: 1 }, { isDel: 1 }]) {
      expect(projectThemeCatalog({ rows: [{ ...row, ...patch }], revision })).toMatchObject({ status: null, editable: false, issues: ['theme_identity_invalid'] });
    }
  });
  it('uses identical explicit trim characters for normalized domain and generic delete protection', () => {
    for (const character of DISE_TEMPLATE_TRIM_CHARACTERS) {
      expect(normalizeDiseTemplateName(`${character}COLOR_CHANGE${character}`)).toBe('color_change');
      expect(adminDiseDeletionProtectionReason({ id: 88, templateName: `${character}COLOR_CHANGE${character}`, type: 1, status: 0, isDiy: 0 })).toContain('主题配置');
    }
    expect(normalizeDiseTemplateName('color_change_extra')).toBe('color_change_extra');
    expect(adminDiseDeletionProtectionReason({ id: 2, templateName: 'ordinary', type: 1, status: 0, isDiy: 1 })).toBeNull();
  });
  it('requires the independent theme authority ahead of broad setting and DIY domains on both prefixes', () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect(requiredAdminPermission('GET', `${prefix}/setting/theme-style`)).toBe('theme_settings.view');
      expect(requiredAdminPermission('GET', `${prefix}/setting/theme-style/request/${nonce}`)).toBe('theme_settings.view');
      expect(requiredAdminPermission('POST', `${prefix}/setting/theme-style`)).toBe('theme_settings.manage');
      expect(requiredAdminPermission('POST', `${prefix}/dise/save`)).toBe('dise.manage');
    }
  });
});
