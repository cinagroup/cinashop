import { describe, expect, it } from 'vitest';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemMenus, systemRole } from '@/models/schema';
import {
  ADMIN_PERMISSION_GROUPS, AdminPermissionService, assertDelegablePermissions,
  normalizeRoleRules, requiredAdminPermission,
} from '@/services/admin/AdminPermissionService';
import { financePostgres } from './helpers/financePostgres';

describe('FAB permission boundary', () => {
  it('requires the dedicated read or write capability on both Admin prefixes', () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const method of ['GET', 'HEAD']) {
        expect(requiredAdminPermission(method, `${prefix}/setting/fab`)).toBe('fab_settings.view');
        expect(requiredAdminPermission(method, `${prefix}/setting/fab/request/receipt`)).toBe('fab_settings.view');
        expect(requiredAdminPermission(method, `${prefix}/setting/fab/link-categories`)).toBe('fab_settings.view');
        expect(requiredAdminPermission(method, `${prefix}/setting/fab/link-targets`)).toBe('fab_settings.view');
      }
      expect(requiredAdminPermission('POST', `${prefix}/setting/fab`)).toBe('fab_settings.manage');
      expect(requiredAdminPermission('POST', `${prefix}/dise/save`)).toBe('dise.manage');
    }
    expect(ADMIN_PERMISSION_GROUPS.find(group => group.key === 'fab_settings')).toMatchObject({
      path: '/setting/fab', manage: true,
    });
  });

  it('does not allow broad configuration, DIY or asset managers to delegate FAB access', () => {
    expect(normalizeRoleRules('fab_settings.manage')).toBe('fab_settings.view,fab_settings.manage');
    const broad = new Set(['config.view', 'config.manage', 'dise.view', 'dise.manage', 'attachment.manage']);
    for (const key of ['fab_settings.view', 'fab_settings.manage']) {
      expect(() => assertDelegablePermissions(broad, [key])).toThrow('不能授予超出当前管理员范围');
    }
    expect(() => assertDelegablePermissions(new Set(['fab_settings.view']), ['fab_settings.manage']))
      .toThrow('不能授予超出当前管理员范围');
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('FAB legacy and assigned permissions in actual SQL', () => {
  it('maps only the exact legacy page pair to read in single and batched resolvers', async () => {
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      const exact = { type: 1, authType: 1, access: 1, isDel: 0,
        menuPath: '/admin/setting/pages/fab', uniqueAuth: 'setting-system-fab' };
      await fixture.db.insert(systemMenus).values([
        { ...exact, id: 1612 },
        { ...exact, id: 91612, uniqueAuth: 'setting-system-theme' },
        { ...exact, id: 91613, menuPath: '/admin/setting/pages/theme' },
        { ...exact, id: 91614, authType: 2 },
        { ...exact, id: 91615, type: 2 },
        { ...exact, id: 91616, access: 0 },
        { ...exact, id: 91617, isDel: 1 },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      const rules = ['1612', '91612', '91613', '91614', '91615', '91616', '91617'];
      expect(await service.resolveRulePermissionKeys(rules[0])).toEqual(['fab_settings.view']);
      for (const rule of rules.slice(1)) expect(await service.resolveRulePermissionKeys(rule)).toEqual([]);
      expect(await service.resolveManyRulePermissionKeys(rules)).toEqual([
        ['fab_settings.view'], [], [], [], [], [], [],
      ]);
      expect(service.buildMenus(new Set(['fab_settings.view']))).toEqual([
        expect.objectContaining({ path: '/setting/fab', name: '悬浮按钮' }),
      ]);
      expect(service.buildMenus(new Set(['config.view', 'dise.view'])).some(menu => menu.path === '/setting/fab')).toBe(false);
    } finally { await fixture.close(); }
  });

  it('keeps explicit canonical action grants separate from the old page and generic writer', async () => {
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 91620, type: 1, authType: 2, access: 1, apiUrl: '/adminapi/setting/fab', methods: 'GET' },
        { id: 91621, type: 1, authType: 2, access: 1, apiUrl: '/api/admin/setting/fab', methods: 'POST' },
        { id: 91622, type: 1, authType: 2, access: 1, apiUrl: '/adminapi/dise/save', methods: 'POST' },
        { id: 91623, type: 1, authType: 2, access: 1, uniqueAuth: 'config.manage' },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      expect(await service.resolveManyRulePermissionKeys(['91620', '91621', '91622', '91623']))
        .toEqual([
          ['fab_settings.view'], ['fab_settings.manage', 'fab_settings.view'],
          ['dise.manage', 'dise.view'], ['config.manage', 'config.view'],
        ]);
    } finally { await fixture.close(); }
  });

  it('uses the same FAB authority for assigned accounts, notification fanout and locked role decisions', async () => {
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values({ id: 1612, type: 1, authType: 1, access: 1,
        menuPath: '/admin/setting/pages/fab', uniqueAuth: 'setting-system-fab' });
      await fixture.db.insert(systemRole).values([
        { id: 901, roleName: 'Legacy FAB viewer', rules: '1612', status: 1 },
        { id: 902, roleName: 'Generic manager', rules: 'config.manage,dise.manage', status: 1 },
        { id: 903, roleName: 'FAB manager', rules: 'fab_settings.manage', status: 1 },
        { id: 904, roleName: 'Disabled FAB role', rules: 'fab_settings.manage', status: 0 },
      ]);
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      const admins = ['901', '902', '903', '904', '999'].map(roles => ({ level: 1, roles }));
      const single = await Promise.all(admins.map(admin => service.resolveAdminPermissionKeys(admin)));
      const batch = await service.resolveManyAdminPermissionKeys(admins);
      expect(batch).toEqual(single);
      expect(single[0]).toEqual(new Set(['fab_settings.view']));
      expect(single[1].has('fab_settings.view')).toBe(false);
      expect(single[1].has('fab_settings.manage')).toBe(false);
      expect(single[2]).toEqual(new Set(['fab_settings.manage', 'fab_settings.view']));
      expect(single[3]).toEqual(new Set());
      expect(single[4]).toEqual(new Set());
      const locked = await fixture.db.transaction(async tx => new AdminPermissionService(createContainerFromDb(tx as unknown as DbClient))
        .resolveRoleAssignment('901', true));
      expect(locked.keys).toEqual(new Set(['fab_settings.view']));
      expect(locked.missingRoleIds).toEqual([]);
    } finally { await fixture.close(); }
  });
});
