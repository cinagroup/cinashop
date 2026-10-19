import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { drizzle } from 'drizzle-orm/postgres-js';
import { storeOrder, storeOrderStatus, orderWaybillJob, systemRole, systemAdmin, expressCompany,
  customerCityDeliveryJob, customerCityDeliveryAttempt, customerCityDeliveryBinding, storeDeliveryOrder, user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { supplierOrderDistributionFixture } from './helpers/supplierOrderDistribution';
import { supplierTrackingAppKey, supplierTrackingPassword } from './helpers/supplierOrderTracking';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

type Envelope = { status: number; msg: string; data: any };
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned distribution HTTP LOGIN'); return wiring.container;
} }));
const app = createApp();
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier shipped distribution actual App/JWT independent PG16 actors', () => {
  let f: Awaited<ReturnType<typeof supplierOrderDistributionFixture>>;
  beforeEach(async () => { f = await supplierOrderDistributionFixture(); wiring.container = f.container;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Metadata author must never invoke provider')); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { await f?.close(); wiring.container = undefined; vi.restoreAllMocks(); } }, 30000);
  async function request(method: 'GET' | 'PUT', target: string | number = 100, body?: unknown, actor: keyof typeof f.tokens | 'anonymous' = 'manager') {
    const response = await app.request('/supplierapi/order/distribution/' + target, { method,
      headers: { ...(actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + f.tokens[actor] }),
        'X-Supplier-Id': '8', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store'); expect(response.headers.get('pragma')).toBe('no-cache'); return response.json<Envelope>();
  }
  async function seed(id = 100, actor: keyof typeof f.tokens = 'manager') { const read = await request('GET', id, undefined, actor); expect(read.status, read.msg).toBe(200); return read.data; }
  async function unchanged(work: () => Promise<unknown>) { const state = await f.snapshot(), seq = await f.sequences(); await work(); expect(await f.snapshot()).toEqual(state); expect(await f.sequences()).toEqual(seq); }
  async function onlyTargetAndAudit(before: Awaited<ReturnType<typeof f.snapshot>>, id: number, patch: Record<string, unknown>) {
    const after = await f.snapshot(); expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const key of Object.keys(before)) if (!['store_order', 'store_order_status'].includes(key)) expect(after[key], key).toEqual(before[key]);
    expect(after.store_order.filter(row => row.row.id !== id)).toEqual(before.store_order.filter(row => row.row.id !== id));
    expect(after.store_order.find(row => row.row.id === id)).toEqual({ row: { ...before.store_order.find(row => row.row.id === id)!.row, ...patch } });
    const previousIds = new Set(before.store_order_status.map(row => row.row.id)); expect(after.store_order_status.filter(row => previousIds.has(row.row.id))).toEqual(before.store_order_status);
    const added = after.store_order_status.filter(row => !previousIds.has(row.row.id)); expect(added).toHaveLength(1);
    expect(added[0].row).toMatchObject({ oid: id, change_type: 'distribution', change_message: JSON.stringify({ actor_id: 21, supplier_id: 7,
      delivery_type: before.store_order.find(row => row.row.id === id)!.row.delivery_type }), change_time: expect.any(Number) });
    expect(added[0].row.change_message).not.toMatch(/下载说明|PRIVATE|CORRECTED|138/);
  }

  it('reads exact raw facts and unique enabled carrier catalog under true SELECT-only LOGIN with all SQL and sequences unchanged', async () => f.withDistributionReader(async peer => {
    wiring.container = peer.container; await unchanged(async () => { const read = await seed(100, 'viewer'); expect(read).toMatchObject({ id: 100, order_id: 'tracking-own-100',
      delivery_type: 'express', delivery_name: '本机真实快递', delivery_code: 'zhongtong', delivery_id: 'OWN-100', editable: true, reason: '', revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      express_companies: [{ id: 11, name: '本机真实快递', code: 'zhongtong' }, { id: 12, name: '本机新快递', code: 'shentong' }] });
      expect(Object.keys(read).sort()).toEqual(['id','order_id','delivery_type','delivery_name','delivery_code','delivery_id','fictitious_content','revision','express_companies','editable','reason'].sort());
      expect(JSON.stringify(read)).not.toMatch(/PRIVATE|supplier_id|user_phone|authVersion|xmin/); });
    const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,has_table_privilege(current_user,'store_order','UPDATE') AS order_write,
      has_any_column_privilege(current_user,'store_order','UPDATE') AS any_order_write,has_table_privilege(current_user,'express_company','UPDATE') AS catalog_write,
      has_table_privilege(current_user,'system_admin','UPDATE') AS auth_write,has_table_privilege(current_user,'system_form_data','SELECT') AS answers`);
    expect(rights).toEqual({ independent: true, order_write: false, any_order_write: false, catalog_write: false, auth_write: false, answers: false });
  }));

  it.each([{ id: 100, patch: { delivery_name: '本机新快递', delivery_code: 'shentong', delivery_id: 'CORRECTED-100' } },
    { id: 202, patch: { delivery_name: '本机新快递', delivery_code: 'shentong', delivery_id: 'CORRECTED-202' } },
    { id: 301, patch: { delivery_name: '本机新快递', delivery_code: 'shentong', delivery_id: 'CORRECTED-301' } }])('revises only selected real owned shipment$id and one redacted audit without reshipping stock money lines answers or siblings', async ({ id, patch }) => f.withWriter(async peer => {
    wiring.container = peer.container; const opened = await seed(id), before = await f.snapshot(), seq = await f.sequences();
    const saved = await request('PUT', id, f.body(opened.revision, patch.delivery_name, patch.delivery_id)); expect(saved.status, saved.msg).toBe(200);
    expect(saved.data).toMatchObject(patch); expect(saved.data.revision).not.toBe(opened.revision); await onlyTargetAndAudit(before, id, patch);
    expect((await f.sequences()).filter(row => row.name !== 'store_order_status_id_seq')).toEqual(seq.filter(row => row.name !== 'store_order_status_id_seq'));
    await unchanged(async () => { expect(await seed(id)).toEqual(saved.data); });
    const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,has_table_privilege(current_user,'store_order','UPDATE') AS whole_order,
      has_column_privilege(current_user,'store_order','delivery_id','UPDATE') AS metadata,has_column_privilege(current_user,'store_order','paid','UPDATE') AS payment,
      has_table_privilege(current_user,'system_admin','UPDATE') AS authority_lock,has_table_privilege(current_user,'express_company','UPDATE') AS catalog_lock,
      has_table_privilege(current_user,'store_delivery_order','UPDATE') AS delivery_lock,has_table_privilege(current_user,'store_product_attr_value','UPDATE') AS stock,
      has_table_privilege(current_user,'system_form_data','SELECT') AS answers`);
    expect(rights).toEqual({ independent: true, whole_order: false, metadata: true, payment: false, authority_lock: true, catalog_lock: true, delivery_lock: true, stock: false, answers: false });
  }));

  it('revises historical manual send name and valid phone while preserving delivery_uid and inactive fields', async () => f.withWriter(async peer => {
    wiring.container = peer.container; const opened = await seed(103), before = await f.snapshot();
    const saved = await request('PUT', 103, f.body(opened.revision, '补正后的历史送货人', '13900139000')); expect(saved.status, saved.msg).toBe(200);
    expect(saved.data).toMatchObject({ delivery_name: '补正后的历史送货人', delivery_id: '13900139000', delivery_code: '' });
    await onlyTargetAndAudit(before, 103, { delivery_name: '补正后的历史送货人', delivery_id: '13900139000' });
  }));
  it('revises real manual virtual content including line breaks and allows deliberate empty content without leaking it to audit', async () => f.withWriter(async peer => {
    wiring.container = peer.container; let opened = await seed(102);
    for (const content of ['修订说明\n第二行\t下载地址\r结束', '😀'.repeat(500), '']) { const before = await f.snapshot();
      const saved = await request('PUT', 102, { expected_revision: opened.revision, delivery_name: '', delivery_id: '', fictitious_content: content }); expect(saved.status, saved.msg).toBe(200);
      expect(saved.data.fictitious_content).toBe(content); await onlyTargetAndAudit(before, 102, { fictitious_content: content }); opened = saved.data;
    }
  }));
  it('no-op returns identical authoritative revision and facts without SQL or audit sequence changes', async () => f.withWriter(async peer => {
    wiring.container = peer.container; const opened = await seed(); await unchanged(async () => {
      const saved = await request('PUT', 100, f.body(opened.revision, opened.delivery_name, opened.delivery_id)); expect(saved.status, saved.msg).toBe(200); expect(saved.data).toEqual(opened);
    });
  }));
  it.each(['anonymous', 'viewer', 'denied', 'foreign', 'admin', 'customer'] as const)('refuses %s writer before any business or sequence changes', async actor => f.withWriter(async peer => {
    wiring.container = peer.container; const opened = await seed(); await unchanged(async () => { expect((await request('PUT', 100, f.body(opened.revision), actor)).status).not.toBe(200); });
  }));
  it.each(['01', '2147483648', '100?type=refund', '100?id=100&id=100'])('rejects invalid reference/query %s for read and write with no changes', async target => f.withWriter(async peer => {
    wiring.container = peer.container; const opened = await seed(); await unchanged(async () => { for (const method of ['GET', 'PUT'] as const) expect((await request(method, target, method === 'PUT' ? f.body(opened.revision) : undefined)).status).not.toBe(200); });
  }));
  it.each([200, 300, 900, 999])('refuses split/platform/foreign/missing target%i without editing a different active child', async id => f.withWriter(async peer => {
    wiring.container = peer.container; const opened = await seed(); await unchanged(async () => { expect((await request('GET', id)).status).not.toBe(200); expect((await request('PUT', id, f.body(opened.revision))).status).not.toBe(200); });
  }));

  it('rejects foreign IDs using tenant-filtered scalar references without selecting private foreign order columns', async () => f.withWriter(async peer => {
    wiring.container = peer.container; const opened = await seed(), queries: Array<{ query: string; params: unknown[] }> = [];
    const actual = drizzle(peer.db.$client, { logger: { logQuery(query, params) { queries.push({ query, params }); } } }) as unknown as DbClient;
    wiring.container = createContainerFromDb(actual);
    await unchanged(async () => { expect((await request('GET', 900)).status).toBe(404); expect((await request('PUT', 900, f.body(opened.revision))).status).toBe(404); });
    const reads = queries.filter(row => row.query.includes('from "store_order"'));
    expect(reads).toHaveLength(2);
    for (const row of reads) { expect(row.query).toContain('"store_order"."supplier_id" ='); expect(row.params).toContain(7); expect(row.params).toContain(900);
      expect(row.query).not.toMatch(/custom_form|virtual_info|fictitious_content|user_address|user_phone/); }
  }));

  it.each([{ label: 'buyer', patch: { uid: 12 } }, { label: 'store', patch: { storeId: 2 } }, { label: 'tenant', patch: { supplierId: 8 } },
    { label: 'nested-root', patch: { pid: 900 } }, { label: 'system-deleted-root', patch: { isSystemDel: 1 } }])('refuses incoherent parent $label in actual SQL scope before returning a child editor', async ({ patch }) => {
    await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, 200));
    await f.withWriter(async peer => { wiring.container = peer.container; const own = await seed(); await unchanged(async () => {
      expect((await request('GET', 202)).status).toBe(404); expect((await request('PUT', 202, f.body(own.revision))).status).toBe(404);
    }); });
  });

  it.each([{ label: 'received', patch: { status: 2 } }, { label: 'unpaid', patch: { paid: 0 } }, { label: 'refund3-not-implicitly-opened', patch: { refundStatus: 3 } },
    { label: 'user-deleted', patch: { isDel: 1 } }, { label: 'automatic-card', patch: { productType: 1, deliveryType: 'fictitious' } }])('reads $label reason but refuses mutation of ineligible actual facts', async ({ patch }) => {
    await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, 100)); await f.withWriter(async peer => { wiring.container = peer.container;
      const opened = await seed(); expect(opened.editable).toBe(false); expect(opened.reason).not.toBe(''); await unchanged(async () => { expect((await request('PUT', 100, f.body(opened.revision))).status).not.toBe(200); }); });
  });
  it.each([{ label: 'unpaid', patch: { paid: 0 } }, { label: 'deleted', patch: { isDel: 1 } }, { label: 'refund', patch: { refundStatus: 1 } }])('refuses child edit when coherent parent becomes $label despite child shipped facts remaining valid', async ({ patch }) => {
    await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, 200)); await f.withWriter(async peer => { wiring.container = peer.container; const opened = await seed(202);
      expect(opened.editable).toBe(false); expect(opened.reason).toContain('主订单'); await unchanged(async () => { expect((await request('PUT', 202, f.body(opened.revision))).status).not.toBe(200); }); });
  });

  it('keeps assigned-rider send readonly and never represents free text correction as rider reassignment', async () => f.withWriter(async peer => {
    wiring.container = peer.container; const opened = await seed(104); expect(opened.editable).toBe(false); expect(opened.reason).toContain('任务管理');
    await unchanged(async () => { expect((await request('PUT', 104, f.body(opened.revision, '伪造配送员', '13900139000'))).status).not.toBe(200); });
  }));
  it('reads nonempty genuine city job/attempt/binding by job_id and refuses managed transport without touching any provider records', async () => {
    const key = '00000000-0000-4000-8000-000000000001';
    await f.db.insert(customerCityDeliveryJob).values({ id: 1, actorUid: 17, serviceId: 1, actorAuthVersion: 'a'.repeat(32), actorExpiresAt: 2000000000,
      scopeKey: 'a'.repeat(64), requestKey: key, requestHash: 'b'.repeat(64), intentHash: 'c'.repeat(64), requestedOrderId: 100, rootOrderId: 100, orderId: 100,
      customerUid: 11, storeId: 1, supplierId: 7, provider: 'dada', providerOrderId: 'owned-city', intent: {}, status: 'ADMITTED', addTime: 1, updateTime: 1 });
    await f.db.insert(customerCityDeliveryAttempt).values({ id: 1, jobId: 1, requestKey: key, phase: 'ACCEPTED', startedTime: 1, issuedTime: 1, updateTime: 1 });
    await f.db.insert(storeDeliveryOrder).values({ id: 1, type: 2, relationId: 7, oid: 100, uid: 11, stationType: 1, orderId: 'owned-city' });
    await f.db.insert(customerCityDeliveryBinding).values({ jobId: 1, attemptId: 1, deliveryOrderId: 1, orderId: 100, rootOrderId: 100,
      customerUid: 11, storeId: 1, supplierId: 7, provider: 'dada', providerOrderId: 'owned-city', addTime: 1, updateTime: 1 });
    await f.withWriter(async peer => { wiring.container = peer.container; await unchanged(async () => { const opened = await seed(); expect(opened.editable).toBe(false);
      expect((await request('PUT', 100, f.body(opened.revision))).status).not.toBe(200); }); });
  });
  it('keeps issued SENT waybill history readonly even after its provider operation is terminal', async () => {
    await f.db.insert(orderWaybillJob).values({ id: 1, eventKey: 'owned-distribution-issued', requestKey: '00000000-0000-4000-8000-000000000001', requestHash: 'a'.repeat(64),
      rootOrderId: 100, orderId: 100, orderNo: 'tracking-own-100', supplierId: 7, storeId: 1, actorType: 'supplier', actorId: 21, fulfillmentMode: 'whole',
      carrierId: 11, carrierCode: 'zhongtong', carrierName: '本机真实快递', templateId: 'OWNED-TEMPLATE', senderName: 'sender-private', senderPhone: '13800138000', senderAddress: 'sender-private-address',
      status: 'SENT', trackingNumber: 'OWN-100', providerReference: 'provider-private', labelUrl: '/issued-label', fulfilledOrderId: 100 });
    await f.withWriter(async peer => { wiring.container = peer.container; await unchanged(async () => { const opened = await seed(); expect(opened.editable).toBe(false);
      expect(JSON.stringify(opened)).not.toMatch(/sender-private|provider-private/); expect((await request('PUT', 100, f.body(opened.revision))).status).not.toBe(200); }); });
  });
  it.each([{ expressDump: '{"issued":true}' }, { kuaidiLabel: '/actual-label' }, { kuaidiTaskId: 'registered-callback-task' }])('refuses real issued-label or merchant callback marker %s', async patch => {
    await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, 100)); await f.withWriter(async peer => { wiring.container = peer.container;
      await unchanged(async () => { const opened = await seed(); expect(opened.editable).toBe(false); expect((await request('PUT', 100, f.body(opened.revision))).status).not.toBe(200); }); });
  });

  it.each([{ label: 'extra-owner', edit: (body: any) => ({ ...body, supplier_id: 8 }) }, { label: 'spoof-code', edit: (body: any) => ({ ...body, delivery_code: 'FORGED' }) },
    { label: 'bad-content', edit: (body: any) => ({ ...body, fictitious_content: 'not applicable' }) }, { label: 'bad-name-control', edit: (body: any) => ({ ...body, delivery_name: 'bad\nname' }) },
    { label: 'invalid-shape', edit: () => [] }])('rejects $label payload before writes and preserves original revision', async ({ edit }) => f.withWriter(async peer => {
    wiring.container = peer.container; const opened = await seed(); await unchanged(async () => { expect((await request('PUT', 100, edit(f.body(opened.revision)))).status).toBe(400); });
  }));
  it('rejects duplicate active carrier name and missing enabled carrier without silently choosing arbitrary authority', async () => f.withWriter(async peer => {
    wiring.container = peer.container; let opened = await seed();
    await unchanged(async () => { expect((await request('PUT', 100, f.body(opened.revision, '停用快递'))).status).toBe(400); });
    await f.db.update(expressCompany).set({ name: '本机新快递' }).where(eq(expressCompany.id, 11));
    await unchanged(async () => { expect((await request('GET')).status).toBe(503); });
  }));

  it('rejects delayed stale editor after a real successful newer edit instead of replaying old metadata over it', async () => f.withWriter(async peer => {
    wiring.container = peer.container; const old = await seed(), first = await request('PUT', 100, f.body(old.revision)); expect(first.status, first.msg).toBe(200);
    await unchanged(async () => { expect((await request('PUT', 100, f.body(old.revision, old.delivery_name, old.delivery_id))).status).toBe(409); expect(await seed()).toEqual(first.data); });
  }));
  it.each(['role', 'credential', 'order'] as const)('rejects genuine two-commit %s ABA against an old revision with final facts restored', async kind => f.withWriter(async peer => {
    wiring.container = peer.container; const old = await seed();
    const statements = kind === 'role' ? ["UPDATE system_role SET rules='supplier.product.view' WHERE id=21", "UPDATE system_role SET rules='supplier.order.manage' WHERE id=21"]
      : kind === 'credential' ? ["UPDATE system_admin SET pwd='temporary' WHERE id=21", "UPDATE system_admin SET pwd='owned-supplier-tracking-password' WHERE id=21"]
      : ["UPDATE store_order SET delivery_id='INTERMEDIATE' WHERE id=100", "UPDATE store_order SET delivery_id='OWN-100' WHERE id=100"];
    for (const statement of statements) await f.exec(statement);
    await unchanged(async () => { expect((await request('PUT', 100, f.body(old.revision))).status).toBe(409); });
  }));

  it.each(['catalog', 'delivery-table', 'root-row'] as const)('honors actual held %s lock with explicit conflict and no rows or sequence effects', async kind => f.withWriter(async peer => {
    wiring.container = peer.container; const opened = await seed(); await f.withWriter(async other => other.db.transaction(async tx => {
      if (kind === 'root-row') await tx.select({ id: storeOrder.id }).from(storeOrder).where(eq(storeOrder.id, 100)).for('update');
      else await tx.execute(sql.raw('LOCK TABLE public.' + (kind === 'catalog' ? 'express_company' : 'store_delivery_order') + ' IN SHARE ROW EXCLUSIVE MODE'));
      await unchanged(async () => { const saved = await request('PUT', 100, f.body(opened.revision)); expect(saved.status, saved.msg).toBe(409); });
    }));
  }));
  it.each(['express_company', 'store_delivery_order'] as const)('reports missing actual %s table-lock privilege as unavailable without partial mutation', async table => f.withWriter(async peer => {
    wiring.container = peer.container; const opened = await seed(); await f.exec(`REVOKE UPDATE ON public.${table} FROM "${peer.role}"`);
    await unchanged(async () => { expect((await request('PUT', 100, f.body(opened.revision))).status).toBe(503); });
  }));

  it.each(['skip', 'rewrite', 'late-authority'] as const)('rejects actual %s trigger behavior with positive executable control and full transaction business rollback', async mode => {
    const action = mode === 'skip' ? 'RETURN NULL;' : mode === 'rewrite' ? "NEW.delivery_id='REWRITTEN'; RETURN NEW;" : "UPDATE system_role SET rules='supplier.product.view' WHERE id=21; RETURN NEW;";
    await f.exec(`CREATE FUNCTION public.owned_distribution_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.delivery_id LIKE 'PROBE-%' THEN ${action} END IF; RETURN NEW; END $$;
      CREATE TRIGGER owned_distribution_probe BEFORE UPDATE OF delivery_id ON public.store_order FOR EACH ROW EXECUTE FUNCTION public.owned_distribution_probe()`);
    const control = await f.db.update(storeOrder).set({ deliveryId: 'PROBE-CONTROL' }).where(eq(storeOrder.id, 100)).returning();
    if (mode === 'skip') expect(control).toEqual([]); else if (mode === 'rewrite') expect(control[0].deliveryId).toBe('REWRITTEN');
    else expect((await f.db.select().from(systemRole).where(eq(systemRole.id, 21)))[0].rules).toBe('supplier.product.view');
    await f.db.update(storeOrder).set({ deliveryId: 'OWN-100' }).where(eq(storeOrder.id, 100)); await f.db.update(systemRole).set({ rules: 'supplier.order.manage' }).where(eq(systemRole.id, 21));
    await f.withWriter(async peer => { wiring.container = peer.container; const opened = await seed(), before = await f.snapshot();
      const saved = await request('PUT', 100, f.body(opened.revision, '本机新快递', 'PROBE-AUTHOR')); expect(saved.status, saved.msg).toBe(409); expect(await f.snapshot()).toEqual(before);
    });
  });

  it('detects deferred audit-trigger rewrite after successful main-row readback and rolls back the complete business transaction', async () => {
    await f.exec(`CREATE FUNCTION public.owned_distribution_deferred() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.change_type='distribution' THEN UPDATE store_order SET delivery_id='LATE-CORRUPT' WHERE id=NEW.oid; END IF; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER owned_distribution_deferred AFTER INSERT ON public.store_order_status DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.owned_distribution_deferred()`);
    await expect(f.db.transaction(async tx => {
      await tx.insert(storeOrderStatus).values({ oid: 100, changeType: 'distribution', changeMessage: 'positive executable control', changeTime: 1 });
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      expect((await tx.select().from(storeOrder).where(eq(storeOrder.id, 100)))[0].deliveryId).toBe('LATE-CORRUPT');
      throw Error('positive control intentional rollback');
    })).rejects.toThrow('positive control intentional rollback');
    await f.withWriter(async peer => { wiring.container = peer.container; const opened = await seed(), before = await f.snapshot();
      const saved = await request('PUT', 100, f.body(opened.revision)); expect(saved.status, saved.msg).toBe(409); expect(await f.snapshot()).toEqual(before);
      // INSERT sequence consumption is nontransactional; only full business
      // rollback is claimed for this deliberately post-audit failure.
    });
  });

  it('corrects actual App-authored shipment after mature checkout/allocation then genuine Customer JWT reads new transport without changing frozen commerce history', async () => {
    const whole = await refundRuntimeFixture();
    try {
      await whole.db.insert(systemRole).values({ id: 21, type: 4, relationId: 7, rules: 'supplier.order.manage' });
      await whole.db.insert(systemAdmin).values({ id: 21, account: 'distribution-real-author', pwd: supplierTrackingPassword, adminType: 4, relationId: 7, roles: '21' });
      await whole.db.insert(expressCompany).values({ id: 9001, name: '本机新快递', code: 'shentong', isShow: 1, status: 1 });
      const env = { ...whole.env, APP_KEY: supplierTrackingAppKey, NODE_ENV: 'test', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as unknown as typeof f.env;
      let target = 0, orderNo = '';
      // The registered migration fixture predates the separately commissioned
      // city runtime. Exercise the service's complete-group-absent contract;
      // existing-job protection is covered by the dedicated fixture above.
      expect(Array.from(await whole.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class
        WHERE relnamespace='public'::regnamespace AND relkind='r'
          AND relname IN('customer_city_delivery_job','customer_city_delivery_attempt','customer_city_delivery_binding')`))).toEqual([]);
      await whole.withRuntime(async writer => {
        await whole.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_menus,public.express_company,public.store_delivery_order TO "${writer.role}";
          GRANT UPDATE ON public.system_admin,public.system_supplier,public.system_role,public.system_menus,public.express_company,public.store_delivery_order TO "${writer.role}"`);
        const paid = await writer.createPaid({ key: 'real-distribution-checkout', orderId: 'real_distribution_order' }); target = paid.id; orderNo = paid.orderId; wiring.container = writer.container;
        const call = async (method: string, path: string, body?: unknown, token = f.tokens.manager) => {
          const response = await app.request(path, { method, headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env); return response.json<Envelope>();
        };
        expect((await call('PUT', '/supplierapi/order/delivery/' + target, { delivery_type: 'express', delivery_name: '本机新快递', delivery_code: 'shentong', delivery_id: 'ORIGINAL-ACTUAL' })).status).toBe(200);
        const baseline = await whole.state(), opened = await call('GET', '/supplierapi/order/distribution/' + target); expect(opened.status, opened.msg).toBe(200);
        const revised = await call('PUT', '/supplierapi/order/distribution/' + target, f.body(opened.data.revision, '本机新快递', 'CORRECTED-ACTUAL')); expect(revised.status, revised.msg).toBe(200);
        const after = await whole.state(); for (const name of Object.keys(baseline)) if (!['store_order', 'store_order_status'].includes(name)) expect(after[name], name).toEqual(baseline[name]);
        await whole.exec("UPDATE system_config SET value='0' WHERE menu_name='logistics_type'");
        const [buyer] = await whole.db.select().from(user).where(eq(user.uid, 11)), token = await createToken(11, 'api', md5(buyer.pwd), supplierTrackingAppKey);
        const beforeRead = await whole.state(), customer = await call('GET', '/api/order/express/' + orderNo, undefined, token.token); expect(customer.status, customer.msg).toBe(200);
        expect(customer.data).toMatchObject({ orderId: orderNo, expressName: '本机新快递', expressCode: 'shentong', expressNo: 'CORRECTED-ACTUAL', trackingState: 'not_configured' });
        expect(await whole.state()).toEqual(beforeRead);
      });
      // Real checkout, allocation, Supplier delivery/edit and Customer JWT read.
      // The reused paid marker is explicit synthetic maintenance SQL, not a
      // payment-provider callback or a Customer HTTP checkout claim.
      expect(target).toBeGreaterThan(0); expect(orderNo).toBe('real_distribution_order');
    } finally { await whole.close(); }
  }, 90000);
});
