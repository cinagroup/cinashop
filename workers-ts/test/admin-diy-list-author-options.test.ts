import { describe, expect, it } from 'vitest';
import { parseDiyListAuthorQuery } from '@/services/admin/AdminDiyListAuthorOptionsService';
import { DISE_AUTHOR_SELECTION_PERMISSION, hasAdminPermission, requiredAdminPermission } from '@/services/admin/AdminPermissionService';

const resources = ['list-products', 'list-brands', 'list-labels', 'list-article-categories'];
describe('narrow list-author query and exact route admission', () => {
  it('keeps bounded literal search, complete pages and canonical hierarchy identities', () => {
    expect(parseDiyListAuthorQuery(new URLSearchParams())).toEqual({ search: '', page: 1, limit: 15, offset: 0, parent_id: 0 });
    expect(parseDiyListAuthorQuery(new URLSearchParams('search=%25_&page=101&limit=100&parent_id=2147483647'), true))
      .toEqual({ search: '%_', page: 101, limit: 100, offset: 10000, parent_id: 2147483647 });
    expect(parseDiyListAuthorQuery(new URLSearchParams('search=%20有效%20'))?.search).toBe('有效');
  });
  it.each(['page=0', 'page=01', 'page=1e2', 'page=-1', 'page=102&limit=100', 'limit=0', 'limit=101', 'limit=1.5',
    'search=x&search=y', 'page=1&page=2', 'kind=product', 'owner_id=0', 'status=0', 'parent_id=0', 'search=%00', 'search=%7f'])
    ('rejects ambiguous or wider flat author query%s before SQL', query => expect(() => parseDiyListAuthorQuery(new URLSearchParams(query))).toThrow());
  it('rejects invalid hierarchy and overlong code-point text without wildcard expansion', () => {
    for (const query of ['parent_id=01', 'parent_id=-1', 'parent_id=2147483648', 'parent_id=1&parent_id=2', 'page=10002']) {
      expect(() => parseDiyListAuthorQuery(new URLSearchParams(query), true)).toThrow();
    }
    for (const search of ['x'.repeat(101), '图'.repeat(101)]) expect(() => parseDiyListAuthorQuery(new URLSearchParams([['search', search]]))).toThrow();
    expect(parseDiyListAuthorQuery(new URLSearchParams([['search', '😀'.repeat(100)]])).search).toBe('😀'.repeat(100));
  });
  it('admits only four exact GET/HEAD resources through the existing nondelegable DIY read rule', () => {
    for (const prefix of ['/adminapi', '/api/admin']) for (const resource of resources) {
      const path = prefix + '/dise/author-options/' + resource;
      for (const method of ['GET', 'HEAD']) expect(requiredAdminPermission(method, path)).toBe(DISE_AUTHOR_SELECTION_PERMISSION);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(requiredAdminPermission(method, path)).toBeNull();
      expect(requiredAdminPermission('GET', path + '/1')).toBeNull();
    }
    expect(hasAdminPermission(new Set(['dise.manage']), DISE_AUTHOR_SELECTION_PERMISSION)).toBe(true);
    for (const rule of ['dise.view', 'product.manage', 'brand.manage', 'label.manage', 'fab_settings.manage', 'attachment.manage', 'config.manage']) {
      expect(hasAdminPermission(new Set([rule]), DISE_AUTHOR_SELECTION_PERMISSION)).toBe(false);
    }
  });
});
