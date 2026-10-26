/** Opt-in CUA host: actual built Admin, registered Worker/JWT/SQL reads and
 * owned native PG16. No business response is synthetic. Connection factories
 * target this owned database; separate production LOGIN ACLs are not asserted.
 * Explicit QA session bootstrap and one role-revoke setup are not login-form
 * or business writes. This file launches no browser or automation driver. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { eq, sql, SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { user, userGroup, userLabel, userLabelRelation, wechatUser, cityArea, systemUserLevel, systemAdmin, systemRole, systemConfig } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { diyFooterBrowserFixture } from '../helpers/diyFooterBrowserFixture';
import { sortedDiyState, stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from '../helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned directory database'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned directory Admin SQL'); return { container: wiring.container, close: async () => {} }; },
}));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
async function files(dir: string): Promise<string[]> { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)]))).flat().sort(); }
async function body(req: IncomingMessage, consumed?: (size: number) => void) { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { const part = Buffer.from(chunk); size += part.length; consumed?.(size); expect(size).toBeLessThanOrEqual(262144); chunks.push(part); } return Buffer.concat(chunks); }
/** A disconnected, zero-body GET may be cancelled only before Worker dispatch.
 * Framing and the native abort error are checked independently of byte count. */
function abortedEmptyGet(req: IncomingMessage, error: unknown, consumed: number) {
  const lengths = req.rawHeaders.flatMap((name, i) => i % 2 === 0 && name.toLowerCase() === 'content-length' ? [req.rawHeaders[i + 1]] : []);
  const transfer = req.rawHeaders.some((name, i) => i % 2 === 0 && name.toLowerCase() === 'transfer-encoding');
  return req.aborted === true && req.method === 'GET' && consumed === 0 && lengths.length <= 1 && lengths.every(value => value === '0') && !transfer
    && error instanceof Error && error.message === 'aborted' && 'code' in error && error.code === 'ECONNRESET';
}
const plans = ['initial','expanded','tags-page1','tags-crosspage','groups-page2','levels-page2','applied-tags','zero-filters','geo-dates','reset','source-draft-isolation','page2','refreshed','reader','revoked','fresh-account','guest','mobile','desktop','finished'];
it('actual Admin user directory performs complete bounded filter/option reads without business writes on owned PG16', async () => {
  const f = await diyFooterBrowserFixture({ namespace: 'public' });
  const prefix = '/tmp/cinashop-admin-user-filters-browser-', repository = resolve(import.meta.dirname, '../../..'), dist = resolve(repository, 'view/admin-ts/dist');
  const origin = 'http://127.0.0.1:40833', control = '/__directory/' + randomUUID();
  let server: ReturnType<typeof createServer> | undefined, timer: ReturnType<typeof setTimeout> | undefined, failure: unknown;
  const traces: Row[] = [], evidence: Row[] = [], staticPaths: Row[] = [], controls: Row[] = [], setups: Row[] = [], snapshots: Record<string, DiyStateSnapshot> = {};
  let failedDispatch: Row | undefined, expected: DiyStateSnapshot | undefined, snapshot!: () => Promise<DiyStateSnapshot>;
  try {
    // Add only absent ORM tables to this owned fixture. Reads do not require a
    // write conflict arbiter; no generic shared fixture or migration is altered.
    const dialect = new PgDialect();
    for (const table of [userGroup, userLabel, userLabelRelation, wechatUser, cityArea, systemUserLevel]) {
      const definition = getTableConfig(table), present = await f.db.execute(sql`SELECT to_regclass(${definition.name}) AS relation`);
      if (present[0]?.relation) continue;
      const columns = definition.columns.map(column => { const initial = column.default, initialSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initialSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`; });
      await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
    }
    const tableNames = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
    const sequenceNames = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
    snapshot = async () => { const state: DiyStateSnapshot = {};
      for (const row of await f.db.execute<{ name: string; rows: Row[] }>(sql.join(tableNames.map(name => sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `))) state[row.name] = row.rows;
      state.__sequences = await f.db.execute(sql.join(sequenceNames.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `)); return sortedDiyState(state); };
    const remember = (value: DiyStateSnapshot) => { const id = digest(value); snapshots[id] ??= structuredClone(value); return id; };
    const setupBefore = await snapshot();
    // Owned deterministic directory; inherited unrelated tables remain intact.
    await f.db.delete(user); await f.db.delete(userGroup); await f.db.delete(userLabel); await f.db.delete(userLabelRelation); await f.db.delete(wechatUser); await f.db.delete(systemUserLevel); await f.db.delete(cityArea);
    const start = Date.parse('2026-09-30T16:00:00Z') / 1000;
    await f.db.insert(user).values(Array.from({ length: 44 }, (_, index) => ({ uid: 1001 + index, account: 'directory-user-' + (index + 1), nickname: '目录用户' + String(index + 1).padStart(2, '0'), phone: '1390000' + String(1001 + index), avatar: '/logo.png',
      groupId: index < 2 ? 7016 : 7001 + index % 32, level: index < 2 ? 7016 : 7001 + index % 32,
      sex: index < 2 ? 0 : 1, isMoneyLevel: index < 2 ? 0 : 1, isPromoter: index < 2 ? 0 : 1, payCount: index < 2 ? 0 : 2,
      nowMoney: (index + 1) + '.00', integral: index * 10, userType: index < 32 ? 'h5' : 'wechat', lastTime: index === 1 ? start + 3 * 86400 : start + 3600, addTime: start + 1800,
      provincials: index === 0 ? '浙江省 杭州市' : '江苏省 南京市', addres: index === 0 ? '浙江省 杭州市' : '江苏省 南京市', isDel: index === 42 ? 1 : 0, deleteTime: index === 43 ? new Date() : null })));
    await f.db.insert(userGroup).values(Array.from({ length: 32 }, (_, i) => ({ id: 7001 + i, groupName: '筛选分组' + String(i + 1).padStart(2, '0') })));
    await f.db.insert(userLabel).values(Array.from({ length: 32 }, (_, i) => ({ id: 7001 + i, name: '筛选标签' + String(i + 1).padStart(2, '0'), type: 0, relationId: 0, status: 1 })));
    await f.db.insert(systemUserLevel).values(Array.from({ length: 32 }, (_, i) => ({ id: 7001 + i, name: '筛选等级' + String(i + 1).padStart(2, '0'), isShow: 1, isDel: 0, grade: i + 1 })));
    await f.db.insert(userLabelRelation).values(Array.from({ length: 44 }, (_, i) => ({ uid: 1001 + i, labelId: i === 0 ? 7001 : i === 1 ? 7016 : 7002 + i % 14, type: 0, relationId: 0 })));
    await f.db.insert(wechatUser).values([{ uid: 1001, openid: 'owned-directory-1001', country: 'China', province: '浙江省', city: '杭州市' }, { uid: 1002, openid: 'owned-directory-1002', country: '中国', province: '江苏省', city: '南京市' }]);
    await f.db.insert(cityArea).values([{ id: 330000, parentId: 0, name: '浙江省', level: 1 }, { id: 320000, parentId: 0, name: '江苏省', level: 1 }, { id: 330100, parentId: 330000, name: '杭州市', level: 2 }, { id: 330200, parentId: 330000, name: '宁波市', level: 2 }, { id: 320100, parentId: 320000, name: '南京市', level: 2 }, { id: 330102, parentId: 330100, name: '上城区', level: 3 }]);
    const password = 'owned-directory-browser-password';
    await f.db.insert(systemRole).values([{ id: 9601, roleName: 'Directory reader', rules: 'user.view', status: 1 }, { id: 9602, roleName: 'Directory manager', rules: 'user.manage', status: 1 }, { id: 9603, roleName: 'Directory fresh account', rules: 'user.manage', status: 1 }]);
    await f.db.insert(systemAdmin).values([9601, 9602, 9603].map(id => ({ id, account: 'directory-admin-' + id, pwd: password, realName: '本机用户目录验收', level: 1, roles: String(id), adminType: 1, relationId: 0, status: 1 })));
    // No external site origin, icon or remote script is introduced by setup.
    for (const key of ['site_url','site_logo','site_logo_square','login_logo','ico_path','admin_login_slide']) await f.db.update(systemConfig).set({ value: '""' }).where(eq(systemConfig.menuName, key));
    f.cache.clear(); wiring.container = f.container;
    const tokens = new Map<number, string>(); for (const id of [9601, 9602, 9603]) tokens.set(id, (await createToken(id, 'admin', md5(password), f.env.APP_KEY)).token);
    const session = (id: number, revoked = false) => ({ userInfo: { id, account: 'directory-admin-' + id, head_pic: '', real_name: '本机用户目录验收', level: 1, roles: String(id) }, menus: [{ id: 1, pid: 0, path: '/user', name: '用户管理', icon: '', sort: 1, type: 1, children: [] }], uniqueAuth: revoked ? [] : id === 9601 ? ['user.view'] : ['user.manage','user.view'] });
    const app = createApp(), resources = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length, objects: digest([...f.objects].map(([key, value]) => ({ key, type: value.type, bytes: [...value.bytes] }))), queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length });
    const initialResources = resources(); expected = await snapshot(); remember(setupBefore); remember(expected);
    const sourcePaths = () => Promise.all(['workers-ts/src','workers-ts/test/helpers','view/admin-ts/src','view/admin-ts/public','view/common'].map(path => files(resolve(repository, path))));
    const sources = async () => { const paths = [...(await sourcePaths()).flat(), ...['workers-ts/test/browser/admin-user-filters.acceptance.ts','workers-ts/vitest.admin-user-filters-browser.config.ts','workers-ts/test/admin-user-list-postgres.test.ts','workers-ts/scripts/run-local-finance-postgres.mjs','workers-ts/package.json','workers-ts/package-lock.json','view/admin-ts/package.json','view/admin-ts/package-lock.json'].map(path => resolve(repository, path))]; return Promise.all([...new Set(paths)].sort().map(async path => ({ path: path.slice(repository.length + 1), sha256: hash(await readFile(path)) }))); };
    const artifacts = async () => Promise.all((await files(dist)).map(async path => ({ path: path.slice(dist.length + 1), sha256: hash(await readFile(path)) })));
    const sourceBefore = await sources(), buildBefore = await artifacts(); expect(buildBefore.length).toBeGreaterThan(100);
    const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Directory Browser forbids external provider I/O'));
    const stage = () => plans[evidence.length]; let queue = Promise.resolve(), pending = 0, actor = 9602, revoked = false;
    const serial = <T>(work: () => Promise<T>) => { const next = queue.then(work); queue = next.then(() => {}, () => {}); return next; };
    let finish!: () => void, fail!: (error: Error) => void; const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; }); completion.catch(() => {});
    const persist = async () => writeFile(prefix + 'progress.json', JSON.stringify({ status: 'running', evidence, traces, staticPaths, controls, setups, snapshots_by_sha256: snapshots, failedDispatch }, null, 2) + '\n', { mode: 0o600 });
    const send = (res: ServerResponse, bytes: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'" }); res.end(bytes); };
    const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value), 200, 'application/json');
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      pending++; try { await serial(async () => {
        const started = Date.now(), method = req.method ?? 'GET', before = await snapshot(), beforeResources = resources(); expect(before).toEqual(expected);
        const allowed = ['/adminapi/new_push','/api/site_config','/api/get_script','/adminapi/user/list','/api/admin/user/list','/adminapi/user/filter_options','/api/admin/user/filter_options','/adminapi/user/filter_regions','/api/admin/user/filter_regions'];
        expect(allowed.includes(url.pathname) || /^\/api\/assets\/[1-9]\d*$/.test(url.pathname)).toBe(true);
        const headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
        const token = (headers.get('authori-zation') ?? headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
        const actualActor = [...tokens].find(([, value]) => value === token)?.[0] ?? 0, probe = headers.get('x-owned-directory-probe') === '1';
        let consumed = 0, bytes: Buffer;
        try { bytes = await body(req, size => { consumed = size; }); }
        catch (error) {
          if (!abortedEmptyGet(req, error, consumed)) throw error;
          const after = await snapshot(), afterResources = resources();
          controls.push({ kind: 'cancelled-before-dispatch', path: url.pathname, query: url.search, method, issued_actor_hint: actualActor, token_match: actualActor !== 0, worker_authenticated: false, probe, stage: stage(),
            aborted: req.aborted, dispatched: false, nonproof: true, request: { bytes_received: consumed, content_length: req.headers['content-length'] ?? null, transfer_encoding: req.headers['transfer-encoding'] ?? null, framing_headers: req.rawHeaders.flatMap((name, i) => i % 2 === 0 && ['content-length','transfer-encoding'].includes(name.toLowerCase()) ? [{ name, value: req.rawHeaders[i + 1] }] : []) },
            error: { name: (error as Error).name, message: (error as Error).message, code: 'ECONNRESET' },
            before: remember(before), after: remember(after), resources_before: beforeResources, resources_after: afterResources, started_at_ms: started, completed_at_ms: Date.now(), at_ms: Date.now() });
          await persist(); // No response, successful trace, phase evidence or read count is fabricated.
          expect(after).toEqual(before); expect(afterResources).toEqual(beforeResources); expect(afterResources).toEqual(initialResources);
          return;
        }
        failedDispatch = { phase: 'before-dispatch', path: url.pathname, query: url.search, method, stage: stage(), request: { bytes: bytes.length, body: bytes.toString(), sha256: hash(bytes) }, before: remember(before), resources_before: beforeResources }; await persist();
        expect(method).toBe('GET'); expect(bytes.length).toBe(0);
        const waits: Promise<unknown>[] = [];
        const response = await app.fetch(new Request(origin + url.pathname + url.search, { method, headers }), f.env, { waitUntil: (work: Promise<unknown>) => waits.push(work), passThroughOnException() {} } as unknown as ExecutionContext); await Promise.all(waits);
        const raw = Buffer.from(await response.arrayBuffer()), type = response.headers.get('Content-Type') ?? '', textBody = /(?:json|javascript|text\/)/.test(type);
        failedDispatch = { path: url.pathname, query: url.search, method, actor: actualActor, probe, stage: stage(), request: { bytes: 0, body: '', sha256: hash('') }, response: { http_status: response.status, content_type: type, bytes: raw.length, body_encoding: textBody ? 'utf8' : 'base64', body: textBody ? raw.toString() : raw.toString('base64'), sha256: hash(raw) }, before: remember(before), resources_before: beforeResources };
        await persist(); // Even malformed JSON retains exact dispatched bytes.
        const after = await snapshot(); failedDispatch.after = remember(after); failedDispatch.resources_after = resources(); await persist();
        const payload: Row | undefined = type.includes('application/json') ? JSON.parse(raw.toString()) : undefined;
        failedDispatch.response.dto = payload;
        // Persist before any status/body/snapshot assertion: failures keep the
        // actual dispatch, raw response, exact database and resource aftermath.
        await persist(); expect(response.status).toBe(200); expect(after).toEqual(before); expect(resources()).toEqual(beforeResources);
        const directory = /\/user\/(?:list|filter_options|filter_regions)$/.test(url.pathname);
        if (directory) expect(response.headers.get('Cache-Control')).toContain('no-store');
        if (directory && actualActor === 0) { expect(stage()).toBe('guest'); expect(probe).toBe(true); expect(payload?.status).toBe(410000); }
        else if (directory && actualActor === 9601 && revoked) { expect(stage()).toBe('revoked'); expect(probe).toBe(true); expect(payload?.status).toBe(400011); }
        else expect(payload?.status ?? 200).toBe(200);
        if (/^\/api\/assets\//.test(url.pathname)) { expect([...url.searchParams.keys()].sort()).toEqual(['expires','signature']); expect(Number(url.searchParams.get('expires')) * 1000).toBeGreaterThan(Date.now()); expect(url.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]{43}$/); }
        traces.push({ ...failedDispatch, started_at_ms: started, completed_at_ms: Date.now(), response: { ...failedDispatch.response, content_type: response.headers.get('Content-Type'), cache_control: response.headers.get('Cache-Control') }, synthetic: false });
        failedDispatch = undefined; await persist(); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      }); } finally { pending--; }
    }
    function listTrace() { return [...traces].reverse().find(trace => trace.actor === actor && !trace.probe && /\/user\/list$/.test(trace.path) && trace.response.dto?.status === 200); }
    async function capture(name: string, data: Row) {
      expect(name).toBe(stage()); expect(pending).toBe(0);
      expect(actor).toBe(name === 'guest' ? 0 : ['reader','revoked'].includes(name) ? 9601 : ['fresh-account','mobile','desktop','finished'].includes(name) ? 9603 : 9602); expect(data.errors).toEqual([]); expect(data.captured_at_ms).toBeGreaterThan(Number(evidence.at(-1)?.captured_at_ms ?? 0));
      expect(new URL(data.href).origin).toBe(origin); expect(data.scrollWidth).toBeLessThanOrEqual(data.clientWidth);
      const wantedWidth = name === 'mobile' ? 600 : 1440; expect(data.frameWidth).toBe(wantedWidth); expect(data.viewportWidth).toBe(wantedWidth); if (actor) expect(data.text).toContain('directory-admin-' + actor);
      expect(data.clientWidth).toBeLessThanOrEqual(wantedWidth); expect(wantedWidth - data.clientWidth).toBeLessThanOrEqual(20);
      const bound = listTrace(); let linked: Row | undefined;
      if (['revoked','guest'].includes(name)) {
        expect(data.rows).toEqual([]); expect(data.money_buttons).toBe(0);
        if (name === 'revoked') { expect(data.text).toContain('当前账号没有用户查看权限'); expect(traces.some(t => t.stage === name && t.actor === 9601 && t.probe && t.response.dto?.status === 400011)).toBe(true); }
        else { expect(new URL(data.href).pathname).toBe('/login'); expect(traces.some(t => t.stage === name && t.actor === 0 && t.probe && t.response.dto?.status === 410000)).toBe(true); }
      } else {
        expect(new URL(data.href).pathname).toBe('/user'); expect(bound).toBeDefined(); expect(bound!.completed_at_ms).toBeLessThanOrEqual(data.captured_at_ms); const dto = bound!.response.dto.data; expect(Array.isArray(dto.list)).toBe(true);
        expect(data.rows.map((row: Row) => row.uid)).toEqual(dto.list.map((row: Row) => row.uid)); expect(data.page).toBe(dto.page); expect(data.total_text).toMatch(new RegExp('(?:^|\\D)' + dto.count + '(?:\\D|$)'));
        for (const [i, row] of dto.list.entries()) { expect(data.rows[i].text).toContain(row.nickname); expect(data.rows[i].text).toContain(row.phone); }
        if (name === 'reader') expect(data.money_buttons).toBe(0); else expect(data.money_buttons).toBe(dto.list.length);
        linked = { trace_index: traces.indexOf(bound!), body_sha256: bound!.response.sha256, query: bound!.query, actor, count: dto.count, page: dto.page, limit: dto.limit, uids: dto.list.map((row: Row) => row.uid), captured_from_same_unmutated_database: remember(expected!) };
        const query = new URLSearchParams(bound!.query);
        if (['initial','reset','reader','fresh-account','mobile','desktop','finished'].includes(name)) { expect(dto.count).toBe(42); expect(dto.page).toBe(1); expect(dto.limit).toBe(15); expect(dto.list.map((row: Row) => row.uid)).toEqual(Array.from({ length: 15 }, (_, i) => 1042 - i)); }
        if (name === 'expanded') for (const label of ['用户分组','用户标签','性别','会员等级','付费会员','身份','访问时间','访问情况','下单次数','国家']) expect(data.labels.join('')).toContain(label);
        if (name === 'applied-tags') { expect(dto.list.map((row: Row) => row.uid)).toEqual([1002,1001]); expect(query.get('label_ids')).toBe('7001,7016'); expect(query.get('group_id')).toBe('7016'); expect(query.get('level')).toBe('7016'); }
        if (name === 'zero-filters' || name === 'geo-dates') { for (const key of ['sex','isMember','is_promoter']) expect(query.get(key)).toBe('0'); expect(query.get('pay_count')).toBe('-1'); expect(query.get('label_ids')).toBe('7001,7016'); }
        if (name === 'zero-filters') expect(dto.list.map((row: Row) => row.uid)).toEqual([1002,1001]);
        if (name === 'geo-dates') { expect(dto.list.map((row: Row) => row.uid)).toEqual([1001]); expect(query.get('country')).toBe('domestic'); expect(query.get('province')).toBe('浙江省'); expect(query.get('city')).toBe('杭州市'); expect(query.get('user_time_type')).toBe('visit'); expect(query.get('user_time')).toBe('2026/10/01-2026/10/02');
          for (const pid of ['0','330000']) expect(traces.some(t => /\/user\/filter_regions$/.test(t.path) && new URLSearchParams(t.query).get('pid') === pid && t.response.dto?.status === 200)).toBe(true); }
        if (name === 'reset') { expect([...query.keys()].sort()).toEqual(['field_key','limit','page']); expect(data.inputs.every((input: Row) => !['用户搜索'].includes(input.label) || input.value === '')).toBe(true); }
        if (name === 'source-draft-isolation' || name === 'page2' || name === 'refreshed') { expect(query.get('user_type')).toBe('h5'); expect(query.has('nickname')).toBe(false); expect(dto.count).toBe(32); if (name === 'source-draft-isolation') { expect(dto.page).toBe(1); expect(data.inputs.some((input: Row) => input.value === '未提交草稿')).toBe(true); } else { expect(dto.page).toBe(2); expect(dto.list.map((row: Row) => row.uid)).toEqual(Array.from({ length: 15 }, (_, i) => 1017 - i)); } }
        if (name === 'refreshed') expect(bound!.stage).toBe('refreshed');
      }
      if (['tags-page1','tags-crosspage','groups-page2','levels-page2'].includes(name)) {
        const kind = name.startsWith('tags') ? 'labels' : name.startsWith('groups') ? 'groups' : 'levels';
        const trace = [...traces].reverse().find(t => t.actor === actor && !t.probe && /\/user\/filter_options$/.test(t.path) && new URLSearchParams(t.query).get('kind') === kind && t.response.dto?.status === 200);
        expect(trace).toBeDefined(); expect(trace!.completed_at_ms).toBeLessThanOrEqual(data.captured_at_ms); const dto = trace!.response.dto.data; expect(dto.count).toBe(32); expect(dto.limit).toBe(15); expect(data.dialog).toBeDefined(); expect(data.dialog.ids).toEqual(dto.list.map((row: Row) => row.id)); expect(data.dialog.page).toBe(name === 'tags-page1' ? 1 : 2); expect(dto.page).toBe(data.dialog.page); expect(dto.list.map((row: Row) => row.id)).toEqual(Array.from({ length: 15 }, (_, i) => (name === 'tags-page1' ? 7001 : 7016) + i));
        if (name === 'tags-page1') expect(data.dialog.selected_ids).toEqual([7001]);
        if (name === 'tags-crosspage') expect(data.dialog.selected_ids).toEqual([7001,7016]);
        if (name === 'levels-page2') { const probe = [...traces].reverse().find(t => t.stage === name && t.probe && /\/user\/filter_options$/.test(t.path)); expect(probe?.response.dto?.data).toMatchObject({ selected: [{ id: 7016, name: '筛选等级16' }], missing_ids: [7999] }); expect(traces.some(t => t.stage === name && t.probe && t.path === '/api/admin/user/list' && t.response.dto?.data?.list?.[0]?.uid === 1001)).toBe(true); }
        data.option_binding = { trace_index: traces.indexOf(trace!), body_sha256: trace!.response.sha256, kind, page: dto.page, count: dto.count, ids: dto.list.map((row: Row) => row.id) };
      }
      expect(await snapshot()).toEqual(expected); expect(resources()).toEqual(initialResources);
      evidence.push({ name, ...data, linked_list: linked, traceCount: traces.length, snapshot: remember(expected!) }); await persist();
      if (name === 'finished') { expect(setups).toHaveLength(1); expect(setups[0].kind).toBe('owned-role-revoke'); expect(traces.every(t => t.method === 'GET')).toBe(true); expect(external).not.toHaveBeenCalled(); expect(await sources()).toEqual(sourceBefore); expect(await artifacts()).toEqual(buildBefore); finish(); }
    }
    const shell = `<!doctype html><html lang="zh"><meta charset="utf-8"><link rel="icon" href="data:,"><title>真实后台用户目录 PG16</title><style>body{margin:8px;font:14px sans-serif;background:#f6f7f8}h1{font-size:18px}button{margin:3px;padding:6px}iframe{display:block;width:1440px;height:1100px;background:white;border:1px solid #ddd}pre{white-space:pre-wrap;max-height:70px;overflow:auto}</style><h1>后台用户目录 · 真实 Worker / PostgreSQL 16</h1><p>全业务读取真实接口；仅本机可销毁种子、QA会话装载及一次明示角色撤权。无业务写/登录POST/外网；本夹具不证明不同SQL LOGIN ACL。</p><button data-actor="9602">装载管理账号</button><button data-actor="9601">装载只读账号</button><button data-actor="9603">装载新账号</button><button id="revoke">真实撤销只读角色</button><button id="guest">退出为访客</button><button id="probe">真实目录缺失/别名核对</button><button data-width="600">窄屏600</button><button data-width="1440">桌面1440</button>${plans.map(name => '<button data-stage="' + name + '">验收 ' + name + '</button>').join('')}<pre id="result"></pre><iframe title="实际后台用户目录"></iframe><script>
const frame=document.querySelector('iframe'),result=document.querySelector('#result');let activeToken='',errors=[];
frame.onload=()=>{const w=frame.contentWindow;w.addEventListener('error',e=>errors.push({kind:'error',message:e.message}));w.addEventListener('unhandledrejection',e=>errors.push({kind:'unhandledrejection',message:String(e.reason)}))};
async function ctl(path){const response=await fetch(${JSON.stringify(control)}+path,{method:'POST'});if(!response.ok)throw Error(await response.text());return response.json()}
async function probe(path,token=activeToken){const response=await fetch(path,{headers:{'X-Owned-Directory-Probe':'1',...(token?{'Authori-zation':'Bearer '+token}:{})}});return response.json()}
for(const button of document.querySelectorAll('[data-actor]'))button.onclick=async()=>{try{const data=await ctl('/session?actor='+button.dataset.actor);activeToken=data.token;localStorage.setItem('admin_token',data.token);localStorage.setItem('admin_session',JSON.stringify(data.session));errors=[];frame.src='/user?fresh='+Date.now();result.textContent='已装载真实JWT账号 '+button.dataset.actor}catch(error){result.textContent=String(error)}};
document.querySelector('#revoke').onclick=async()=>{try{const data=await ctl('/revoke');localStorage.setItem('admin_session',JSON.stringify(data.session));result.textContent=JSON.stringify(await probe('/adminapi/user/list'))}catch(error){result.textContent=String(error)}};
document.querySelector('#guest').onclick=async()=>{try{await ctl('/guest');activeToken='';localStorage.removeItem('admin_token');localStorage.removeItem('admin_session');errors=[];frame.src='/user?fresh='+Date.now();result.textContent=JSON.stringify(await probe('/adminapi/user/list',''))}catch(error){result.textContent=String(error)}};
document.querySelector('#probe').onclick=async()=>{try{result.textContent=JSON.stringify({missing:await probe('/adminapi/user/filter_options?kind=levels&page=2&limit=15&selected_ids=7016,7999'),alias:await probe('/api/admin/user/list?uid=1001')})}catch(error){result.textContent=String(error)}};
for(const button of document.querySelectorAll('[data-width]'))button.onclick=()=>{frame.style.width=button.dataset.width+'px'};
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{button.disabled=true;try{const d=frame.contentDocument,w=frame.contentWindow,visible=n=>!!n&&n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0&&w.getComputedStyle(n).display!=='none',page=n=>Number(n?.querySelector('.el-pager .is-active')?.textContent||1),user=d.querySelector('.user-list'),pager=user?.querySelector('.el-pagination'),dialog=[...d.querySelectorAll('.el-dialog')].find(visible),rows=[...(user?.querySelectorAll('.el-table__body tbody tr.el-table__row')||[])].filter(visible).map(n=>({uid:Number(n.querySelector('td .cell')?.textContent),text:n.innerText}));
const data={captured_at_ms:Date.now(),href:w.location.href,frameWidth:frame.clientWidth,viewportWidth:w.innerWidth,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,text:d.body.innerText,rows,page:page(pager),total_text:pager?.querySelector('.el-pagination__total')?.textContent||'',money_buttons:[...(user?.querySelectorAll('.el-table__body button')||[])].filter(n=>visible(n)&&n.textContent.includes('调整余额')).length,labels:[...(user?.querySelectorAll('.el-form-item__label')||[])].filter(visible).map(n=>n.textContent),inputs:[...(user?.querySelectorAll('.user-filters input')||[])].map(n=>({label:n.getAttribute('aria-label')||'',placeholder:n.placeholder,value:n.value})),errors,
...(dialog?{dialog:{title:dialog.querySelector('.el-dialog__title')?.textContent,page:page(dialog.querySelector('.el-pagination')),ids:[...dialog.querySelectorAll('.option-row')].map(n=>Number(n.querySelector('small')?.textContent?.replace('#',''))),selected_ids:[...dialog.querySelectorAll('.chosen .el-tag')].map(n=>Number(/（(\\d+)）/.exec(n.textContent)?.[1]))}}:{})};
const response=await fetch(${JSON.stringify(control)}+'/phase/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});result.textContent=await response.text();}catch(error){result.textContent=String(error)}finally{button.disabled=false}};
</script></html>`;
    // No hidden-state capture endpoint: only the concrete DOM JSON sent by the
    // QA button is accepted. Session controls never modify frontend internals.
    const host = createServer((req, res) => { void (async () => {
      expect(req.socket.remoteAddress).toBe('127.0.0.1'); expect(req.headers.host).toBe('127.0.0.1:40833');
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname.startsWith(control)) {
        expect(req.method).toBe('POST');
        if (url.pathname === control + '/session') { const id = Number(url.searchParams.get('actor')); expect(tokens.has(id)).toBe(true); actor = id; controls.push({ kind: 'load-account', actor, at_ms: Date.now() }); json(res, { token: tokens.get(id), session: session(id, revoked && id === 9601) }); return; }
        if (url.pathname === control + '/guest') { expect(stage()).toBe('guest'); actor = 0; controls.push({ kind: 'guest', at_ms: Date.now() }); json(res, { ok: true }); return; }
        if (url.pathname === control + '/revoke') { await serial(async () => {
          expect(stage()).toBe('revoked'); expect(actor).toBe(9601); expect(revoked).toBe(false); const before = await snapshot(), beforeResources = resources(); expect(before).toEqual(expected);
          await f.db.update(systemRole).set({ rules: '' }).where(eq(systemRole.id, 9601)); const after = await snapshot(), want = structuredClone(before); want.system_role = want.system_role.map(row => row.id === 9601 ? { ...row, rules: '' } : row); expect(after).toEqual(sortedDiyState(want)); expect(resources()).toEqual(beforeResources); expected = after; revoked = true;
          setups.push({ kind: 'owned-role-revoke', role_id: 9601, before: remember(before), after: remember(after), resources_before: beforeResources, resources_after: resources(), at_ms: Date.now() }); await persist(); json(res, { session: session(9601, true) });
        }); return; }
        if (url.pathname.startsWith(control + '/phase/')) { const data = JSON.parse((await body(req)).toString()); await serial(async () => { const phaseName = url.pathname.slice((control + '/phase/').length); await capture(phaseName, data); json(res, { accepted: true, name: phaseName, complete: evidence.length === plans.length, next: stage(), actual_reads: traces.length }); }); return; }
        // Deliberately no generic mutation/control passthrough.
        throw Error('Unknown owned directory control');
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/adminapi/')) { await api(req, res, url); return; }
      expect(req.method).toBe('GET');
      if (url.pathname === '/') { send(res, shell); return; }
      if (url.pathname === '/favicon.ico') { send(res, '', 204, 'image/x-icon'); return; }
      const decoded = decodeURIComponent(url.pathname), target = ['/user','/login'].includes(decoded) ? resolve(dist, 'index.html') : resolve(dist, '.' + decoded);
      expect(target === resolve(dist, 'index.html') || target.startsWith(dist + sep)).toBe(true); let raw = await readFile(target);
      if (target === resolve(dist, 'index.html')) raw = Buffer.from(raw.toString().replace('<head>', '<head><link rel="icon" href="data:,">'));
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
      staticPaths.push({ path: decoded, file: target.slice(dist.length + 1), sha256: hash(raw), status: 200 }); send(res, raw, 200, types[extname(target)] ?? 'application/octet-stream');
    })().catch(error => { failure ??= error; controls.push({ kind: 'server-error', method: req.method, url: req.url, stage: stage(), error: String(error) }); void persist().then(() => fail(error), saveError => fail(saveError)); if (!res.headersSent) send(res, String(error), 500, 'text/plain'); else res.end(); }); });
    server = host; host.on('upgrade', (_req, socket) => { const error = Error('User-only directory roles must not open notification/provider sockets'); failure ??= error; fail(error); socket.destroy(); });
    timer = setTimeout(() => fail(Error('Admin directory Browser timed out')), 55 * 60_000);
    await new Promise<void>((yes, no) => { host.once('error', no); host.listen(40833, '127.0.0.1', yes); });
    await writeFile(prefix + 'ready.json', JSON.stringify({ origin, plans, prefix, control, table_count: tableNames.length, sequence_count: sequenceNames.length, source_count: sourceBefore.length, build_count: buildBefore.length, seed: { visible_user_count: 42, deleted_users: [1043,1044], selected_tags: [7001,7016], selected_group: 7016, selected_level: 7016, cohort: [1002,1001], geo_date_cohort: [1001], source_h5_count: 32 }, boundary: 'All business/chrome API replies actual Worker; fixture connection factories adapted, no separate LOGIN ACL or login form proof. Probe-tagged actual HTTP reads distinguish QA missing-ID/alias checks from Vue list reads.' }) + '\n', { mode: 0o600 });
    console.log('ADMIN_USER_FILTERS_BROWSER_READY ' + origin); await completion; await queue;
    await writeFile(prefix + 'evidence.json', JSON.stringify({ status: 'passed', plans, evidence, traces, staticPaths, controls, setups, snapshots_by_sha256: snapshots, fixture_setup: { before: setupBefore, after: snapshots[traces[0]?.before ?? digest(expected)] }, final: expected, resources_before: initialResources, resources_after: resources(), sourceBefore, sourceAfter: await sources(), buildBefore, buildAfter: await artifacts() }, null, 2) + '\n', { mode: 0o600 });
  } catch (error) { failure ??= error; await writeFile(prefix + 'failed.json', JSON.stringify({ status: 'failed', error: String(error), stack: error instanceof Error ? error.stack : null, failedDispatch, evidence, traces, staticPaths, controls, setups, snapshots_by_sha256: snapshots, latest_expected: expected, latest_actual: snapshot ? await snapshot().catch(() => null) : null }, null, 2) + '\n', { mode: 0o600 }); throw error; }
  finally { clearTimeout(timer); let cleanupFailure: unknown, fixtureClosed = false;
    try { if (server) { server.closeAllConnections(); if (server.listening) await new Promise<void>((yes, no) => server!.close(error => error ? no(error) : yes())); } } catch (error) { cleanupFailure = error; }
    try { await f.close(); fixtureClosed = true; } catch (error) { cleanupFailure ??= error; }
    wiring.container = undefined; vi.restoreAllMocks(); await writeFile(prefix + 'cleanup.json', JSON.stringify({ server_created: !!server, server_closed: !server?.listening, fixture_closed: fixtureClosed, failure: failure ? String(failure) : null, cleanup_failure: cleanupFailure ? String(cleanupFailure) : null }) + '\n', { mode: 0o600 }); if (cleanupFailure) throw cleanupFailure;
  }
}, 57 * 60_000);
