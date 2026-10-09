import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { createContainerFromDb } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { adminAuthorityOperation } from '@/models/schema/adminAuthorityOperation';
import { ADMIN_AUTHORITY_OPERATION_SQL } from '@/migrations/adminAuthorityOperation';
import { ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL } from '@/migrations/runAdminLegacyAdminOperationUpgrade';
import { AdminLegacyAdminWorkflowService, parseLegacyAdminCommitMetadata, parseLegacyAdminPathId,
  parseLegacyAdminSave, type LegacyAdminActor, type LegacyAdminOperationKind } from '@/services/admin/AdminLegacyAdminWorkflowService';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const password = 'owned-legacy-staff-password';
const payload = (id = 0) => ({ id, account: id ? 'renamed-staff' : 'created-staff', real_name: '管理员姓名', phone: '13800000099',
  pwd: id ? '' : 'new-password-1234', conf_pwd: id ? '' : 'new-password-1234', roles: [50], status: 1 });
const intent = (operation: LegacyAdminOperationKind, body: Record<string, unknown>) => ({ operation_id: randomUUID(), operation, payload: body });

describe('legacy seven-field staff validation', () => {
  it('accepts exact old body, numeric roles, status omitted 0 and storage-bound account rename', () => {
    const { id, ...body } = payload();
    expect(parseLegacyAdminSave('0', { ...body, roles: [52, 50, 52], status: undefined })).toMatchObject({ account: 'created-staff', roles: '50,52', status: 0 });
    const { id: editId, ...edit } = payload(200);
    expect(parseLegacyAdminSave(String(editId), edit)).toMatchObject({ account: 'renamed-staff', password: '' });
  });
  it.each(['0', '01', '-1', '1.0', '2147483648', ' 1', '1 ', '1e1'])('rejects malformed target %s', value => {
    expect(() => parseLegacyAdminPathId(value)).toThrow();
  });
  it.each([
    { account: 'abc' }, { account: 'a'.repeat(33) }, { account: 'valid space' }, { phone: '' }, { phone: '12800000000' },
    { phone: '138000000001' }, { real_name: '' }, { real_name: '名'.repeat(17) }, { roles: [] }, { roles: ['50'] },
    { roles: [1.5] }, { roles: [2147483648] }, { roles: Array(2) }, { roles: Array.from({ length: 30 }, (_, index) => 2147483600 + index) },
    { level: 1 }, { admin_type: 1 }, { id: 0 }, { status: null }, { pwd: 'short', conf_pwd: 'short' },
    { pwd: 'new-password-1234', conf_pwd: 'different-password' }, { pwd: '文'.repeat(25), conf_pwd: '文'.repeat(25) },
  ])('rejects incomplete/overflow/client scope or password body %j', patch => {
    const { id, ...body } = payload(); expect(() => parseLegacyAdminSave('0', { ...body, ...patch })).toThrow();
  });
  it('requires explicit bounded confirmation headers and refuses duplicate collapsed header values', () => {
    expect(() => parseLegacyAdminCommitMetadata(new Headers())).toThrow('预览');
    const headers = new Headers({ 'X-Admin-Operation-Id': randomUUID(), 'X-Admin-Revision': 'a'.repeat(64),
      'X-Admin-Expires-At': '2000000000', 'X-Admin-Confirmed': 'true' });
    expect(parseLegacyAdminCommitMetadata(headers).confirmed).toBe(true);
    headers.append('X-Admin-Operation-Id', randomUUID()); expect(() => parseLegacyAdminCommitMetadata(headers)).toThrow();
  });
});

describe('legacy next-level staff decisions and durable operation business semantics in PGlite', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>, service: AdminLegacyAdminWorkflowService;
  const actor = (id = 101): LegacyAdminActor => ({ id, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  beforeAll(async () => {
    if (process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Memory business fixture only; native semantics have their own file');
    fixture = await financePostgres([systemAdmin, systemRole, systemMenus], { namespace: 'public' });
    // This is the reviewed exact DDL, not a synthetic receipt schema. The
    // explicit PG16 maintenance installer is exercised only in the native file.
    await fixture.exec(ADMIN_AUTHORITY_OPERATION_SQL); await fixture.exec(ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL);
    service = new AdminLegacyAdminWorkflowService(createContainerFromDb(fixture.db), 'owned-legacy-staff-hmac-key');
  }, 30000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    await fixture.db.delete(systemAdmin); await fixture.db.delete(systemRole); await fixture.db.delete(systemMenus);
    await fixture.db.insert(systemMenus).values([
      { id: 1, menuName: '结构', authType: 0 },
      { id: 2, pid: 1, menuName: '商品读取', authType: 2, apiUrl: 'product/list', methods: 'GET' },
      { id: 3, menuName: '旧未知可保留', authType: 2, apiUrl: 'old-owned-extension', methods: 'GET' },
      { id: 4, menuName: '不可委派', authType: 2, apiUrl: 'user/list', methods: 'GET' },
      { id: 20, authType: 1, menuPath: '/admin/setting/system_admin/index', uniqueAuth: 'setting-system-list' },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 900, level: 1, rules: 'system.legacy_admin_manage,2,3' },
      { id: 901, level: 1, rules: 'system.legacy_admin_form_view,2,3' },
      { id: 902, level: 1, rules: '20' },
      { id: 50, level: 2, roleName: '数字身份', rules: '1,2' },
      { id: 51, level: 2, rules: '4' },
      { id: 52, type: 1, level: 2, roleName: 'opaque兼容身份', rules: '3' },
      { id: 53, level: 2, rules: 'unknown.permission' },
      { id: 54, level: 2, rules: '999' },
      { id: 55, level: 3, rules: '2' },
      { id: 56, level: 2, status: 0, rules: '2' },
      { id: 57, level: 2, type: 4, relationId: 9, rules: '2' },
      { id: 58, level: 2, rules: '20' },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 100, account: 'super', pwd: password, level: 0 },
      { id: 101, account: 'manager', pwd: password, roles: '900', level: 1 },
      { id: 102, account: 'viewer', pwd: password, roles: '901', level: 1 },
      { id: 103, account: 'list-only', pwd: password, roles: '902', level: 1 },
      { id: 104, account: 'other-manager', pwd: password, roles: '900', level: 1 },
      { id: 200, account: 'old-staff', phone: '13800000001', realName: '原姓名', pwd: password, level: 2, roles: '50' },
      { id: 201, account: 'occupied', phone: '13800000002', pwd: password, level: 2, roles: '50' },
      { id: 202, account: 'deleted-reuse', phone: '13800000003', pwd: password, level: 2, roles: '50', isDel: 1 },
      { id: 203, account: 'foreign-domain', phone: '13800000004', pwd: password, level: 2, roles: '50', adminType: 4, relationId: 8 },
      { id: 204, account: 'other-level', phone: '13800000005', pwd: password, level: 3, roles: '55' },
      { id: 205, account: 'outside-role', phone: '13800000006', pwd: password, level: 2, roles: '51' },
    ]);
    await fixture.exec("SELECT setval(pg_get_serial_sequence('system_admin','id'),205,true)");
  });
  const snapshot = async () => ({ admins: await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id),
    roles: await fixture.db.select().from(systemRole).orderBy(systemRole.id), menus: await fixture.db.select().from(systemMenus).orderBy(systemMenus.id),
    receipts: await fixture.db.select().from(adminAuthorityOperation).orderBy(adminAuthorityOperation.operationId) });
  async function commit(input: ReturnType<typeof intent>, claims = actor()) {
    const preview = await service.preview(input, claims);
    return service.commit({ ...input, revision: preview.revision, expires_at: preview.expires_at, confirmed: true }, claims);
  }
  it('returns real seven-field form values/actions/options without hashes, and separates form from list permission', async () => {
    const before = await snapshot(), created = await service.createForm(new URLSearchParams(), actor(102));
    expect(created.action).toBe('setting/admin'); expect(created.method).toBe('POST');
    expect(created.rules.map(row => row.field)).toEqual(['account', 'pwd', 'conf_pwd', 'real_name', 'phone', 'roles', 'status']);
    expect(created.rules.find(row => row.field === 'status')?.value).toBe(1);
    expect(created.rules.find(row => row.field === 'roles')?.options?.map(row => row.value)).toEqual([50, 52]);
    const edited = await service.editForm('200', new URLSearchParams(), actor(102));
    expect(edited).toMatchObject({ action: 'setting/admin/200', method: 'PUT' });
    expect(edited.rules.find(row => row.field === 'roles')?.value).toEqual([50]);
    expect(edited.rules.find(row => row.field === 'account')?.value).toBe('old-staff');
    expect(JSON.stringify(edited)).not.toContain(password);
    await expect(service.createForm(new URLSearchParams(), actor(103))).rejects.toThrow();
    await expect(service.preview(intent('legacy-admin-save', payload()), actor(102))).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it('renames account and phone, preserves blank password, persists exact results and recovers only original actor', async () => {
    const claims = actor(), input = intent('legacy-admin-save', payload(200)), before = await snapshot();
    const preview = await service.preview(input, claims);
    expect(preview.summary).toMatchObject({ action: 'update', before: { account: 'old-staff', phone: '13800000001' },
      after: { account: 'renamed-staff', phone: '13800000099', password_changed: false, level: 2, is_del: 0 } });
    expect(await snapshot()).toEqual(before);
    const confirmation = { ...input, revision: preview.revision, expires_at: preview.expires_at, confirmed: true };
    const receipt = await service.commit(confirmation, claims);
    expect(receipt).toMatchObject({ state: 'committed', result: { id: 200, created: false }, request_hash: preview.request_hash });
    const [stored] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 200));
    expect(stored).toMatchObject({ account: 'renamed-staff', phone: '13800000099', pwd: password, roles: '50', level: 2 });
    const after = await snapshot(); expect(await service.commit(confirmation, claims)).toEqual(receipt); expect(await snapshot()).toEqual(after);
    expect(await service.receipt(input.operation_id, input.operation, claims)).toEqual(receipt);
    await expect(service.receipt(input.operation_id, input.operation, actor(104))).rejects.toThrow();
    await expect(service.commit({ ...confirmation, payload: { ...input.payload, real_name: '换请求' } }, claims)).rejects.toThrow('原提交');
  });
  it('creates at next level, stores verified bcrypt with no secret receipt, and actually changes confirmed password', async () => {
    const created = await commit(intent('legacy-admin-save', { ...payload(), roles: [52, 50] }));
    const [row] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, created.result!.id));
    expect(row).toMatchObject({ adminType: 1, relationId: 0, level: 2, roles: '50,52', isDel: 0 });
    expect(await bcrypt.compare('new-password-1234', row.pwd)).toBe(true);
    expect(JSON.stringify(await snapshot()).includes('new-password-1234')).toBe(false);
    await commit(intent('legacy-admin-save', { ...payload(200), phone: '13800000098', pwd: 'changed-password-1234', conf_pwd: 'changed-password-1234' }));
    const [changed] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 200));
    expect(await bcrypt.compare('changed-password-1234', changed.pwd)).toBe(true);
  });
  it.each([{ account: 'occupied' }, { phone: '13800000002' }, { roles: [51] }, { roles: [53] }, { roles: [54] },
    { roles: [55] }, { roles: [56] }, { roles: [57] }])('rejects actual uniqueness/delegation decision %j without deltas', async patch => {
    const before = await snapshot(); await expect(service.preview(intent('legacy-admin-save', { ...payload(), ...patch }), actor())).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it.each([100, 101, 202, 203, 204, 205])('rejects out-of-scope/current-role target %s for all three writes', async id => {
    const before = await snapshot();
    for (const operation of ['legacy-admin-save', 'legacy-admin-status', 'legacy-admin-delete'] as const) {
      await expect(service.preview(intent(operation, operation === 'legacy-admin-save' ? payload(id) : { id, ...(operation === 'legacy-admin-status' ? { status: 0 } : {}) }), actor())).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });
  it('commits real independent status and soft delete with durable original results', async () => {
    expect(await commit(intent('legacy-admin-status', { id: 200, status: 0 }))).toMatchObject({ result: { id: 200, created: false } });
    expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 200)))[0].status).toBe(0);
    expect(await commit(intent('legacy-admin-delete', { id: 200 }))).toMatchObject({ result: { id: 200, deleted: true } });
    expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 200)))[0]).toMatchObject({ status: 0, isDel: 1, account: 'old-staff' });
  });
  it('echoes known inactive roles without granting them, allows removal/repair and safe status/delete, but preserves complete invalid-role refusal', async () => {
    await fixture.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 50));
    const edited = await service.editForm('200', new URLSearchParams(), actor());
    expect(edited.rules.find(row => row.field === 'roles')?.value).toEqual([50]);
    expect(edited.rules.find(row => row.field === 'roles')?.options).toContainEqual({ value: 50, label: '数字身份（当前停用身份，保存时请移除）', disabled: true });
    await expect(service.preview(intent('legacy-admin-save', payload(200)), actor())).rejects.toThrow('未启用');
    await commit(intent('legacy-admin-save', { ...payload(200), roles: [52] }));
    expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 200)))[0].roles).toBe('52');
    await commit(intent('legacy-admin-status', { id: 201, status: 0 }));
    await commit(intent('legacy-admin-delete', { id: 201 }));
    await fixture.db.update(systemAdmin).set({ roles: '999' }).where(eq(systemAdmin.id, 200));
    await expect(service.preview(intent('legacy-admin-delete', { id: 200 }), actor())).rejects.toThrow('缺失');
  });
  it.each(['target', 'role', 'menu', 'actor', 'expiry', 'uniqueness'] as const)('invalidates full confirmation after %s changes', async change => {
    const claims = actor(), input = intent('legacy-admin-save', payload(200)), preview = await service.preview(input, claims);
    if (change === 'target') await fixture.db.update(systemAdmin).set({ lastIp: '127.0.0.2' }).where(eq(systemAdmin.id, 200));
    if (change === 'role') await fixture.db.update(systemRole).set({ roleName: '已改身份名称' }).where(eq(systemRole.id, 50));
    if (change === 'menu') await fixture.db.update(systemMenus).set({ menuName: '元数据已变' }).where(eq(systemMenus.id, 2));
    if (change === 'actor') await fixture.db.update(systemAdmin).set({ pwd: 'changed-live-password' }).where(eq(systemAdmin.id, 101));
    if (change === 'expiry') claims.expiresAt = Math.floor(Date.now() / 1000) - 1;
    if (change === 'uniqueness') await fixture.db.insert(systemAdmin).values({ account: 'renamed-staff', phone: '13800000090', pwd: password, level: 2 });
    const changed = await snapshot();
    await expect(service.commit({ ...input, revision: preview.revision, expires_at: preview.expires_at, confirmed: true }, claims)).rejects.toThrow();
    expect(await snapshot()).toEqual(changed);
  });
  it('keeps notfound unknown and seals absent UUID under the write barrier; recovery needs no current manage role', async () => {
    const claims = actor(), input = intent('legacy-admin-save', payload()), preview = await service.preview(input, claims);
    await fixture.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 900));
    expect(await service.receipt(input.operation_id, input.operation, claims)).toMatchObject({ state: 'unknown', result: null });
    const sealed = await service.resolve({ operation_id: input.operation_id, operation: input.operation }, claims);
    expect(sealed).toMatchObject({ state: 'not_applied', request_hash: null, result: null });
    await fixture.db.update(systemRole).set({ rules: 'system.legacy_admin_manage,2,3' }).where(eq(systemRole.id, 900));
    await expect(service.commit({ ...input, revision: preview.revision, expires_at: preview.expires_at, confirmed: true }, claims)).rejects.toThrow('封存');
    expect(await service.resolve({ operation_id: input.operation_id, operation: input.operation }, claims)).toEqual(sealed);
    await expect(service.receipt(input.operation_id, 'admin-save', claims)).rejects.toThrow('类型');
  });
  it('supports actor9 to next-level10 for role options, create, edit, status and delete', async () => {
    await fixture.db.update(systemAdmin).set({ level: 9 }).where(eq(systemAdmin.id, 101));
    await fixture.db.update(systemRole).set({ level: 10 }).where(eq(systemRole.id, 50));
    const created = await commit(intent('legacy-admin-save', payload()));
    expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, created.result!.id)))[0].level).toBe(10);
    expect((await service.editForm(String(created.result!.id), new URLSearchParams(), actor())).rules.find(row => row.field === 'roles')?.value).toEqual([50]);
    await commit(intent('legacy-admin-status', { id: created.result!.id, status: 0 }));
    await commit(intent('legacy-admin-delete', { id: created.result!.id }));
  });
});
