import { describe, expect, it } from 'vitest';
import { distributorCanonical, distributorColor, distributorHash, distributorImage, distributorLevelValues,
  distributorTaskValues, parseDistributorQuery, readDistributorBody } from '../src/services/admin/AdminDistributorLevelInput';
import { distributorCommissionRatio, distributorGraphIssues } from '../src/services/admin/AdminDistributorLevelService';

const nonce = '00000000-0000-4000-8000-000000000001', revision = 'a'.repeat(64);
const level = () => ({ name: ' 一级 🌿 ', grade: 1, image: '/legacy/level.png', color: '#abc', one_brokerage: 1000, two_brokerage: 1000, status: 1 });
const task = () => ({ level_id: 1, name: ' 邀请好友 ', type: 1, number: 2147483647, desc: ' 首行\r\n\t次行 ', sort: 32767, status: 1 });
describe('complete distributor level/task input and active graph contract', () => {
  it('normalizes full legacy values and retains readonly is_must outside the writable contract', () => {
    expect(distributorLevelValues(level())).toEqual({ ...level(), name: '一级 🌿' });
    expect(distributorTaskValues(task())).toEqual({ ...task(), name: '邀请好友', desc: '首行\r\n\t次行' });
    expect(() => distributorTaskValues({ ...task(), is_must: 1 })).toThrow();
    expect(() => distributorLevelValues({ ...level(), sort: 1 })).toThrow();
  });
  it('rejects incomplete/unknown fields and numeric/control/Unicode boundaries before trimming', () => {
    for (const change of [{ grade: 0 }, { grade: 32768 }, { one_brokerage: '2' }, { one_brokerage: 1001 }, { two_brokerage: 1001 },
      { one_brokerage: 1, two_brokerage: 2 }, { status: 2 }, { name: 'x\n' }, { name: '\ud800' }, { name: '🌿'.repeat(51) }]) expect(() => distributorLevelValues({ ...level(), ...change })).toThrow();
    for (const change of [{ type: 0 }, { type: 6 }, { number: 0 }, { number: 2147483648 }, { sort: -1 }, { sort: 32768 }, { desc: 'x\u0000 ' },
      { level_id: 0 }, { desc: 'x'.repeat(256) }]) expect(() => distributorTaskValues({ ...task(), ...change })).toThrow();
    const missing = { ...task() } as Record<string, unknown>; delete missing.desc; expect(() => distributorTaskValues(missing)).toThrow();
  });
  it('accepts safe CSS colors while rejecting injected or semantically invalid CSS', () => {
    for (const color of ['#aBc', '#abcd', '#AABBCC', '#aabbccdd', 'rgb(255, 0, 1)', 'rgba(1,2,3,0.5)', 'rgba(1,2,3,1.000)']) expect(distributorColor(color)).toBe(color);
    for (const color of ['red', 'var(--x)', '#aaa;display:none', 'rgb(256,0,1)', 'rgba(1,2,3,.5)', 'rgb(1,2,3,0.5)', 'rgba(1,2,3)', 'rgba(1,2,3,1.001)']) expect(() => distributorColor(color)).toThrow();
  });
  it('permits stable platform/legacy images and rejects signed/private alias or unsafe address spellings', () => {
    for (const image of ['/api/assets/41', '/uploads/system/level.png', 'https://cdn.example/My%20Level.png']) expect(distributorImage(image)).toBe(image);
    for (const image of ['http://cdn.example/a.png', 'https:example.com', '//evil.test', '/a/..//evil.test', '/a/%252e%252e//evil.test',
      '/a/../api/assets/41', '/api/%61ssets/41', '/api/assets/01', '/api/assets/41?expires=1', 'https://cdn.example/a.png?token=x',
      '/foo%250a', '/foo%5cbar', 'https://a:b@example.com/a.png']) expect(() => distributorImage(image), image).toThrow();
  });
  it('hashes fixed operation/ID/revision and fixed normalized value order, excluding UUID', async () => {
    const input = { request_id: nonce, revision, values: level() }, parsed = distributorCanonical('level:create', 0, input);
    expect(JSON.stringify(parsed.canonical)).toBe(`{"operation":"level:create","id":0,"revision":"${revision}","values":{"name":"一级 🌿","grade":1,"image":"/legacy/level.png","color":"#abc","one_brokerage":1000,"two_brokerage":1000,"status":1}}`);
    expect(await distributorHash(parsed.canonical)).toBe(await distributorHash(distributorCanonical('level:create', 42, { ...input, request_id: crypto.randomUUID(), values: Object.fromEntries(Object.entries(level()).reverse()) }).canonical));
    expect(await distributorHash(parsed.canonical)).not.toBe(await distributorHash(distributorCanonical('level:update', 1, input).canonical));
    expect(distributorCanonical('task:status', 2, { request_id: nonce, revision, status: 0 }).canonical).toEqual({ operation: 'task:status', id: 2, revision, status: 0 });
    expect(() => distributorCanonical('level:delete', '01', { request_id: nonce, revision })).toThrow();
    expect(() => distributorCanonical('task:delete', 1, { request_id: nonce, revision, values: {} })).toThrow();
  });
  it('uses strict bounded queries with literal percent/underscore and requires a real task parent', () => {
    expect(parseDistributorQuery(new URLSearchParams('level_id=1&keyword=%25_&limit=100'), true)).toEqual({ level_id: 1, keyword: '%_', page: 1, limit: 100, offset: 0 });
    for (const query of ['level_id=0', 'level_id=01', 'level_id=1&level_id=2', 'level_id=1&status=1&status=0', 'level_id=1&is_del=1', 'level_id=1&limit=101', 'level_id=1&page=100002&limit=1', '']) expect(() => parseDistributorQuery(new URLSearchParams(query), true)).toThrow();
  });
  it('checks the entire active graph while ignoring hidden-parent and deleted-task requirements', () => {
    const levels = [1, 2, 3].map(id => ({ id, grade: id, status: 1, isDel: 0 }));
    const tasks = levels.map(row => ({ id: row.id, levelId: row.id, type: 1, number: row.id * 10, status: 1, isDel: 0 }));
    expect(distributorGraphIssues(levels, tasks)).toEqual([]);
    expect(distributorGraphIssues(levels, tasks.map(row => row.id === 3 ? { ...row, number: 20 } : row))).toContain('non_monotonic_type:1');
    expect(distributorGraphIssues(levels.map(row => row.id === 3 ? { ...row, status: 0 } : row), tasks.map(row => row.id === 3 ? { ...row, number: 1 } : row))).toEqual([]);
    expect(distributorGraphIssues(levels, [...tasks, { ...tasks[0], id: 99, status: 0 }])).toContain('duplicate_type:1:1');
    expect(distributorGraphIssues([...levels, { ...levels[0], id: 4, status: 0 }], tasks)).toContain('duplicate_grade:1');
    expect(distributorGraphIssues(levels, [...tasks, { ...tasks[0], id: 99, levelId: 999 }])).toContain('orphan_task:99');
  });
  it('computes exact percentage uplift without floating point and reports invalid history explicitly', () => {
    expect(distributorCommissionRatio('10.01', 19)).toBe('11.91'); expect(distributorCommissionRatio('10.00', 0)).toBe('10.00');
    expect(distributorCommissionRatio('100.00', 1000)).toBe('1100.00'); expect(distributorCommissionRatio(null, 1)).toBeNull();
    expect(distributorCommissionRatio('10.00', -1)).toBeNull();
  });
  it('rejects duplicate decoded JSON keys and oversized/non-JSON requests', async () => {
    const request = (body: string, type = 'application/json') => new Request('https://test.invalid', { method: 'POST', headers: { 'content-type': type }, body });
    await expect(readDistributorBody(request('{"values":{"name":"a","na\\u006de":"b"}}'))).rejects.toThrow(/重复/);
    await expect(readDistributorBody(request('x'.repeat(16385)))).rejects.toThrow(/16 KiB/);
    await expect(readDistributorBody(request('{}', 'text/plain'))).rejects.toThrow(/application\/json/);
  });
});
