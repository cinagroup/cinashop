import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Container } from '../src/lib/di';
import { createContainerFromDb } from '../src/lib/di';
import type { Env } from '../src/env';
import { financePostgres } from './helpers/financePostgres';
import { INVOICE_EVIDENCE_SQL } from '../src/migrations/invoiceEvidence';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderInvoice, storeOrderStatus,
  systemAdmin, systemRole, user } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Isolated invoice fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Isolated invoice fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

let f: Awaited<ReturnType<typeof financePostgres>>;
const app = createApp();
const env = { APP_KEY: 'local-admin-invoice-only', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'isolated-invoice-role';
const identities = { manager: 9801, reader: 9802, order: 9803, orderReader: 9804 } as const;
const tokens = new Map<keyof typeof identities, string>();

beforeEach(async () => {
  f = await financePostgres([storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderInvoice, storeOrderStatus,
    systemAdmin, systemRole, user]);
  wiring.container = createContainerFromDb(f.db);
  await f.exec(INVOICE_EVIDENCE_SQL);
  await f.db.insert(storeOrder).values({ id: 10, orderId: 'local-admin-invoice', uid: 11, paid: 1,
    payType: 'yue', payPrice: '10.00', totalPrice: '10.00' });
  await f.db.insert(user).values({ uid: 11, nickname: 'Invoice buyer' });
  await f.db.insert(storeOrderInvoice).values({ id: 41, uid: 11, orderId: 10, invoiceId: 77,
    isPay: 1, invoiceAmount: '10.00', dutyNumber: 'LOCAL-TAX-ID', bank: 'LOCAL-BANK', cardNumber: 'LOCAL-ACCOUNT' });
  await f.db.insert(systemRole).values([
    { id: identities.manager, roleName: 'Invoice manager', rules: 'invoice.manage' },
    { id: identities.reader, roleName: 'Invoice reader', rules: 'invoice.view' },
    { id: identities.order, roleName: 'Ordinary order manager', rules: 'order.manage' },
    { id: identities.orderReader, roleName: 'Ordinary order reader', rules: 'order.view' },
  ]);
  await f.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({ id,
    account: `local-invoice-${name}`, pwd: password, roles: String(id), level: 1,
    adminType: 1, status: 1, isDel: 0 })));
  for (const [name, id] of Object.entries(identities))
    tokens.set(name as keyof typeof identities, (await createToken(id, 'admin', md5(password), env.APP_KEY)).token);
}, 30_000);
afterEach(async () => { wiring.container = undefined; tokens.clear(); await f?.close(); });

async function request(base: string, name: keyof typeof identities | 'anonymous', path: string,
  method = 'GET', body?: unknown) {
  const response = await app.request(`${base}/order/invoices${path}`, { method,
    headers: { ...(name === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(name)}` }),
      'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  return response.json<{ status: number; msg: string; data: Record<string, unknown> | null }>();
}

it.each(['/adminapi', '/api/admin'])('enforces independent invoice.view/manage on actual %s HTTP routes', async base => {
  expect((await request(base, 'anonymous', '')).status).not.toBe(200);
  const ordinary = await request(base, 'order', '');
  expect(ordinary.status).not.toBe(200);
  expect(JSON.stringify(ordinary)).not.toContain('LOCAL-TAX-ID');
  expect((await request(base, 'order', '/41')).status).not.toBe(200);
  expect((await request(base, 'order', '/41/order-info')).status).not.toBe(200);
  expect((await request(base, 'orderReader', '')).status).not.toBe(200);
  expect((await request(base, 'orderReader', '/41')).status).not.toBe(200);
  expect((await request(base, 'orderReader', '/41/order-info')).status).not.toBe(200);
  const list = await request(base, 'reader', '');
  expect(list).toMatchObject({ status: 200, data: { count: 1 } });
  const detail = await request(base, 'reader', '/41');
  expect(detail).toMatchObject({ status: 200, data: { id: 41, duty_number: 'LOCAL-TAX-ID',
    bank: 'LOCAL-BANK', card_number: 'LOCAL-ACCOUNT' } });
  expect(await request(base, 'reader', '/41/order-info')).toMatchObject({ status: 200,
    data: { invoice_id: 41, order: { id: 10, order_number: 'local-admin-invoice' },
      user: { nickname: 'Invoice buyer', spread_name: '' }, cart_items: [] } });
  const row = detail.data as Record<string, unknown>;
  const body = { is_invoice: 1, invoice_number: '12345678', remark: '',
    revision: row.revision, request_id: crypto.randomUUID() };
  expect((await request(base, 'order', '/41/process', 'POST', body)).status).not.toBe(200);
  expect((await request(base, 'reader', '/41/process', 'POST', body)).status).not.toBe(200);
  expect(await request(base, 'manager', '/41/process', 'POST', body)).toMatchObject({ status: 200,
    data: { committed: true, request_id: body.request_id, is_invoice: 1 } });
});
