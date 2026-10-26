/** Actual built Admin + registered Worker/JWT/SQL on owned PG16. Only DI selects
 * this fixture database. QA session loading and one role-revoke setup are not
 * login-form or independent PostgreSQL LOGIN ACL proofs. CUA is driven by the
 * coordinator; this host never launches a browser or synthesizes business DTOs. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { eq, sql, SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { memberShip, memberCardBatch, memberCard, otherOrder, systemAdmin, systemRole, systemConfig } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { diyFooterBrowserFixture } from '../helpers/diyFooterBrowserFixture';
import { sortedDiyState, stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from '../helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned member-package database'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned member-package Admin SQL'); return { container: wiring.container, close: async () => {} }; },
}));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
async function files(dir: string): Promise<string[]> { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)]))).flat().sort(); }
async function body(req: IncomingMessage, consumed?: (size: number) => void) { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { const part = Buffer.from(chunk); size += part.length; consumed?.(size); expect(size).toBeLessThanOrEqual(262144); chunks.push(part); } return Buffer.concat(chunks); }
function abortedEmptyGet(req: IncomingMessage, error: unknown, consumed: number) {
  const lengths = req.rawHeaders.flatMap((name, i) => i % 2 === 0 && name.toLowerCase() === 'content-length' ? [req.rawHeaders[i + 1]] : []);
  const transfer = req.rawHeaders.some((name, i) => i % 2 === 0 && name.toLowerCase() === 'transfer-encoding');
  return req.aborted === true && req.method === 'GET' && consumed === 0 && lengths.length <= 1 && lengths.every(value => value === '0') && !transfer
    && error instanceof Error && error.message === 'aborted' && 'code' in error && error.code === 'ECONNRESET';
}
const plans = ['initial','page7','refreshed-page7','page1','disabled','refreshed-disabled','reopened-disabled','enabled','reader','revoked','fresh-account','guest','restored','mobile','desktop','finished'];
it('actual Admin member packages retain stopped plans and paginate/reactivate through registered Worker routes', async () => {
  const f = await diyFooterBrowserFixture({ namespace: 'public' });
  const prefix = '/tmp/cinashop-admin-member-packages-browser-', repository = resolve(import.meta.dirname, '../../..'), dist = resolve(repository, 'view/admin-ts/dist');
  const origin = 'http://127.0.0.1:40841', control = '/__member_packages/' + randomUUID();
  let server: ReturnType<typeof createServer> | undefined, timer: ReturnType<typeof setTimeout> | undefined, failure: unknown;
  const traces: Row[] = [], evidence: Row[] = [], staticPaths: Row[] = [], controls: Row[] = [], setups: Row[] = [], snapshots: Record<string, DiyStateSnapshot> = {};
  let failedDispatch: Row | undefined, expected: DiyStateSnapshot | undefined, snapshot!: () => Promise<DiyStateSnapshot>;
  try {
    const additionalTables: string[] = [], dialect = new PgDialect();
    for (const table of [memberShip, memberCardBatch, memberCard, otherOrder]) {
      const definition = getTableConfig(table), present = await f.db.execute(sql`SELECT to_regclass(${definition.name}) AS relation`);
      if (present[0]?.relation) continue;
      const columns = definition.columns.map(column => { const initial = column.default, initialSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initialSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`; });
      await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`); additionalTables.push(definition.name);
    }
    const tableNames = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
    const sequenceNames = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
    snapshot = async () => { const state: DiyStateSnapshot = {};
      for (const row of await f.db.execute<{ name: string; rows: Row[] }>(sql.join(tableNames.map(name => sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `))) state[row.name] = row.rows;
      state.__sequences = await f.db.execute(sql.join(sequenceNames.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `)); return sortedDiyState(state); };
    const remember = (value: DiyStateSnapshot) => { const id = digest(value); snapshots[id] ??= structuredClone(value); return id; };
    const setupBefore = await snapshot();
    await f.db.delete(memberShip);
    await f.db.insert(memberShip).values(Array.from({ length: 125 }, (_, index) => ({ id: 7001 + index,
      type: ['month','quarter','year','ever','free'][index % 5], title: '原生套餐 ' + String(index + 1).padStart(3, '0'),
      vipDay: index % 5 === 3 ? -1 : 30 + index, price: index % 5 === 4 ? '0.00' : '29.00', prePrice: index % 5 === 4 ? '0.00' : '19.00',
      isLabel: index === 124 ? 1 : 0, sort: 0, isDel: index % 9 === 0 ? 1 : 0, addTime: 1_790_000_000 + index })));
    const password = 'owned-member-packages-browser-password';
    await f.db.insert(systemRole).values([{ id: 9601, roleName: 'Member packages reader', rules: 'paid_membership.view', status: 1 },
      { id: 9602, roleName: 'Member packages manager', rules: 'paid_membership.manage', status: 1 }, { id: 9603, roleName: 'Member packages fresh manager', rules: 'paid_membership.manage', status: 1 }]);
    await f.db.insert(systemAdmin).values([9601,9602,9603].map(id => ({ id, account: 'pkg-admin-' + id, pwd: password, realName: 'pkg-admin-' + id, level: 1, roles: String(id), adminType: 1, relationId: 0, status: 1 })));
    for (const key of ['site_url','site_logo','site_logo_square','login_logo','ico_path','admin_login_slide']) await f.db.update(systemConfig).set({ value: '""' }).where(eq(systemConfig.menuName, key));
    f.cache.clear(); wiring.container = f.container;
    const tokens = new Map<number, string>(); for (const id of [9601,9602,9603]) tokens.set(id, (await createToken(id, 'admin', md5(password), f.env.APP_KEY)).token);
    const session = (id: number, denied = false) => ({ userInfo: { id, account: 'pkg-admin-' + id, head_pic: '', real_name: 'pkg-admin-' + id, level: 1, roles: String(id) },
      menus: [{ id: 1, pid: 0, path: '/member', name: '付费会员', icon: '', sort: 1, type: 1, children: [] }], uniqueAuth: denied ? [] : id === 9601 ? ['paid_membership.view'] : ['paid_membership.manage','paid_membership.view'] });
    const app = createApp(), resources = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length,
      objects: digest([...f.objects].map(([key, value]) => ({ key, type: value.type, bytes: [...value.bytes] }))), queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length });
    const initialResources = resources(); expected = await snapshot(); const baseline = structuredClone(expected); remember(setupBefore); remember(expected);
    const sources = async () => { const paths = [...(await Promise.all(['workers-ts/src','workers-ts/test/helpers','view/admin-ts/src','view/admin-ts/public','view/common'].map(path => files(resolve(repository, path))))).flat(),
      ...['workers-ts/test/browser/admin-member-packages.acceptance.ts','workers-ts/vitest.admin-member-packages-browser.config.ts','workers-ts/test/admin-member-packages-postgres.test.ts','workers-ts/scripts/run-local-finance-postgres.mjs','workers-ts/package.json','workers-ts/package-lock.json','view/admin-ts/package.json','view/admin-ts/package-lock.json'].map(path => resolve(repository, path))];
      return Promise.all([...new Set(paths)].sort().map(async path => { const bytes = await readFile(path); return { path: path.slice(repository.length + 1), bytes: bytes.length, sha256: hash(bytes) }; })); };
    const artifacts = async () => Promise.all((await files(dist)).map(async path => { const bytes = await readFile(path); return { path: path.slice(dist.length + 1), bytes: bytes.length, sha256: hash(bytes) }; }));
    const sourceBefore = await sources(), buildBefore = await artifacts(); expect(buildBefore.length).toBeGreaterThan(100);
    const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Member-package Browser forbids external provider I/O'));
    const stage = () => plans[evidence.length]; let queue = Promise.resolve(), pending = 0, actor = 9602, revoked = false, businessWrites = 0;
    const serial = <T>(work: () => Promise<T>) => { const next = queue.then(work); queue = next.then(() => {}, () => {}); return next; };
    let finish!: () => void, fail!: (error: Error) => void; const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; }); completion.catch(() => {});
    const persist = async () => writeFile(prefix + 'progress.json', JSON.stringify({ status: 'running', evidence, traces, staticPaths, controls, setups, snapshots_by_sha256: snapshots, businessWrites, failedDispatch }, null, 2) + '\n', { mode: 0o600 });
    const send = (res: ServerResponse, bytes: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'" }); res.end(bytes); };
    const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value), 200, 'application/json');
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      pending++; try { await serial(async () => {
        const started = Date.now(), method = req.method ?? 'GET', before = await snapshot(), beforeResources = resources(); expect(before).toEqual(expected);
        const allowed = ['/adminapi/new_push','/api/site_config','/api/get_script','/adminapi/member/ship','/adminapi/member_batch/index','/adminapi/member/record','/adminapi/member_ship/set_ship_status'];
        expect(allowed.includes(url.pathname) || /^\/api\/assets\/[1-9]\d*$/.test(url.pathname)).toBe(true);
        const headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
        const token = (headers.get('authori-zation') ?? headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''), actualActor = [...tokens].find(([, value]) => value === token)?.[0] ?? 0;
        const probe = headers.get('x-owned-member-packages-probe') === '1'; let consumed = 0, bytes: Buffer;
        try { bytes = await body(req, size => { consumed = size; }); }
        catch (error) {
          if (!abortedEmptyGet(req, error, consumed)) throw error;
          const after = await snapshot(), afterResources = resources();
          controls.push({ kind: 'cancelled-before-dispatch', path: url.pathname, query: url.search, method, issued_actor_hint: actualActor, token_match: actualActor !== 0, worker_authenticated: false, probe, stage: stage(),
            aborted: req.aborted, dispatched: false, nonproof: true, request: { bytes_received: consumed, content_length: req.headers['content-length'] ?? null, transfer_encoding: req.headers['transfer-encoding'] ?? null,
              framing_headers: req.rawHeaders.flatMap((name, i) => i % 2 === 0 && ['content-length','transfer-encoding'].includes(name.toLowerCase()) ? [{ name, value: req.rawHeaders[i + 1] }] : []) },
            error: { name: (error as Error).name, message: (error as Error).message, code: 'ECONNRESET' }, before: remember(before), after: remember(after), resources_before: beforeResources, resources_after: afterResources, started_at_ms: started, completed_at_ms: Date.now() });
          await persist(); expect(after).toEqual(before); expect(afterResources).toEqual(beforeResources); expect(afterResources).toEqual(initialResources); return;
        }
        failedDispatch = { phase: 'before-dispatch', path: url.pathname, query: url.search, method, actor: actualActor, probe, stage: stage(), request: { bytes: bytes.length, body: bytes.toString(), sha256: hash(bytes) }, before: remember(before), resources_before: beforeResources }; await persist();
        const writing = url.pathname === '/adminapi/member_ship/set_ship_status';
        if (writing) { expect(method).toBe('POST'); expect(probe).toBe(false); expect(actualActor).toBe(9602); expect(url.search).toBe('');
          expect(stage()).toBe(businessWrites === 0 ? 'disabled' : 'enabled'); expect(businessWrites).toBeLessThan(2);
          expect(JSON.parse(bytes.toString())).toEqual({ id: 7002, is_del: businessWrites === 0 ? 1 : 0 });
        } else { expect(method).toBe('GET'); expect(bytes.length).toBe(0); }
        const waits: Promise<unknown>[] = [];
        const response = await app.fetch(new Request(origin + url.pathname + url.search, { method, headers, ...(writing ? { body: bytes } : {}) }), f.env,
          { waitUntil: (work: Promise<unknown>) => waits.push(work), passThroughOnException() {} } as unknown as ExecutionContext); await Promise.all(waits);
        const raw = Buffer.from(await response.arrayBuffer()), type = response.headers.get('Content-Type') ?? '', textBody = /(?:json|javascript|text\/)/.test(type);
        failedDispatch = { ...failedDispatch, phase: 'dispatched', response: { http_status: response.status, content_type: type, bytes: raw.length, body_encoding: textBody ? 'utf8' : 'base64', body: textBody ? raw.toString() : raw.toString('base64'), sha256: hash(raw), cache_control: response.headers.get('Cache-Control') } }; await persist();
        const after = await snapshot(); failedDispatch.after = remember(after); failedDispatch.resources_after = resources(); await persist();
        const payload: Row | undefined = type.includes('application/json') ? JSON.parse(raw.toString()) : undefined; failedDispatch.response.dto = payload; await persist();
        expect(response.status).toBe(200); expect(resources()).toEqual(beforeResources); expect(resources()).toEqual(initialResources);
        if (writing) {
          const flag = businessWrites === 0 ? 1 : 0, want = structuredClone(before); expect(want.member_ship.filter(row => row.id === 7002)).toHaveLength(1);
          expect(want.member_ship.find(row => row.id === 7002)?.is_del).toBe(1 - flag);
          want.member_ship = want.member_ship.map(row => row.id === 7002 ? { ...row, is_del: flag } : row);
          expect(payload).toEqual({ status: 200, msg: '修改成功', data: { id: 7002 } }); expect(after).toEqual(sortedDiyState(want)); expected = after; businessWrites++;
          failedDispatch.mutation = { kind: 'member-plan-status', id: 7002, field: 'is_del', before: 1 - flag, after: flag };
        } else {
          expect(after).toEqual(before); failedDispatch.mutation = { kind: 'read' };
          const catalogue = url.pathname === '/adminapi/member/ship';
          if (catalogue && actualActor === 0) { expect(stage()).toBe('guest'); expect(probe).toBe(true); expect(payload?.status).toBe(410000); }
          else if (catalogue && actualActor === 9601 && revoked) { expect(stage()).toBe('revoked'); expect(probe).toBe(true); expect(payload?.status).toBe(400011); }
          else expect(payload?.status ?? 200).toBe(200);
          if (catalogue && payload?.status === 200) {
            const page = Number(url.searchParams.get('page') ?? 1), limit = Number(url.searchParams.get('limit') ?? 50), all = url.searchParams.get('include_deleted') === '1';
            expect([...url.searchParams.keys()].every(key => ['page','limit','include_deleted'].includes(key))).toBe(true);
            if (all) { expect(limit).toBe(20); expect(page).toBeGreaterThanOrEqual(1); expect(page).toBeLessThanOrEqual(7); }
            else { expect(limit).toBe(100); expect([1,2]).toContain(page); }
            const rows = before.member_ship.filter(row => all || row.is_del === 0).sort((a, b) => Number(b.sort) - Number(a.sort) || Number(a.id) - Number(b.id));
            const wanted = rows.slice((page - 1) * limit, page * limit); expect(payload.data.count).toBe(rows.length); expect(payload.data.list.map((row: Row) => row.id)).toEqual(wanted.map(row => row.id));
            for (const [i, row] of wanted.entries()) expect(payload.data.list[i]).toEqual({ id: row.id, type: row.type, title: row.title, vip_day: row.vip_day, price: Number(row.price).toFixed(2), pre_price: Number(row.pre_price).toFixed(2), is_label: row.is_label, sort: row.sort, is_del: row.is_del, add_time: row.add_time });
          }
          if (url.pathname.startsWith('/adminapi/')) expect(response.headers.get('Cache-Control')).toContain('no-store');
          if (/^\/api\/assets\//.test(url.pathname)) { expect([...url.searchParams.keys()].sort()).toEqual(['expires','signature']); expect(Number(url.searchParams.get('expires')) * 1000).toBeGreaterThan(Date.now()); expect(url.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]{43}$/); }
        }
        traces.push({ ...failedDispatch, started_at_ms: started, completed_at_ms: Date.now(), synthetic: false }); failedDispatch = undefined; await persist();
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      }); } finally { pending--; }
    }
    async function capture(name: string, data: Row) {
      expect(name).toBe(stage()); expect(pending).toBe(0);
      const wantedActor = name === 'guest' ? 0 : ['reader','revoked'].includes(name) ? 9601 : ['fresh-account','restored','mobile','desktop','finished'].includes(name) ? 9603 : 9602;
      expect(actor).toBe(wantedActor); expect(data.errors).toEqual([]); expect(data.overlay).toBe(false); expect(data.captured_at_ms).toBeGreaterThan(Number(evidence.at(-1)?.captured_at_ms ?? 0));
      expect(new URL(data.href).origin).toBe(origin); expect(data.scrollWidth).toBeLessThanOrEqual(data.clientWidth);
      const width = name === 'mobile' ? 600 : 1440; expect(data.frameWidth).toBe(width); expect(data.viewportWidth).toBe(width); expect(data.clientWidth).toBeLessThanOrEqual(width); expect(width - data.clientWidth).toBeLessThanOrEqual(20);
      const writes = ['initial','page7','refreshed-page7','page1'].includes(name) ? 0 : ['disabled','refreshed-disabled','reopened-disabled'].includes(name) ? 1 : 2; expect(businessWrites).toBe(writes);
      let linked: Row | undefined;
      if (['guest','revoked'].includes(name)) {
        expect(data.rows).toEqual([]); expect(data.table_present).toBe(false); expect(data.pager_present).toBe(false);
        if (name === 'guest') { expect(new URL(data.href).pathname).toBe('/login'); expect(data.login).toEqual({ account: true, password: true, login: true }); }
        else { expect(new URL(data.href).pathname).toBe('/member'); expect(data.text).toContain('暂无查看会员套餐权限'); expect(data.new_button).toEqual({ visible: true, disabled: true }); }
        const probe = traces.find(trace => trace.stage === name && trace.probe && trace.actor === actor && trace.path === '/adminapi/member/ship');
        expect(probe).toBeDefined(); expect(probe!.completed_at_ms).toBeLessThanOrEqual(data.captured_at_ms); expect(probe!.response.dto?.status).toBe(name === 'guest' ? 410000 : 400011);
        linked = { probe: true, trace_index: traces.indexOf(probe!), sha256: probe!.response.sha256, status: probe!.response.dto.status };
      } else {
        expect(new URL(data.href).pathname).toBe('/member'); expect(data.text).toContain('pkg-admin-' + actor); expect(data.table_present).toBe(true); expect(data.pager_present).toBe(true);
        const page = ['page7','refreshed-page7'].includes(name) ? 7 : 1;
        const bound = [...traces].reverse().find(trace => trace.actor === actor && !trace.probe && trace.path === '/adminapi/member/ship' && new URLSearchParams(trace.query).get('include_deleted') === '1' && Number(new URLSearchParams(trace.query).get('page')) === page && trace.response.dto?.status === 200);
        expect(bound).toBeDefined(); expect(bound!.completed_at_ms).toBeLessThanOrEqual(data.captured_at_ms);
        if (!['mobile','desktop','finished'].includes(name)) expect(bound!.stage).toBe(name);
        expect(bound!.after).toBe(remember(expected!)); const dto = bound!.response.dto.data;
        const ids = Array.from({ length: page === 7 ? 5 : 20 }, (_, i) => (page === 7 ? 7121 : 7001) + i);
        expect(dto.count).toBe(125); expect(dto.list.map((row: Row) => row.id)).toEqual(ids);
        expect(data.rows.map((row: Row) => row.id)).toEqual(ids); expect(data.page).toBe(page); expect(data.total_text).toMatch(/(?:^|\D)125(?:\D|$)/); expect(data.page_numbers).toContain(7);
        expect(data.new_button).toEqual({ visible: true, disabled: name === 'reader' });
        for (const [i, row] of dto.list.entries()) {
          const actual = data.rows[i]; expect(actual.text).toContain(row.title); expect(actual.text).toContain(row.pre_price); expect(actual.text).toContain(row.price);
          expect(actual.switch.checked).toBe(row.is_del === 0); expect(actual.switch.disabled).toBe(name === 'reader'); expect(actual.switch.label).toBe(row.title + '：' + (row.is_del === 0 ? '停用' : '启用'));
          expect(actual.edit).toEqual({ visible: true, disabled: name === 'reader' });
        }
        if (page === 1) expect(data.rows.find((row: Row) => row.id === 7002)?.switch.checked).toBe(writes !== 1);
        linked = { trace_index: traces.indexOf(bound!), body_sha256: bound!.response.sha256, query: bound!.query, actor, count: dto.count, page, limit: 20, ids, database: bound!.after };
      }
      expect(await snapshot()).toEqual(expected); expect(resources()).toEqual(initialResources);
      evidence.push({ name, ...data, actor, linked_list: linked, business_writes: businessWrites, traceCount: traces.length, snapshot: remember(expected!) }); await persist();
      if (name === 'finished') {
        expect(businessWrites).toBe(2); expect(setups).toHaveLength(1); expect(setups[0].kind).toBe('owned-role-revoke');
        const want = structuredClone(baseline); want.system_role = want.system_role.map(row => row.id === 9601 ? { ...row, rules: '' } : row); expect(expected).toEqual(sortedDiyState(want));
        expect(traces.filter(trace => trace.method === 'POST')).toHaveLength(2); expect(traces.filter(trace => trace.method !== 'GET' && trace.method !== 'POST')).toEqual([]);
        expect(controls.filter(value => value.kind === 'server-error')).toEqual([]); expect(external).not.toHaveBeenCalled(); expect(await sources()).toEqual(sourceBefore); expect(await artifacts()).toEqual(buildBefore); finish();
      }
    }
    const shell = String.raw`<!doctype html><html lang="zh"><meta charset="utf-8"><link rel="icon" href="data:,"><title>真实后台会员套餐 PG16</title><style>body{margin:8px;font:14px sans-serif;background:#f6f7f8}h1{font-size:18px}button{margin:3px;padding:6px}iframe{display:block;width:1440px;height:1100px;border:0;background:white}pre{white-space:pre-wrap;max-height:100px;overflow:auto}</style><h1>会员套餐 · 真实 Worker / PostgreSQL16</h1><p>仅验套餐列表/分页/停用重读/启用。实际2次POST只改套餐7002状态；QA装载JWT、一次撤销只读角色。无登录表单/独立LOGIN ACL、权益媒体、发行/兑换/支付或其它Tab验收。先装载管理账号；页内操作请用真实控件，page7为最后一页。</p><button data-actor="9602">装载管理账号</button><button data-actor="9601">装载只读账号</button><button data-actor="9603">装载新账号</button><button id="reopen">重新打开当前套餐页</button><button id="revoke">真实撤销只读角色</button><button id="guest">退出为访客</button><button data-width="600">窄屏600</button><button data-width="1440">桌面1440</button>${plans.map(name => '<button data-stage="' + name + '">验收 ' + name + '</button>').join('')}<pre id="result"></pre><iframe title="实际后台会员套餐"></iframe><script>
let frame=document.querySelector('iframe');const result=document.querySelector('#result');let activeToken='',errors=[];
frame.onload=e=>{const w=e.currentTarget.contentWindow;if(!w)return;w.addEventListener('error',e=>errors.push({kind:'error',message:e.message}));w.addEventListener('unhandledrejection',e=>errors.push({kind:'unhandledrejection',message:String(e.reason)}))};
async function ctl(path){const response=await fetch(${JSON.stringify(control)}+path,{method:'POST'});if(!response.ok)throw Error(await response.text());return response.json()}
async function probe(){const response=await fetch('/adminapi/member/ship?page=1&limit=20&include_deleted=1',{headers:{'X-Owned-Member-Packages-Probe':'1',...(activeToken?{'Authori-zation':'Bearer '+activeToken}:{})}});return response.json()}
function open(){errors=[];const old=frame,fresh=old.cloneNode(false);fresh.removeAttribute('src');fresh.onload=old.onload;frame=fresh;old.replaceWith(fresh);frame.src='/member?fresh='+Date.now()}
for(const b of document.querySelectorAll('[data-actor]'))b.onclick=async()=>{try{const data=await ctl('/session?actor='+b.dataset.actor);activeToken=data.token;localStorage.setItem('admin_token',data.token);localStorage.setItem('admin_session',JSON.stringify(data.session));open();result.textContent='已装载真实JWT账号 '+b.dataset.actor}catch(error){result.textContent=String(error)}};
document.querySelector('#reopen').onclick=async()=>{try{await ctl('/reopen');open()}catch(error){result.textContent=String(error)}};
document.querySelector('#revoke').onclick=async()=>{try{const data=await ctl('/revoke');localStorage.setItem('admin_session',JSON.stringify(data.session));result.textContent=JSON.stringify(await probe())}catch(error){result.textContent=String(error)}};
document.querySelector('#guest').onclick=async()=>{try{await ctl('/guest');activeToken='';localStorage.removeItem('admin_token');localStorage.removeItem('admin_session');open();result.textContent=JSON.stringify(await probe())}catch(error){result.textContent=String(error)}};
for(const b of document.querySelectorAll('[data-width]'))b.onclick=()=>{frame.style.width=b.dataset.width+'px'};
for(const b of document.querySelectorAll('[data-stage]'))b.onclick=async()=>{b.disabled=true;try{const d=frame.contentDocument,w=frame.contentWindow,shown=n=>!!n&&n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0&&w.getComputedStyle(n).display!=='none',text=n=>(n?.textContent||'').trim(),table=d.querySelector('[data-membership-plan-table]'),pager=d.querySelector('[data-membership-plan-pager]'),newButton=[...d.querySelectorAll('button')].find(n=>shown(n)&&text(n)==='新增套餐'),state=n=>({visible:shown(n),disabled:!!n?.disabled||n?.getAttribute('aria-disabled')==='true'||!!n?.closest('.is-disabled')}),rows=[...(table?.querySelectorAll('tbody tr.el-table__row')||[])].filter(shown).map(n=>{const s=n.querySelector('[role="switch"]')||n.querySelector('input[type="checkbox"]'),edit=[...n.querySelectorAll('button')].find(b=>text(b)==='编辑');return{id:Number(/#\s*(\d+)/u.exec(n.innerText)?.[1]),text:n.innerText,switch:{checked:typeof s?.checked==='boolean'?s.checked:s?.getAttribute('aria-checked')==='true',disabled:!!s?.disabled||s?.getAttribute('aria-disabled')==='true'||!!s?.closest('.is-disabled'),label:s?.getAttribute('aria-label')||s?.closest('.el-switch')?.getAttribute('aria-label')||''},edit:state(edit)}});
const data={captured_at_ms:Date.now(),href:w.location.href,frameWidth:frame.clientWidth,viewportWidth:w.innerWidth,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,text:d.body.innerText,rows,table_present:shown(table),pager_present:shown(pager),page:Number(pager?.querySelector('.el-pager .is-active')?.textContent||0),page_numbers:[...(pager?.querySelectorAll('.el-pager .number')||[])].map(n=>Number(text(n))),total_text:text(pager?.querySelector('.el-pagination__total')),new_button:state(newButton),errors:[...errors],overlay:!!d.querySelector('vite-error-overlay'),login:{account:!!d.querySelector('input[placeholder="账号"]'),password:!!d.querySelector('input[placeholder="密码"]'),login:[...d.querySelectorAll('button')].some(n=>shown(n)&&text(n)==='登录')},images:[...d.querySelectorAll('img')].filter(shown).map(n=>({src:n.src,currentSrc:n.currentSrc,complete:n.complete,naturalWidth:n.naturalWidth,naturalHeight:n.naturalHeight,className:n.className}))};
const response=await fetch(${JSON.stringify(control)}+'/phase/'+b.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});result.textContent=await response.text()}catch(error){result.textContent=String(error)}finally{b.disabled=false}};
</script></html>`;
    const host = createServer((req, res) => { void (async () => {
      expect(req.socket.remoteAddress).toBe('127.0.0.1'); expect(req.headers.host).toBe('127.0.0.1:40841'); const url = new URL(req.url ?? '/', origin);
      if (url.pathname.startsWith(control)) {
        expect(req.method).toBe('POST');
        if (url.pathname === control + '/session') { expect(pending).toBe(0); const id = Number(url.searchParams.get('actor'));
          const wanted = stage() === 'initial' ? 9602 : stage() === 'reader' ? 9601 : ['fresh-account','restored'].includes(stage()) ? 9603 : -1; expect(id).toBe(wanted); expect(tokens.has(id)).toBe(true);
          actor = id; controls.push({ kind: 'qa-session', issued_actor_hint: actor, stage: stage(), at_ms: Date.now() }); json(res, { token: tokens.get(id), session: session(id, revoked && id === 9601) }); return; }
        if (url.pathname === control + '/reopen') { expect(pending).toBe(0); expect(stage()).toBe('reopened-disabled'); expect(actor).toBe(9602); controls.push({ kind: 'qa-reopen-fresh-document', actor, stage: stage(), at_ms: Date.now() }); json(res, { ok: true }); return; }
        if (url.pathname === control + '/guest') { expect(pending).toBe(0); expect(stage()).toBe('guest'); actor = 0; controls.push({ kind: 'qa-guest', stage: stage(), at_ms: Date.now() }); json(res, { ok: true }); return; }
        if (url.pathname === control + '/revoke') { await serial(async () => {
          expect(stage()).toBe('revoked'); expect(actor).toBe(9601); expect(revoked).toBe(false); const before = await snapshot(), beforeResources = resources(); expect(before).toEqual(expected);
          await f.db.update(systemRole).set({ rules: '' }).where(eq(systemRole.id, 9601)); const after = await snapshot(), want = structuredClone(before); expect(want.system_role.filter(row => row.id === 9601)).toHaveLength(1);
          want.system_role = want.system_role.map(row => row.id === 9601 ? { ...row, rules: '' } : row); expect(after).toEqual(sortedDiyState(want)); expect(resources()).toEqual(beforeResources); expected = after; revoked = true;
          setups.push({ kind: 'owned-role-revoke', role_id: 9601, before: remember(before), after: remember(after), resources_before: beforeResources, resources_after: resources(), at_ms: Date.now() }); await persist(); json(res, { session: session(9601, true) });
        }); return; }
        if (url.pathname.startsWith(control + '/phase/')) { const data = JSON.parse((await body(req)).toString()); await serial(async () => { const name = url.pathname.slice((control + '/phase/').length); await capture(name, data);
          json(res, { accepted: true, name, complete: evidence.length === plans.length, next: stage(), actual_reads: traces.filter(trace => trace.method === 'GET').length, business_writes: businessWrites, qa_setups: setups.length, cancelled_nonproof: controls.filter(value => value.kind === 'cancelled-before-dispatch').length }); }); return; }
        throw Error('Unknown owned member-package control');
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/adminapi/')) { await api(req, res, url); return; }
      expect(req.method).toBe('GET'); if (url.pathname === '/') { send(res, shell); return; } if (url.pathname === '/favicon.ico') { send(res, '', 204, 'image/x-icon'); return; }
      const decoded = decodeURIComponent(url.pathname), target = ['/member','/login'].includes(decoded) ? resolve(dist, 'index.html') : resolve(dist, '.' + decoded); expect(target.startsWith(dist + sep)).toBe(true);
      let raw = await readFile(target); const index = target === resolve(dist, 'index.html'); if (index) raw = Buffer.from(raw.toString().replace('<head>', '<head><link rel="icon" href="data:,">'));
      const types: Record<string, string> = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.gif':'image/gif','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.woff2':'font/woff2','.ttf':'font/ttf' };
      staticPaths.push({ path: decoded, query: url.search, file: target.slice(dist.length + 1), bytes: raw.length, sha256: hash(raw), status: 200, index_transform: index ? 'insert-data-favicon-after-head' : null }); send(res, raw, 200, types[extname(target)] ?? 'application/octet-stream');
    })().catch(error => { failure ??= error; controls.push({ kind: 'server-error', method: req.method, url: req.url, stage: stage(), error: String(error) }); void persist().then(() => fail(error), saveError => fail(saveError)); if (!res.headersSent && !res.destroyed) send(res, String(error), 500, 'text/plain'); else res.destroy(); }); });
    server = host; host.on('upgrade', (_req, socket) => { const error = Error('Member-package-only roles must not open provider/notification sockets'); failure ??= error; fail(error); socket.destroy(); });
    timer = setTimeout(() => fail(Error('Admin member-package Browser timed out')), 50 * 60_000); await new Promise<void>((yes, no) => { host.once('error', no); host.listen(40841, '127.0.0.1', yes); });
    await writeFile(prefix + 'ready.json', JSON.stringify({ origin, plans, prefix, control, table_count: tableNames.length, sequence_count: sequenceNames.length, additional_tables: additionalTables,
      source_count: sourceBefore.length, build_count: buildBefore.length, seed: { plan_count:125,active_count:111,disabled_count:14,ids:[7001,7125],page_size:20,last_page:7,last_ids:[7121,7122,7123,7124,7125],target:7002,actors:[9601,9602,9603] },
      boundary: 'Actual registered Worker/JWT/SQL and built Admin. Only two real status POSTs change7002.is_del0→1→0; one QA role-revoke changes9601.rules. QA JWT/session loading is not login-form or independent SQL LOGIN ACL proof. Scope is membership plans only; no rights media/card issuance/redemption/purchase/payment or other-tab acceptance.' }, null, 2) + '\n', { mode: 0o600 });
    console.log('ADMIN_MEMBER_PACKAGES_BROWSER_READY ' + origin); await completion; await queue;
    await writeFile(prefix + 'evidence.json', JSON.stringify({ status: 'passed', plans, evidence, traces, staticPaths, controls, setups, snapshots_by_sha256: snapshots, businessWrites, fixture_setup: { before: setupBefore, after: baseline }, final: expected,
      resources_before: initialResources, resources_after: resources(), sourceBefore, sourceAfter: await sources(), buildBefore, buildAfter: await artifacts() }, null, 2) + '\n', { mode: 0o600 });
  } catch (error) { failure ??= error; await writeFile(prefix + 'failed.json', JSON.stringify({ status:'failed',error:String(error),stack:error instanceof Error?error.stack:null,failedDispatch,evidence,traces,staticPaths,controls,setups,snapshots_by_sha256:snapshots,latest_expected:expected,latest_actual:snapshot?await snapshot().catch(()=>null):null }, null, 2) + '\n', { mode: 0o600 }); throw error; }
  finally { clearTimeout(timer); let cleanupFailure: unknown, fixtureClosed = false;
    try { if (server) { server.closeAllConnections(); if (server.listening) await new Promise<void>((yes, no) => server!.close(error => error ? no(error) : yes())); } } catch (error) { cleanupFailure = error; }
    try { await f.close(); fixtureClosed = true; } catch (error) { cleanupFailure ??= error; }
    wiring.container = undefined; vi.restoreAllMocks(); await writeFile(prefix + 'cleanup.json', JSON.stringify({ server_created:!!server,server_closed:!server?.listening,fixture_closed:fixtureClosed,failure:failure?String(failure):null,cleanup_failure:cleanupFailure?String(cleanupFailure):null }) + '\n', { mode: 0o600 }); if (cleanupFailure) throw cleanupFailure;
  }
}, 54 * 60_000);
