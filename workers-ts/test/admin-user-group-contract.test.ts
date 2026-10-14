import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { systemAdmin, systemLog, systemMenus, systemRole, user, userGroup } from '@/models/schema';
import { userGroupId } from '@/services/admin/AdminUserGroupService';
import { AdminPermissionService, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { groupActor, userGroupFixture } from './helpers/adminUserGroups';

describe('PHP UserGroup contract and current Admin lifecycle', () => {
  let f: Awaited<ReturnType<typeof userGroupFixture>>;
  beforeAll(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden')); f = await userGroupFixture(); }, 30000);
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });
  it('projects the exact paginated legacy DTO and retains the modern editor DTO', async () => {
    expect(await f.service.list(new URLSearchParams('page=1&limit=2'), groupActor())).toEqual({ list: [{ id: 30, group_name: '历史分组' }, { id: 20, group_name: '会员' }], count: 3 });
    expect(await f.service.list(new URLSearchParams('page=1&limit=2&group_name=会员'), groupActor(), false)).toEqual({ list: [{ id: 20, group_name: '会员' }], count: 1, page: 1, limit: 2 });
  });
  it('restores add/edit forms and refuses a missing or conflicting edit identity', async () => {
    expect(await f.service.form(0, new URLSearchParams(), groupActor())).toMatchObject({ title: '添加分组', action: 'user/user_group/save', method: 'POST', rules: [{ field: 'group_name', value: '', props: { maxlength: 20 } }] });
    expect(await f.service.form(20, new URLSearchParams('id=20'), groupActor())).toMatchObject({ title: '修改分组', rules: [{ field: 'id', value: 20 }, { field: 'group_name', value: '会员' }] });
    await expect(f.service.form(20, new URLSearchParams('id=10'), groupActor())).rejects.toThrow();
    await expect(f.service.form(999, new URLSearchParams(), groupActor())).rejects.toThrow('不存在');
  });
  it('creates, edits and removes with real SQL and complete atomic audit', async () => {
    const { id } = await f.service.save({ group_name: '  新分组  ' }, groupActor());
    expect(id).toBe(100);
    await f.service.save({ id, group_name: '已编辑分组' }, groupActor(104));
    expect(await f.service.remove(id, new URLSearchParams(), groupActor())).toBe('删除成功!');
    expect(await f.service.remove(id, new URLSearchParams(), groupActor())).toBe('删除成功!');
    expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row => JSON.parse(row.action))).toEqual([
      { operation: 'create', id }, { operation: 'update', id }, { operation: 'delete', id }]);
  });
  it('preserves both live and deleted user references, balances and points on rejected deletion', async () => {
    const before = await f.db.select().from(user).orderBy(user.uid), logs = await f.db.select().from(systemLog);
    for (const id of [10, 30]) await expect(f.service.remove(id, new URLSearchParams(), groupActor())).rejects.toThrow('仍有用户');
    expect(await f.db.select().from(user).orderBy(user.uid)).toEqual(before);
    expect(await f.db.select().from(systemLog)).toEqual(logs);
  });
  it('enforces source 20-character forms while keeping the modern 64-character editor', async () => {
    await expect(f.service.save({ group_name: '中'.repeat(21) }, groupActor())).rejects.toThrow('20');
    const modern = await f.service.save({ group_name: '中'.repeat(64) }, groupActor(), false);
    expect((await f.db.select().from(userGroup).where(eq(userGroup.id, modern.id)))[0].groupName).toHaveLength(64);
    await f.service.remove(modern.id, new URLSearchParams(), groupActor(), false);
    const unicode = await f.service.save({ group_name: '😀'.repeat(20) }, groupActor());
    await f.service.remove(unicode.id, new URLSearchParams(), groupActor());
  });
  it('rejects duplicate names, malformed IDs, query repetition and opaque body fields before mutation', async () => {
    const before = await f.db.select().from(userGroup).orderBy(userGroup.id), logs = await f.db.select().from(systemLog);
    for (const value of [true, [], {}, -1, '01', '1e2', '', '2147483648']) expect(() => userGroupId(value)).toThrow();
    for (const body of [{ group_name: '会员' }, { id: 999, group_name: '不存在' }, { group_name: '新分组', owner_id: 77 }, { group_name: '坏\u0000名字' }]) {
      await expect(f.service.save(body, groupActor())).rejects.toThrow();
    }
    for (const query of ['page=1&page=2', 'limit=101', 'page=0', 'group_name=会员']) await expect(f.service.list(new URLSearchParams(query), groupActor())).rejects.toThrow();
    await expect(f.service.remove(20, new URLSearchParams('id=10'), groupActor())).rejects.toThrow();
    expect(await f.db.select().from(userGroup).orderBy(userGroup.id)).toEqual(before);
    expect(await f.db.select().from(systemLog)).toEqual(logs);
  });
  it('allows legacy numeric read and denies read-only or unrelated writers', async () => {
    expect((await f.service.list(new URLSearchParams(), groupActor(105))).count).toBe(3);
    await expect(f.service.save({ group_name: '只读拒绝' }, groupActor(102))).rejects.toMatchObject({ code: 400011 });
    await expect(f.service.list(new URLSearchParams(), groupActor(103))).rejects.toMatchObject({ code: 400011 });
    for (const path of ['/adminapi/user/user_group/list', '/adminapi/user/user_group/add/:id']) expect(requiredAdminPermission('GET', path)).toBe('user.view');
    expect(requiredAdminPermission('POST', '/adminapi/user/user_group/save')).toBe('user.manage');
    expect(requiredAdminPermission('DELETE', '/adminapi/user/user_group/del/:id')).toBe('user.manage');
  });
  it('rechecks current password, role, tenant and expiry inside the service', async () => {
    await f.db.update(systemAdmin).set({ relationId: 77 }).where(eq(systemAdmin.id, 101));
    await expect(f.service.save({ group_name: '异域拒绝' }, groupActor())).rejects.toMatchObject({ code: 410002 });
    await f.db.update(systemAdmin).set({ relationId: 0 }).where(eq(systemAdmin.id, 101));
    await expect(f.service.list(new URLSearchParams(), { ...groupActor(), authVersion: '0'.repeat(32) })).rejects.toThrow('凭据');
    await expect(f.service.save({ group_name: '过期拒绝' }, { ...groupActor(), expiresAt: 1 })).rejects.toThrow('过期');
    await f.db.update(systemRole).set({ rules: 'product.manage' }).where(eq(systemRole.id, 1));
    await expect(f.service.save({ group_name: '撤权拒绝' }, groupActor())).rejects.toMatchObject({ code: 400011 });
    await f.db.update(systemRole).set({ rules: 'user.manage' }).where(eq(systemRole.id, 1));
  });
  it('restores exact PHP group page seeds and rejects their forged API/write tuples in both resolvers', async () => {
    const permissions = new AdminPermissionService(f.container);
    expect(await permissions.resolveManyRulePermissionKeys(['227', '263', '264', '262', '265']))
      .toEqual([['user.view'], ['user.view'], ['user.view'], ['user.manage', 'user.view'], ['user.manage', 'user.view']]);
    for (const id of [106, 107, 108]) {
      expect((await f.service.list(new URLSearchParams(), groupActor(id))).count).toBe(3);
      await expect(f.service.save({ group_name: '页面只读' }, groupActor(id))).rejects.toThrow('权限');
    }
    await f.db.update(systemMenus).set({ authType: 2, apiUrl: 'user/user_group/save', methods: 'POST' }).where(eq(systemMenus.id, 227));
    try {
      expect(await permissions.resolveRulePermissionKeys('227')).toEqual([]);
      expect(await permissions.resolveManyRulePermissionKeys(['227'])).toEqual([[]]);
    } finally { await f.db.update(systemMenus).set({ authType: 1, apiUrl: '', methods: '' }).where(eq(systemMenus.id, 227)); }
  });
  it('rolls back the catalog when its audit cannot commit', async () => {
    const before = await f.db.select().from(userGroup).orderBy(userGroup.id);
    await f.exec("CREATE FUNCTION fail_group_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'group audit fixture failure'; END $$; CREATE TRIGGER fail_group_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION fail_group_audit()");
    try { await expect(f.service.save({ group_name: '审计失败' }, groupActor())).rejects.toThrow(); }
    finally { await f.exec('DROP TRIGGER fail_group_audit ON system_log; DROP FUNCTION fail_group_audit()'); }
    expect(await f.db.select().from(userGroup).orderBy(userGroup.id)).toEqual(before);
  });
});
