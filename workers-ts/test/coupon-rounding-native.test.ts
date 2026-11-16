import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL as NodeURL } from 'node:url';
import { Hono } from 'hono';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '@/env';
import { authMiddleware } from '@/middleware/auth';
import { adminRuntimeAuthMiddleware } from '@/middleware/admin-runtime-auth';
import { errorHandler } from '@/middleware/error';
import { createToken, md5 } from '@/utils/jwt';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { ScheduledMaintenanceService } from '@/services/order/ScheduledMaintenanceService';
import { authorizeCustomerWorkActor } from '@/services/customer-work/CustomerWorkScope';
import { adminAssistedCartAdd, adminAssistedConfirm, adminAssistedComputed,
  adminAssistedCoupons, adminAssistedCreate } from '@/controllers/api/v1/AdminController';
import * as ordinaryHttp from '@/controllers/api/v1/CustomerWorkOrdinaryCashierController';
import { storeCart, storeCouponIssue, storeCouponUser, storeOrder, storeOrderCartInfo,
  storeProduct, storeProductAttrValue, storePromotions, storePromotionsAuxiliary,
  systemConfig, user, userBill } from '@/models/schema';
import { withBuyerInvoices } from './helpers/buyerInvoices';
import { customerCashierOrdinaryFixture } from './helpers/customerCashierOrdinaryFixture';
import { couponLegacyRuntimeSource } from './helpers/couponLegacyRuntimeSource';

type Buyer = Parameters<Parameters<typeof withBuyerInvoices>[0]>[0];
type KvEvent = { operation: 'put' | 'delete'; key: string; ttl?: number };
type Harness = { s: Buyer; events: KvEvent[]; sequenceCalls(): number };
const ISSUE = 956100, OWNED = 956101, FOREIGN = 956102;
const money = (cents: number) => (cents / 100).toFixed(2);
function parsedCartInfo(value: string | null) {
  if (typeof value !== 'string') throw Error('Actual persisted cart info must be textual');
  return JSON.parse(value);
}
const CONFIG_TRANSPORT_KEYS = ['store_func_status', 'store_self_mention', 'member_func_status', 'member_card_status', 'svip_price_status',
  'integral_ratio_status', 'integral_ratio', 'integral_max_type', 'integral_max_num', 'integral_max_rate', 'whole_free_shipping',
  'store_free_postage', 'offline_postage', 'newcomer_status', 'first_order_status', 'first_order_discount', 'first_order_discount_limit',
  'newcomer_limit_status', 'newcomer_limit_time', 'brokerage_func_status', 'store_brokerage_statu', 'brokerage_level',
  'brokerage_compute_type', 'store_brokerage_ratio'];

/** refundRuntimeFixture exposes its real KV transport, not its inner quote
 * fixture's private config object/setter. Maintain actual SQL source rows and
 * populate only that same cache transport; no pricing service is replaced. */
async function configure(s: Buyer, values: Record<string, string>) {
  for (const [menuName, value] of Object.entries(values)) {
    const changed = await s.f.db.update(systemConfig).set({ value }).where(eq(systemConfig.menuName, menuName)).returning({ id: systemConfig.id });
    if (!changed.length) await s.f.db.insert(systemConfig).values({ menuName, value });
    await s.env.CONFIG_KV.put('cfg_' + menuName, value);
  }
}

/** Reuse the helper's original commissioned pair. Recommissioning additional
 * peers would change the exact reviewed catalog instead of testing transport. */
async function assertCommissionedPeers(s: Buyer) {
  const names = { app: s.appRole, admin: s.adminRole, maintenance: 'finance_test' };
  for (const [kind, container, role] of [['app', s.appContainer, s.appRole], ['admin', s.adminContainer, s.adminRole]] as const) {
    expect(await auditRuntimeBusinessPrivileges(container.db, kind, names)).toMatchObject({ ready: true, failures: [] });
    const [identity] = await container.db.execute(sql`SELECT current_user AS role,session_user AS session`);
    expect(identity).toEqual({ role, session: role });
  }
}

/** Only source fixtures are maintained with the owner connection. Every money,
 * eligibility, quote, reserve, idempotency and cancellation result is produced
 * by a real service on the independently commissioned application LOGIN. */
async function prepare(s: Buyer): Promise<Harness> {
  expect(s.f.format).toBe('pg16');
  const [identity] = await s.appContainer.db.execute(sql`SELECT current_user AS role, session_user AS session`);
  expect(identity).toEqual({ role: s.appRole, session: s.appRole });
  const [role] = await s.f.exec(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls FROM pg_roles WHERE rolname='${s.appRole}'`);
  expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolbypassrls: false });
  await s.f.db.update(storeCouponIssue).set({ status: 0 });
  await s.f.db.update(user).set({ isEverLevel: 0, isMoneyLevel: 0, level: 0, isFirstOrder: 0 }).where(eq(user.uid, 11));
  await configure(s, { member_func_status: '0', newcomer_status: '0', first_order_status: '0', integral_ratio_status: '0' });
  await s.f.db.update(storeProduct).set({ price: '19.99', freight: 1, isVip: 0, giveIntegral: '0.00',
    isSub: 0, deliveryType: '1,2,3' }).where(eq(storeProduct.id, 70));
  await s.f.db.update(storeProductAttrValue).set({ price: '19.99', vipPrice: '19.99', brokerage: '0.00' }).where(eq(storeProductAttrValue.id, 1));
  await s.f.db.update(storeCart).set({ cartNum: 1 }).where(eq(storeCart.id, 1));
  await s.f.db.insert(storeCouponIssue).values({ id: ISSUE, title: '本机 PHP 百分比精度', couponTitle: '本机 PHP 百分比精度',
    category: 1, type: 2, couponType: 0, couponPrice: '85.99', useMinPrice: '0.00', status: 1, receiveType: 1,
    day: 7, receiveLimit: 1, totalCount: 5, remainCount: 5 });
  await s.f.db.insert(storeCouponUser).values([
    { id: OWNED, uid: 11, issueCouponId: ISSUE, couponPrice: '85.99', useMinPrice: '0.00', type: 2 },
    { id: FOREIGN, uid: 22, issueCouponId: ISSUE, couponPrice: '1.00', useMinPrice: '0.00', type: 2 },
  ]);
  let serial = 0;
  Object.assign(s.env, { SEQUENCE: { idFromName: () => 'owned-coupon-rounding',
    get: () => ({ fetch: async () => new Response(`coupon_rounding_${++serial}`) }) } });
  const original = s.env.CONFIG_KV, events: KvEvent[] = [];
  Object.assign(s.env, { CONFIG_KV: { ...original,
    put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
      events.push({ operation: 'put', key, ttl: options?.expirationTtl }); await original.put(key, value, options);
    },
    delete: async (key: string) => { events.push({ operation: 'delete', key }); await original.delete(key); },
  } });
  return { s, events, sequenceCalls: () => serial };
}

/** Includes every table and every nontransactional sequence in the full
 * migration database. A read cannot hide writes in a table omitted by a list. */
function snapshotRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw Error('Actual snapshot SQL result must be rows');
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('Actual snapshot SQL row must be a record');
    return row as Record<string, unknown>;
  });
}
async function databaseSnapshot(exec: (statement: string) => Promise<unknown>, expectedTables?: number) {
  const relations = snapshotRows(await exec("SELECT relname AS name,relkind AS kind FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','S') ORDER BY relname"));
  if (expectedTables !== undefined) expect(relations.filter(row => row.kind === 'r')).toHaveLength(expectedTables);
  expect(relations.some(row => row.kind === 'r')).toBe(true);
  expect(relations.some(row => row.kind === 'S')).toBe(true);
  const result: Record<string, unknown> = {};
  for (const row of relations) {
    const name = String(row.name); expect(name).toMatch(/^[a-z][a-z0-9_]*$/u);
    result[name] = snapshotRows(await exec(row.kind === 'S' ? `SELECT last_value,is_called FROM public."${name}"`
      : `SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`));
  }
  return result;
}
const snapshot = (s: Buyer) => databaseSnapshot(s.f.exec, 283);

type LegacyQuote = { version: number; mode: 'quote' | 'create'; ref: string; sources: Record<string, string>;
  bundle: { entryPoint: string; format: string; platform: string; target: string; packages: string; esbuildVersion: string;
    inputCount: number; inputs: Record<string, string>; inputManifestSha256: string; bundleSha256: string;
    externalImports: string[]; emittedExternalAliases: string[]; allInputsTrackedInFixedRepository: boolean;
    allTrackedFilesCleanAtFixedRef: boolean; sourceScopesHaveNoUntrackedFiles: boolean; temporaryDirectoryRemoved: boolean };
  identity: { role: string; session: string; database: string }; externalCalls: number; sequenceCalls: number;
  selection: ReturnType<typeof selection>; confirm: { orderKey: string; quoteToken: string; priceGroup: { couponPrice: string; pay_price: string } };
  computed: { orderKey: string; quoteToken: string; couponPrice: string; pay_price: string };
  replies: Array<{ path: string; httpStatus: number; body: string; sha256: string }>;
  puts: Array<{ key: string; value: string; ttl: number }>; records: Array<[string, string]>;
  created?: { orderId: string; key: string };
  createdState?: { order: { id: number; uid: number; order_id: string; unique: string; paid: number; coupon_price: string; pay_price: string };
    lines: Array<{ cart_info: string; cart_num: number; product_id: number }> } };

function assertLegacyBundle(result: LegacyQuote) {
  const bundle = result.bundle;
  expect(bundle).toMatchObject({ entryPoint: 'workers-ts/src/app.ts', format: 'esm', platform: 'node', target: 'node24', packages: 'external',
    esbuildVersion: '0.28.2', inputCount: 1796, emittedExternalAliases: [], allInputsTrackedInFixedRepository: true,
    allTrackedFilesCleanAtFixedRef: true, sourceScopesHaveNoUntrackedFiles: true, temporaryDirectoryRemoved: true });
  const names = Object.keys(bundle.inputs);
  expect(names).toHaveLength(1796); expect(new Set(names).size).toBe(1796);
  expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right, 'en')));
  for (const [path, sha] of Object.entries(bundle.inputs)) {
    expect(path.startsWith('workers-ts/src/') || path.startsWith('view/common/')).toBe(true);
    expect(path.split('/')).not.toContain('..'); expect(path).not.toContain('ci-readonly-key');
    expect(sha).toMatch(/^[a-f0-9]{64}$/u);
  }
  expect(names.some(path => path.startsWith('view/common/'))).toBe(true);
  expect(createHash('sha256').update(JSON.stringify(bundle.inputs)).digest('hex')).toBe(bundle.inputManifestSha256);
  expect(bundle.bundleSha256).toMatch(/^[a-f0-9]{64}$/u);
  for (const [path, sha] of Object.entries(result.sources)) {
    if (path !== 'workers-ts/tsconfig.json') expect(bundle.inputs[path]).toBe(sha);
  }
  expect(bundle.externalImports).toEqual([...new Set(bundle.externalImports)].sort());
  expect(bundle.externalImports).toEqual(expect.arrayContaining(['hono', 'drizzle-orm', 'postgres', 'node:crypto']));
  expect(bundle.externalImports.every(path => !/^(?:@\/|\.|\/|file:)/u.test(path))).toBe(true);
}

/** No child command argument/env carries a database secret. A fresh process
 * loads the unmodified old source, independently authenticates its LOGIN/JWT,
 * and returns exactly its actual KV transport writes through a bounded pipe. */
async function legacyQuote(s: Buyer, connectionString: string, role: string, mode: 'quote' | 'create' = 'quote'): Promise<LegacyQuote> {
  const source = await couponLegacyRuntimeSource();
  try {
  const old = source.root;
  const workers = join(old, 'workers-ts'), helper = fileURLToPath(new NodeURL('./helpers/couponLegacyRuntimeQuote.ts', import.meta.url));
  const config: Array<[string, string | null]> = [];
  const rows = await s.f.db.select({ name: systemConfig.menuName }).from(systemConfig);
  // Seeded configuration form metadata also contains empty menu names. Carry
  // real named keys without imposing a new naming rule on the legacy cache.
  const names = [...new Set([...CONFIG_TRANSPORT_KEYS, ...rows.map(row => row.name)])].filter(name => name.length > 0).sort();
  expect(names.length).toBeLessThanOrEqual(5000);
  for (const name of names) {
    if (name.length > 256 || /[\x00-\x1f\x7f]/u.test(name)) throw Error('Owned config key is invalid');
    const value = await s.env.CONFIG_KV.get('cfg_' + name);
    if (value !== null && typeof value !== 'string') throw Error('Owned config transport must be textual');
    config.push(['cfg_' + name, value]);
  }
  // Generated Worker declarations require production-only env keys. This
  // separate Node child deliberately receives only the five transport keys.
  const childEnv = { PATH: process.env.PATH, LANG: process.env.LANG, TZ: process.env.TZ,
    NODE_OPTIONS: '--max-old-space-size=8192', TSX_TSCONFIG_PATH: join(workers, 'tsconfig.json') } as unknown as NodeJS.ProcessEnv;
  return await new Promise<LegacyQuote>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(join(workers, 'node_modules/tsx/dist/loader.mjs')).href, helper], {
      cwd: workers, env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false, overflow = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 90_000);
    const append = (stream: 'out' | 'err', chunk: Buffer) => {
      if (stream === 'out') stdout += chunk.toString(); else stderr += chunk.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 2 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', (chunk: Buffer) => append('out', chunk)); child.stderr.on('data', (chunk: Buffer) => append('err', chunk));
    child.on('error', () => { clearTimeout(timeout); reject(Error('Old runtime child could not start')); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || signal || timedOut || overflow) {
        const failure = stderr.split('\n').find(line => line.startsWith('COUPON_LEGACY_RUNTIME_FAILURE '));
        let stage = 'loader-or-process', label = 'unknown', errorCode = 'unavailable';
        if (failure) { try { const value = JSON.parse(failure.slice('COUPON_LEGACY_RUNTIME_FAILURE '.length));
          if (typeof value.stage === 'string' && /^[a-z_]+$/.test(value.stage)) stage = value.stage;
          if (typeof value.label === 'string' && /^[a-z_]+$/.test(value.label)) label = value.label;
          if (typeof value.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value.code)) errorCode = value.code;
        } catch { /* Never echo secret-bearing error output. */ } }
        reject(Error(`Old runtime child failed: exit=${code}, signal=${signal}, stage=${stage}, label=${label}, code=${errorCode}, timeout=${timedOut}, overflow=${overflow}`)); return;
      }
      try {
        const prefix = 'COUPON_LEGACY_RUNTIME_RESULT ', lines = stdout.split('\n').filter(line => line.startsWith(prefix));
        if (lines.length !== 1) throw Error('Old runtime did not emit exactly one result');
        resolve(JSON.parse(lines[0].slice(prefix.length)) as LegacyQuote);
      } catch { reject(Error('Old runtime result protocol was invalid')); }
    });
    child.stdin.on('error', () => { /* Exit/close above owns the terminal diagnostic. */ });
    child.stdin.end(JSON.stringify({ connectionString, role, appKey: s.env.APP_KEY, uid: 11, config, selection: selection(), mode }));
  });
  } finally { await source.release(); }
}
async function readOnly<T>(h: Harness, work: () => Promise<T>, puts = 0) {
  const before = await snapshot(h.s), start = h.events.length, result = await work();
  expect(await snapshot(h.s)).toEqual(before);
  const events = h.events.slice(start); expect(events).toHaveLength(puts);
  expect(events.every(event => event.operation === 'put' && event.ttl === 1800)).toBe(true);
  return result;
}
async function ok(s: Buyer, path: string, body?: unknown, bearer?: string | null) {
  const reply = await s.request(path, body, bearer); expect(reply.status, `${path}: ${reply.msg}`).toBe(200); return reply.data;
}
const selection = (ids: number[] = [1], couponId = OWNED) => ({ cartIds: ids, type: 0, addressId: 11,
  shippingType: 1, storeId: 0, couponId, useIntegral: false });
async function quoted(h: Harness, ids: number[], expected: { gross: number; coupon: number; pay: number; first?: number }, couponId = OWNED) {
  const body = selection(ids, couponId);
  return readOnly(h, async () => {
    const coupons = await ok(h.s, `/api/coupons/order/0?cartId=${ids.join(',')}&new=1&shipping_type=1&store_id=0&limit=20`);
    expect(Array.isArray(coupons)).toBe(true);
    if (expected.coupon > 0) expect(coupons.find((row: { id: number }) => row.id === OWNED))
      .toMatchObject({ estimated_discount: money(expected.coupon) });
    else expect(coupons).toEqual([]);
    expect(coupons.some((row: { id: number }) => row.id === FOREIGN)).toBe(false);
    const confirm = await ok(h.s, '/api/order/confirm', body);
    expect(confirm.priceGroup).toMatchObject({ totalPrice: money(expected.gross), couponPrice: money(expected.coupon),
      firstOrderPrice: money(expected.first ?? 0), pay_price: money(expected.pay), deduction_price: '0.00' });
    const computed = await ok(h.s, '/api/order/computed/' + confirm.orderKey, body);
    expect(computed).toMatchObject({ orderKey: confirm.orderKey, totalPrice: money(expected.gross), couponPrice: money(expected.coupon),
      firstOrderPrice: money(expected.first ?? 0), pay_price: money(expected.pay), deduction_price: '0.00' });
    expect(computed.quoteToken).not.toBe(confirm.quoteToken);
    expect(h.events.slice(-3).map(event => event.key)).toEqual([
      `order:confirm:11:${confirm.orderKey}`, `order:quote:v1:11:0:${confirm.orderKey}:${confirm.quoteToken}`,
      `order:quote:v1:11:0:${confirm.orderKey}:${computed.quoteToken}`,
    ]);
    return { body, key: confirm.orderKey as string, quoteToken: computed.quoteToken as string };
  }, 3);
}
async function resources(s: Buyer, ids: number[]) {
  return {
    products: await s.f.db.select({ id: storeProduct.id, stock: storeProduct.stock, sales: storeProduct.sales }).from(storeProduct).orderBy(asc(storeProduct.id)),
    skus: await s.f.db.select({ id: storeProductAttrValue.id, stock: storeProductAttrValue.stock, sales: storeProductAttrValue.sales }).from(storeProductAttrValue).orderBy(asc(storeProductAttrValue.id)),
    carts: await s.f.db.select({ id: storeCart.id, isPay: storeCart.isPay }).from(storeCart).where(inArray(storeCart.id, ids)).orderBy(asc(storeCart.id)),
    coupons: await s.f.db.select().from(storeCouponUser).orderBy(asc(storeCouponUser.id)),
    buyer: await s.f.db.select({ uid: user.uid, integral: user.integral, nowMoney: user.nowMoney }).from(user).where(eq(user.uid, 11)),
    bills: await s.f.db.select().from(userBill).orderBy(asc(userBill.id)),
  };
}
async function createAndCancel(h: Harness, quote: Awaited<ReturnType<typeof quoted>>, expected: { pay: number; coupon: number; shares: string[]; first?: number }) {
  const before = await resources(h.s, quote.body.cartIds), payload = { ...quote.body, quoteToken: quote.quoteToken };
  expect(payload).not.toHaveProperty('payType');
  const foreign = await h.s.token(22);
  await readOnly(h, async () => {
    expect((await h.s.request('/api/order/create/' + quote.key, payload, foreign)).status).not.toBe(200);
  });
  const created = await ok(h.s, '/api/order/create/' + quote.key, payload);
  const [order] = await h.s.f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
  expect(order).toMatchObject({ uid: 11, type: 0, paid: 0, payPrice: money(expected.pay), couponPrice: money(expected.coupon),
    firstOrderPrice: money(expected.first ?? 0) });
  expect(Number(order.payPrice)).toBeGreaterThan(0);
  const lines = await h.s.f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id)).orderBy(asc(storeOrderCartInfo.id));
  expect(lines.map(line => parsedCartInfo(line.cartInfo).coupon_price)).toEqual(expected.shares);
  expect(lines.map(line => Number(parsedCartInfo(line.cartInfo).coupon_price)).reduce((a, b) => a + Math.round(b * 100), 0)).toBe(expected.coupon);
  for (const line of lines) {
    const financial = parsedCartInfo(line.cartInfo);
    expect(Number(financial.sum_true_price)).toBeGreaterThanOrEqual(0);
    const grossCents = Math.round(Number(financial.sku.price) * 100) * line.cartNum;
    expect(Math.round(Number(financial.coupon_price) * 100)).toBeLessThanOrEqual(grossCents);
    expect(Math.round(Number(financial.sum_true_price) * 100)
      + Math.round(Number(financial.coupon_price) * 100)
      + Math.round(Number(financial.first_order_price) * 100)
      + Math.round(Number(financial.integral_price) * 100)).toBe(grossCents);
  }
  await readOnly(h, async () => { expect(await ok(h.s, '/api/order/create/' + quote.key, payload)).toEqual(created); });
  expect((await h.s.f.db.select().from(storeOrder).where(eq(storeOrder.unique, quote.key)))).toHaveLength(1);
  await ok(h.s, '/api/order/cancel', { id: order.orderId });
  expect(await resources(h.s, quote.body.cartIds)).toEqual(before);
  expect((await h.s.f.db.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0])
    .toMatchObject({ paid: 0, status: -2, isDel: 1 });
  await readOnly(h, async () => { expect((await h.s.request('/api/order/cancel', { id: order.orderId })).status).not.toBe(200); });
  return order;
}
async function setFirstOrder(s: Buyer, payPercent: string) {
  const values = { newcomer_status: '1', first_order_status: '1', newcomer_limit_status: '0',
    newcomer_limit_time: '0', first_order_discount: payPercent, first_order_discount_limit: '100.00' };
  await configure(s, values);
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('coupon PHP amount and line precision on actual restricted PG16 consumers', () => {
  it('uses stored owned percentages in picker/confirm/computed/create/cancel and rounds after quantity aggregation', async () => withBuyerInvoices(async s => {
    const h = await prepare(s);
    // A changed current template cannot replace the issued owner's value.
    await s.f.db.update(storeCouponIssue).set({ couponPrice: '50.00' }).where(eq(storeCouponIssue.id, ISSUE));
    for (const sample of [
      { unit: '19.99', quantity: 1, gross: 1999, coupon: 300, pay: 1699 },
      { unit: '19.99', quantity: 2, gross: 3998, coupon: 600, pay: 3398 },
      { unit: '10.01', quantity: 2, gross: 2002, coupon: 301, pay: 1701 },
    ]) {
      await s.f.db.update(storeProduct).set({ price: sample.unit }).where(eq(storeProduct.id, 70));
      await s.f.db.update(storeProductAttrValue).set({ price: sample.unit, vipPrice: sample.unit }).where(eq(storeProductAttrValue.id, 1));
      await s.f.db.update(storeCart).set({ cartNum: sample.quantity }).where(eq(storeCart.id, 1));
      const q = await quoted(h, [1], sample);
      await createAndCancel(h, q, { ...sample, shares: [money(sample.coupon)] });
    }
  }), 180_000);

  it('uses the PHP line-weight truncation for actual 6-cent rows, gift thresholds and persisted order lines', async () => withBuyerInvoices(async s => {
    const h = await prepare(s), now = Math.floor(Date.now() / 1000);
    await s.f.db.update(storeProduct).set({ price: '0.06', freight: 1, isVip: 0, giveIntegral: '0.00', deliveryType: '1,2,3' }).where(inArray(storeProduct.id, [70, 71]));
    await s.f.db.update(storeProductAttrValue).set({ price: '0.06', vipPrice: '0.06' }).where(inArray(storeProductAttrValue.id, [1, 2]));
    await s.f.db.update(storeCart).set({ cartNum: 1, isNew: 0 }).where(inArray(storeCart.id, [1, 2]));
    await s.f.db.insert(storePromotions).values({ id: 956110, pid: 0, type: 1, storeId: 0, promotionsType: 4, promotionsCate: 1,
      name: '精度分摊后的指定商品满送', thresholdType: 1, threshold: '0.06', giveIntegral: 5, productPartakeType: 2,
      startTime: now - 60, stopTime: now + 3600, status: 1, isDel: 0, updateTime: now });
    await s.f.db.insert(storePromotionsAuxiliary).values({ promotionsId: 956110, type: 1, productId: 70, unique: 'qared001', isAll: 1 });
    await readOnly(h, async () => {
      const budget = await ok(s, '/api/cart/compute', { cartId: '1,2' });
      expect(budget).toMatchObject({ deduction: { sum_price: 0.12, coupon_price: 0.02, pay_price: 0.10 },
        budget: { couponIssueId: ISSUE, couponUserId: OWNED, requiresCouponClaim: false, gifts: [] } });
    });
    await s.f.db.update(storePromotions).set({ threshold: '0.05' }).where(eq(storePromotions.id, 956110));
    await readOnly(h, async () => {
      const budget = await ok(s, '/api/cart/compute', { cartId: '1,2' });
      expect(budget.budget.gifts).toMatchObject([{ id: 956110, giveIntegral: 5 }]);
    });
    await s.f.db.update(storePromotions).set({ threshold: '0.06' }).where(eq(storePromotions.id, 956110));
    await s.f.db.update(storeCart).set({ isNew: 1 }).where(inArray(storeCart.id, [1, 2]));
    const q = await quoted(h, [1, 2], { gross: 12, coupon: 2, pay: 10 });
    const order = await createAndCancel(h, q, { coupon: 2, pay: 10, shares: ['0.01', '0.01'] });
    expect(order.giveIntegral).toBe(0);
  }), 180_000);

  it('conserves a full 0.99-percent coupon while moving only the overflowing final-line residue', async () => withBuyerInvoices(async s => {
    const h = await prepare(s);
    await s.f.db.update(storeCouponUser).set({ couponPrice: '0.99' }).where(eq(storeCouponUser.id, OWNED));
    await s.f.db.update(storeProduct).set({ price: '100.01', freight: 2, postage: '3.00' }).where(eq(storeProduct.id, 70));
    await s.f.db.update(storeProduct).set({ price: '0.01', freight: 1, deliveryType: '1,2,3' }).where(eq(storeProduct.id, 71));
    await s.f.db.update(storeProductAttrValue).set({ price: '100.01', vipPrice: '100.01' }).where(eq(storeProductAttrValue.id, 1));
    await s.f.db.update(storeProductAttrValue).set({ price: '0.01', vipPrice: '0.01' }).where(eq(storeProductAttrValue.id, 2));
    await s.f.db.update(storeCart).set({ cartNum: 1 }).where(inArray(storeCart.id, [1, 2]));
    const q = await quoted(h, [1, 2], { gross: 10002, coupon: 10002, pay: 300 });
    // Raw PHP scale4 shares are100.00+0.02. The established capacity guard
    // moves the overflowing cent back; merchandise net stays zero on both.
    await createAndCancel(h, q, { coupon: 10002, pay: 300, shares: ['100.01', '0.01'] });
  }), 180_000);

  it('keeps actual first-order 2.99 and zero-saving eligibility exclusive of ordinary coupons and gifts', async () => withBuyerInvoices(async s => {
    const h = await prepare(s), now = Math.floor(Date.now() / 1000);
    await s.f.db.insert(storePromotions).values({ id: 956111, pid: 0, type: 1, storeId: 0, promotionsType: 4, promotionsCate: 1,
      name: '首单不叠加赠送', thresholdType: 1, threshold: '1.00', giveIntegral: 7, productPartakeType: 1,
      startTime: now - 60, stopTime: now + 3600, status: 1, isDel: 0, updateTime: now });
    for (const sample of [{ percent: '85.99', first: 299, pay: 1700 }, { percent: '100.00', first: 0, pay: 1999 }]) {
      await setFirstOrder(s, sample.percent);
      await s.f.db.update(user).set({ isFirstOrder: 0 }).where(eq(user.uid, 11));
      const q = await quoted(h, [1], { gross: 1999, coupon: 0, first: sample.first, pay: sample.pay });
      const order = await createAndCancel(h, q, { coupon: 0, first: sample.first, pay: sample.pay, shares: ['0.00'] });
      expect(order.giveIntegral).toBe(0);
    }
  }), 180_000);

  it('rejects a genuinely drifted quote and preserves the original created result after coupon-source changes', async () => withBuyerInvoices(async s => {
    const h = await prepare(s), q = await quoted(h, [1], { gross: 1999, coupon: 300, pay: 1699 });
    await s.f.db.update(storeCouponUser).set({ couponPrice: '84.99' }).where(eq(storeCouponUser.id, OWNED));
    await readOnly(h, async () => {
      const failed = await s.request('/api/order/create/' + q.key, { ...q.body, quoteToken: q.quoteToken });
      expect(failed.status).not.toBe(200);
      expect(failed.data).toMatchObject({ errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: q.key });
    });
    const current = await readOnly(h, () => ok(s, '/api/order/computed/' + q.key, q.body), 1);
    expect(current).toMatchObject({ couponPrice: '3.20', pay_price: '16.79' });
    const payload = { ...q.body, quoteToken: current.quoteToken }, created = await ok(s, '/api/order/create/' + q.key, payload);
    const [order] = await s.f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    expect(order).toMatchObject({ paid: 0, couponPrice: '3.20', payPrice: '16.79' });
    await s.f.db.update(storeCouponIssue).set({ type: 1, couponPrice: '0.01', status: 0 }).where(eq(storeCouponIssue.id, ISSUE));
    await s.f.db.update(storeCouponUser).set({ couponPrice: '0.01' }).where(eq(storeCouponUser.id, OWNED));
    await readOnly(h, async () => { expect(await ok(s, '/api/order/create/' + q.key, payload)).toEqual(created); });
    expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.unique, q.key)))).toHaveLength(1);
    expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0].payPrice).toBe('16.79');
    await ok(s, '/api/order/cancel', { id: order.orderId });
    expect((await s.f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id, OWNED)))[0].status).toBe(0);
  }), 180_000);

  it('rejects an actual fixed-old-runtime 2.99 quote without writes, then refreshes the same original key to 3.00', async () => withBuyerInvoices(async s => {
    const h = await prepare(s);
    const [database] = await s.f.exec('SELECT current_database() AS name');
    await assertCommissionedPeers(s);
    const old = await readOnly(h, async () => {
      const result = await legacyQuote(s, s.appConnectionString, s.appRole);
      expect(result).toMatchObject({ version: 1, ref: '41f4d25ae1daab3067f5ea745d30cabd77c93b80', externalCalls: 0, sequenceCalls: 0,
        identity: { role: s.appRole, session: s.appRole, database: String(database.name) }, selection: selection() });
      expect(result.sources['workers-ts/src/services/activity/ProductCouponService.ts'])
        .toBe('aec6e37c95104b8865e4c5ae5629eb0beb4bb6520fd36bb6e21896e9c8577a39');
      expect(Object.keys(result.sources)).toHaveLength(10);
      expect(Object.values(result.sources).every(sha => /^[a-f0-9]{64}$/.test(sha))).toBe(true);
      assertLegacyBundle(result);
      expect(result.confirm.priceGroup).toMatchObject({ couponPrice: '2.99', pay_price: '17.00' });
      expect(result.computed).toMatchObject({ orderKey: result.confirm.orderKey, couponPrice: '2.99', pay_price: '17.00' });
      expect(result.replies).toHaveLength(2);
      for (const reply of result.replies) {
        expect(reply.httpStatus).toBe(200); expect(createHash('sha256').update(reply.body).digest('hex')).toBe(reply.sha256);
        expect(JSON.parse(reply.body).status).toBe(200);
      }
      expect(result.puts.map(put => put.key)).toEqual([
        `order:confirm:11:${result.confirm.orderKey}`,
        `order:quote:v1:11:0:${result.confirm.orderKey}:${result.confirm.quoteToken}`,
        `order:quote:v1:11:0:${result.confirm.orderKey}:${result.computed.quoteToken}`,
      ]);
      expect(result.records).toEqual(result.puts.map(put => [put.key, put.value]));
      for (const put of result.puts) {
        expect(put.ttl).toBe(1800);
        expect(await s.env.CONFIG_KV.get(put.key)).toBeNull();
        // This restores only byte-identical values produced by the real old
        // service. No amount, fingerprint, token, actor or timestamp is edited.
        await s.env.CONFIG_KV.put(put.key, put.value, { expirationTtl: put.ttl });
      }
      return result;
    }, 3);
    const payload = { ...selection(), quoteToken: old.computed.quoteToken };
    await readOnly(h, async () => {
      const rejected = await s.request('/api/order/create/' + old.confirm.orderKey, payload);
      expect(rejected.status).not.toBe(200);
      expect(rejected.data).toMatchObject({ errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: old.confirm.orderKey });
    });
    const current = await readOnly(h, () => ok(s, '/api/order/computed/' + old.confirm.orderKey, selection()), 1);
    expect(current).toMatchObject({ orderKey: old.confirm.orderKey, couponPrice: '3.00', pay_price: '16.99' });
    expect(current.quoteToken).not.toBe(old.computed.quoteToken);
    for (const put of old.puts) expect(await s.env.CONFIG_KV.get(put.key)).toBe(put.value);
    await createAndCancel(h, { body: selection(), key: old.confirm.orderKey, quoteToken: current.quoteToken },
      { coupon: 300, pay: 1699, shares: ['3.00'] });
    console.log('COUPON_ROUNDING_ACTUAL_OLD_RUNTIME ' + JSON.stringify({ ref: old.ref, sources: old.sources, bundle: old.bundle,
      identity: old.identity, responseSha256: old.replies.map(reply => reply.sha256), oldCoupon: old.computed.couponPrice,
      oldPay: old.computed.pay_price, newCoupon: current.couponPrice, newPay: current.pay_price,
      actualOldHttpRequests: old.replies.length, oldExternalCalls: old.externalCalls, oldSequenceCalls: old.sequenceCalls }));
  }), 180_000);

  it('returns a genuinely old-created 17.00 order under the new runtime without repricing or repeating its claims', async () => withBuyerInvoices(async s => {
    const h = await prepare(s), before = await resources(s, [1]);
    expect(h.sequenceCalls()).toBe(0);
    const [database] = await s.f.exec('SELECT current_database() AS name');
    await assertCommissionedPeers(s);
    // This is an actual old-version write, deliberately outside readOnly.
    // Only the fixed old App's original checkout creates rows and claims.
    const old = await legacyQuote(s, s.appConnectionString, s.appRole, 'create');
    expect(old).toMatchObject({ version: 1, mode: 'create', ref: '41f4d25ae1daab3067f5ea745d30cabd77c93b80',
      identity: { role: s.appRole, session: s.appRole, database: String(database.name) }, externalCalls: 0, sequenceCalls: 1,
      selection: selection(), created: { orderId: 'coupon_legacy_created_1', key: old.confirm.orderKey },
      createdState: { order: { uid: 11, paid: 0, coupon_price: '2.99', pay_price: '17.00' } } });
    expect(old.sources['workers-ts/src/services/activity/ProductCouponService.ts'])
      .toBe('aec6e37c95104b8865e4c5ae5629eb0beb4bb6520fd36bb6e21896e9c8577a39');
    expect(Object.keys(old.sources)).toHaveLength(10);
    assertLegacyBundle(old);
    expect(old.replies.map(reply => reply.path)).toEqual(['/api/order/confirm', '/api/order/computed/' + old.confirm.orderKey,
      '/api/order/create/' + old.confirm.orderKey]);
    for (const reply of old.replies) {
      expect(reply.httpStatus).toBe(200); expect(createHash('sha256').update(reply.body).digest('hex')).toBe(reply.sha256);
      expect(JSON.parse(reply.body).status).toBe(200);
    }
    const [order] = await s.f.db.select().from(storeOrder).where(eq(storeOrder.unique, old.confirm.orderKey));
    expect(order).toMatchObject({ id: old.createdState!.order.id, orderId: old.created!.orderId, uid: 11,
      paid: 0, type: 0, couponId: OWNED, couponPrice: '2.99', payPrice: '17.00' });
    expect(await s.f.db.select().from(storeOrder)).toHaveLength(1);
    const lines = await s.f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    expect(lines).toHaveLength(1); expect(lines[0]).toMatchObject({ productId: 70, cartId: '1', cartNum: 1 });
    expect(parsedCartInfo(lines[0].cartInfo)).toMatchObject({ coupon_price: '2.99', sum_true_price: '17.00' });
    expect(old.createdState!.lines).toHaveLength(1);
    expect(old.createdState!.lines[0].cart_info).toBe(lines[0].cartInfo);
    expect((await s.f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0].stock).toBe(7);
    expect((await s.f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0].stock).toBe(7);
    expect((await s.f.db.select().from(storeCart).where(eq(storeCart.id, 1)))[0].isPay).toBe(1);
    expect((await s.f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id, OWNED)))[0]).toMatchObject({ status: 3, useTime: null });
    await readOnly(h, async () => {
      expect(old.puts).toHaveLength(3);
      expect(old.records).toEqual(old.puts.map(put => [put.key, put.value]));
      for (const put of old.puts) {
        expect(put.ttl).toBe(1800); expect(await s.env.CONFIG_KV.get(put.key)).toBeNull();
        await s.env.CONFIG_KV.put(put.key, put.value, { expirationTtl: put.ttl });
      }
    }, 3);
    const payload = { ...selection(), quoteToken: old.computed.quoteToken };
    expect(payload).not.toHaveProperty('payType');
    await readOnly(h, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await ok(s, '/api/order/create/' + old.confirm.orderKey, payload)).toEqual(old.created);
      }
      expect((await s.request('/api/order/create/' + old.confirm.orderKey, payload, await s.token(22))).status).not.toBe(200);
    });
    expect(h.sequenceCalls()).toBe(0);
    expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0])
      .toMatchObject({ paid: 0, payPrice: '17.00', couponPrice: '2.99' });
    await ok(s, '/api/order/cancel', { id: order.orderId });
    expect(await resources(s, [1])).toEqual(before);
    expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0])
      .toMatchObject({ paid: 0, status: -2, isDel: 1, payPrice: '17.00', couponPrice: '2.99' });
    expect(h.sequenceCalls()).toBe(0);
    console.log('COUPON_ROUNDING_ACTUAL_OLD_CREATED ' + JSON.stringify({ ref: old.ref, sources: old.sources, bundle: old.bundle,
      identity: old.identity, responseSha256: old.replies.map(reply => reply.sha256), orderId: order.orderId,
      persistedOldPay: order.payPrice, persistedOldCoupon: order.couponPrice, actualOldHttpRequests: 3,
      oldOrderNumberCalls: old.sequenceCalls, newOrderNumberCalls: h.sequenceCalls(), duplicateNewRequests: 2 }));
  }), 180_000);

  it('prices real Admin-assisted candidates and creation through actual Admin JWT, route permission and independent SQL binding', async () => withBuyerInvoices(async s => {
    const h = await prepare(s);
    await s.f.exec(`INSERT INTO system_role(id,role_name,rules,status) VALUES
      (1,'Owned coupon assisted','order.assisted',1),(2,'Owned coupon reader','order.view',1);
      INSERT INTO system_admin(id,account,pwd,admin_type,level,roles) VALUES
      (1,'owned-coupon-admin','owned-coupon-admin-password',1,1,'1'),
      (2,'owned-coupon-reader','owned-coupon-admin-password',1,1,'2');
      SELECT setval('public.store_cart_id_seq',(SELECT max(id) FROM public.store_cart),true)`);
    await assertCommissionedPeers(s);
    const env = { ...s.env, HYPERDRIVE_ADMIN: { connectionString: s.adminConnectionString } } as Env;
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', s.appContainer); await next(); });
    app.onError(errorHandler);
    const auth = adminRuntimeAuthMiddleware(), roles: string[] = [];
    const observed: typeof auth = async (c, next) => {
      const application = c.get('applicationContainer');
      if (!application) throw Error('Actual application authentication container missing');
      const [applicationIdentity] = await application.db.execute(sql`SELECT current_user AS role,session_user AS session`);
      expect(applicationIdentity).toEqual({ role: s.appRole, session: s.appRole });
      const [identity] = await c.get('container').db.execute(sql`SELECT current_user AS role,session_user AS session`);
      expect(identity).toEqual({ role: s.adminRole, session: s.adminRole });
      roles.push(String(identity.role)); await next();
    };
    app.post('/api/admin/order/cart/add/:uid', auth, observed, adminAssistedCartAdd);
    app.get('/api/admin/order/coupons/:uid', auth, observed, adminAssistedCoupons);
    app.post('/api/admin/order/confirm/:uid', auth, observed, adminAssistedConfirm);
    app.post('/api/admin/order/computed/:key/:uid', auth, observed, adminAssistedComputed);
    app.post('/api/admin/order/create/:key/:uid', auth, observed, adminAssistedCreate);
    const tokens = await Promise.all([1, 2].map(async id => (await createToken(id, 'admin', md5('owned-coupon-admin-password'), env.APP_KEY)).token));
    const request = async (path: string, body?: unknown, actor = 1) => {
      const response = await app.request('/api/admin/order/' + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + tokens[actor - 1], 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
      return response.json<{ status: number; msg: string; data: any }>();
    };
    const success = async (path: string, body?: unknown) => {
      const reply = await request(path, body); expect(reply.status, path + ': ' + reply.msg).toBe(200); return reply.data;
    };
    await readOnly(h, async () => {
      const denied = await request('cart/add/11', { productId: 70, uniqueId: 'qared001', cartNum: 1, new: 1 }, 2);
      expect(denied.status).not.toBe(200); expect(denied.msg).toContain('权限');
    });
    expect(roles).toEqual([]);
    const added = await success('cart/add/11', { productId: 70, uniqueId: 'qared001', cartNum: 1, new: 1 });
    expect((await s.f.db.select().from(storeCart).where(eq(storeCart.id, added.cartId)))[0])
      .toMatchObject({ uid: 11, staffId: 1, isNew: 1, cartNum: 1 });
    // Issued value and current template face are deliberately different.
    await s.f.db.update(storeCouponIssue).set({ couponPrice: '50.00' }).where(eq(storeCouponIssue.id, ISSUE));
    const candidates = await readOnly(h, () => success(`coupons/11?cartId=${added.cartId}&new=1&shipping_type=1`), 2);
    expect(candidates.find((row: { id: number }) => row.id === OWNED))
      .toMatchObject({ true_coupon_price: '3.00', coupon_price: '85.99' });
    expect(candidates.some((row: { id: number }) => row.id === FOREIGN)).toBe(false);
    const body = { cartId: [added.cartId], new: 1, couponId: OWNED, addressId: 11, shipping_type: 1, useIntegral: false, payType: 'cash' };
    const confirm = await readOnly(h, () => success('confirm/11', body), 2);
    expect(confirm.priceGroup).toMatchObject({ totalPrice: '19.99', couponPrice: '3.00', pay_price: '16.99' });
    const computed = await readOnly(h, () => success(`computed/${confirm.orderKey}/11`, body), 1);
    expect(computed.result).toMatchObject({ couponPrice: '3.00', pay_price: '16.99' });
    const made = await success(`create/${confirm.orderKey}/11`, { ...body, quoteToken: computed.result.quoteToken });
    const [order] = await s.f.db.select().from(storeOrder).where(eq(storeOrder.orderId, made.result.order_id));
    expect(order).toMatchObject({ uid: 11, staffId: 1, isChannel: 2, paid: 0, payPrice: '16.99', couponPrice: '3.00' });
    expect((await s.f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id, OWNED)))[0].status).toBe(3);
    await readOnly(h, async () => {
      const again = await success(`create/${confirm.orderKey}/11`, { ...body, quoteToken: computed.result.quoteToken });
      expect(again.result).toMatchObject({ order_id: order.orderId, pay_price: '16.99', extended: true });
      expect((await request(`create/${confirm.orderKey}/11`, body, 2)).status).not.toBe(200);
    });
    expect(roles.every(role => role === s.adminRole)).toBe(true);
    await new ScheduledMaintenanceService(s.appContainer, s.env).processOrder({ action: 'processScheduledOrder', job: 'unpaid_order_cancel',
      runId: 'coupon-rounding-admin-cleanup', scheduledAt: (order.addTime + 7200) * 1000, threshold: order.addTime + 3600, orderId: order.id });
    expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0]).toMatchObject({ paid: 0, status: -2 });
    expect((await s.f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id, OWNED)))[0].status).toBe(0);
  }), 180_000);

  it('uses the actual mobile ordinary cashier draft/quote/coupon/create permission boundary and never initiates payment', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Coupon cashier acceptance forbids external I/O'));
    let f: Awaited<ReturnType<typeof customerCashierOrdinaryFixture>> | undefined;
    try {
      f = await customerCashierOrdinaryFixture(); const owned = f;
      await owned.reset('19.99');
      await owned.maintenanceDb.insert(storeCouponIssue).values({ id: ISSUE, title: '实际普通收银百分比券', couponTitle: '实际普通收银百分比券',
        category: 1, type: 2, couponType: 0, couponPrice: '50.00', status: 1 });
      await owned.maintenanceDb.insert(storeCouponUser).values({ id: OWNED, uid: 11, issueCouponId: ISSUE, couponPrice: '85.99', useMinPrice: '0.00', type: 2 });
      const [identity] = await owned.db.execute(sql`SELECT current_user AS role,session_user AS session`);
      expect(identity).toEqual({ role: owned.role, session: owned.role });
      let sequence = 0; const puts: Array<{ key: string; ttl?: number }> = [], original = owned.env.CONFIG_KV;
      const env = { ...owned.env, SEQUENCE: { idFromName: () => 'owned-coupon-cashier',
        get: () => ({ fetch: async () => new Response('coupon_cashier_' + ++sequence) }) },
        CONFIG_KV: { ...original, put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
          puts.push({ key, ttl: options?.expirationTtl }); await original.put(key, value, options);
        } }, ORDER_QUEUE: { send: async () => { throw Error('Unpaid coupon test must not enqueue'); },
          sendBatch: async () => { throw Error('Unpaid coupon test must not enqueue'); } } } as unknown as Env;
      const base = '/api/mobile/work/cashier/ordinary', app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use('*', async (c, next) => { c.set('container', owned.container); await next(); });
      app.use('*', authMiddleware({ force: true })); app.onError(errorHandler);
      app.post(base + '/drafts', ordinaryHttp.draft); app.post(base + '/quote', ordinaryHttp.quote);
      app.get(base + '/quotes/:token/coupons', ordinaryHttp.coupons); app.post(base + '/orders', ordinaryHttp.create);
      const http = async (path: string, body?: unknown, key?: string, uid = 101, realm: 'api' | 'admin' = 'api') => {
        const token = (await createToken(uid, realm, md5('owned-financial-password'), env.APP_KEY)).token;
        const response = await app.request(base + path, { method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
        return response.json<{ status: number; msg: string; data: any }>();
      };
      const success = async (path: string, body?: unknown, key?: string) => {
        const reply = await http(path, body, key); expect(reply.status, path + ': ' + reply.msg).toBe(200); return reply.data;
      };
      const scope = await authorizeCustomerWorkActor(owned.db, owned.actor()), draftKey = randomUUID();
      const draftBody = { version: 'customer-cashier-ordinary-v1', scope_key: scope.scope_key, buyer_uid: 11, tourist_key: '',
        rows: [{ product_id: 70, sku_unique: 'qared001', quantity: 1 }] };
      let before = await databaseSnapshot(owned.exec);
      const denied = await http('/drafts', draftBody, draftKey, 102);
      expect(denied.status).toBe(403); expect(denied.msg).toContain('没有手机订单管理权限');
      expect((await http('/drafts', draftBody, draftKey, 101, 'admin')).status).not.toBe(200);
      expect(await databaseSnapshot(owned.exec)).toEqual(before);
      const draft = await success('/drafts', draftBody, draftKey), saved = draft.receipt.evidence.draft;
      expect(saved.rows).toHaveLength(1);
      const intent = { version: 'customer-cashier-ordinary-v1', scope_key: scope.scope_key, draft_key: draftKey, draft_hash: saved.draft_hash,
        buyer_uid: 11, tourist_key: '', coupon_id: OWNED, use_integral: false, shipping_type: 2, store_id: 0, address_id: 0,
        manual_address: null, real_name: '本机真实购买人', user_phone: '00000000000', mark: '', custom_form: [] };
      const requestKey = randomUUID(), putStart = puts.length; before = await databaseSnapshot(owned.exec);
      const quote = await success('/quote', { request_key: requestKey, intent });
      expect(quote.data.pricing).toMatchObject({ total: '19.99', coupon_discount: '3.00', amount: '16.99', postage: '0.00' });
      expect(quote.data.coupons.list.find((row: { id: number }) => row.id === OWNED)).toMatchObject({ estimated_discount: '3.00' });
      const page = await success(`/quotes/${quote.data.quote_token}/coupons?request_key=${requestKey}&scope_key=${scope.scope_key}&limit=20&before=0`);
      expect(page.data.coupons.list.find((row: { id: number }) => row.id === OWNED)).toMatchObject({ estimated_discount: '3.00' });
      expect(await databaseSnapshot(owned.exec)).toEqual(before);
      expect(puts.slice(putStart)).toEqual([{ key: `customer:cashier:ordinary:quote:v1:101:${requestKey}:${quote.data.quote_token}`, ttl: 1800 }]);
      expect(sequence).toBe(0);
      const payload = { intent, quote_token: quote.data.quote_token }, made = await success('/orders', payload, requestKey);
      const created = made.receipt.evidence.order, actual = await owned.actual(created.order_id);
      expect(actual.order).toMatchObject({ staffId: 101, uid: 11, isChannel: 2, type: 0, paid: 0, payPrice: '16.99', couponPrice: '3.00' });
      expect(actual.carts).toHaveLength(1); expect(parsedCartInfo(actual.carts[0].cartInfo).coupon_price).toBe('3.00');
      expect(sequence).toBe(1);
      await owned.maintenanceDb.update(storeCouponIssue).set({ type: 1, status: 0 }).where(eq(storeCouponIssue.id, ISSUE));
      before = await databaseSnapshot(owned.exec);
      expect((await success('/orders', { intent, quote_token: 'expired-local-token' }, requestKey)).receipt).toEqual(made.receipt);
      expect((await http('/orders', payload, requestKey, 102)).status).not.toBe(200);
      expect(await databaseSnapshot(owned.exec)).toEqual(before); expect(sequence).toBe(1);
      expect(network).not.toHaveBeenCalled();
      // Fixture teardown owns database/LOGIN cleanup. This test never calls the
      // cash/payment endpoints or fabricates paid/origin/receipt rows.
    } finally { network.mockRestore(); await f?.close(); }
  }, 180_000);
});
