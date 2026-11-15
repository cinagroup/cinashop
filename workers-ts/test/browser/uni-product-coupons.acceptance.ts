/** Installed Browser -> shipped H5 -> real App/JWT -> commissioned restricted
 * PG16 LOGIN/local R2. Controls select synthetic sessions/routes and arm two
 * single-use response delivery faults. Business JSON is always the real App's.
 * A full 283-table/229-sequence oracle is checked after every business request. */
import { expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { memberRight, storeBrand, storeCouponIssue, storeCouponIssueUser, storeCouponProduct, storeCouponUser,
  storeProduct, storeProductAttrValue, storeProductCategory, systemAttachment, systemConfig, user } from '@/models/schema';
import { withBuyerInvoices } from '../helpers/buyerInvoices';
import { buyerReviewPng, buyerReviewR2 } from '../helpers/buyerReviewR2';

type Row = Record<string, any>;
type Snapshot = { tables: Record<string, Row[]>; sequences: Record<string, { last_value: string; is_called: boolean }> };
const prefix = '/tmp/cinashop-uni-product-coupons-browser-';
const ids = { product: 70, otherProduct: 80, first: 960000, lost: 960000, rules: 960001, member: 960003, normal: 960004,
  historical: 960006, historicalOwned: 960200, asset: 990101, category: 950102, categoryParent: 950101, brand: 950104, brandParent: 950103 };
const phases = ['guest', 'owner-first', 'rules', 'more-failed', 'more-retried', 'all-pages', 'normal-grant', 'lost-grant',
  'remounted-pending', 'other-product-pending', 'owner-b', 'owner-a-relogin', 'recovered', 'mobile', 'desktop'];
const prose = '完整用券规则 😀 与换行\n'.repeat(200);
function stable(value: any): any { return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value; }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(stable(value)));
function sorted(value: Snapshot) {
  const result = structuredClone(value);
  for (const rows of Object.values(result.tables)) rows.sort((a, b) => JSON.stringify(stable(a)).localeCompare(JSON.stringify(stable(b)), 'en'));
  return result;
}
function one(rows: Row[], key: string, value: unknown): Row {
  const found = rows.filter(row => row[key] === value); expect(found).toHaveLength(1); return found[0]!;
}
const millis = (value: unknown) => Date.parse(String(value).match(/[zZ]|[+-]\d\d:\d\d$/u) ? String(value) : String(value) + 'Z');
const epoch = (value: unknown) => value === null ? null : Math.floor(millis(value) / 1000);
const money = (value: unknown) => Number(value).toFixed(2);
async function files(directory: string): Promise<string[]> {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(row => row.isDirectory()
    ? files(resolve(directory, row.name)) : [resolve(directory, row.name)]))).flat().sort();
}
async function body(req: IncomingMessage) {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; expect(bytes).toBeLessThanOrEqual(65536); parts.push(chunk); }
  return Buffer.concat(parts);
}

it('accepts the complete real H5 product coupon directory, two exact grants and original-product recovery', async () => withBuyerInvoices(async s => {
  expect(process.env.TEST_UNI_PRODUCT_COUPONS_BROWSER).toBe('1');
  const repository = resolve(import.meta.dirname, '../../..'), dist = resolve(repository, 'view/uniapp-ts/dist/build/h5');
  expect((await stat(resolve(dist, 'index.html'))).isFile()).toBe(true);
  const r2 = buyerReviewR2(), objectName = 'attachments/admin/1/uni_product_coupon_rule.png';
  r2.objects.set(objectName, { bytes: buyerReviewPng.slice(), contentType: 'image/png' });
  Object.assign(s.env, { ASSETS_BUCKET: r2.bucket });
  await s.f.db.insert(systemAttachment).values({ attId: ids.asset, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
    name: objectName, attDir: '/api/assets/' + ids.asset, sattDir: '/api/assets/' + ids.asset, attType: 'image/png', attSize: String(buyerReviewPng.length) });
  await s.f.db.update(user).set({ nickname: '商品券验收客户A', isEverLevel: 0, isMoneyLevel: 0, overdueTime: 0 }).where(eq(user.uid, 11));
  await s.f.db.update(user).set({ nickname: '商品券验收客户B', isEverLevel: 0, isMoneyLevel: 0, overdueTime: 0 }).where(eq(user.uid, 22));
  for (const [menuName, value] of Object.entries({ member_card_status: '1', member_func_status: '1' })) {
    await s.f.db.delete(systemConfig).where(eq(systemConfig.menuName, menuName));
    await s.f.db.insert(systemConfig).values({ menuName, value });
  }
  const right = await s.f.db.update(memberRight).set({ status: 1 }).where(eq(memberRight.rightType, 'coupon')).returning({ id: memberRight.id });
  if (!right.length) await s.f.db.insert(memberRight).values({ id: 950201, rightType: 'coupon', status: 1, number: 1 });
  await s.f.db.insert(storeProductCategory).values([{ id: ids.categoryParent, cateName: '验收父分类' }, { id: ids.category, pid: ids.categoryParent, cateName: '验收分类', level: 1 }]);
  await s.f.db.insert(storeBrand).values([{ id: ids.brandParent, brandName: '验收父品牌' }, { id: ids.brand, pid: ids.brandParent, brandName: '验收品牌' }]);
  const image = '/api/assets/' + ids.asset;
  await s.f.db.update(storeProduct).set({ storeName: '完整商品优惠券主样本', cateId: String(ids.category), brandId: ids.brand,
    recommendList: '80', image, sliderImage: JSON.stringify([image]) }).where(eq(storeProduct.id, 70));
  await s.f.db.insert(storeProduct).values({ id: 80, storeName: '恢复原商品领券的第二商品', cateId: String(ids.category), brandId: ids.brand,
    recommendList: '70', type: 2, relationId: 7, price: '20.00', stock: 8, isShow: 1, isVerify: 1, image, sliderImage: JSON.stringify([image]) });
  await s.f.db.insert(storeProductAttrValue).values({ id: 950300, productId: 80, type: 0, unique: 'unicpn80', suk: '标准款', stock: 8, price: '20.00', image });
  await s.f.db.delete(storeCouponProduct); await s.f.db.delete(storeCouponIssueUser); await s.f.db.delete(storeCouponUser); await s.f.db.delete(storeCouponIssue);
  const now = Date.now(), yesterday = new Date(now - 86400000), nextMonth = new Date(now + 30 * 86400000);
  const rule = '<h3>适用规则标题</h3><p>' + prose + '</p><ul><li>不可与其他券叠加</li></ul><table><tr><td>使用说明</td><td>完整保留表格</td></tr></table>'
    + '<img src="' + image + '" alt="平台规则图" onerror="globalThis.couponUnsafe=1">'
    + '<script>PRIVATE_SCRIPT_BODY</script><style>PRIVATE_STYLE_BODY</style><iframe>PRIVATE_FRAME_BODY</iframe><a href="javascript:alert(1)">规则结束标记</a>';
  for (let index = 0; index < 23; index++) {
    const scope = index % 4, id = ids.first + index;
    await s.f.db.insert(storeCouponIssue).values({ id, category: id === ids.member ? 2 : 0, couponType: scope,
      couponTitle: id === ids.lost ? '仅余一张的相对商品券' : id === ids.normal ? '正常领取的相对商品券' : id === ids.member ? '付费会员品牌专享券'
        : id === ids.historical ? 'A账号此前已领取的商品券' : id === ids.rules ? '八五折完整规则品类券' : '完整商品适用券 ' + (index + 1),
      type: index % 2 ? 2 : 1, couponPrice: index % 2 ? '85.00' : '5.00', useMinPrice: '20.00',
      productId: scope === 2 ? '70' : '0', category_id: scope === 1 ? String(ids.categoryParent) : '0', brandId: scope === 3 ? String(ids.brandParent) : '0',
      receiveType: 1, appType: 0, receiveLimit: 3, totalCount: 9, remainCount: id === ids.lost ? 1 : 9,
      day: index % 2 ? 0 : 7, startTime: yesterday, endTime: nextMonth, useStartTime: yesterday, useEndTime: nextMonth,
      sort: 1000 - index, rule: id === ids.rules ? rule : '<p>第 ' + (index + 1) + ' 张券完整使用规则</p>' });
  }
  await s.f.db.insert(storeCouponIssue).values([
    { id: 960100, couponTitle: '其他商品不适用券', couponType: 2, productId: '999999', receiveType: 1, appType: 0, day: 7, remainCount: 9 },
    { id: 960101, couponTitle: '其他分类不适用券', couponType: 1, category_id: '999999', receiveType: 1, appType: 0, day: 7, remainCount: 9 },
    { id: 960102, couponTitle: '其他品牌不适用券', couponType: 3, brandId: '999999', receiveType: 1, appType: 0, day: 7, remainCount: 9 },
    { id: 960103, couponTitle: '已停发券', status: 0, couponType: 0, receiveType: 1, appType: 0, day: 7, remainCount: 9 },
    { id: 960104, couponTitle: '非公开券', couponType: 0, receiveType: 3, appType: 0, day: 7, remainCount: 9 },
  ]);
  await s.f.db.insert(storeCouponUser).values({ id: ids.historicalOwned, uid: 11, issueCouponId: ids.historical, couponTitle: 'A账号此前已领取的商品券',
    couponPrice: '5.00', useMinPrice: '20.00', status: 0, type: 1, startTime: yesterday, endTime: nextMonth, receiveTime: Math.floor(now / 1000), receiveSource: 'get', isFail: 0 });
  await s.f.db.insert(storeCouponIssueUser).values({ uid: 11, issueCouponId: ids.historical, addTime: Math.floor(now / 1000) });
  const names = await s.f.exec("SELECT relname AS name,relkind AS kind FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','S') ORDER BY relname");
  const tableNames = names.filter(row => row.kind === 'r').map(row => String(row.name)), sequenceNames = names.filter(row => row.kind === 'S').map(row => String(row.name));
  expect(tableNames).toHaveLength(283); expect(sequenceNames).toHaveLength(229);
  for (const name of [...tableNames, ...sequenceNames]) expect(name).toMatch(/^[a-z][a-z0-9_]*$/u);
  const tableSql = tableNames.map(name => `SELECT '${name}' AS name,coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM public."${name}" t`).join(' UNION ALL ');
  const sequenceSql = sequenceNames.map(name => `SELECT '${name}' AS name,last_value::text AS last_value,is_called FROM public."${name}"`).join(' UNION ALL ');
  async function snapshot(): Promise<Snapshot> {
    const tables = await s.f.exec(tableSql), sequences = await s.f.exec(sequenceSql);
    return sorted({ tables: Object.fromEntries(tables.map(row => [row.name, row.rows])),
      sequences: Object.fromEntries(sequences.map(row => [row.name, { last_value: row.last_value, is_called: row.is_called }])) });
  }
  const tokens = new Map([[11, await s.token(11)], [22, await s.token(22)]]), control = '/__uni_product_coupons/' + randomUUID();
  const traces: Row[] = [], evidence: Row[] = [], controls: Row[] = [], staticPaths: Row[] = [], snapshots: Record<string, Snapshot> = {};
  const remember = (value: Snapshot) => { const id = digest(value); snapshots[id] ??= structuredClone(value); return id; };
  let expected = await snapshot(); const baseline = structuredClone(expected); remember(baseline);
  expect(expected.tables.store_product_log).toEqual([]); expect(expected.tables.store_visit).toEqual([]);
  const initialResources = { objectCount: r2.objects.size, objects: [...r2.objects].map(([key, row]) => ({ key, bytes: row.bytes.length, sha256: hash(row.bytes), contentType: row.contentType })) };
  const resources = () => ({ ...initialResources, reads: [...r2.reads], writes: [...r2.writes], deletes: [...r2.deletes] });
  const manifest = async (paths: string[]) => Promise.all(paths.sort().map(async path => { const bytes = await readFile(path); return { path: path.slice(repository.length + 1), bytes: bytes.length, sha256: hash(bytes) }; }));
  const sourcePaths = [...(await Promise.all(['workers-ts/src', 'workers-ts/test/helpers', 'view/uniapp-ts/src', 'view/common'].map(path => files(resolve(repository, path))))).flat(),
    ...['workers-ts/test/browser/uni-product-coupons.acceptance.ts', 'workers-ts/vitest.uni-product-coupons-browser.config.ts', 'workers-ts/scripts/run-local-finance-postgres.mjs',
      'workers-ts/test/local-finance-postgres-runner.test.ts', 'workers-ts/test/uni-product-coupons-native.test.ts', 'workers-ts/package.json', 'view/uniapp-ts/package.json'].map(path => resolve(repository, path))];
  const sourceBefore = await manifest(sourcePaths), buildPaths = await files(dist), buildBefore = await manifest(buildPaths);
  expect(buildBefore.length).toBeGreaterThan(300);
  let origin = '', uid = 0, pending = 0, queue = Promise.resolve(), finished = false, nextMoreFault = false, nextGrantFault = false, failure: unknown, failedDispatch: Row | undefined;
  let done!: () => void, fail!: (error: unknown) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  const stage = () => phases[evidence.length];
  const send = (res: ServerResponse, value: string | Buffer, status = 200, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'private, no-store' }); res.end(value);
  };
  const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value));
  async function serial(work: () => Promise<void>) { const next = queue.then(work); queue = next.catch(() => {}); return next; }
  async function persist(status = 'in_progress') {
    await writeFile(prefix + (status === 'passed' ? 'result.json' : 'in-progress.json'), JSON.stringify({ status, origin, control, phases, nextPhase: stage(), ids,
      fixtureIdentity: { appRole: s.appRole, appPid: s.appPid, uidA: 11, uidB: 22 }, fullTables: tableNames, fullSequences: sequenceNames,
      traces, evidence, controls, staticPaths, snapshots_by_sha256: snapshots, baseline, final: expected, resources: resources(), pending, finished,
      sourceBefore, buildBefore, failedDispatch }, null, 2) + '\n', { mode: 0o600 });
  }
  function allocate(value: Snapshot, name: string) {
    const sequence = value.sequences[name]!; expect(sequence).toBeDefined();
    const id = Number(BigInt(sequence.last_value) + (sequence.is_called ? 1n : 0n));
    sequence.last_value = String(id); sequence.is_called = true; return id;
  }
  function timeWithin(value: number, started: number, ended: number) { expect(value).toBeGreaterThanOrEqual(Math.floor(started / 1000)); expect(value).toBeLessThanOrEqual(Math.floor(ended / 1000)); }
  function grantOracle(before: Snapshot, after: Snapshot, input: Row, actor: number, dto: Row, started: number, ended: number) {
    expect(actor).toBe(11); expect(Object.keys(input)).toEqual(['id']);
    const prior = traces.filter(row => row.classification.kind === 'actual-coupon-grant');
    expect(input.id).toBe([ids.normal, ids.lost][prior.length]); expect(stage()).toBe(prior.length ? 'lost-grant' : 'normal-grant');
    const value = structuredClone(before), issue = one(value.tables.store_coupon_issue!, 'id', input.id), id = allocate(value, 'store_coupon_user_id_seq');
    expect(issue.category).toBe(0); expect(issue.is_permanent).toBe(0); expect(issue.remain_count).toBeGreaterThan(0);
    expect(before.tables.store_coupon_user!.filter(row => row.uid === actor && row.issue_coupon_id === input.id)).toEqual([]);
    const row = one(after.tables.store_coupon_user!, 'id', id), start = millis(row.start_time), end = millis(row.end_time);
    expect(start).toBeGreaterThanOrEqual(started); expect(start).toBeLessThanOrEqual(ended); expect(end - start).toBe(7 * 86400000);
    timeWithin(row.receive_time, started, ended);
    const expectedRow = { id, uid: actor, issue_coupon_id: input.id, coupon_title: issue.coupon_title, coupon_price: issue.coupon_price,
      use_min_price: issue.use_min_price, status: 0, start_time: row.start_time, end_time: row.end_time, use_time: null,
      type: issue.type, receive_time: row.receive_time, receive_source: 'get', is_fail: 0 };
    expect(row).toEqual(expectedRow); value.tables.store_coupon_user!.push(expectedRow);
    value.tables.store_coupon_issue_user!.push({ uid: actor, issue_coupon_id: input.id, add_time: row.receive_time });
    issue.remain_count--; expect(after).toEqual(sorted(value)); expect(dto.data).toEqual({ couponUserId: id });
    return { kind: 'actual-coupon-grant', owner: actor, product_id: 70, issue_id: input.id, coupon_user_id: id, remaining: issue.remain_count };
  }
  function visitOracle(before: Snapshot, after: Snapshot, product: number, actor: number, started: number, ended: number) {
    const value = structuredClone(before), id = allocate(value, 'store_product_log_id_seq'), row = one(after.tables.store_product_log!, 'id', id);
    timeWithin(row.add_time, started, ended);
    const expectedRow = { id, type: 'visit', product_id: product, uid: actor, visit_num: 1, cart_num: 0, order_num: 0, pay_num: 0,
      pay_price: 0, cost_price: 0, pay_uid: 0, refund_num: 0, refund_price: 0, collect_num: 0, add_time: row.add_time, delete_time: null };
    expect(row).toEqual(expectedRow); value.tables.store_product_log!.push(expectedRow);
    const existing = value.tables.store_visit!.filter(item => item.uid === actor && item.product_id === product && item.product_type === 'product').sort((a, b) => b.id - a.id)[0];
    let visitId: number;
    if (!existing) {
      visitId = allocate(value, 'store_visit_id_seq');
      const actual = one(after.tables.store_visit!, 'id', visitId);
      const visit = { id: visitId, product_id: product, product_type: 'product', cate_id: product, type: actual.type,
        uid: actor, count: 1, content: '', add_time: row.add_time };
      expect(String(actual.type).trimEnd()).toBe('view'); expect(actual).toEqual(visit); value.tables.store_visit!.push(visit);
    } else {
      visitId = existing.id;
      if (existing.add_time + 20 < row.add_time) Object.assign(existing, { count: existing.count + 1, cate_id: product, add_time: row.add_time });
    }
    expect(after).toEqual(sorted(value));
    return { kind: 'actual-necessary-product-visit', owner: actor, product_id: product, log_id: id, visit_id: visitId };
  }
  function directoryOracle(before: Snapshot, actor: number, product: number, params: URLSearchParams, dto: Row) {
    expect([...params.keys()].sort()).toEqual(['limit', 'page', 'view']); expect(params.get('view')).toBe('uni_product_coupons');
    expect(params.get('limit')).toBe('10'); const page = Number(params.get('page')); expect(page).toBeGreaterThan(0);
    expect(dto.data).toMatchObject({ version: 1, view: 'uni_product_coupons', uid: actor, productId: product, page, limit: 10 });
    const all = before.tables.store_coupon_issue!.filter(row => row.id >= ids.first && row.id < ids.first + 23 && row.remain_count > 0
      && (product === 70 || row.coupon_type !== 2)).sort((a, b) => b.sort - a.sort || b.id - a.id);
    expect(dto.data.total).toBe(all.length); const selected = all.slice((page - 1) * 10, page * 10);
    expect(dto.data.items.map((row: Row) => row.id)).toEqual(selected.map(row => row.id));
    for (const [index, issue] of selected.entries()) {
      const row = dto.data.items[index], received = actor ? before.tables.store_coupon_user!.filter(item => item.uid === actor && item.issue_coupon_id === issue.id).length : 0;
      const reason = received ? '已领取' : !actor ? '登录后领取' : issue.category === 2 ? '请先购买有效的付费会员后领取' : '';
      const rule = row.rule; expect(typeof rule).toBe('string'); expect(rule.length).toBeLessThanOrEqual(64000);
      if (issue.id === ids.rules) {
        expect(rule).toContain(prose); expect(rule).toContain('<h3>适用规则标题</h3>'); expect(rule).toContain('<li>不可与其他券叠加</li>'); expect(rule).toContain('<td>完整保留表格</td>');
        expect(rule).toContain('规则结束标记'); expect(rule).toMatch(/src="\/api\/assets\/990101\?expires=\d+&amp;signature=[A-Za-z0-9_-]+"/u);
        expect(rule).not.toMatch(/onerror|PRIVATE_(SCRIPT|STYLE|FRAME)_BODY|javascript:|<script|<style|<iframe/u);
      } else expect(rule).toBe(issue.rule);
      expect(row).toEqual({ id: issue.id, title: issue.coupon_title, scopeType: issue.coupon_type, benefitType: issue.type,
        benefitValue: money(issue.coupon_price), minimum: money(issue.use_min_price),
        validity: { kind: issue.day ? 'relative' : 'fixed', days: issue.day, startTime: issue.day ? null : epoch(issue.use_start_time), endTime: issue.day ? null : epoch(issue.use_end_time) },
        receivedCount: received, receiveLimit: issue.receive_limit, claimable: !reason, claimReason: reason, isMember: issue.category === 2, rule });
    }
    expect(Buffer.byteLength(JSON.stringify(dto.data))).toBeLessThanOrEqual(1048576);
    return { kind: 'actual-complete-product-coupon-directory', owner: actor, product_id: product, page, total: all.length, issue_ids: selected.map(row => row.id), scopes: selected.map(row => row.coupon_type) };
  }
  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    pending++;
    try {
      const bytes = await body(req);
      await serial(async () => {
        const before = await snapshot(); expect(before).toEqual(expected);
        const method = req.method ?? 'GET', headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (value !== undefined && key !== 'host') headers.set(key, Array.isArray(value) ? value.join(',') : value);
        const authorization = headers.get('authori-zation') ?? headers.get('authorization') ?? '', token = authorization.replace(/^Bearer\s+/iu, '');
        const actor = token ? [...tokens].find(([, value]) => token === value)?.[0] : 0;
        expect(actor).toBeDefined(); const owner = actor!;
        const path = url.pathname, write = method !== 'GET' && method !== 'HEAD', grant = write && path === '/api/coupon/receive';
        if (write) { expect(grant).toBe(true); expect(owner).toBe(uid); expect(url.search).toBe(''); }
        const productMatch = /^\/api\/product\/detail\/(70|80)(?:\/0)?$/u.exec(path), directoryMatch = /^\/api\/product\/detail\/(70|80)\/coupons$/u.exec(path);
        const receipt = path === '/api/product/detail/70/coupons/' + ids.lost + '/receipt', asset = path === '/api/assets/' + ids.asset;
        const started = Date.now(), input = write ? JSON.parse(bytes.toString('utf8')) : null;
        failedDispatch = { stage: stage(), method, path, query: url.search, started_at_ms: started, before_sha256: remember(before), request: { uid: owner,
          authorization_sha256: hash(authorization), body_sha256: hash(bytes), body_bytes: bytes.length, json: input, form_type: headers.get('form-type') } };
        const response = await s.fetch(new Request(url, { method, headers, ...(write ? { body: bytes } : {}) }));
        const raw = Buffer.from(await response.arrayBuffer()), ended = Date.now(), dto = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(raw.toString('utf8')) : null;
        const after = await snapshot(); let classification: Row;
        expect(response.status).toBe(200);
        if (grant) { expect(headers.get('form-type')).toBe('h5'); expect(dto?.status, dto?.msg).toBe(200); classification = grantOracle(before, after, input, owner, dto!, started, ended); }
        else if (productMatch) { expect(dto?.status, dto?.msg).toBe(200); expect(dto.data.id).toBe(Number(productMatch[1])); classification = visitOracle(before, after, Number(productMatch[1]), owner, started, ended); }
        else {
          expect(after).toEqual(before); classification = { kind: 'actual-read-only-application-GET' };
          if (directoryMatch) { expect(dto?.status, dto?.msg).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store'); classification = directoryOracle(before, owner, Number(directoryMatch[1]), url.searchParams, dto!); }
          if (receipt) {
            expect(owner).toBe(11); expect(uid).toBe(11); expect(stage()).toBe('recovered'); expect(url.search).toBe('');
            const owned = before.tables.store_coupon_user!.filter(row => row.uid === owner && row.issue_coupon_id === ids.lost); expect(owned).toHaveLength(1);
            expect(dto.data).toEqual({ version: 1, uid: owner, productId: 70, couponId: ids.lost, receivedCount: 1, latestCouponUserId: owned[0]!.id });
            expect(response.headers.get('cache-control')).toContain('no-store'); classification = { kind: 'actual-original-product-receipt', owner, product_id: 70, issue_id: ids.lost, coupon_user_id: owned[0]!.id };
          }
          if (asset) { expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']); expect(raw).toEqual(Buffer.from(buyerReviewPng)); expect(response.headers.get('content-type')).toContain('image/png'); classification = { kind: 'actual-signed-R2-read', attachment_id: ids.asset, object_key: objectName, bytes: raw.length, sha256: hash(raw) }; }
        }
        expect(r2.writes).toEqual([]); expect(r2.deletes).toEqual([]); expect(r2.objects.size).toBe(1); expect(r2.objects.get(objectName)!.bytes).toEqual(buyerReviewPng);
        expect(r2.reads.every(key => key === objectName)).toBe(true);
        let outgoing = raw, deliveredStatus = response.status, fault: string | null = null;
        if (directoryMatch && Number(directoryMatch[1]) === 70 && owner === 11 && url.searchParams.get('page') === '2' && nextMoreFault) {
          expect(stage()).toBe('more-failed'); nextMoreFault = false; deliveredStatus = 503; fault = 'single-page-response-503';
          outgoing = Buffer.from(JSON.stringify({ status: 503, msg: '本机样本：第二页暂不可用，请重试本页', data: null }));
        }
        if (grant && nextGrantFault) {
          expect(input.id).toBe(ids.lost); expect(stage()).toBe('lost-grant'); nextGrantFault = false; deliveredStatus = 503; fault = 'single-successful-grant-ack-lost';
          outgoing = Buffer.from(JSON.stringify({ status: 503, msg: '本机样本：领取成功回执丢失，请核对原领取', data: null }));
        }
        const trace = { ...failedDispatch, completed_at_ms: ended, after_sha256: remember(after), classification, synthetic_business_response: false,
          worker_response: { http_status: response.status, dto, bytes: raw.length, sha256: hash(raw), headers: Object.fromEntries(response.headers) },
          delivered: { http_status: deliveredStatus, bytes: outgoing.length, sha256: hash(outgoing), fault }, resources: resources() };
        traces.push(trace); if (fault) controls.push({ kind: 'qa-delivery-fault', nonproof: true, stage: stage(), trace_index: traces.length - 1, fault });
        expected = after; failedDispatch = undefined; await persist();
        const outgoingHeaders = Object.fromEntries(response.headers); delete outgoingHeaders['content-length'];
        res.writeHead(deliveredStatus, outgoingHeaders); res.end(outgoing);
      });
    } finally { pending--; }
  }
  async function capture(name: string, data: Row) {
    expect(name).toBe(stage()); expect(data.errors).toEqual([]); expect(data.overlay).toBe(false); expect(data.owner).toBe(uid);
    expect(data.href).toContain('/pages/goods/detail?id=' + data.product); expect([70, 80]).toContain(data.product);
    expect(data.clientWidth).toBe(data.scrollWidth); expect(data.frameWidth).toBe(name === 'desktop' ? 1280 : 375);
    const current = traces.filter(row => row.stage === name), list = (count: number, removed = false) => Array.from({ length: count }, (_, i) => ids.first + i + (removed ? 1 : 0));
    if (name === 'guest') { expect(data.owner).toBe(0); expect(data.issue_ids).toEqual(list(10)); expect(data.text).toContain('登录后领取'); }
    if (['owner-first', 'rules', 'more-failed'].includes(name)) { expect(data.total).toBe(23); expect(data.issue_ids).toEqual(list(10)); }
    if (name === 'owner-first') {
      expect(data.text).toContain('8.5 折'); expect(data.text).toContain('¥5.00'); expect(data.text).toContain('领取后 7 天内可用'); expect(data.text).toMatch(/\d{4}-\d{2}-\d{2} 至 \d{4}-\d{2}-\d{2} 可用/u);
      for (const scope of ['通用券', '品类券', '商品券', '品牌券']) expect(data.text).toContain(scope);
      expect(data.text).toContain('付费会员'); expect(data.received_issue_ids).toContain(ids.historical); expect(data.disabled_issue_ids).toContain(ids.member);
    }
    if (name === 'more-failed') { expect(data.text).toContain('第二页暂不可用'); expect(data.text).toContain('重新读取优惠券'); expect(current.filter(row => row.delivered.fault === 'single-page-response-503')).toHaveLength(1); }
    if (name === 'more-retried') { expect(data.issue_ids).toEqual(list(20)); expect(current.some(row => row.classification.kind === 'actual-complete-product-coupon-directory' && row.classification.page === 2 && row.delivered.http_status === 200)).toBe(true); }
    if (name === 'all-pages') { expect(data.total).toBe(23); expect(data.issue_ids).toEqual(list(23)); expect(data.text).toContain('已显示全部 23 张'); }
    if (name === 'normal-grant') { expect(data.phase).toBe('received'); expect(data.confirmedIssue).toBe(ids.normal); expect(data.confirmedOwned).toBe(one(expected.tables.store_coupon_user!, 'issue_coupon_id', ids.normal).id); expect(data.pendingIssue).toBe(0); expect(data.received_issue_ids).toContain(ids.normal); }
    if (['lost-grant', 'remounted-pending', 'other-product-pending', 'owner-a-relogin'].includes(name)) {
      expect(data.phase).toBe('uncertain'); expect(data.pendingIssue).toBe(ids.lost); expect(data.pendingProduct).toBe(70); expect(data.confirmedOwned).toBe(0);
      expect(data.text).toContain('核对领取状态'); if (name !== 'lost-grant') expect(data.issue_ids).not.toContain(ids.lost); expect(one(expected.tables.store_coupon_issue!, 'id', ids.lost).remain_count).toBe(0);
      expect(current.filter(row => row.method === 'POST')).toHaveLength(name === 'lost-grant' ? 1 : 0);
    }
    if (name === 'remounted-pending') { expect(data.product).toBe(70); expect(data.total).toBe(22); }
    if (['other-product-pending', 'owner-a-relogin'].includes(name)) { expect(data.product).toBe(80); expect(data.text).toContain('这是其他商品页面的原领取操作'); }
    if (name === 'owner-b') { expect(data.owner).toBe(22); expect(data.phase).toBe('idle'); expect(data.pendingIssue).toBe(0); expect(data.confirmedOwned).toBe(0); expect(data.received_issue_ids).toEqual([]); expect(data.text).not.toContain('待核对：'); }
    if (name === 'recovered') {
      expect(data.product).toBe(80); expect(data.phase).toBe('received'); expect(data.pendingIssue).toBe(0); expect(data.confirmedIssue).toBe(ids.lost);
      expect(data.confirmedOwned).toBe(one(expected.tables.store_coupon_user!, 'issue_coupon_id', ids.lost).id); expect(data.text).toContain('当前账号已领取该优惠券');
      expect(current.filter(row => row.classification.kind === 'actual-original-product-receipt')).toHaveLength(1); expect(current.filter(row => row.method === 'POST')).toEqual([]);
    }
    if (['rules', 'mobile', 'desktop'].includes(name)) {
      expect(data.expanded_rules).toContain(ids.rules); const rich = data.rules.find((row: Row) => row.id === ids.rules)!; expect(rich).toBeTruthy();
      expect(rich.text).toContain(prose); expect(rich.text).toContain('规则结束标记'); expect(rich.text).toContain('完整保留表格');
      expect(rich.text).not.toContain('PRIVATE_'); expect(rich.html).not.toMatch(/onerror|javascript:|<script|<style|<iframe/u); expect(data.unsafe).toBe(false);
      expect(data.images.some((row: Row) => row.rule && row.complete && row.naturalWidth > 0 && row.src.includes('/api/assets/' + ids.asset))).toBe(true);
    }
    expect(await snapshot()).toEqual(expected); evidence.push({ name, ...data, trace_indices: traces.flatMap((row, index) => row.stage === name ? [index] : []), snapshot_sha256: remember(expected) });
    await persist();
  }
  const shell = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Uni商品优惠券真实链验收</title><link rel="icon" href="data:,"><style>body{margin:0;font:13px sans-serif;background:#edf0f4}nav{display:flex;flex-wrap:wrap;gap:4px;padding:5px}button{padding:5px}iframe{display:block;border:0;width:375px;height:calc(100vh - 110px);background:white}pre{max-height:38px;overflow:auto;margin:0;white-space:pre-wrap;font-size:11px}</style></head><body><nav>${['guest','ownerA','remountA','otherA','ownerB','reloginA','mainA','failMore','loseGrant','mobile','desktop','finish'].map(name => '<button id="'+name+'">'+name+'</button>').join('')}${phases.map(name => '<button data-phase="'+name+'">记录 '+name+'</button>').join('')}</nav><pre id="result">正式H5/App/JWT/受限PG16/R2；仅合成会话和路由、两个单次响应故障为QA控制。</pre><iframe title="正式H5商品优惠券"></iframe><script>
const ctl=${JSON.stringify(control)},result=document.querySelector('#result');let frame=document.querySelector('iframe'),errors=[];
// QA controls observe the iframe without stealing its focus or causing a product revalidation.
document.querySelector('nav').addEventListener('mousedown',e=>{if(e.target.closest('button'))e.preventDefault()});
async function post(action,data){const r=await fetch(ctl+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});if(!r.ok)throw Error(await r.text());return r.json()}
function wire(n){n.onload=e=>{const w=e.currentTarget.contentWindow;w.addEventListener('error',e=>errors.push(String(e.message)));w.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)))}}wire(frame);
function open(id){errors=[];const old=frame,n=old.cloneNode(false);frame=n;wire(n);old.replaceWith(n);n.src='/__h5#/pages/goods/detail?id='+id}
async function session(owner,id){const d=await post('session',{uid:owner,product:id});if(owner){localStorage.setItem('uni_token',JSON.stringify({type:'string',data:d.token}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:owner}))}else{localStorage.removeItem('uni_token');localStorage.removeItem('uni_uid')}open(id)}
for(const [name,owner,id] of [['guest',0,70],['ownerA',11,70],['remountA',11,70],['otherA',11,80],['ownerB',22,80],['reloginA',11,80],['mainA',11,70]])document.getElementById(name).onclick=()=>session(owner,id).catch(e=>result.textContent=String(e));
for(const name of ['failMore','loseGrant','finish'])document.getElementById(name).onclick=async()=>{try{result.textContent=JSON.stringify(await post(name))}catch(e){result.textContent=String(e)}};
document.getElementById('mobile').onclick=()=>frame.style.width='375px';document.getElementById('desktop').onclick=()=>frame.style.width='1280px';
for(const button of document.querySelectorAll('[data-phase]'))button.onclick=async()=>{button.disabled=true;try{const d=frame.contentDocument,w=frame.contentWindow,shown=n=>{if(!n||n.getBoundingClientRect().width<=0||n.getBoundingClientRect().height<=0)return false;for(let p=n;p&&p.nodeType===1;p=p.parentElement){const s=w.getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden')return false}return true},page=[...d.querySelectorAll('uni-page')].filter(shown).at(-1)||d.body,coupons=[...page.querySelectorAll('[data-product-coupon-owner]')].filter(shown).at(-1),attr=k=>Number(coupons?.getAttribute('data-product-coupon-'+k)||0),rows=[...page.querySelectorAll('[data-product-coupon]')].filter(shown),rules=[...page.querySelectorAll('[data-product-coupon-rules]')].filter(shown),data={captured_at_ms:Date.now(),href:w.location.href,text:coupons?.innerText||page.innerText,owner:attr('owner'),product:attr('product'),phase:coupons?.getAttribute('data-product-coupon-phase')||'',pendingProduct:attr('pending-product'),pendingIssue:attr('pending-issue'),confirmedIssue:attr('confirmed-issue'),confirmedOwned:attr('confirmed-owned'),total:attr('total'),issue_ids:rows.map(n=>Number(n.getAttribute('data-product-coupon'))),received_issue_ids:rows.filter(n=>n.innerText.includes('已领取 · 查看我的优惠券')).map(n=>Number(n.getAttribute('data-product-coupon'))),disabled_issue_ids:rows.filter(n=>[...n.querySelectorAll('button,uni-button')].some(b=>((b.tagName==='BUTTON'&&b.disabled)||(b.tagName==='UNI-BUTTON'&&b.getAttribute('disabled')==='true'))&&b.innerText.includes('暂不可领'))).map(n=>Number(n.getAttribute('data-product-coupon'))),expanded_rules:rules.map(n=>Number(n.getAttribute('data-product-coupon-rules'))),rules:rules.map(n=>({id:Number(n.getAttribute('data-product-coupon-rules')),text:n.innerText,html:n.innerHTML})),frameWidth:frame.clientWidth,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,errors:[...errors],overlay:!!d.querySelector('vite-error-overlay'),unsafe:!!w.couponUnsafe,images:[...page.querySelectorAll('img')].filter(shown).map(n=>({src:n.src,currentSrc:n.currentSrc,complete:n.complete,naturalWidth:n.naturalWidth,naturalHeight:n.naturalHeight,rule:!!n.closest('[data-product-coupon-rules]')}))};result.textContent=JSON.stringify(await post('capture/'+button.dataset.phase,data))}catch(e){result.textContent=String(e)}finally{button.disabled=false}};
session(0,70).catch(e=>result.textContent=String(e));</script></body></html>`;
  const server = createServer((req, res) => { void (async () => {
    expect(req.socket.remoteAddress).toBe('127.0.0.1'); expect(req.headers.host).toBe(new URL(origin).host);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, shell, 200, 'text/html; charset=utf-8');
    if (path.startsWith(control + '/')) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin); expect(url.search).toBe('');
      const action = path.slice(control.length + 1), input = JSON.parse((await body(req)).toString('utf8'));
      if (action.startsWith('capture/')) return serial(async () => {
        if (pending || input.phase === 'claiming' || input.images?.some((row: Row) => !row.complete || row.naturalWidth <= 0))
          return json(res, { accepted: false, reason: 'business or image request pending', next: stage() });
        await capture(action.slice('capture/'.length), input); json(res, { accepted: true, next: stage(), complete: evidence.length === phases.length });
      });
      expect(pending).toBe(0); await serial(async () => {
        expect(await snapshot()).toEqual(expected);
        if (action === 'session') { expect(Object.keys(input).sort()).toEqual(['product', 'uid']); expect([0, 11, 22]).toContain(input.uid); expect([70, 80]).toContain(input.product);
          const allowed: Record<string, number[]> = { guest: [0, 70], 'owner-first': [11, 70], 'remounted-pending': [11, 70], 'other-product-pending': [11, 80], 'owner-b': [22, 80], 'owner-a-relogin': [11, 80], mobile: [11, 70] };
          expect([input.uid, input.product]).toEqual(allowed[stage() ?? '']);
          uid = input.uid; controls.push({ kind: 'qa-synthetic-session-and-route', nonproof: true, stage: stage(), uid, product: input.product, token_sha256: hash(tokens.get(uid) ?? '') }); json(res, { token: tokens.get(uid) ?? '' }); }
        else if (action === 'failMore') { expect(stage()).toBe('more-failed'); expect(nextMoreFault).toBe(false); expect(controls.some(row => row.kind === 'qa-arm-page-fault')).toBe(false);
          nextMoreFault = true; controls.push({ kind: 'qa-arm-page-fault', nonproof: true, stage: stage() }); json(res, { armed: 'page2-once' }); }
        else if (action === 'loseGrant') { expect(stage()).toBe('lost-grant'); expect(nextGrantFault).toBe(false); expect(controls.some(row => row.kind === 'qa-arm-grant-fault')).toBe(false);
          nextGrantFault = true; controls.push({ kind: 'qa-arm-grant-fault', nonproof: true, stage: stage() }); json(res, { armed: 'successful-grant-ack-once' }); }
        else if (action === 'finish') {
          expect(evidence).toHaveLength(phases.length); expect(nextMoreFault || nextGrantFault).toBe(false);
          expect(traces.filter(row => row.method === 'POST').map(row => row.classification.issue_id)).toEqual([ids.normal, ids.lost]);
          expect(traces.filter(row => row.classification.kind === 'actual-original-product-receipt')).toHaveLength(1);
          expect(traces.filter(row => row.delivered.fault)).toHaveLength(2); expect(r2.reads.length).toBeGreaterThan(0);
          expect(await manifest(sourcePaths)).toEqual(sourceBefore); expect(await manifest(buildPaths)).toEqual(buildBefore);
          expect(expected.tables.store_coupon_user).toHaveLength(3); expect(expected.tables.store_coupon_issue_user).toHaveLength(3);
          finished = true; await persist('passed'); json(res, { accepted: true, finished, posts: 2, tables: tableNames.length, sequences: sequenceNames.length }); done();
        } else throw Error('Unknown owned Uni coupon QA control');
        await persist();
      }); return;
    }
    if (path.startsWith('/api/')) return api(req, res, url);
    expect(method).toBe('GET'); if (path === '/favicon.ico') return send(res, '', 204, 'text/plain');
    const decoded = decodeURIComponent(path), target = decoded === '/__h5' ? resolve(dist, 'index.html') : resolve(dist, '.' + decoded);
    expect(target.startsWith(dist + sep)).toBe(true); const selected = await stat(target); expect(selected.isFile()).toBe(true);
    const raw = await readFile(target); staticPaths.push({ path, file: target.slice(repository.length + 1), bytes: raw.length, sha256: hash(raw) });
    send(res, raw, 200, ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf' } as Record<string, string>)[extname(target)] ?? 'application/octet-stream');
  })().catch(error => { failure ??= error; controls.push({ kind: 'server-error', path: req.url, stage: stage(), error: String(error) });
    void persist().then(() => fail(error), () => fail(error)); if (!res.headersSent) send(res, String(error), 500, 'text/plain'); else res.end(); }); });
  server.on('upgrade', (_req, socket) => { const error = Error('Uni coupon Browser forbids external sockets'); failure ??= error; fail(error); socket.destroy(); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Owned Uni coupon listener missing'); origin = 'http://127.0.0.1:' + address.port;
    await writeFile(prefix + 'ready.json', JSON.stringify({ origin, control, url: origin + control, prefix, phases, ids, expectedPosts: 2,
      fullTables: tableNames.length, fullSequences: sequenceNames.length, sourceCount: sourceBefore.length, buildCount: buildBefore.length,
      boundary: 'Formal built H5, actual App/JWT and commissioned restricted LOGIN/local R2. Synthetic sessions/routes and two finite actual-response delivery faults are controls. Two real different-issue grants, one original-product read-only receipt; no replay, payment, provider, Queue or production login claim.' }, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write('UNI_PRODUCT_COUPONS_BROWSER_READY ' + JSON.stringify({ url: origin + control, ids, phases }) + '\n');
    deadline = setTimeout(() => fail(Error('Uni product coupons Browser finish missing')), 90 * 60000); await completion; await queue;
    expect(await snapshot()).toEqual(expected);
  } catch (error) { failure ??= error; await writeFile(prefix + 'failed.json', JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : null,
    failedDispatch, traces, evidence, controls, snapshots_by_sha256: snapshots }, null, 2) + '\n', { mode: 0o600 }); throw error;
  } finally {
    if (deadline) clearTimeout(deadline); nextMoreFault = false; nextGrantFault = false; server.closeAllConnections();
    if (server.listening) await new Promise<void>(yes => server.close(() => yes()));
    await writeFile(prefix + 'cleanup.json', JSON.stringify({ finished, ownedListeners: 0, faultsCleared: !nextMoreFault && !nextGrantFault,
      queued: pending, failure: failure ? String(failure) : null, fixtureCleanup: 'withBuyerInvoices finally closes both LOGIN peers and owned schema' }, null, 2) + '\n', { mode: 0o600 });
  }
}), 92 * 60000);
