import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { adminAuthorityOperation } from '@/models/schema/adminAuthorityOperation';
import { ADMIN_AUTHORITY_OPERATION_SQL } from '@/migrations/adminAuthorityOperation';
import { ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL } from '@/migrations/runAdminLegacyAdminOperationUpgrade';
import { ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL } from '@/migrations/runAdminLegacyRoleOperationUpgrade';
import { AdminLegacyRoleOperationService } from '@/services/admin/AdminLegacyRoleOperationService';
import { AdminAuthorityWriteService, parseAdminAuthorityRoleIds } from '@/services/admin/AdminAuthorityWriteService';
import { AdminLegacyAdminWorkflowService } from '@/services/admin/AdminLegacyAdminWorkflowService';
import { AdminLegacyRoleWorkflowService } from '@/services/admin/AdminLegacyRoleWorkflowService';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { loadAdminLegacyRoleDeletionProofs, loadAdminLegacyRoleReferenceHistory } from '@/services/admin/AdminLegacyRoleDeletionProof';
import { md5 } from '@/utils/jwt';
import { financeMemoryPostgres } from './helpers/financePostgres';

const password = 'owned-role-history-password', key = 'owned-role-history-hmac';
const actor = (id = 101) => ({ id, authVersion: md5(password), expiresAt: Math.floor(Date.now()/1000)+3600 });

/** Exercise old consumers after the real new status/hard-delete decisions.
 * Snapshots classify references only; they must never restore deleted grants. */
describe('complete role reference history across existing authority consumers in PGlite', () => {
  let fixture: Awaited<ReturnType<typeof financeMemoryPostgres>>;
  let roles: AdminLegacyRoleOperationService, modern: AdminAuthorityWriteService;
  let staff: AdminLegacyAdminWorkflowService, forms: AdminLegacyRoleWorkflowService, permissions: AdminPermissionService;
  beforeAll(async () => {
    fixture = await financeMemoryPostgres([systemAdmin,systemRole,systemMenus],{ namespace:'public' });
    if (!fixture.isMemory) throw Error('Memory business fixture only; native semantics have separate cases');
    const container = createContainerFromDb(fixture.db);
    roles = new AdminLegacyRoleOperationService(container,key); modern = new AdminAuthorityWriteService(container);
    staff = new AdminLegacyAdminWorkflowService(container,key); forms = new AdminLegacyRoleWorkflowService(container);
    permissions = new AdminPermissionService(container);
  },30_000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    // Recreate this owned memory fixture, including its immutable history, so
    // reusing synthetic role IDs between cases cannot fabricate ID reuse.
    await fixture.exec('DROP TABLE IF EXISTS public.admin_authority_operation; DROP FUNCTION IF EXISTS public.admin_authority_operation_immutable_v1(); DROP FUNCTION IF EXISTS public.admin_authority_menu_lock_v1()');
    await fixture.exec(ADMIN_AUTHORITY_OPERATION_SQL); await fixture.exec(ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL);
    await fixture.exec(ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL);
    await fixture.db.delete(systemAdmin); await fixture.db.delete(systemRole); await fixture.db.delete(systemMenus);
    await fixture.db.insert(systemMenus).values({ id:2,menuName:'商品读取',authType:2,apiUrl:'product/list',methods:'GET' });
    await fixture.db.insert(systemRole).values([
      { id:50,level:1,roleName:'将删除身份',rules:'user.manage' },
      { id:51,level:1,roleName:'剩余写身份',rules:'system.manage,product.view,2' },
      { id:52,level:2,roleName:'下级保留身份',rules:'2' },
      { id:53,level:2,roleName:'下级将删除身份',rules:'2' },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id:100,account:'super-history',pwd:password,level:0 },
      { id:101,account:'history-manager',pwd:password,level:1,roles:'50,51' },
      { id:201,account:'history-staff',realName:'原姓名',phone:'13800000099',pwd:password,level:2,roles:'52,53' },
    ]);
  });
  const snapshot = async () => ({ admins:await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id),
    roles:await fixture.db.select().from(systemRole).orderBy(systemRole.id),
    receipts:await fixture.db.select().from(adminAuthorityOperation).orderBy(adminAuthorityOperation.operationId) });
  const commitRole = async (operation:'legacy-role-delete'|'legacy-role-status', payload:object, id=100) => {
    const input={ operation_id:randomUUID(),operation,payload }, claims=actor(id), preview=await roles.preview(input,claims);
    return roles.commit({ ...input,revision:preview.revision,expires_at:preview.expires_at,confirmed:true },claims);
  };
  const assertOldConsumersReject = async () => {
    const before=await snapshot();
    await expect(modern.saveAdmin({ id:101,real_name:'不得写入' },actor())).rejects.toThrow();
    await expect(forms.createForm(new URLSearchParams(),actor())).rejects.toThrow();
    await expect(staff.createForm(new URLSearchParams(),actor())).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  };
  it('keeps CSV after physical deletion and permits old consumers using only the remaining live authority',async () => {
    const before=await snapshot(); await commitRole('legacy-role-delete',{ id:50 });
    expect((await snapshot()).admins).toEqual(before.admins);
    expect(await fixture.db.select().from(systemRole).where(eq(systemRole.id,50))).toEqual([]);
    await expect(modern.saveAdmin({ id:101,real_name:'保留能力可用' },actor())).resolves.toEqual({ id:101,created:false });
    await expect(forms.editForm('52',new URLSearchParams(),actor())).resolves.toMatchObject({ role:{ id:52 } });
    await expect(forms.save('52',{ role_name:'下级已改名',status:1,checked_menus:[2] },actor())).resolves.toEqual({ id:52,created:false });
    await expect(staff.editForm('201',new URLSearchParams(),actor())).resolves.toMatchObject({ title:'管理员修改' });
    const [live]=await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id,101));
    expect(live.roles).toBe('50,51'); const keys=await permissions.resolveAdminPermissionKeys(live);
    expect(keys.has('product.view')).toBe(true); expect(keys.has('user.manage')).toBe(false);
    const history=await loadAdminLegacyRoleReferenceHistory(fixture.db,[50,51],1);
    expect(history.roles.map(role=>role.id)).toEqual([51]); expect(history.deleted.get(50)).toMatchObject({ rules:'user.manage',level:1 });
  });
  it('permits remaining authority after a normal referenced disable and restores grants only upon real re-enable',async () => {
    await commitRole('legacy-role-status',{ id:50,status:0 });
    await expect(modern.saveAdmin({ id:101,real_name:'停用后仍可用' },actor())).resolves.toMatchObject({ id:101 });
    await expect(forms.createForm(new URLSearchParams(),actor())).resolves.toHaveProperty('menus');
    await expect(forms.save('52',{ role_name:'停用历史仍可保存',status:1,checked_menus:[2] },actor())).resolves.toEqual({ id:52,created:false });
    await expect(staff.createForm(new URLSearchParams(),actor())).resolves.toHaveProperty('rules');
    let [live]=await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id,101));
    expect((await permissions.resolveAdminPermissionKeys(live)).has('user.manage')).toBe(false);
    await commitRole('legacy-role-status',{ id:50,status:1 });
    [live]=await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id,101));
    expect((await permissions.resolveAdminPermissionKeys(live)).has('user.manage')).toBe(true);
  });
  it('shows a proven deleted current staff role as disabled, refuses re-assignment, and allows explicit removal',async () => {
    await commitRole('legacy-role-delete',{ id:53 },101);
    const form=await staff.editForm('201',new URLSearchParams(),actor()), field=form.rules.find(row=>row.field==='roles')!;
    expect(field.value).toEqual([52,53]);
    expect(field.options).toContainEqual({ value:53,label:'下级将删除身份（当前已删除身份，保存时请移除）',disabled:true });
    const body={ id:201,account:'history-staff',real_name:'显式移除',phone:'13800000099',pwd:'',conf_pwd:'',roles:[52],status:1 };
    const bad={ operation_id:randomUUID(),operation:'legacy-admin-save',payload:{ ...body,roles:[52,53] } };
    const before=await snapshot(); await expect(staff.preview(bad,actor())).rejects.toThrow(); expect(await snapshot()).toEqual(before);
    const input={ operation_id:randomUUID(),operation:'legacy-admin-save',payload:body }, preview=await staff.preview(input,actor());
    expect(await staff.commit({ ...input,revision:preview.revision,expires_at:preview.expires_at,confirmed:true },actor())).toMatchObject({ state:'committed',result:{ id:201,created:false } });
    expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id,201)))[0].roles).toBe('52');
  });
  it('rejects unknown missing references across all old consumers without inventing deletion evidence',async () => {
    await fixture.db.update(systemAdmin).set({ roles:'51,999' }).where(eq(systemAdmin.id,101)); await assertOldConsumersReject();
  });
  it('retains ordinary missing-reference conflicts on exact old addons and refuses to hide a drifted catalog as ordinary history',async () => {
    await fixture.db.update(systemAdmin).set({ roles:'51,999' }).where(eq(systemAdmin.id,101));
    for (const version of ['v1','legacy-admin-v2']) {
      await fixture.exec('DROP TABLE public.admin_authority_operation; DROP FUNCTION public.admin_authority_operation_immutable_v1(); DROP FUNCTION public.admin_authority_menu_lock_v1()');
      await fixture.exec(ADMIN_AUTHORITY_OPERATION_SQL);
      if (version==='legacy-admin-v2') await fixture.exec(ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL);
      const before=await snapshot();
      await expect(modern.saveAdmin({ id:101,real_name:'不得写入' },actor())).rejects.toMatchObject({ code:409 });
      await expect(staff.createForm(new URLSearchParams(),actor())).rejects.toMatchObject({ code:409 });
      expect(await snapshot()).toEqual(before);
    }
    await fixture.exec("ALTER TABLE public.admin_authority_operation DROP CONSTRAINT aao_operation_ck; ALTER TABLE public.admin_authority_operation ADD CONSTRAINT aao_operation_ck CHECK (operation<>'')");
    const drifted=await snapshot();
    await expect(modern.saveAdmin({ id:101,real_name:'不得修复' },actor())).rejects.toMatchObject({ code:503 });
    expect(await snapshot()).toEqual(drifted);
  });
  it.each([{ type:4 },{ relationId:9 }])('rejects a complete persisted foreign reference %j rather than dropping it',async patch => {
    await fixture.db.update(systemRole).set(patch).where(eq(systemRole.id,50)); await assertOldConsumersReject();
  });
  it('rejects a deleted snapshot at a different actor level',async () => {
    await commitRole('legacy-role-delete',{ id:50 });
    await fixture.db.update(systemAdmin).set({ level:2 }).where(eq(systemAdmin.id,101)); await assertOldConsumersReject();
  });
  it('rejects malformed complete CSV in modern and staff paths even when missing IDs have deletion evidence',async () => {
    await commitRole('legacy-role-delete',{ id:50 });
    expect(parseAdminAuthorityRoleIds('')).toEqual([]); expect(parseAdminAuthorityRoleIds('50, 51')).toEqual([50,51]);
    for (const malformed of ['50,,51','50,51,',',50,51','50, ,51']) {
      expect(()=>parseAdminAuthorityRoleIds(malformed)).toThrow();
      await fixture.db.update(systemAdmin).set({ roles:malformed }).where(eq(systemAdmin.id,101)); await assertOldConsumersReject();
    }
  });
  it('refuses to classify a reappearing physical foreign row as deleted even with an immutable old receipt',async () => {
    await commitRole('legacy-role-delete',{ id:50 });
    await fixture.db.insert(systemRole).values({ id:50,type:4,level:1,rules:'user.manage' });
    await expect(loadAdminLegacyRoleDeletionProofs(fixture.db,[50])).rejects.toMatchObject({ code:409 }); await assertOldConsumersReject();
  });
  it('never recovers write capability from a deleted snapshot when no live writer remains',async () => {
    await commitRole('legacy-role-delete',{ id:50 });
    await fixture.db.update(systemRole).set({ status:0 }).where(eq(systemRole.id,51)); await assertOldConsumersReject();
  });
});
