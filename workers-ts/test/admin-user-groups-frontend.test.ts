import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';

// These five existing behavioral regressions now mount the current compiled
// template and real request adapter. No predecessor page is substituted.
const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { runtime, tick, row, css, byLabel, buttons, replay, click, update, deferred }: any = require(resolve(root, 'scripts/helpers/group-author-runtime.cjs'));
const runs: any[] = [];
const base = '/user/group/author';
const journal = (r: any) => [...r.storage].filter(([key]: [string, string]) => key.startsWith('cinashop_group_pending_v1_'));
async function mount(options: Record<string, unknown> = {}) { const r = runtime(options); runs.push(r); await tick(); return r; }
afterEach(async () => { for (const r of runs.splice(0)) await r.finish(); });

it('validates the real list and mutation contracts', async () => {
 const fixture = await mount(), groups = fixture.load(resolve(root, 'src/api/userGroups.ts'));
 const oldPage = { list: [{ id: 1, group_name: '历史用户' }], count: 21, page: 2, limit: 10 };
 expect(groups.parseUserGroupPage(oldPage).list[0].id).toBe(1);
 expect(() => groups.parseUserGroupPage({ ...oldPage, count: -1 })).toThrow('分组列表格式错误');
 expect(() => groups.parseUserGroupPage({ ...oldPage, list: [{ id: 3, group_name: 'A' }, { id: 3, group_name: 'B' }] })).toThrow('分组记录格式错误');
 expect(groups.normalizedUserGroupName('  VIP  ')).toBe('VIP');
 expect(() => groups.normalizedUserGroupName(' ')).toThrow('请输入分组名称');
 expect(() => groups.normalizedUserGroupName('x'.repeat(65))).toThrow('64');
 expect(groups.normalizedUserGroupName('😀'.repeat(64))).toBe('😀'.repeat(64));
 expect(requiredAdminPermission('GET', '/adminapi/user_group/list')).toBe('user.view');
 expect(requiredAdminPermission('POST', '/adminapi/user_group/save')).toBe('user.manage');
 expect(requiredAdminPermission('DELETE', '/adminapi/user_group/del/:id')).toBe('user.manage');
});

it('applies search and pagination to server results without giving a view-only role write access', async () => {
 const fixture = await mount({ rows: Array.from({ length: 21 }, (_, i) => row(i + 1, { group_name: i < 11 ? `VIP ${i}` : `普通用户 ${i}` })), actor: { userInfo: { id: 20, level: 1 }, uniqueAuth: ['user.view'] } });
 expect(fixture.bindings.canView).toBe(true); expect(fixture.bindings.canManage).toBe(false); expect(fixture.state.snapshot.count).toBe(21);
 await update(fixture, '分组名称', ' VIP '); await click(fixture, '查询'); expect(css(fixture, 'group-row')).toHaveLength(10);
 await click(fixture, '下一页'); expect(css(fixture, 'group-row')).toHaveLength(1); expect(fixture.state.filters.page).toBe(2);
 expect(buttons(fixture, '新增分组')).toHaveLength(0); expect(buttons(fixture, '编辑')).toHaveLength(0); expect(buttons(fixture, '删除')).toHaveLength(0);
 expect(fixture.io.every((call: any) => call.method === 'GET')).toBe(true); expect(fixture.reads()).toHaveLength(1);
 // A formerly visible native create handler cannot turn a read-only session
 // into a writer, even when replayed directly after the UI hides it.
 const earlier = await mount(), oldCreate = buttons(earlier, '新增分组')[0].props.onClick;
 earlier.sync({ userInfo: { id: 7, level: 1 }, uniqueAuth: ['user.view'] }); await tick(); replay(oldCreate); await tick();
 expect(earlier.state.editor).toBeNull(); expect(earlier.writes()).toHaveLength(0);
});

it('creates, edits, and refuses occupied deletion while keeping the row visible', async () => {
 const fixture = await mount({ rows: [row(3, { group_name: '普通用户' }), row(2, { group_name: 'VIP' })], send(call: any, next: () => unknown) {
  if (call.url === base + '/commit' && call.body.operation === 'delete') return { httpStatus: 409, status: 409, msg: '该分组仍有用户，不能删除', data: null };
  return next();
 } });
 await click(fixture, '新增分组'); await update(fixture, '编辑分组名称', ' 新用户 '); await click(fixture, '保存'); await click(fixture, '确认提交');
 expect(fixture.writes()[0].body).toMatchObject({ operation: 'create', target_id: 0, payload: { group_name: ' 新用户 ' } });
 expect(fixture.state.editor).toBeNull(); expect(fixture.server.rows.at(-1).group_name).toBe('新用户');
 await click(fixture, '编辑'); await update(fixture, '编辑分组名称', '普通会员'); await click(fixture, '保存'); await click(fixture, '确认提交');
 expect(fixture.writes()[1].body).toMatchObject({ operation: 'update', target_id: 3, payload: { group_name: '普通会员' } });
 await click(fixture, '删除'); await click(fixture, '确认提交');
 expect(fixture.state.snapshot.list[0].id).toBe(3); expect(fixture.state.snapshot.list[0].group_name).toBe('普通会员'); expect(fixture.state.error).toContain('该分组仍有用户');
 expect(journal(fixture)).toHaveLength(1); expect(fixture.state.pending.operation).toBe('delete');
 await click(fixture, '读取原回执'); expect(fixture.state.error).toContain('结果仍未知'); expect(journal(fixture)).toHaveLength(1);
});

it('blocks direct reads without user.view and returns to the preceding page after deleting its last row', async () => {
 const denied = await mount({ actor: { userInfo: { id: 20, level: 1 }, uniqueAuth: [] } });
 expect(denied.bindings.canView).toBe(false); expect(denied.io).toEqual([]); await denied.model.load(); expect(denied.io).toEqual([]);
 const fixture = await mount({ rows: Array.from({ length: 11 }, (_, i) => row(i + 1)) });
 await click(fixture, '下一页'); expect(fixture.state.filters.page).toBe(2); expect(css(fixture, 'group-row')).toHaveLength(1);
 await click(fixture, '删除'); await click(fixture, '确认提交');
 expect(fixture.writes()[0].body.target_id).toBe(11); expect(fixture.state.filters.page).toBe(1); expect(fixture.state.snapshot.list[0].id).toBe(1); expect(css(fixture, 'group-row')).toHaveLength(10);
});

it('ignores an old list response after a newer search and aborts on session replacement', async () => {
 const old = deferred(), sessionRead = deferred(); let n = 0;
 const fixture = await mount({ rows: [row(3, { group_name: '普通用户' }), row(2, { group_name: 'NEW' })], send(call: any, next: () => unknown) {
  if (call.url === base + '/catalog') { n++; if (n === 2) return old.promise; if (n === 4) return sessionRead.promise; }
  return next();
 } });
 replay(buttons(fixture, '刷新')[0].props.onClick); await tick(); const oldRequest = fixture.reads().at(-1);
 await click(fixture, '刷新'); await update(fixture, '分组名称', 'NEW'); await click(fixture, '查询');
 expect(oldRequest.signal.aborted).toBe(true); expect(css(fixture, 'group-row')).toHaveLength(1);
 old.resolve({ data: { list: [row(99, { group_name: '过期结果' })], count: 1, revision: 'b'.repeat(64), write_ready: true } }); await tick();
 expect(fixture.state.snapshot.list[0].id).toBe(3); expect(css(fixture, 'group-row')).toHaveLength(1); expect(byLabel(fixture, '分组名称').props.value).toBe('NEW');
 replay(buttons(fixture, '刷新')[0].props.onClick); await tick(); const pending = fixture.reads().at(-1);
 fixture.sync({ token: 'group-token-b', userInfo: { id: 21, level: 1 }, uniqueAuth: [] }); await tick();
 expect(pending.signal.aborted).toBe(true); expect(fixture.bindings.canView).toBe(false); expect(fixture.state.snapshot).toBeNull();
 sessionRead.resolve({ data: { list: [row(99)], count: 1, revision: 'b'.repeat(64), write_ready: true } }); await tick(); expect(fixture.state.snapshot).toBeNull();
});
