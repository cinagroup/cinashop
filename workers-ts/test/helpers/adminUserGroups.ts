import { createContainerFromDb } from '@/lib/di';
import { systemAdmin, systemLog, systemMenus, systemRole, user, userGroup } from '@/models/schema';
import { md5 } from '@/utils/jwt';
import { AdminUserGroupService } from '@/services/admin/AdminUserGroupService';
import { financePostgres } from './financePostgres';

export const groupSchema = { systemAdmin, systemLog, systemMenus, systemRole, user, userGroup };
export const groupActor = (id = 101) => ({ id, authVersion: md5('group-fixture-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
export async function seedUserGroups(db: ReturnType<typeof createContainerFromDb>['db']) {
  await db.insert(systemRole).values([{ id: 1, roleName: '管理', rules: 'user.manage' },
    { id: 2, roleName: '只读', rules: 'user.view' }, { id: 3, roleName: '无关', rules: 'product.manage' },
    { id: 4, roleName: '原菜单写', rules: '265' }, { id: 5, roleName: '原菜单读', rules: '261' },
    { id: 6, roleName: '原分组页面', rules: '227' }, { id: 7, roleName: '原编辑页面', rules: '263' },
    { id: 8, roleName: '原编辑表单', rules: '264' }]);
  await db.insert(systemMenus).values([{ id: 265, type: 1, authType: 2, apiUrl: 'user/user_group/save', methods: 'POST' },
    { id: 261, type: 1, authType: 2, apiUrl: 'user/user_group/list', methods: 'GET' },
    { id: 262, type: 1, authType: 2, apiUrl: 'user/user_group/del/<id>', methods: 'DELETE' },
    { id: 264, type: 1, authType: 2, apiUrl: 'user/user_group/add/<id>', methods: 'GET' },
    { id: 227, type: 1, authType: 1, menuPath: '/admin/user/group', uniqueAuth: 'user-user-group' },
    { id: 263, type: 1, authType: 1, menuPath: '/admin/user/group', uniqueAuth: 'admin-user-group' }]);
  await db.insert(systemAdmin).values([100, 101, 102, 103, 104, 105, 106, 107, 108].map(id => ({ id, account: `group-${id}`,
    pwd: 'group-fixture-password', level: id === 100 ? 0 : 1, roles: id === 100 ? '' : String(id - 100) })));
  await db.insert(userGroup).values([{ id: 10, groupName: '普通用户' }, { id: 20, groupName: '会员' }, { id: 30, groupName: '历史分组' }]);
  await db.insert(user).values([{ uid: 1, account: 'group-user', groupId: 10, nowMoney: '18.50', integral: 70 },
    { uid: 2, account: 'deleted-group-user', groupId: 30, isDel: 1 }]);
}
export async function userGroupFixture() {
  const f = await financePostgres(Object.values(groupSchema), { namespace: 'public' });
  await seedUserGroups(f.db);
  await f.exec("SELECT setval(pg_get_serial_sequence('user_group','id'),100,false)");
  const container = createContainerFromDb(f.db);
  return { ...f, container, service: new AdminUserGroupService(container) };
}
