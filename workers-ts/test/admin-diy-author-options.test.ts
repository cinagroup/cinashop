import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSION_GROUPS, DISE_AUTHOR_SELECTION_PERMISSION, assertDelegablePermissions,
  hasAdminPermission, normalizeRoleRules, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { AdminDiyAuthorOptionsService } from '@/services/admin/AdminDiyAuthorOptionsService';
import { createContainerFromDb, type DbClient } from '@/lib/di';

const DIY_AUTHOR_RESOURCES = ['hot-words', 'link-categories', 'link-targets', 'tab-categories', 'tab-targets'];
describe('DIY author options scoped permission and query admission', () => {
  it('admits exactly five read resources on both prefixes and leaves all writes/children unregistered', () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const resource of DIY_AUTHOR_RESOURCES) {
        const route = `${prefix}/dise/author-options/${resource}`;
        for (const method of ['GET', 'HEAD']) expect(requiredAdminPermission(method, route)).toBe(DISE_AUTHOR_SELECTION_PERMISSION);
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(requiredAdminPermission(method, route)).toBeNull();
        expect(requiredAdminPermission('GET', route + '/1')).toBeNull();
      }
      expect(requiredAdminPermission('GET', prefix + '/dise/author-options')).toBeNull();
      expect(requiredAdminPermission('GET', prefix + '/dise/author-options/missing')).toBeNull();
      expect(requiredAdminPermission('POST', prefix + '/dise/save')).toBe('dise.manage');
      expect(requiredAdminPermission('GET', prefix + '/setting/fab/link-targets')).toBe('fab_settings.view');
    }
  });
  it('keeps the virtual reader out of stored/delegated permissions and grants no adjacent authority', () => {
    expect(hasAdminPermission(new Set(['dise.manage']), DISE_AUTHOR_SELECTION_PERMISSION)).toBe(true);
    for (const grant of ['dise.view', 'product.manage', 'config.manage', 'attachment.manage', 'fab_settings.manage']) {
      expect(hasAdminPermission(new Set([grant]), DISE_AUTHOR_SELECTION_PERMISSION), grant).toBe(false);
    }
    for (const required of ['product.view', 'fab_settings.view', 'attachment.view']) expect(hasAdminPermission(new Set(['dise.manage']), required)).toBe(false);
    expect(() => normalizeRoleRules(DISE_AUTHOR_SELECTION_PERMISSION)).toThrow(/未知权限规则/);
    expect(() => assertDelegablePermissions(new Set(['dise.manage']), [DISE_AUTHOR_SELECTION_PERMISSION])).toThrow();
    expect(JSON.stringify(ADMIN_PERMISSION_GROUPS)).not.toContain(DISE_AUTHOR_SELECTION_PERMISSION);
  });
  it('returns complete capability categories without a DB read and rejects scope injection before any DB work', async () => {
    const service = new AdminDiyAuthorOptionsService(createContainerFromDb({} as DbClient), { APP_KEY: 'no-database' });
    expect((await service.linkCategories()).list.map(item => item.kind)).toEqual(['basic', 'personal', 'distribution', 'marketing', 'product', 'product_category', 'seckill', 'bargain', 'combination', 'integral', 'presale', 'news', 'special']);
    expect((await service.tabCategories()).list.map(item => item.kind)).toEqual(['product_category', 'special']);
    for (const read of [service.hotWords.bind(service), service.linkCategories.bind(service), service.tabCategories.bind(service)]) {
      await expect(read(new URLSearchParams('type=2&relation_id=77'))).rejects.toThrow();
    }
    for (const query of ['kind=product', 'kind=special&kind=product_category', 'kind=special&raw=1', 'kind=special&parent_id=11',
      'kind=special&page=01', 'kind=special&limit=101', 'kind=special&page=102&limit=100', 'kind=special&search=%00', 'kind=special&search=' + 'x'.repeat(101)]) {
      await expect(service.tabTargets(new URLSearchParams(query)), query).rejects.toThrow();
    }
  });
});

// Resolve the actual runner admission before any PostgreSQL binary/process is
// reached, including negative suffix/path variants retained as literal input.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
describe('DIY author native runner exact file admission', () => {
  const root = resolve(import.meta.dirname, '..'), runner = resolve(root, 'scripts/run-local-finance-postgres.mjs');
  const files = ['test/admin-diy-author-options.test.ts', 'test/admin-diy-author-options-postgres.test.ts', 'test/admin-diy-author-options-http.test.ts'];
  it.each(files)('admits %s only up to nonexistent trusted-bin lookup', file => {
    const result = spawnSync(process.execPath, [runner, '--schema-maintenance', 'unused-owned-author-bin', file], { cwd: root, encoding: 'utf8', timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain('ENOENT');
  });
  it.each(files.flatMap(file => [file + '.extra', 'test/../' + file]))('rejects nonliteral %s before native work', file => {
    const result = spawnSync(process.execPath, [runner, '--schema-maintenance', 'unused-owned-author-bin', file], { cwd: root, encoding: 'utf8', timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('ENOENT');
    expect(result.stderr).toContain('Only explicit unit test paths');
  });
});
