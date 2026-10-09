import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { adminAuthorityOperation } from '@/models/schema/adminAuthorityOperation';
import { ADMIN_AUTHORITY_OPERATION_SQL } from '@/migrations/adminAuthorityOperation';
import { ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL } from '@/migrations/runAdminLegacyAdminOperationUpgrade';
import { ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL } from '@/migrations/runAdminLegacyRoleOperationUpgrade';
import { AdminLegacyRoleOperationService, legacyRoleOperationKind, parseLegacyRoleCommitMetadata, parseLegacyRoleOperationPathId,
  parseLegacyRoleOperationStatus, type LegacyRoleActor, type LegacyRoleOperationKind } from '@/services/admin/AdminLegacyRoleOperationService';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const password = 'owned-legacy-role-password', key = 'owned-legacy-role-operation-hmac-key';
const sessionExpiresAt = Math.floor(Date.now() / 1000) + 3600;
const actor = (id = 101): LegacyRoleActor => ({ id, authVersion: md5(password), expiresAt: sessionExpiresAt });
const intent = (operation: LegacyRoleOperationKind, payload: Record<string, unknown>) => ({ operation_id: randomUUID(), operation, payload });

describe('legacy independent role protocol validation', () => {
  it.each(['0', '01', '-1', '1.0', '1e1', ' 50', '50 ', '2147483648'])('rejects malformed path ID %s', value => {
    expect(() => parseLegacyRoleOperationPathId(value)).toThrow();
  });
  it('accepts only independent status/delete domains and exact positive int32/status path semantics', () => {
    expect(parseLegacyRoleOperationPathId('2147483647')).toBe(2147483647);
    expect(parseLegacyRoleOperationStatus('0')).toBe(0); expect(parseLegacyRoleOperationStatus('1')).toBe(1);
    for (const bad of ['-1', '01', 'true', ' 0']) expect(() => parseLegacyRoleOperationStatus(bad)).toThrow();
    for (const bad of ['role-delete', 'role-save', 'legacy-admin-status', 'legacy-role-save']) expect(() => legacyRoleOperationKind(bad)).toThrow();
  });
  it('requires exact four confirmation headers and rejects collapsed duplicates, malformed UUID/expiry and implicit confirmation', () => {
    expect(() => parseLegacyRoleCommitMetadata(new Headers())).toThrow('预览');
    const headers = new Headers({ 'X-Admin-Operation-Id': randomUUID(), 'X-Admin-Revision': 'a'.repeat(64), 'X-Admin-Expires-At': '2000000000', 'X-Admin-Confirmed': 'true' });
    expect(parseLegacyRoleCommitMetadata(headers).confirmed).toBe(true);
    for (const [name, value] of [['X-Admin-Operation-Id', randomUUID().toUpperCase()], ['X-Admin-Revision', 'A'.repeat(64)], ['X-Admin-Expires-At', '02000000000'], ['X-Admin-Confirmed', '1']]) {
      const changed = new Headers(headers); changed.set(name, value); expect(() => parseLegacyRoleCommitMetadata(changed)).toThrow();
    }
    headers.append('X-Admin-Revision', 'a'.repeat(64)); expect(() => parseLegacyRoleCommitMetadata(headers)).toThrow();
  });
});

describe('legacy independent role impact decisions and immutable results in PGlite', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>, service: AdminLegacyRoleOperationService;
  beforeAll(async () => {
    if (process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Memory business fixture only; actual PostgreSQL semantics have their own file');
    fixture = await financePostgres([systemAdmin, systemRole, systemMenus], { namespace: 'public' });
    await fixture.exec(ADMIN_AUTHORITY_OPERATION_SQL); await fixture.exec(ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL); await fixture.exec(ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL);
    service = new AdminLegacyRoleOperationService(createContainerFromDb(fixture.db), key);
  }, 30000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    // This disposable memory fixture is freshly recreated between cases.
    // Permanent receipt rows themselves have no UPDATE/DELETE/TRUNCATE escape;
    // retaining them while reusing synthetic role IDs would forge ID reuse.
    await fixture.exec('DROP TABLE public.admin_authority_operation; DROP FUNCTION public.admin_authority_operation_immutable_v1(); DROP FUNCTION public.admin_authority_menu_lock_v1()');
    await fixture.exec(ADMIN_AUTHORITY_OPERATION_SQL); await fixture.exec(ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL); await fixture.exec(ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL);
    await fixture.db.delete(systemAdmin); await fixture.db.delete(systemRole); await fixture.db.delete(systemMenus);
    await fixture.db.insert(systemMenus).values([
      { id: 1, menuName: '结构', authType: 0 },
      { id: 2, pid: 1, menuName: '商品读取', authType: 2, apiUrl: 'product/list', methods: 'GET' },
      { id: 3, menuName: '旧未知可保留', authType: 2, apiUrl: 'owned-historical-extension', methods: 'GET' },
      { id: 4, menuName: '不可委派', authType: 2, apiUrl: 'user/list', methods: 'GET' },
      { id: 329, authType: 2, apiUrl: 'setting/role/set_status/<id>/<status>', uniqueAuth: 'setting-role-set_status', methods: 'PUT' },
      { id: 330, authType: 2, apiUrl: 'setting/role/<id>', uniqueAuth: 'setting-role-delete', methods: 'DELETE' },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 900, level: 1, rules: 'system.legacy_role_status,system.legacy_role_delete,product.view,3' },
      { id: 901, level: 1, rules: 'system.legacy_role_status,product.view,3' },
      { id: 902, level: 1, rules: 'system.legacy_role_delete,product.view,3' },
      { id: 903, level: 1, rules: 'system.legacy_role_manage,product.view,3' },
      { id: 50, level: 2, roleName: '被引用数字身份', rules: '1,2' },
      { id: 51, level: 2, roleName: '重复授予商品读取', rules: 'product.view' },
      { id: 52, level: 2, roleName: 'opaque扩展', rules: '3' },
      { id: 53, level: 2, rules: '4' }, { id: 54, level: 2, rules: '999' },
      { id: 55, level: 3, rules: '2' }, { id: 56, level: 2, status: -1, rules: '2' },
      { id: 57, level: 2, type: 4, relationId: 9, rules: '2' },
      { id: 58, level: 2, rules: 'unknown.permission' },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 100, account: 'super', pwd: password, level: 0 },
      { id: 101, account: 'manager', pwd: password, roles: '900', level: 1 },
      { id: 102, account: 'status-only', pwd: password, roles: '901', level: 1 },
      { id: 103, account: 'delete-only', pwd: password, roles: '902', level: 1 },
      { id: 104, account: 'save-only', pwd: password, roles: '903', level: 1 },
      { id: 105, account: 'other-manager', pwd: password, roles: '900', level: 1 },
      { id: 200, account: 'affected', realName: '当前受影响', pwd: password, level: 2, roles: '50' },
      { id: 201, account: 'duplicate-grant', pwd: password, level: 2, roles: '50,51' },
      { id: 202, account: 'disabled-reference', pwd: password, level: 2, roles: '50', status: 0 },
      { id: 203, account: 'historical-reference', pwd: password, level: 2, roles: '50', isDel: 1 },
    ]);
  });
  const snapshot = async () => ({ admins: await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id),
    roles: await fixture.db.select().from(systemRole).orderBy(systemRole.id), menus: await fixture.db.select().from(systemMenus).orderBy(systemMenus.id),
    receipts: await fixture.db.select().from(adminAuthorityOperation).orderBy(adminAuthorityOperation.operationId) });
  const confirmed = async (input: ReturnType<typeof intent>, claims = actor()) => {
    const value = await service.preview(input, claims); return { ...input, revision: value.revision, expires_at: value.expires_at, confirmed: true };
  };
  const commit = async (input: ReturnType<typeof intent>, claims = actor()) => service.commit(await confirmed(input, claims), claims);
  it('rejects client-supplied authority fields, modern kinds, malformed UUIDs and inexact payloads before any mutation', async () => {
    const before = await snapshot(), input = intent('legacy-role-status', { id: 50, status: 0 });
    for (const value of [{ ...input, operation: 'role-delete' }, { ...input, operation_id: input.operation_id.toUpperCase() },
      { ...input, payload: { id: 50, status: '0' } }, { ...input, payload: { id: 50, status: 0, level: 2 } },
      { ...input, payload: { id: 50, status: 0, rules: '2' } }, { ...input, actor_id: 100 },
      { ...input, operation: 'legacy-role-delete', payload: { id: 50, status: 0 } }]) await expect(service.preview(value, actor())).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it('binds revision to operation, payload, current session and expiry and requires an explicit boolean confirmation', async () => {
    const input = intent('legacy-role-status', { id: 50, status: 0 }), value = await confirmed(input), before = await snapshot();
    for (const changed of [{ ...value, confirmed: false }, { ...value, confirmed: 'true' }, { ...value, revision: 'a'.repeat(64) },
      { ...value, expires_at: Math.floor(Date.now() / 1000) - 1 }, { ...value, payload: { id: 50, status: 1 } },
      { ...value, operation: 'legacy-role-delete', payload: { id: 50 } }]) await expect(service.commit(changed, actor())).rejects.toThrow();
    await expect(service.commit(value, { ...actor(), expiresAt: actor().expiresAt - 1 })).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  });
  it('previews every current and historical reference without writes or secrets, with real effective-permission overlap', async () => {
    const before = await snapshot(), value = await service.preview(intent('legacy-role-status', { id: 50, status: 0 }), actor());
    expect(value.summary).toMatchObject({ target_id: 50, action: 'status', before: { rules: '1,2', status: 1 }, after: { rules: '1,2', status: 0 },
      impact: { reference_count: 4, active_reference_count: 2 } });
    expect(value.summary.impact.references.map(row => [row.id, row.effective_permission_change])).toEqual([[200, true], [201, false], [202, false], [203, false]]);
    expect(JSON.stringify(value)).not.toContain(password); expect(await snapshot()).toEqual(before);
  });
  it('rejects a complete valid related-role collection above 4MiB without truncating references or producing a confirmation', async () => {
    const rules = 'product.view,'.repeat(1259) + 'product.view'; expect(rules.length).toBeLessThanOrEqual(16384);
    await fixture.db.insert(systemRole).values(Array.from({ length: 270 }, (_, index) => ({ id: 1000 + index, level: 2, rules })));
    await fixture.db.insert(systemAdmin).values(Array.from({ length: 270 }, (_, index) => ({ id: 4000 + index, account: `capacity-reference-${index}`,
      pwd: password, level: 2, roles: `50,${1000 + index}` })));
    const [size] = await fixture.db.execute(sql`SELECT sum(octet_length(to_jsonb(r)::text))::text AS bytes FROM system_role r WHERE id>=1000`);
    expect(Number(size.bytes)).toBeGreaterThan(4 * 1024 * 1024);
    const before = await snapshot(); await expect(service.preview(intent('legacy-role-delete', { id: 50 }), actor())).rejects.toMatchObject({ code: 503 });
    expect(await snapshot()).toEqual(before);
  });
  it('rejects a complete menu collection above 4MiB before full menu transfer/HMAC even below 10000 rows, with no mutation', async () => {
    const extra = Array.from({ length: 2400 }, (_, index) => ({ id: 10000 + index, authType: 2, apiUrl: 'product/list', methods: 'GET',
      menuName: 'm'.repeat(64), icon: 'i'.repeat(50), module: 'm'.repeat(32), controller: 'c'.repeat(64), action: 'a'.repeat(32), params: 'p'.repeat(512),
      path: 'p'.repeat(255), menuPath: 'm'.repeat(255), header: 'h'.repeat(50), uniqueAuth: 'u'.repeat(150) }));
    for (let start = 0; start < extra.length; start += 400) await fixture.db.insert(systemMenus).values(extra.slice(start, start + 400));
    const [size] = await fixture.db.execute(sql`SELECT count(*)::integer AS rows,sum(octet_length(to_jsonb(m)::text))::text AS bytes FROM system_menus m`);
    expect(Number(size.rows)).toBeLessThan(10000); expect(Number(size.bytes)).toBeGreaterThan(4 * 1024 * 1024);
    const before = await snapshot(); await expect(service.preview(intent('legacy-role-status', { id: 50, status: 0 }), actor())).rejects.toMatchObject({ code: 503 });
    expect(await snapshot()).toEqual(before);
  });
  it('normally commits referenced disable and re-enable, changing only role status while retaining all admin CSV and exact durable results', async () => {
    const before = await snapshot(), input = intent('legacy-role-status', { id: 50, status: 0 }), value = await confirmed(input);
    const receipt = await service.commit(value, actor()); expect(receipt).toMatchObject({ state: 'committed', result: { id: 50, created: false } });
    const disabled = await snapshot(); expect(disabled.admins).toEqual(before.admins);
    expect(disabled.roles).toEqual(before.roles.map(row => row.id === 50 ? { ...row, status: 0 } : row));
    const permission = new AdminPermissionService(createContainerFromDb(fixture.db));
    expect([...(await permission.resolveAdminPermissionKeys(disabled.admins.find(row => row.id === 200)!))]).not.toContain('product.view');
    expect([...(await permission.resolveAdminPermissionKeys(disabled.admins.find(row => row.id === 201)!))]).toContain('product.view');
    expect(await service.commit(value, actor())).toEqual(receipt); expect(await snapshot()).toEqual(disabled);
    await commit(intent('legacy-role-status', { id: 50, status: 1 }));
    expect((await snapshot()).admins).toEqual(before.admins); expect((await snapshot()).roles).toEqual(before.roles);
  });
  it('physically deletes a referenced role with full immutable historical proof, preserves CSV, immediately revokes authority and cannot resurrect via status', async () => {
    const before = await snapshot(), input = intent('legacy-role-delete', { id: 50 }), value = await confirmed(input), receipt = await service.commit(value, actor());
    expect(receipt).toMatchObject({ state: 'committed', result: { id: 50, deleted: true } }); expect(Object.keys(receipt.result!)).toEqual(['id', 'deleted']);
    const after = await snapshot(); expect(after.admins).toEqual(before.admins); expect(after.roles.some(row => row.id === 50)).toBe(false);
    const stored = after.receipts.find(row => row.operationId === input.operation_id)!;
    expect(stored.result).toEqual({ id: 50, deleted: true, deleted_role: { id: 50, type: 0, relation_id: 0, role_name: '被引用数字身份', rules: '1,2', level: 2, status: 1 } });
    expect([...(await new AdminPermissionService(createContainerFromDb(fixture.db)).resolveAdminPermissionKeys(after.admins.find(row => row.id === 200)!))]).not.toContain('product.view');
    expect(await service.commit(value, actor())).toEqual(receipt); expect(await snapshot()).toEqual(after);
    await expect(service.preview(intent('legacy-role-status', { id: 50, status: 1 }), actor())).rejects.toThrow('不存在');
    await expect(service.preview(intent('legacy-role-status', { id: 56, status: 1 }), actor())).rejects.toThrow('不存在');
  });
  it('keeps independent status/delete capabilities separate from old form save and permits each correct narrow action', async () => {
    await expect(service.preview(intent('legacy-role-delete', { id: 50 }), actor(102))).rejects.toThrow('权限');
    await expect(service.preview(intent('legacy-role-status', { id: 50, status: 0 }), actor(103))).rejects.toThrow('权限');
    for (const operation of ['legacy-role-status', 'legacy-role-delete'] as const) await expect(service.preview(intent(operation, { id: 50, ...(operation === 'legacy-role-status' ? { status: 0 } : {}) }), actor(104))).rejects.toThrow('权限');
    await commit(intent('legacy-role-status', { id: 50, status: 0 }), actor(102)); await commit(intent('legacy-role-delete', { id: 50 }), actor(103));
  });
  it.each([53, 54, 55, 56, 57, 58, 900])('rejects out-of-scope, corrupt, self or retired target %s with no mutation', async id => {
    const before = await snapshot(); for (const operation of ['legacy-role-status', 'legacy-role-delete'] as const) {
      await expect(service.preview(intent(operation, { id, ...(operation === 'legacy-role-status' ? { status: 0 } : {}) }), actor())).rejects.toThrow();
    } expect(await snapshot()).toEqual(before);
  });
  it.each(['foreign-account', 'different-level', 'missing-role', 'foreign-role', 'outside-grant', 'malformed-csv', 'malformed-rule'] as const)('refuses complete reference defect %s without filtering it away', async defect => {
    if (defect === 'foreign-account') await fixture.db.update(systemAdmin).set({ adminType: 4, relationId: 8 }).where(eq(systemAdmin.id, 200));
    if (defect === 'different-level') await fixture.db.update(systemAdmin).set({ level: 3 }).where(eq(systemAdmin.id, 200));
    if (defect === 'missing-role') await fixture.db.update(systemAdmin).set({ roles: '50,999' }).where(eq(systemAdmin.id, 200));
    if (defect === 'foreign-role') await fixture.db.update(systemAdmin).set({ roles: '50,57' }).where(eq(systemAdmin.id, 200));
    if (defect === 'outside-grant') await fixture.db.update(systemAdmin).set({ roles: '50,53' }).where(eq(systemAdmin.id, 200));
    if (defect === 'malformed-csv') await fixture.db.update(systemAdmin).set({ roles: '50,,51' }).where(eq(systemAdmin.id, 200));
    if (defect === 'malformed-rule') await fixture.db.update(systemRole).set({ rules: '1,2,,3' }).where(eq(systemRole.id, 50));
    const before = await snapshot(); await expect(service.preview(intent('legacy-role-delete', { id: 50 }), actor())).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  });
  it('supports retained proven-deleted CSV during a second role operation, without accepting a forged missing, foreign or different-level identity', async () => {
    await commit(intent('legacy-role-delete', { id: 50 }));
    const second = await commit(intent('legacy-role-status', { id: 51, status: 0 })); expect(second.result).toEqual({ id: 51, created: false });
    expect((await snapshot()).admins.find(row => row.id === 201)?.roles).toBe('50,51');
    await fixture.db.insert(systemRole).values({ id: 50, type: 4, relationId: 9, level: 2, rules: '2' });
    await expect(service.preview(intent('legacy-role-delete', { id: 51 }), actor())).rejects.toThrow('角色域');
  });
  it('allows a current actor with an immutable proven-deleted role and another live action role to use the remaining narrow capability', async () => {
    await fixture.db.insert(systemRole).values({ id: 905, level: 1, rules: 'system.legacy_role_status,system.legacy_role_delete,product.view,3' });
    await fixture.db.update(systemAdmin).set({ roles: '900,905' }).where(eq(systemAdmin.id, 101));
    await commit(intent('legacy-role-delete', { id: 900 }), actor(100));
    expect((await snapshot()).admins.find(row => row.id === 101)?.roles).toBe('900,905');
    expect((await commit(intent('legacy-role-status', { id: 50, status: 0 }))).result).toEqual({ id: 50, created: false });
  });
  it.each(['target', 'reference', 'new-reference', 'other-role', 'menu', 'actor', 'expiry'] as const)('invalidates confirmed action after full %s changed', async change => {
    const claims = actor(), input = intent('legacy-role-status', { id: 50, status: 0 }), value = await confirmed(input, claims);
    if (change === 'target') await fixture.db.update(systemRole).set({ roleName: '变更名称' }).where(eq(systemRole.id, 50));
    if (change === 'reference') await fixture.db.update(systemAdmin).set({ realName: '引用账号变更' }).where(eq(systemAdmin.id, 200));
    if (change === 'new-reference') await fixture.db.insert(systemAdmin).values({ id: 299, account: 'new-reference', pwd: password, level: 2, roles: '50' });
    if (change === 'other-role') await fixture.db.update(systemRole).set({ roleName: '其它引用角色变化' }).where(eq(systemRole.id, 51));
    if (change === 'menu') await fixture.db.update(systemMenus).set({ menuName: '菜单变化' }).where(eq(systemMenus.id, 2));
    if (change === 'actor') await fixture.db.update(systemAdmin).set({ pwd: 'changed-password' }).where(eq(systemAdmin.id, 101));
    if (change === 'expiry') claims.expiresAt = Math.floor(Date.now() / 1000) - 1;
    const changed = await snapshot(); await expect(service.commit(value, claims)).rejects.toThrow(); expect(await snapshot()).toEqual(changed);
  });
  it('preserves unknown, durably seals an absent key, rejects UUID payload/type/owner reuse and allows only original current identity recovery', async () => {
    const input = intent('legacy-role-status', { id: 50, status: 0 }), value = await confirmed(input), receipt = await service.commit(value, actor());
    await expect(service.commit({ ...value, payload: { id: 50, status: 1 } }, actor())).rejects.toThrow('原提交');
    await expect(service.receipt(input.operation_id, 'legacy-role-delete', actor())).rejects.toThrow('类型');
    await expect(service.receipt(input.operation_id, input.operation, actor(105))).rejects.toThrow('无权');
    await fixture.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 900));
    expect(await service.receipt(input.operation_id, input.operation, actor())).toEqual(receipt);
    const absent = intent('legacy-role-delete', { id: 51 });
    expect(await service.receipt(absent.operation_id, absent.operation, actor())).toMatchObject({ state: 'unknown', result: null });
    const sealed = await service.resolve({ operation_id: absent.operation_id, operation: absent.operation }, actor()); expect(sealed).toMatchObject({ state: 'not_applied', result: null });
    await fixture.db.update(systemRole).set({ rules: 'system.legacy_role_status,system.legacy_role_delete,product.view,3' }).where(eq(systemRole.id, 900));
    await expect(service.preview(absent, actor())).rejects.toThrow('耐久');
    await fixture.db.update(systemAdmin).set({ pwd: 'new-current-password' }).where(eq(systemAdmin.id, 101));
    await expect(service.receipt(input.operation_id, input.operation, actor())).rejects.toThrow('凭据');
    expect(await service.receipt(input.operation_id, input.operation, { ...actor(), authVersion: md5('new-current-password') })).toEqual(receipt);
  });
  it('supports actual next-level10 roles and level10 referencing staff for actor9 without modern level substitution', async () => {
    await fixture.db.update(systemAdmin).set({ level: 9 }).where(eq(systemAdmin.id, 101)); await fixture.db.update(systemRole).set({ level: 9 }).where(eq(systemRole.id, 900));
    for (const id of [50, 51]) await fixture.db.update(systemRole).set({ level: 10 }).where(eq(systemRole.id, id));
    for (const id of [200, 201, 202, 203]) await fixture.db.update(systemAdmin).set({ level: 10 }).where(eq(systemAdmin.id, id));
    const preview = await service.preview(intent('legacy-role-delete', { id: 50 }), actor()); expect(preview.summary.before.level).toBe(10);
    expect((await commit(intent('legacy-role-delete', { id: 50 }))).result).toEqual({ id: 50, deleted: true });
  });
});
