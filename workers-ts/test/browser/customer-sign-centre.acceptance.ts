/** Opt-in CUA host. Every API response comes from createApp/JWT/owned PG16.
 * QA session bootstrap, two sign_mode maintenance changes and two explicit
 * pre-dispatch/post-commit response withholding controls never fabricate responses.
 * Fixture DI is not independent production LOGIN ACL or login-form proof. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemConfig, systemSignReward, user, userBill, userSign } from '@/models/schema';
import { USER_CENTER_COMPATIBILITY_INDEX_SQL } from '@/migrations/userCenterCompatibility';
import { createToken, md5 } from '@/utils/jwt';
import { signDayWindow } from '@/utils/sign';
import { diyFooterBrowserFixture } from '../helpers/diyFooterBrowserFixture';
import { sortedDiyState, stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from '../helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned sign-centre database'); return wiring.container;
} }));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
const plans = ['initial','calendar','calendar-previous','calendar-next','history-first','history-more','history-back','reminder-on','reminder-off','signed','signed-reload','month-mode','week-mode','other-signed','unknown-ready','unknown-reconciled','retry-ready','retry-uncertain','retry-applied','guest','restored','desktop','finished'];
async function files(dir: string): Promise<string[]> { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)]))).flat().sort(); }
async function body(req: IncomingMessage, consumed?: (size: number) => void, max = 65_536) { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { const part = Buffer.from(chunk); size += part.length; consumed?.(size); expect(size).toBeLessThanOrEqual(max); chunks.push(part); } return Buffer.concat(chunks); }
function abortedEmptyGet(req: IncomingMessage, error: unknown, consumed: number) {
  const lengths = req.rawHeaders.flatMap((name, i) => i % 2 === 0 && name.toLowerCase() === 'content-length' ? [req.rawHeaders[i + 1]] : []);
  return req.aborted === true && req.method === 'GET' && consumed === 0 && lengths.length <= 1 && lengths.every(value => value === '0')
    && !req.rawHeaders.some((name, i) => i % 2 === 0 && name.toLowerCase() === 'transfer-encoding')
    && error instanceof Error && error.message === 'aborted' && 'code' in error && error.code === 'ECONNRESET';
}
it('built customer sign centre uses actual calendars, paged history, explicit writes and manual unknown-write recovery on owned PG16', async () => {
  const f = await diyFooterBrowserFixture();
  const prefix = '/tmp/cinashop-customer-sign-centre-browser-', repository = resolve(import.meta.dirname, '../../..'), dist = resolve(repository, 'view/uniapp-ts/dist/build/h5');
  const origin = 'http://127.0.0.1:40837', control = '/__sign/' + randomUUID();
  let server: ReturnType<typeof createServer> | undefined, timer: ReturnType<typeof setTimeout> | undefined, failure: unknown;
  const traces: Row[] = [], evidence: Row[] = [], staticPaths: Row[] = [], controls: Row[] = [], setups: Row[] = [], snapshots: Record<string, DiyStateSnapshot> = {};
  let failedDispatch: Row | undefined, expected: DiyStateSnapshot | undefined;
  try {
    const index = /CREATE UNIQUE INDEX IF NOT EXISTS "us_uid_shanghai_day_uq"[\s\S]*?;/.exec(USER_CENTER_COMPATIBILITY_INDEX_SQL)?.[0];
    if (!index) throw Error('Missing production Shanghai sign-day unique index'); await f.exec(index);
    const setupBefore = await f.snapshot(), now = Math.floor(Date.now() / 1000), day = signDayWindow(now), local = new Date((now + 28_800) * 1000);
    await f.db.delete(userSign); await f.db.delete(userBill); await f.db.delete(systemSignReward);
    await f.db.update(user).set({ nickname: '签到体验用户11', integral: 100, exp: '0.00', levelStatus: 0, signNum: 0, signRemind: 0, isMoneyLevel: 0, isEverLevel: 0 }).where(eq(user.uid, 11));
    await f.db.update(user).set({ nickname: '已签用户22', integral: 200, exp: '0.00', levelStatus: 0, signNum: 1, signRemind: 0, isMoneyLevel: 0, isEverLevel: 0 }).where(eq(user.uid, 22));
    const [template] = await f.db.select().from(user).where(eq(user.uid, 11));
    await f.db.insert(user).values({ ...template, uid: 33, account: 'owned-sign-recovery-33', nickname: '未知写入用户33', integral: 300, signNum: 0 });
    await f.db.insert(user).values({ ...template, uid: 44, account: 'owned-sign-retry-44', nickname: '人工重试用户44', integral: 400, signNum: 0 });
    const records: Array<typeof userSign.$inferInsert> = [];
    for (let offset = 9; offset >= 1; offset--) for (let d = 1; d <= 12; d++) records.push({ uid: 11, title: '用户11·历史签到奖励', number: 3, balance: 100, expNum: 0,
      addTime: Math.floor(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - offset, d) / 1000) - 28_800 + 3600 });
    records[records.length - 1] = { ...records[records.length - 1], title: '用户11·历史调整签到', number: -2, expNum: -1 };
    records.push({ uid: 11, title: '用户11·昨日签到奖励', number: 3, balance: 100, expNum: 0, addTime: day.yesterdayStart + 3600 },
      { uid: 22, title: '用户22·今日已签到', number: 5, balance: 200, expNum: 0, addTime: Math.min(now, day.todayStart + 3600) },
      { uid: 33, title: '用户33·历史签到奖励', number: 2, balance: 300, expNum: 0, addTime: day.yesterdayStart + 3600 });
    await f.db.insert(userSign).values(records);
    const configKeys = ['sign_status','sign_in_switch','sign_give_point','sign_in_integral','sign_mode','sign_give_exp','sign_remind','member_func_status','member_card_status'];
    await f.db.delete(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, configKeys)));
    await f.db.insert(systemConfig).values(Object.entries({ sign_in_switch: '1', sign_in_integral: '7', sign_mode: '1', sign_give_exp: '0', sign_remind: '1', member_func_status: '1', member_card_status: '0' }).map(([menuName, value]) => ({ menuName, value, isStore: 0, status: 1 })));
    await f.db.insert(systemSignReward).values([{ id: 1, type: 0, days: 7, point: 11, exp: 0 }, { id: 2, type: 1, days: 1000, point: 20, exp: 0 }]);
    f.cache.clear(); wiring.container = f.container;
    const tokens = new Map<number, string>([[11, f.token], [22, f.otherToken], [33, (await createToken(33, 'api', md5(template.pwd), f.env.APP_KEY)).token], [44, (await createToken(44, 'api', md5(template.pwd), f.env.APP_KEY)).token]]);
    const app = createApp(), resources = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length,
      objects: digest([...f.objects].map(([key, value]) => ({ key, type: value.type, bytes: [...value.bytes] }))), queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length });
    const remember = (value: DiyStateSnapshot) => { const id = digest(value); snapshots[id] ??= structuredClone(value); return id; };
    expected = await f.snapshot(); const baseline = structuredClone(expected), initialResources = resources(); remember(setupBefore); remember(expected);
    const sources = async () => {
      const dirs = ['workers-ts/src','workers-ts/test/helpers','view/uniapp-ts/src','view/uniapp-ts/scripts','view/common'];
      const paths = [...(await Promise.all(dirs.map(dir => files(resolve(repository, dir))))).flat(), ...['workers-ts/test/browser/customer-sign-centre.acceptance.ts','workers-ts/vitest.customer-sign-centre-browser.config.ts','workers-ts/test/user-sign-config-compatibility.test.ts','workers-ts/scripts/run-local-finance-postgres.mjs','workers-ts/package.json','workers-ts/package-lock.json','view/uniapp-ts/package.json','view/uniapp-ts/package-lock.json'].map(file => resolve(repository, file))];
      return Promise.all([...new Set(paths)].sort().map(async path => ({ path: path.slice(repository.length + 1), sha256: hash(await readFile(path)) })));
    };
    const artifacts = async () => Promise.all((await files(dist)).map(async path => ({ path: path.slice(dist.length + 1), sha256: hash(await readFile(path)) })));
    const sourceBefore = await sources(), buildBefore = await artifacts(); expect(buildBefore.length).toBeGreaterThan(100);
    const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Sign-centre Browser forbids external provider I/O'));
    let queue = Promise.resolve(), pending = 0, owner = 11, signWrites = 0, remindWrites = 0, dropped = 0, armed = false, preDropped = 0, preArmed = false, clientReset = false;
    const stage = () => plans[evidence.length]; const serial = <T>(work: () => Promise<T>) => { const next = queue.then(work); queue = next.then(() => {}, () => {}); return next; };
    let finish!: () => void, fail!: (error: Error) => void; const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; }); completion.catch(() => {});
    const persist = async () => writeFile(prefix + 'progress.json', JSON.stringify({ status: 'running', plans, evidence, traces, controls, setups, staticPaths, snapshots_by_sha256: snapshots, failedDispatch }, null, 2) + '\n', { mode: 0o600 });
    const send = (res: ServerResponse, bytes: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'" }); res.end(bytes); };
    const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value), 200, 'application/json');
    async function withholdUntilClientClose(req: IncomingMessage, res: ServerResponse, faultPoint: 'pre-dispatch' | 'post-commit', uid: number) {
      const started = Date.now(), before = await f.snapshot(), beforeResources = resources(); expect(before).toEqual(expected);
      expect(req.complete).toBe(true); expect(res.headersSent).toBe(false); expect(res.writableEnded).toBe(false); expect(res.destroyed).toBe(false);
      await new Promise<void>((yes, no) => {
        const cleanup = () => { clearTimeout(safety); res.off('close', closed); res.off('finish', finished); res.off('error', failed); };
        const closed = () => { cleanup(); yes(); };
        const finished = () => { cleanup(); no(Error('Withheld response unexpectedly finished')); };
        const failed = (error: Error) => { cleanup(); no(error); };
        const safety = setTimeout(() => { cleanup(); no(Error('Client did not close withheld response before 25s safety deadline')); }, 25_000);
        res.once('close', closed); res.once('finish', finished); res.once('error', failed);
      });
      const closedAt = Date.now(), after = await f.snapshot(), afterResources = resources();
      controls.push({ kind: 'withheld-client-close', fault_point: faultPoint, path: '/api/sign/integral', query: '', method: 'POST', issued_actor_hint: uid, stage: stage(),
        dispatched: faultPoint === 'post-commit', nonproof: true, request_body_complete: req.complete, headers_sent: res.headersSent, writable_ended: res.writableEnded, writable_finished: res.writableFinished,
        observed: 'client-closed-without-response', expected_client_deadline_ms: 12_000, safety_timeout_ms: 25_000, started_at_ms: started, client_closed_at_ms: closedAt, completed_at_ms: Date.now(), elapsed_ms: closedAt - started,
        before: remember(before), after: remember(after), resources_before: beforeResources, resources_after: afterResources, response_http_status: null, response_bytes: 0 });
      await persist(); expect(res.headersSent).toBe(false); expect(res.writableEnded).toBe(false); expect(res.writableFinished).toBe(false); expect(res.destroyed).toBe(true);
      expect(after).toEqual(before); expect(afterResources).toEqual(beforeResources); expect(afterResources).toEqual(initialResources);
    }
    function actor(req: IncomingMessage) { const token = String(req.headers['authori-zation'] ?? req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''); return [...tokens].find(([, value]) => value === token)?.[0] ?? 0; }
    const allowed = ['/api/site_config','/api/share','/api/get_open_adv','/api/get_script','/api/v2/diy/color_change/color_change','/api/diy/get_suspended','/api/diy/diy_version/0','/api/navigation','/api/sign/config','/api/sign/status','/api/sign/calendar','/api/sign/list','/api/sign/month','/api/sign/user','/api/sign/integral','/api/sign/remind/0','/api/sign/remind/1'];
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      pending++; try { await serial(async () => {
        expect(clientReset).toBe(true);
        const started = Date.now(), method = req.method ?? '', before = await f.snapshot(), beforeResources = resources(), issuedActorHint = actor(req);
        expect(before).toEqual(expected); expect(allowed.includes(url.pathname) || /^\/api\/assets\/[1-9]\d*$/.test(url.pathname)).toBe(true);
        expect([...url.searchParams.keys()].length).toBe(new Set(url.searchParams.keys()).size);
        let consumed = 0, bytes: Buffer;
        try { bytes = await body(req, size => { consumed = size; }); }
        catch (error) {
          if (!abortedEmptyGet(req, error, consumed)) throw error;
          const after = await f.snapshot(), afterResources = resources();
          controls.push({ kind: 'cancelled-before-dispatch', path: url.pathname, query: url.search, method, issued_actor_hint: issuedActorHint, token_match: issuedActorHint !== 0, worker_authenticated: false,
            aborted: true, dispatched: false, nonproof: true, stage: stage(), request: { bytes_received: consumed, content_length: req.headers['content-length'] ?? null, transfer_encoding: req.headers['transfer-encoding'] ?? null,
              framing_headers: req.rawHeaders.flatMap((name, i) => i % 2 === 0 && ['content-length','transfer-encoding'].includes(name.toLowerCase()) ? [{ name, value: req.rawHeaders[i + 1] }] : []) },
            error: { name: (error as Error).name, message: (error as Error).message, code: 'ECONNRESET' }, before: remember(before), after: remember(after), resources_before: beforeResources, resources_after: afterResources, started_at_ms: started, completed_at_ms: Date.now() });
          await persist(); expect(after).toEqual(before); expect(afterResources).toEqual(beforeResources); return;
        }
        const input: unknown = bytes.length ? JSON.parse(bytes.toString()) : {};
        const isSign = url.pathname === '/api/sign/integral', isRemind = url.pathname.startsWith('/api/sign/remind/'), isStats = url.pathname === '/api/sign/user';
        failedDispatch = { path: url.pathname, query: url.search, method, issued_actor_hint: issuedActorHint, stage: stage(), request: { bytes: bytes.length, body: bytes.toString(), sha256: hash(bytes), input }, before: remember(before), resources_before: beforeResources }; await persist();
        if (isSign) { expect(method).toBe('POST'); expect(input).toEqual({}); expect(issuedActorHint).toBe(stage() === 'signed' ? 11 : stage() === 'unknown-reconciled' ? 33 : ['retry-uncertain','retry-applied'].includes(stage() ?? '') ? 44 : -1); expect(signWrites).toBe(stage() === 'signed' ? 0 : stage() === 'unknown-reconciled' ? 1 : 2); if (issuedActorHint === 33) expect(armed).toBe(true); if (issuedActorHint === 44) { expect(preDropped).toBe(stage() === 'retry-uncertain' ? 0 : 1); expect(preArmed).toBe(stage() === 'retry-uncertain'); } }
        else if (isRemind) { expect(method).toBe('GET'); expect(bytes.length).toBe(0); expect(issuedActorHint).toBe(11); expect(url.pathname).toBe(stage() === 'reminder-on' ? '/api/sign/remind/1' : stage() === 'reminder-off' ? '/api/sign/remind/0' : 'forbidden'); expect(remindWrites).toBe(stage() === 'reminder-on' ? 0 : 1); }
        else if (isStats) { expect(method).toBe('POST'); expect(input).toEqual({ sign: 1 }); }
        else { expect(method).toBe('GET'); expect(bytes.length).toBe(0); }
        if (isSign && issuedActorHint === 44 && stage() === 'retry-uncertain') {
          expect(preArmed).toBe(true); expect(preDropped).toBe(0);
          const after = await f.snapshot(), afterResources = resources();
          controls.push({ kind: 'withheld-pre-dispatch-until-client-timeout', path: url.pathname, query: url.search, method, issued_actor_hint: 44, token_match: true, worker_authenticated: false,
            stage: stage(), dispatched: false, nonproof: true, request: { bytes: bytes.length, body: bytes.toString(), sha256: hash(bytes), input },
            before: remember(before), after: remember(after), resources_before: beforeResources, resources_after: afterResources, started_at_ms: started, completed_at_ms: Date.now(),
            browser_delivery: { kind: 'withheld-until-client-timeout', fault_point: 'pre-dispatch', http_status: null, bytes: 0, sha256: null, received_proof: false } });
          await persist(); expect(after).toEqual(before); expect(afterResources).toEqual(beforeResources); expect(afterResources).toEqual(initialResources);
          preArmed = false; preDropped++; failedDispatch = undefined; await persist(); await withholdUntilClientClose(req, res, 'pre-dispatch', 44); return;
        }
        const headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
        const waits: Promise<unknown>[] = [];
        const response = await app.fetch(new Request(origin + url.pathname + url.search, { method, headers, ...(bytes.length ? { body: bytes } : {}) }), f.env,
          { waitUntil: (work: Promise<unknown>) => waits.push(work), passThroughOnException() {} } as unknown as ExecutionContext); await Promise.all(waits);
        const raw = Buffer.from(await response.arrayBuffer()), type = response.headers.get('Content-Type') ?? '', textBody = /(?:json|javascript|text\/)/.test(type);
        const after = await f.snapshot(), afterResources = resources();
        failedDispatch = { ...failedDispatch, after: remember(after), resources_after: afterResources, worker_response: { http_status: response.status, content_type: type, cache_control: response.headers.get('Cache-Control'), bytes: raw.length,
          body_encoding: textBody ? 'utf8' : 'base64', body: textBody ? raw.toString() : raw.toString('base64'), sha256: hash(raw) } }; await persist();
        const payload: Row | undefined = type.includes('application/json') ? JSON.parse(raw.toString()) : undefined;
        failedDispatch.worker_response.dto = payload; await persist(); expect(response.status).toBe(200); expect(payload?.status ?? 200).toBe(200);
        const want = structuredClone(before), mutation: Row = { kind: 'read' };
        if (isSign) {
          expect(payload?.data).toMatchObject({ point: 7, exp: 0, sign_point: 7, sign_exp: 0, continuousDays: 1 });
          const newSigns = after.user_sign.filter(row => !before.user_sign.some(old => old.id === row.id)); const newBills = after.user_bill.filter(row => !before.user_bill.some(old => old.id === row.id));
          expect(newSigns).toHaveLength(1); expect(newBills).toHaveLength(1); const signed = newSigns[0], bill = newBills[0];
          expect(signed).toMatchObject({ uid: issuedActorHint, title: '签到奖励', number: 7, exp_num: 0, balance: (issuedActorHint === 11 ? 100 : issuedActorHint === 33 ? 300 : 400) + 7 });
          expect(bill).toMatchObject({ uid: issuedActorHint, pm: 1, category: 'integral', type: 'sign' }); expect(bill.number).toBe(7); expect(bill.balance).toBe((issuedActorHint === 11 ? 100 : issuedActorHint === 33 ? 300 : 400) + 7);
          expect(payload!.data.cumulativeDays).toBe(before.user_sign.filter(row => row.uid === issuedActorHint).length + 1);
          want.user = want.user.map(row => row.uid === issuedActorHint ? { ...row, integral: Number(row.integral) + 7, sign_num: 1 } : row); want.user_sign.push(signed); want.user_bill.push(bill);
          for (const [table, added] of [['user_sign', signed], ['user_bill', bill]] as const) {
            const sequence = table + '_id_seq', previous = want.__sequences.find(row => row.name === sequence); expect(previous).toBeDefined();
            const next = BigInt(previous!.last) + (previous!.called ? 1n : 0n); expect(BigInt(added.id)).toBe(next);
            want.__sequences = want.__sequences.map(row => row.name === sequence ? { ...row, last: String(next), called: true } : row);
          }
          mutation.kind = 'sign'; mutation.uid = issuedActorHint; mutation.sign_id = signed.id; mutation.bill_id = bill.id; signWrites++;
        } else if (isRemind) { expect(payload?.data).toBe(null); const next = url.pathname.endsWith('/1') ? 1 : 0; want.user = want.user.map(row => row.uid === 11 ? { ...row, sign_remind: next } : row); mutation.kind = 'reminder'; mutation.value = next; remindWrites++; }
        expect(after).toEqual(sortedDiyState(want)); expect(afterResources).toEqual(beforeResources); expect(afterResources).toEqual(initialResources);
        if (url.pathname.startsWith('/api/sign/')) expect(response.headers.get('Cache-Control')).toContain('no-store');
        if (/^\/api\/assets\//.test(url.pathname)) { expect([...url.searchParams.keys()].sort()).toEqual(['expires','signature']); expect(Number(url.searchParams.get('expires')) * 1000).toBeGreaterThan(Date.now()); expect(url.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]{43}$/); }
        expected = after; const drop = isSign && issuedActorHint === 33; if (drop) { expect(armed).toBe(true); expect(dropped).toBe(0); armed = false; dropped++; }
        traces.push({ ...failedDispatch, actor: issuedActorHint, mutation, synthetic: false, started_at_ms: started, completed_at_ms: Date.now(),
          browser_delivery: drop ? { kind: 'withheld-until-client-timeout', fault_point: 'post-commit', http_status: null, bytes: 0, sha256: null, received_proof: false } : { kind: 'bridge-delivered', http_status: response.status, bytes: raw.length, sha256: hash(raw), received_proof: true } });
        failedDispatch = undefined; await persist(); if (drop) { await withholdUntilClientClose(req, res, 'post-commit', 33); return; } res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      }); } finally { pending--; }
    }
    const latest = (path: string, time: number) => [...traces].reverse().find(t => t.actor === owner && t.path === path && t.worker_response.dto?.status === 200 && t.browser_delivery.received_proof && t.completed_at_ms <= time);
    async function capture(name: string, data: Row) {
      expect(clientReset).toBe(true); expect(name).toBe(stage()); expect(pending).toBe(0); expect(data.errors).toEqual([]); expect(data.captured_at_ms).toBeGreaterThan(Number(evidence.at(-1)?.captured_at_ms ?? 0));
      const history = name.startsWith('history-') && name !== 'history-back';
      expect(data.href).toBe(origin + '/__h5#/pages/user/' + (history ? 'signRecords' : 'sign')); expect(data.scrollWidth).toBeLessThanOrEqual(data.clientWidth);
      const width = ['desktop','finished'].includes(name) ? 1000 : 375; expect(data.frameWidth).toBe(width); expect(data.viewportWidth).toBe(width); expect(data.clientWidth).toBeLessThanOrEqual(width); expect(width - data.clientWidth).toBeLessThanOrEqual(20);
      expect(owner).toBe(name === 'other-signed' ? 22 : ['unknown-ready','unknown-reconciled'].includes(name) ? 33 : ['retry-ready','retry-uncertain','retry-applied'].includes(name) ? 44 : name === 'guest' ? 0 : 11);
      for (const image of data.images) { expect(image.complete).toBe(true); expect(image.naturalWidth).toBeGreaterThan(0); expect(new URL(image.currentSrc || image.src, origin).origin).toBe(origin); }
      const links: Row = {};
      if (!owner) { expect(data.text).toContain('登录后开启每日签到'); expect(data.sign_button).toBe(null); expect(data.records).toEqual([]); }
      else if (history) {
        const monthTraces = traces.filter(t => t.actor === owner && t.path === '/api/sign/month' && t.browser_delivery.received_proof && t.completed_at_ms <= data.captured_at_ms);
        const first = monthTraces.find(t => new URLSearchParams(t.query).get('page') === '1'); expect(first).toBeDefined(); expect(first!.stage).toBe('history-first'); expect(first!.worker_response.dto.data).toHaveLength(8);
        const selected = name === 'history-more' ? [first!, monthTraces.find(t => new URLSearchParams(t.query).get('page') === '2')!] : [first!]; expect(selected.every(Boolean)).toBe(true); if (name === 'history-more') { expect(selected[1].stage).toBe('history-more'); expect(selected[1].worker_response.dto.data.length).toBeGreaterThan(0); expect(selected[1].worker_response.dto.data.length).toBeLessThan(8); } for (const t of selected) expect(new URLSearchParams(t.query).get('limit')).toBe('8');
        const groups = selected.flatMap(t => t.worker_response.dto.data); expect(data.groups.map((g: Row) => ({ month: g.month, ids: g.ids }))).toEqual(groups.map((g: Row) => ({ month: g.month, ids: g.list.map((r: Row) => r.id) })));
        for (const [i, group] of groups.entries()) for (const [j, row] of group.list.entries()) { const text = data.groups[i].records[j].text; expect(text).toContain(row.title); expect(text).toContain(row.add_time); const rewards = data.groups[i].records[j].rewards.map((reward: Row) => ({ amount: reward.amount, unit: reward.unit })).sort((a: Row, b: Row) => a.unit.localeCompare(b.unit)); const expectedRewards = [[row.exp_num, '经验'], [row.number, '积分']].filter(([value]) => Number(value) !== 0).map(([value, unit]) => ({ amount: Number(value) > 0 ? '+' + value : String(value), unit })).sort((a, b) => String(a.unit).localeCompare(String(b.unit))); expect(rewards).toEqual(expectedRewards); } expect(groups.some((g: Row) => g.list.length === 12)).toBe(true); expect(groups.flatMap((g: Row) => g.list).every((r: Row) => r.uid === owner)).toBe(true);
        links.months = selected.map(t => ({ trace_index: traces.indexOf(t), sha256: t.worker_response.sha256 }));
      } else {
        for (const [key, path] of Object.entries({ config: '/api/sign/config', status: '/api/sign/status', recent: '/api/sign/list', points: '/api/sign/user' })) { const t = latest(path, data.captured_at_ms); expect(t).toBeDefined(); if (['initial','history-back','signed','signed-reload','month-mode','week-mode','other-signed','unknown-ready','unknown-reconciled','retry-ready','retry-uncertain','retry-applied','restored'].includes(name)) expect(t!.stage).toBe(name); links[key] = { trace_index: traces.indexOf(t!), sha256: t!.worker_response.sha256 }; }
        const config = traces[links.config.trace_index].worker_response.dto.data, status = traces[links.status.trace_index].worker_response.dto.data, recent = traces[links.recent.trace_index].worker_response.dto.data, points = traces[links.points.trace_index].worker_response.dto.data;
        const actualAward = status.signedToday ? recent.find((row: Row) => row.add_time === new Date((day.todayStart + 28_800) * 1000).toISOString().slice(0, 10)) : { number: status.integral, exp_num: status.exp };
        expect(actualAward).toBeDefined();
        const expectedBubbles = [{ value: Number(actualAward.number), label: status.signedToday ? '已得积分' : '签到领积分' }, { value: Number(actualAward.exp_num), label: status.signedToday ? '已得经验' : '签到领经验' }].filter(row => row.value > 0);
        expect(data.bubbles.map((row: Row) => row.value)).toEqual(expectedBubbles.map(row => row.value)); for (const [index, bubble] of expectedBubbles.entries()) expect(data.bubbles[index].text).toContain(bubble.label);
        expect(data.wallet).toBe(points.integral); expect(points.uid).toBe(owner); expect(data.continuous).toBe(config.continuousSignDays); expect(data.cumulative).toBe(config.cumulativeSignDays);
        expect(data.records.map((r: Row) => r.id)).toEqual(recent.map((r: Row) => r.id)); for (const [i, row] of recent.entries()) { expect(data.records[i].text).toContain(row.title); if (row.add_time) expect(data.records[i].text).toContain(row.add_time); const rewards = data.records[i].rewards.map((reward: Row) => ({ amount: reward.amount, unit: reward.unit })).sort((a: Row, b: Row) => a.unit.localeCompare(b.unit)); const expectedRewards = [[row.exp_num, '经验'], [row.number, '积分']].filter(([value]) => Number(value) !== 0).map(([value, unit]) => ({ amount: Number(value) > 0 ? '+' + value : String(value), unit })).sort((a, b) => String(a.unit).localeCompare(String(b.unit))); expect(rewards).toEqual(expectedRewards); } expect(recent.every((r: Row) => r.uid === owner)).toBe(true); expect(data.rail.map((c: Row) => c.day)).toEqual(config.signList.map((c: Row) => c.day));
        expect(config.signData.sign_point).toBe(7); expect(config.signData.sign_exp).toBe(0); expect(config.signStatus).toBe(1); expect(config.checkSign).toBe(status.signedToday);
        if (name === 'retry-uncertain') { expect(status.signedToday).toBe(false); expect(data.sign_button.disabled).toBe(true); expect(data.sign_button.text).toContain('请先核对签到结果'); expect(data.retry_button).not.toBe(null); expect(data.retry_button.disabled).toBe(false); expect(data.retry_button.text).toContain('重新尝试今日签到'); expect(data.notice).toContain('原请求结果未确认'); expect(preDropped).toBe(1); expect(signWrites).toBe(2); }
        else { expect(data.sign_button.disabled).toBe(status.signedToday); expect(data.sign_button.text).toContain(status.signedToday ? '今日已签到' : '立即签到'); }
        expect(data.remind_checked).toBe(config.signRemindStatus === 1);
        if (name === 'reminder-on') expect(config.signRemindStatus).toBe(1); if (name === 'reminder-off') expect(config.signRemindStatus).toBe(0);
        if (name === 'month-mode') expect(config.signList).toHaveLength(new Date(local.getUTCFullYear(), local.getUTCMonth() + 1, 0).getDate()); else expect(config.signList).toHaveLength(7);
        if (['calendar','calendar-previous','calendar-next'].includes(name)) {
          expect(data.calendar).not.toBe(null); const t = latest('/api/sign/calendar', data.captured_at_ms); expect(t).toBeDefined(); const dto = t!.worker_response.dto.data, month = data.calendar.month; const wantedMonth = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + (name === 'calendar-previous' ? -1 : 0), 1)).toISOString().slice(0, 7); expect(month).toBe(wantedMonth); expect(t!.stage).toBe(name);
          expect(new URLSearchParams(t!.query).get('time') || dto.today.slice(0, 7)).toBe(month); expect(data.calendar.cells.map((cell: Row) => cell.signed)).toEqual(dto.signList.map((cell: Row) => cell.is_sign));
          expect(data.calendar.cells.map((cell: Row) => cell.day)).toEqual(Array.from({ length: dto.signList.length }, (_, i) => i + 1)); links.calendar = { trace_index: traces.indexOf(t!), sha256: t!.worker_response.sha256 };
        }
        if (name === 'initial' || name === 'unknown-ready' || name === 'retry-ready') expect(status.signedToday).toBe(false);
        if (['signed','signed-reload','other-signed','unknown-reconciled','retry-applied','restored','desktop','finished'].includes(name)) expect(status.signedToday).toBe(true);
        if (name === 'unknown-reconciled') { expect(dropped).toBe(1); expect(signWrites).toBe(2); expect(data.notice).toContain('已核对当天状态'); }
      }
      if (name === 'retry-applied') { expect(preDropped).toBe(1); expect(signWrites).toBe(3); expect(data.wallet).toBe(407); }
      expect(await f.snapshot()).toEqual(expected); expect(resources()).toEqual(initialResources);
      evidence.push({ name, ...data, owner, links, traceCount: traces.length, snapshot: remember(expected!), signWrites, remindWrites, dropped, preDropped }); await persist();
      if (name === 'finished') { expect(controls.filter(row => row.kind === 'qa-client-state-reset')).toHaveLength(1); expect(signWrites).toBe(3); expect(remindWrites).toBe(2); expect(dropped).toBe(1); expect(setups).toHaveLength(2); expect(armed).toBe(false); expect(preDropped).toBe(1); expect(preArmed).toBe(false); expect(external).not.toHaveBeenCalled(); expect(await sources()).toEqual(sourceBefore); expect(await artifacts()).toEqual(buildBefore); finish(); }
    }
    const shell = `<!doctype html><html lang="zh"><meta charset="utf-8"><link rel="icon" href="data:,"><title>真实顾客签到中心 PG16</title><style>body{margin:8px;font:14px sans-serif;background:#f6f7f8}h1{font-size:18px}button{margin:3px;padding:6px}iframe{display:block;width:375px;height:1000px;border:0;background:#fff}pre{white-space:pre-wrap;max-height:80px;overflow:auto}</style><h1>顾客签到中心 · 真实 Worker / PostgreSQL16</h1><p>业务和chrome均为真实接口。QA仅装载测试JWT/两次sign_mode维护/一次提交后保留回复至客户端超时/一次完整接收POST后未派发并等客户端超时；不证明登录表单、独立LOGIN ACL或真实跨夜。先点QA初始化按钮，仅精确清除本轮四个测试账号的请求标记；之后刷新和切账号不再自动清除。请只从实际页面显式签到/提醒。</p><button id="client-reset">QA初始化本轮测试账号请求标记</button>${[11,22,33,44,0].map(uid => '<button data-owner="' + uid + '">装载用户' + uid + '</button>').join('')}<button id="mode0">QA切月模式</button><button id="mode1">QA还原周模式</button><button id="drop">QA保留用户33已提交签到回复至客户端超时</button><button id="pre-drop">QA用户44首次签到不派发并等待客户端超时</button><button id="reload">实际重新加载签到页</button><button id="wide">桌面1000</button>${plans.map(name => '<button data-stage="' + name + '">验收 ' + name + '</button>').join('')}<pre id="result"></pre><iframe title="实际顾客签到应用"></iframe><script>
const frame=document.querySelector('iframe'),result=document.querySelector('#result');let errors=[];
frame.onload=()=>{const w=frame.contentWindow;w.addEventListener('error',e=>errors.push({kind:'error',message:e.message}));w.addEventListener('unhandledrejection',e=>errors.push({kind:'unhandledrejection',message:String(e.reason)}))};
async function ctl(path){const r=await fetch(${JSON.stringify(control)}+path,{method:'POST'});if(!r.ok)throw Error(await r.text());return r.json()}
function open(){errors=[];const target='/__h5#/pages/user/sign';if(frame.contentWindow.location.href===new URL(target,location.href).href)frame.contentWindow.location.reload();else frame.src=target}
for(const b of document.querySelectorAll('[data-owner]'))b.onclick=async()=>{try{const uid=Number(b.dataset.owner),data=await ctl('/owner?uid='+uid);if(uid){localStorage.setItem('uni_token',JSON.stringify({type:'string',data:data.token}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:uid}))}else{localStorage.removeItem('uni_token');localStorage.removeItem('uni_uid')}open()}catch(e){result.textContent=String(e)}};
for(const value of [0,1])document.querySelector('#mode'+value).onclick=async()=>{try{await ctl('/mode?value='+value);open()}catch(e){result.textContent=String(e)}};
document.querySelector('#drop').onclick=async()=>{try{result.textContent=JSON.stringify(await ctl('/drop'))}catch(e){result.textContent=String(e)}};
document.querySelector('#pre-drop').onclick=async()=>{try{result.textContent=JSON.stringify(await ctl('/pre-dispatch-drop'))}catch(e){result.textContent=String(e)}};
document.querySelector('#client-reset').onclick=async()=>{try{const keys=[11,22,33,44].map(uid=>'cinashop_sign_pending_v1_'+uid),before=keys.map(key=>({key,value:localStorage.getItem(key)}));for(const key of keys)localStorage.removeItem(key);const after=keys.map(key=>({key,value:localStorage.getItem(key)})),r=await fetch(${JSON.stringify(control)}+'/client-reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keys,before,after})});if(!r.ok)throw Error(await r.text());result.textContent=await r.text();if(r.ok)document.querySelector('#client-reset').disabled=true}catch(e){result.textContent=String(e)}};
document.querySelector('#reload').onclick=open;document.querySelector('#wide').onclick=()=>{frame.style.width='1000px'};
for(const b of document.querySelectorAll('[data-stage]'))b.onclick=async()=>{b.disabled=true;try{const d=frame.contentDocument,w=frame.contentWindow,shown=n=>!!n&&n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0&&w.getComputedStyle(n).display!=='none',images=n=>[...n.querySelectorAll('img')].map(i=>({src:i.src,currentSrc:i.currentSrc,complete:i.complete,naturalWidth:i.naturalWidth,naturalHeight:i.naturalHeight,className:i.className})),records=n=>[...n.querySelectorAll('[data-sign-record-id]')].map(r=>({id:Number(r.getAttribute('data-sign-record-id')),text:r.innerText,rewards:[...r.querySelectorAll('.reward')].map(v=>({amount:[...v.querySelectorAll('uni-text,text')].find(t=>!t.classList.contains('unit'))?.textContent,unit:v.querySelector('.unit')?.textContent,text:v.innerText}))})),p=[...d.querySelectorAll('uni-page')].filter(shown).at(-1)||d,button=p.querySelector('.sign-button'),retry=p.querySelector('.retry-sign'),cal=p.querySelector('.calendar-panel'),switcher=p.querySelector('[aria-label="签到提醒"] .uni-switch-input');
const data={captured_at_ms:Date.now(),href:w.location.href,frameWidth:frame.clientWidth,viewportWidth:w.innerWidth,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,text:d.body.innerText,errors,images:images(d),wallet:Number(p.querySelector('.points .numeric')?.textContent),continuous:Number(p.querySelector('.continue .numeric')?.textContent),cumulative:Number(p.querySelector('.total-number .numeric')?.textContent),records:records(p),bubbles:[...p.querySelectorAll('.bubble')].filter(shown).map(b=>({value:Number(b.querySelector('.bubble-value')?.textContent),text:b.innerText})),groups:[...p.querySelectorAll('[data-sign-month]')].map(g=>({month:g.getAttribute('data-sign-month'),ids:records(g).map(r=>r.id),records:records(g)})),rail:[...p.querySelectorAll('[data-sign-day]')].map(r=>({day:r.getAttribute('data-sign-day'),text:r.innerText})),notice:p.querySelector('.notice')?.textContent||'',remind_checked:switcher?switcher.classList.contains('uni-switch-input-checked'):null,retry_button:retry?{text:retry.textContent,disabled:(retry.hasAttribute('disabled')&&retry.getAttribute('disabled')!=='false')||retry.getAttribute('aria-disabled')==='true'||retry.classList.contains('uni-button-disabled')}:null,sign_button:button?{text:button.textContent,disabled:(button.hasAttribute('disabled')&&button.getAttribute('disabled')!=='false')||button.getAttribute('aria-disabled')==='true'||button.classList.contains('uni-button-disabled')}:null,calendar:shown(cal)?{month:/\\d{4}-\\d{2}/.exec(cal.querySelector('.month-navigation')?.textContent||'')?.[0],cells:[...cal.querySelectorAll('[data-calendar-day]')].map(c=>({day:Number(c.getAttribute('data-calendar-day')),signed:c.classList.contains('signed'),text:c.innerText}))}:null};
const r=await fetch(${JSON.stringify(control)}+'/phase/'+b.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});result.textContent=await r.text()}catch(e){result.textContent=String(e)}finally{b.disabled=false}};
</script></html>`;
    const host = createServer((req, res) => { void (async () => {
      expect(req.socket.remoteAddress).toBe('127.0.0.1'); expect(req.headers.host).toBe('127.0.0.1:40837'); const url = new URL(req.url ?? '/', origin);
      if (url.pathname.startsWith(control)) {
        expect(req.method).toBe('POST');
        if (url.pathname === control + '/client-reset') { await serial(async () => {
          expect(url.search).toBe(''); expect(stage()).toBe('initial'); expect(clientReset).toBe(false); expect(traces).toHaveLength(0); expect(evidence).toHaveLength(0); expect(controls).toHaveLength(0); expect(setups).toHaveLength(0); expect(pending).toBe(0); expect(signWrites + remindWrites).toBe(0);
          const started = Date.now(), bytes = await body(req), input: Row = JSON.parse(bytes.toString()), keys = [11,22,33,44].map(uid => 'cinashop_sign_pending_v1_' + uid);
          expect(Object.keys(input).sort()).toEqual(['after','before','keys']); expect(input.keys).toEqual(keys); expect(input.before).toHaveLength(4); expect(input.after).toEqual(keys.map(key => ({ key, value: null })));
          for (const [index, row] of input.before.entries()) { expect(Object.keys(row).sort()).toEqual(['key','value']); expect(row.key).toBe(keys[index]); expect(row.value === null || typeof row.value === 'string' && row.value.length <= 1024).toBe(true); }
          const before = await f.snapshot(), beforeResources = resources(); expect(before).toEqual(expected); const after = await f.snapshot(), afterResources = resources(); expect(after).toEqual(before); expect(afterResources).toEqual(beforeResources); expect(afterResources).toEqual(initialResources);
          controls.push({ kind: 'qa-client-state-reset', stage: stage(), nonproof: true, dispatched: false, boundary: 'Explicit owned fixture bootstrap; client-reported localStorage attestation is not production recovery proof.', keys, before: remember(before), after: remember(after), resources_before: beforeResources, resources_after: afterResources, started_at_ms: started, completed_at_ms: Date.now(), request: { bytes: bytes.length, body: bytes.toString(), sha256: hash(bytes), input } });
          clientReset = true; await persist(); json(res, { client_reset: true, keys, after: input.after, nonproof: true });
        }); return; }
        if (url.pathname === control + '/owner') { const uid = Number(url.searchParams.get('uid')); expect(clientReset).toBe(true); expect([0,11,22,33,44]).toContain(uid); owner = uid; controls.push({ kind: 'qa-session', issued_actor_hint: uid, stage: stage(), at_ms: Date.now() }); json(res, { token: tokens.get(uid) ?? '' }); return; }
        if (url.pathname === control + '/drop') { expect(stage()).toBe('unknown-reconciled'); expect(owner).toBe(33); expect(armed).toBe(false); expect(dropped).toBe(0); armed = true; controls.push({ kind: 'arm-post-commit-drop', uid: 33, at_ms: Date.now(), stage: stage() }); json(res, { armed: true, boundary: 'Actual transaction will commit; headers/body remain unsent until the real client closes after its request deadline. A 25s safety timeout is fatal. Read recovery must not repeat POST.' }); return; }
        if (url.pathname === control + '/pre-dispatch-drop') { expect(stage()).toBe('retry-uncertain'); expect(owner).toBe(44); expect(preArmed).toBe(false); expect(preDropped).toBe(0); preArmed = true; controls.push({ kind: 'arm-pre-dispatch-drop', issued_actor_hint: 44, stage: stage(), at_ms: Date.now() }); json(res, { armed: true, boundary: 'The complete first POST body is recorded before app.fetch; no Worker response or actual trace is created. Headers/body remain unsent until the client closes after its request deadline; 25s safety timeout is fatal.' }); return; }
        if (url.pathname === control + '/mode') { await serial(async () => {
          const value = url.searchParams.get('value'); expect(value).toBe(stage() === 'month-mode' ? '0' : stage() === 'week-mode' ? '1' : 'forbidden'); expect(owner).toBe(11);
          const before = await f.snapshot(), beforeResources = resources(); expect(before).toEqual(expected); await f.db.update(systemConfig).set({ value: value! }).where(and(eq(systemConfig.isStore, 0), eq(systemConfig.menuName, 'sign_mode')));
          const after = await f.snapshot(), want = structuredClone(before); expect(want.system_config.filter(row => row.menu_name === 'sign_mode' && row.is_store === 0)).toHaveLength(1); want.system_config = want.system_config.map(row => row.menu_name === 'sign_mode' && row.is_store === 0 ? { ...row, value } : row); expect(after).toEqual(sortedDiyState(want)); expect(resources()).toEqual(beforeResources); expected = after; f.cache.clear();
          setups.push({ kind: 'qa-sign-mode', value, before: remember(before), after: remember(after), resources_before: beforeResources, resources_after: resources(), at_ms: Date.now() }); await persist(); json(res, { mode: value });
        }); return; }
        if (url.pathname.startsWith(control + '/phase/')) { const data = JSON.parse((await body(req, undefined, 262_144)).toString()); await serial(async () => { const name = url.pathname.slice((control + '/phase/').length); await capture(name, data); json(res, { accepted: true, name, complete: evidence.length === plans.length, next: stage(), actual_dispatched: traces.length, actual_readonly_responses: traces.filter(t => t.mutation.kind === 'read' && t.browser_delivery.received_proof).length, business_writes: signWrites + remindWrites, cancelled: controls.filter(c => c.kind === 'cancelled-before-dispatch').length, response_drops: dropped, pre_dispatch_drops: preDropped }); }); return; }
        throw Error('Unknown owned sign control');
      }
      if (url.pathname.startsWith('/api/')) { await api(req, res, url); return; }
      expect(req.method).toBe('GET'); if (url.pathname === '/') { send(res, shell); return; } if (url.pathname === '/favicon.ico') { send(res, '', 204, 'image/x-icon'); return; }
      const decoded = decodeURIComponent(url.pathname), target = decoded === '/__h5' ? resolve(dist, 'index.html') : resolve(dist, '.' + decoded); expect(target.startsWith(dist + sep)).toBe(true); let raw = await readFile(target);
      if (target === resolve(dist, 'index.html')) raw = Buffer.from(raw.toString().replace('<head>', '<head><link rel="icon" href="data:,">'));
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
      staticPaths.push({ path: decoded, file: target.slice(dist.length + 1), sha256: hash(raw), status: 200 }); send(res, raw, 200, types[extname(target)] ?? 'application/octet-stream');
    })().catch(error => { failure ??= error; controls.push({ kind: 'server-error', method: req.method, url: req.url, stage: stage(), error: String(error) }); void persist().then(() => fail(error), saveError => fail(saveError)); if (!res.headersSent && !res.destroyed) send(res, String(error), 500, 'text/plain'); else res.destroy(); }); });
    server = host; host.on('upgrade', (_req, socket) => { const error = Error('Customer sign-centre must not open provider sockets'); failure ??= error; fail(error); socket.destroy(); });
    timer = setTimeout(() => fail(Error('Customer sign-centre Browser timed out')), 50 * 60_000);
    await new Promise<void>((yes, no) => { host.once('error', no); host.listen(40837, '127.0.0.1', yes); });
    await writeFile(prefix + 'ready.json', JSON.stringify({ origin, plans, prefix, control, table_count: f.tables.length, sequence_count: f.sequences.length, source_count: sourceBefore.length, build_count: buildBefore.length,
      seed: { uid: 11, initial_integral: 100, alias_only_points: 7, exp: 0, whole_history_months: 9, per_historical_month: 12, signed_other: 22, recovery_uid: 33, manual_retry_uid: 44, manual_retry_balance: 400, negative_history: { number: -2, exp_num: -1 }, server_day: new Date((day.todayStart + 28_800) * 1000).toISOString().slice(0, 10) },
      boundary: 'Explicit once-only client reset clears exactly owned uid11/22/33/44 pending keys before any API; no reset on ordinary reload or owner change. All API/chrome responses actual Worker. Fixture DI and QA JWT are not LOGIN ACL/login form proof. Two QA mode changes and one intentional post-commit response withholding and one pre-dispatch POST withholding until client timeout are separate from5 business writes. No actual midnight-race claim.' }) + '\n', { mode: 0o600 });
    console.log('CUSTOMER_SIGN_CENTRE_BROWSER_READY ' + origin); await completion; await queue;
    await writeFile(prefix + 'evidence.json', JSON.stringify({ status: 'passed', plans, evidence, traces, controls, setups, staticPaths, snapshots_by_sha256: snapshots, fixture_setup: { before: setupBefore, after: baseline }, final: expected,
      resources_before: initialResources, resources_after: resources(), sourceBefore, sourceAfter: await sources(), buildBefore, buildAfter: await artifacts() }, null, 2) + '\n', { mode: 0o600 });
  } catch (error) { failure ??= error; await writeFile(prefix + 'failed.json', JSON.stringify({ status: 'failed', error: String(error), stack: error instanceof Error ? error.stack : null, failedDispatch, evidence, traces, controls, setups, staticPaths, snapshots_by_sha256: snapshots, latest_expected: expected, latest_actual: await f.snapshot().catch(() => null) }, null, 2) + '\n', { mode: 0o600 }); throw error; }
  finally { clearTimeout(timer); let cleanupFailure: unknown, fixtureClosed = false;
    try { if (server) { server.closeAllConnections(); if (server.listening) await new Promise<void>((yes, no) => server!.close(error => error ? no(error) : yes())); } } catch (error) { cleanupFailure = error; }
    try { await f.close(); fixtureClosed = true; } catch (error) { cleanupFailure ??= error; }
    wiring.container = undefined; vi.restoreAllMocks(); await writeFile(prefix + 'cleanup.json', JSON.stringify({ server_created: !!server, server_closed: !server?.listening, fixture_closed: fixtureClosed, failure: failure ? String(failure) : null, cleanup_failure: cleanupFailure ? String(cleanupFailure) : null }) + '\n', { mode: 0o600 }); if (cleanupFailure) throw cleanupFailure;
  }
}, 54 * 60_000);
