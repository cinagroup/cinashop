import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, systemAdmin, systemRole, systemMenus } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { SupplierOrderTrackingService } from '@/services/supplier/SupplierOrderTrackingService';
import { supplierOrderTrackingFixture, supplierTrackingAppKey, supplierTrackingPassword } from './helpers/supplierOrderTracking';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

type Envelope = { status: number; msg: string; data: any };
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned tracking HTTP LOGIN'); return wiring.container;
} }));
const app = createApp();
const carrier = (delivered = false) => Response.json({ status: 0, result: { deliverystatus: delivered ? 3 : 1,
  list: [{ time: '2026-10-19 00:00:00', status: delivered ? '本机承运商：已签收' : '本机承运商实际运输节点' }] } });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier single-shipment tracking actual App JWT SELECT-only owned PG16', () => {
  let f: Awaited<ReturnType<typeof supplierOrderTrackingFixture>>;
  beforeEach(async () => { f = await supplierOrderTrackingFixture(); wiring.container = f.container;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Uncommissioned external tracking request')); }, 30000);
  afterEach(async () => { try { await f?.close(); } finally { wiring.container = undefined; vi.restoreAllMocks(); } }, 30000);
  async function read(reference: string | number = 100, actor: keyof typeof f.tokens | 'anonymous' = 'viewer', token?: string) {
    const response = await app.request('/supplierapi/order/express/' + reference, { headers: {
      ...(actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + (token ?? f.tokens[actor]) }), 'X-Supplier-Id': '8',
    } }, f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store'); expect(response.headers.get('pragma')).toBe('no-cache');
    return response.json<Envelope>();
  }
  async function unchanged(work: () => Promise<unknown>) {
    const before = await f.snapshot(), seq = await f.sequences(); await work();
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq);
  }
  function privateDto(data: Envelope['data'], orderId = 'tracking-own-100', number = 'OWN-100') {
    expect(data).toMatchObject({ orderId, expressName: '本机真实快递', expressCode: 'zhongtong', expressNo: number,
      delivery_name: '本机真实快递', delivery_id: number, order: { order_id: orderId, delivery_id: number,
        delivery_name: '本机真实快递', delivery_code: 'zhongtong', delivery_type: 'express' } });
    expect(data.packages).toHaveLength(1); expect(data.packages[0]).toEqual(Object.fromEntries(Object.entries(data)
      .filter(([key]) => !['packages', 'order', 'express', 'delivery_name', 'delivery_id', 'result'].includes(key))));
    expect(data.result).toEqual(data.express); expect(data.result).toEqual(data.traces.map((row: { time: string; content: string }) => ({ time: row.time, status: row.content })));
    expect(Object.keys(data.order).sort()).toEqual(['delivery_code', 'delivery_id', 'delivery_name', 'delivery_type', 'order_id']);
    expect(JSON.stringify(data)).not.toMatch(/PRIVATE-UNCHANGED|13800138000|userPhone|user_phone|supplierId|supplier_id|authVersion|OWNED-PROVIDER-KEY|fingerprint|xmin|pay_price|custom_form/);
  }
  function noTransport() { expect(fetch).not.toHaveBeenCalled(); expect(f.cacheReads).toEqual([]); expect(f.cacheWrites).toEqual([]); }

  it('reads a genuine single shipment under independent SELECT-only LOGIN with complete SQL and sequence zero-write proof', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,current_user AS role,
      has_schema_privilege(current_user,'public','CREATE') AS creates,
      has_table_privilege(current_user,'store_order','SELECT') AS reads,
      has_any_column_privilege(current_user,'store_order','UPDATE') AS edits,
      has_table_privilege(current_user,'store_order','INSERT,DELETE') AS mutates,
      has_table_privilege(current_user,'system_admin','UPDATE') AS edits_auth,
      has_table_privilege(current_user,'system_form_data','SELECT') AS answers,
      EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S'
        AND has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE')) AS sequences`);
    expect(rights).toEqual({ independent: true, role: peer.role, creates: false, reads: true, edits: false, mutates: false, edits_auth: false, answers: false, sequences: false });
    await unchanged(async () => { const response = await read(); expect(response.status, response.msg).toBe(200); privateDto(response.data);
      expect(response.data).toMatchObject({ trackingState: 'not_configured', trackingSource: 'merchant', traces: [], express: [], result: [] }); }); noTransport();
  }));

  it('keeps existing broader application containers compatible while the new service itself opens READ ONLY snapshots', async () => {
    // This is the owned maintenance container compatibility control, distinct
    // from the least-privilege production-path proof above.
    await unchanged(async () => { const response = await read(); expect(response.status, response.msg).toBe(200); privateDto(response.data); }); noTransport();
  });

  it('resolves whitespace comma-separated roles and numeric legacy menu authority from real rows', async () => {
    await f.db.insert(systemMenus).values({ id: 143, type: 4, authType: 2, access: 1, isDel: 0, methods: 'GET', apiUrl: 'order/express/:id' });
    await f.db.insert(systemRole).values({ id: 24, type: 4, relationId: 7, rules: ' 143 , 143 ' });
    await f.db.update(systemRole).set({ rules: 'supplier.product.view' }).where(eq(systemRole.id, 22));
    await f.db.update(systemAdmin).set({ roles: ' 22 , 24 ' }).where(eq(systemAdmin.id, 22));
    await f.withReader(async peer => { wiring.container = peer.container; await unchanged(async () => {
      const response = await read(); expect(response.status, response.msg).toBe(200); privateDto(response.data);
    }); }); noTransport();
  });

  it.each([{ id: 201, order: 'tracking-child-201', number: 'CHILD-201' }, { id: 202, order: 'tracking-child-202', number: 'CHILD-202' },
    { id: 301, order: 'tracking-allocation-301', number: 'ALLOC-301' }])('reads only chosen owned child$id including coherent platform allocation without aggregating siblings', async ({ id, order, number }) => f.withReader(async peer => {
    wiring.container = peer.container; await unchanged(async () => { const response = await read(id); expect(response.status, response.msg).toBe(200); privateDto(response.data, order, number);
      expect(JSON.stringify(response.data)).not.toContain(id === 201 ? 'CHILD-202' : 'CHILD-201'); }); noTransport();
  }));

  it('permits Supplier legacy user-deleted shipment and parent history while preserving system deletion denial', async () => {
    await f.db.update(storeOrder).set({ isDel: 1 }).where(eq(storeOrder.id, 100));
    await f.db.update(storeOrder).set({ isDel: 1 }).where(eq(storeOrder.id, 200));
    await f.withReader(async peer => { wiring.container = peer.container; await unchanged(async () => {
      expect((await read()).status).toBe(200); expect((await read(201)).status).toBe(200);
    }); }); noTransport();
  });

  it.each(['anonymous', 'admin', 'customer', 'kefu', 'denied', 'foreign'] as const)('refuses %s identity before carrier/cache with no SQL or sequence changes', async actor => f.withReader(async peer => {
    wiring.container = peer.container; await unchanged(async () => { expect((await read(100, actor)).status).not.toBe(200); }); noTransport();
  }));

  it('refuses a genuinely signed expired Supplier JWT and expired direct actor before transport', async () => f.withReader(async peer => {
    wiring.container = peer.container; const token = await createToken(22, 'supplier', md5(supplierTrackingPassword), supplierTrackingAppKey, 'cinashop', Math.floor(Date.now() / 1000) - 8 * 86400);
    await unchanged(async () => { expect((await read(100, 'viewer', token.token)).status).not.toBe(200);
      await expect(f.service(peer.db).read({ ...f.actor(), expiresAt: 1 }, 100)).rejects.toThrow('登录已过期'); }); noTransport();
  }));

  it.each(['0', '01', '2147483648', '%20100'])('refuses noncanonical int4 reference %s with no SQL/sequence writes', async reference => f.withReader(async peer => {
    wiring.container = peer.container; await unchanged(async () => { expect((await read(reference)).status).toBe(400); }); noTransport();
  }));
  it.each(['100?id=100&id=100', '100?type=refund', '100?supplier_id=7'])('refuses every query parameter including duplicate query %s before provider', async reference => f.withReader(async peer => {
    wiring.container = peer.container; await unchanged(async () => { expect((await read(reference)).status).toBe(400); }); noTransport();
  }));
  it.each([{ id: 200, status: 400 }, { id: 300, status: 404 }, { id: 900, status: 404 }, { id: 999, status: 404 }])('refuses split/platform/foreign/missing reference$id rather than broadening its scope', async ({ id, status }) => f.withReader(async peer => {
    wiring.container = peer.container; await unchanged(async () => { const response = await read(id); expect(response.status, response.msg).toBe(status);
      if (id === 200) expect(response.msg).toContain('请选择具体发货子单'); }); noTransport();
  }));
  it.each([{ label: 'system-deleted', patch: { isSystemDel: 1 } }, { label: 'manual', patch: { deliveryType: 'fictitious' } },
    { label: 'blank-number', patch: { deliveryId: '   ' } }])('refuses $label shipment before transport', async ({ patch }) => {
    await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, 100));
    await f.withReader(async peer => { wiring.container = peer.container; await unchanged(async () => { expect((await read()).status).not.toBe(200); }); }); noTransport();
  });
  it.each([{ label: 'buyer', patch: { uid: 12 } }, { label: 'store', patch: { storeId: 2 } }, { label: 'tenant', patch: { supplierId: 8 } },
    { label: 'nested-parent', patch: { pid: 900 } }, { label: 'deleted-parent', patch: { isSystemDel: 1 } }])('refuses child whose actual parent has incoherent $label', async ({ patch }) => {
    await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, 200));
    await f.withReader(async peer => { wiring.container = peer.container; await unchanged(async () => { expect((await read(201)).status).toBe(404); }); }); noTransport();
  });
  it('requires completed platform allocation coherence before resolving its owned child', async () => {
    await f.db.update(storeOrder).set({ supplierAllocationStatus: 1 }).where(eq(storeOrder.id, 300));
    await f.withReader(async peer => { wiring.container = peer.container; await unchanged(async () => { expect((await read(301)).status).toBe(404); }); }); noTransport();
  });

  it('does not disguise missing SELECT metadata as unconfigured carrier success', async () => f.withReader(async peer => {
    await f.exec(`REVOKE SELECT ON public.system_config FROM "${peer.role}"`); wiring.container = peer.container;
    await unchanged(async () => { const response = await read(); expect(response.status, response.msg).toBe(503); }); noTransport();
  }));

  it.each([false, true])('uses actual controlled Aliyun transport then signed-state cache delivered=%s without any SQL/sequence writes', async delivered => {
    await f.provider(); vi.mocked(fetch).mockResolvedValue(carrier(delivered));
    await f.withReader(async peer => { wiring.container = peer.container; await unchanged(async () => {
      const first = await read(); expect(first.status, first.msg).toBe(200); privateDto(first.data);
      expect(first.data).toMatchObject({ trackingSource: 'carrier', trackingState: delivered ? 'delivered' : 'in_transit',
        result: [{ time: '2026-10-19 00:00:00', status: delivered ? '本机承运商：已签收' : '本机承运商实际运输节点' }] });
      const second = await read(); expect(second.status, second.msg).toBe(200); expect(second.data).toMatchObject({ ...first.data, trackingSource: 'cache', packages: [{ ...first.data.packages[0], trackingSource: 'cache' }] });
    }); });
    expect(fetch).toHaveBeenCalledTimes(1); const [input, init] = vi.mocked(fetch).mock.calls[0], url = new URL(String(input));
    expect(url.origin + url.pathname).toBe('https://wuliu.market.alicloudapi.com/kdi'); expect(url.searchParams.get('no')).toBe('OWN-100'); expect(url.searchParams.get('type')).toBe('ZTO');
    expect(new Headers(init?.headers).get('Authorization')).toBe('APPCODE OWNED-PROVIDER-KEY');
    expect(f.cacheWrites).toHaveLength(1); expect(f.cacheWrites[0].ttl).toBe(delivered ? 30 * 24 * 3600 : 1800); expect(f.cacheReads).toHaveLength(2);
  });

  it.each(['http', 'rejected-payload'] as const)('returns honest %s transport degradation while preserving the real waybill and zero SQL writes', async kind => {
    await f.provider(); vi.mocked(fetch).mockImplementation(async () => kind === 'http' ? new Response('', { status: 503 })
      : Response.json({}));
    await f.withReader(async peer => { wiring.container = peer.container; await unchanged(async () => { const response = await read(); expect(response.status, response.msg).toBe(200); privateDto(response.data);
      expect(response.data).toMatchObject({ trackingState: 'temporarily_unavailable', trackingSource: 'merchant', traces: [], result: [] }); }); }); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves existing raw padded waybill fields and applies only the established provider code normalization', async () => {
    await f.db.update(storeOrder).set({ deliveryName: ' 本机真实快递 ', deliveryCode: ' zhongtong ', deliveryId: ' OWN-100 ' }).where(eq(storeOrder.id, 100));
    await f.provider(); vi.mocked(fetch).mockResolvedValue(carrier());
    await f.withReader(async peer => { wiring.container = peer.container; await unchanged(async () => {
      const response = await read(); expect(response.status, response.msg).toBe(200); expect(response.data).toMatchObject({ expressName: ' 本机真实快递 ', expressCode: ' zhongtong ', expressNo: ' OWN-100 ',
        delivery_name: ' 本机真实快递 ', delivery_id: ' OWN-100 ', order: { delivery_id: ' OWN-100 ', delivery_name: ' 本机真实快递 ', delivery_code: ' zhongtong ' } });
    }); }); expect(fetch).toHaveBeenCalledTimes(1); const url = new URL(String(vi.mocked(fetch).mock.calls[0][0])); expect(url.searchParams.get('no')).toBe(' OWN-100 '); expect(url.searchParams.get('type')).toBe('ZTO');
  });

  const changes = [
    { label: 'waybill', query: "UPDATE store_order SET delivery_id='CHANGED' WHERE id=100" },
    { label: 'carrier-code', query: "UPDATE store_order SET delivery_code='sf' WHERE id=100" },
    { label: 'order-status', query: 'UPDATE store_order SET status=2 WHERE id=100' },
    { label: 'customer', query: 'UPDATE store_order SET uid=12 WHERE id=100' },
    { label: 'store', query: 'UPDATE store_order SET store_id=2 WHERE id=100' },
    { label: 'tenant', query: 'UPDATE store_order SET supplier_id=8 WHERE id=100' },
    { label: 'parent-reference', query: 'UPDATE store_order SET pid=200 WHERE id=100' },
    { label: 'system-deletion', query: 'UPDATE store_order SET is_system_del=1 WHERE id=100' },
    { label: 'role-revocation', query: "UPDATE system_role SET rules='supplier.product.view' WHERE id=22" },
    { label: 'credential', query: "UPDATE system_admin SET pwd='changed-real-password' WHERE id=22" },
    { label: 'supplier-disabled', query: 'UPDATE system_supplier SET is_show=0 WHERE id=7' },
    { label: 'role-authority-ABA', query: ["UPDATE system_role SET rules='supplier.product.view' WHERE id=22", "UPDATE system_role SET rules='supplier.order.view' WHERE id=22"] },
    { label: 'credential-authority-ABA', query: ["UPDATE system_admin SET pwd='temporary-owned-tracking-password' WHERE id=22", "UPDATE system_admin SET pwd='owned-supplier-tracking-password' WHERE id=22"] },
  ] as const;
  it.each(changes)('rechecks fresh authority and shipping identity after provider: $label refuses obsolete result with no transaction held across network', async ({ label, query }) => {
    await f.provider(); let changed = false, during!: Awaited<ReturnType<typeof f.snapshot>>, activity: unknown;
    await f.withReader(async peer => {
      wiring.container = peer.container; const seq = await f.sequences();
      vi.mocked(fetch).mockImplementation(async () => { activity = await f.exec(`SELECT state,xact_start IS NULL AS no_transaction FROM pg_stat_activity WHERE pid=${peer.pid}`);
        for (const statement of typeof query === 'string' ? [query] : query) await f.exec(statement);
        changed = true; during = await f.snapshot(); return carrier(); });
      const response = await read(); expect(changed).toBe(true); expect(activity).toEqual([{ state: 'idle', no_transaction: true }]); expect(response.status, response.msg).not.toBe(200);
      if (label.endsWith('-ABA')) expect(response.status, response.msg).toBe(409);
      expect(response.data).toBeNull(); expect(await f.snapshot()).toEqual(during); expect(await f.sequences()).toEqual(seq);
    }); expect(fetch).toHaveBeenCalledTimes(1); // The cache may have been filled before final authorization; SQL remains read-only.
  });

  it.each([{ id: 201, root: 200, query: 'uid=12' }, { id: 301, root: 300, query: 'supplier_allocation_status=1' }])('rechecks actual parent coherence for child$id after network transport', async ({ id, root, query }) => {
    await f.provider(); let changed = false, during!: Awaited<ReturnType<typeof f.snapshot>>;
    await f.withReader(async peer => { wiring.container = peer.container; const seq = await f.sequences();
      vi.mocked(fetch).mockImplementation(async () => { await f.exec(`UPDATE store_order SET ${query} WHERE id=${root}`); changed = true; during = await f.snapshot(); return carrier(); });
      expect((await read(id)).status).toBe(404); expect(changed).toBe(true); expect(await f.snapshot()).toEqual(during); expect(await f.sequences()).toEqual(seq);
    }); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('allows unrelated remark updates during transport while returning only real carrier traces and closing every read snapshot', async () => {
    await f.provider(); let during!: Awaited<ReturnType<typeof f.snapshot>>, activity: unknown, changed = false;
    await f.withReader(async peer => { wiring.container = peer.container; const seq = await f.sequences();
      vi.mocked(fetch).mockImplementation(async () => { activity = await f.exec(`SELECT state,xact_start IS NULL AS no_transaction FROM pg_stat_activity WHERE pid=${peer.pid}`);
        await f.db.update(storeOrder).set({ remark: 'Independent concurrent maintenance note' }).where(eq(storeOrder.id, 100)); changed = true; during = await f.snapshot(); return carrier(); });
      const response = await read(); expect(response.status, response.msg).toBe(200); expect(changed).toBe(true); privateDto(response.data); expect(activity).toEqual([{ state: 'idle', no_transaction: true }]);
      expect(response.data.result).toEqual([{ time: '2026-10-19 00:00:00', status: '本机承运商实际运输节点' }]); expect(await f.snapshot()).toEqual(during); expect(await f.sequences()).toEqual(seq);
    }); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rechecks authority after a real cache hit as well as a carrier request', async () => {
    await f.provider(); vi.mocked(fetch).mockResolvedValue(carrier());
    await f.withReader(async peer => { wiring.container = peer.container; expect((await read()).status).toBe(200); expect(f.cacheWrites).toHaveLength(1);
      const kv = f.env.CONFIG_KV as unknown as { get: (key: string, kind?: string) => Promise<unknown> };
      const original = kv.get.bind(kv); let changed = false, during!: Awaited<ReturnType<typeof f.snapshot>>;
      const cacheGet = vi.spyOn(kv, 'get').mockImplementation(async (key, kind) => {
        const value = await original(key, kind);
        if (key.startsWith('tracking_v1_')) { await f.exec('UPDATE system_role SET rules=rules WHERE id=22'); changed = true; during = await f.snapshot(); }
        return value;
      });
      try { const seq = await f.sequences(); const response = await read(); expect(changed).toBe(true); expect(response.status, response.msg).toBe(409); expect(await f.snapshot()).toEqual(during); expect(await f.sequences()).toEqual(seq); }
      finally { cacheGet.mockRestore(); }
    }); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses nested transaction callers so an inherited snapshot cannot span carrier I/O', async () => f.withReader(async peer => {
    await unchanged(async () => withTx(peer.container, async tx => { await expect(new SupplierOrderTrackingService(createContainerFromDb(tx), f.env)
      .read(f.actor(), 100)).rejects.toThrow('独立读取事务之外'); })); noTransport();
  }));

  it('reads the waybill created by actual Supplier App delivery after mature real checkout and allocation while all order SKU money line and answer history stays unchanged', async () => {
    const whole = await refundRuntimeFixture();
    try {
      await whole.db.insert(systemRole).values([{ id: 21, type: 4, relationId: 7, rules: 'supplier.order.manage' }, { id: 22, type: 4, relationId: 7, rules: 'supplier.order.view' }]);
      await whole.db.insert(systemAdmin).values([21, 22].map(id => ({ id, account: 'owned-tracking-runtime-' + id, pwd: supplierTrackingPassword, adminType: 4, relationId: 7, roles: String(id), level: 1 })));
      const env = { ...whole.env, APP_KEY: supplierTrackingAppKey, NODE_ENV: 'test', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as unknown as typeof f.env;
      let shippedId = 0, shippedNumber = '';
      await whole.withRuntime(async writer => {
        await whole.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_menus TO "${writer.role}"`);
        const created = await writer.createPaid({ key: 'actual-tracking-checkout', orderId: 'actual_tracking_checkout' }); shippedId = created.id; shippedNumber = created.orderId;
        wiring.container = writer.container;
        const response = await app.request('/supplierapi/order/delivery/' + shippedId, { method: 'PUT', headers: { Authorization: 'Bearer ' + f.tokens.manager, 'Content-Type': 'application/json' },
          body: JSON.stringify({ delivery_type: 'express', delivery_name: '实际发货承运商', delivery_code: 'zhongtong', delivery_id: 'APP-ACTUAL-WAYBILL' }) }, env);
        const delivered = await response.json<Envelope>(); expect(delivered.status, delivered.msg).toBe(200);
        expect(await writer.order(shippedId)).toMatchObject({ status: 1, deliveryType: 'express', deliveryName: '实际发货承运商', deliveryId: 'APP-ACTUAL-WAYBILL' });
      });
      // The reused mature fixture's payment marker is synthetic maintenance SQL;
      // checkout/allocation and the Supplier delivery endpoint are real. This is
      // not a payment provider or Customer HTTP acceptance claim.
      async function allState() {
        const rows: Record<string, unknown> = {}, seq: unknown[] = [];
        for (const item of await whole.db.execute<{ name: string; kind: string }>(sql`SELECT relname AS name,relkind AS kind FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN('r','S') ORDER BY relname`)) {
          if (!/^[a-z][a-z0-9_]*$/.test(item.name)) throw Error('Unowned runtime snapshot identifier');
          if (item.kind === 'r') rows[item.name] = await whole.exec(`SELECT to_jsonb(t) AS row FROM public."${item.name}" t ORDER BY to_jsonb(t)::text`);
          else seq.push({ name: item.name, values: await whole.exec(`SELECT last_value,is_called FROM public."${item.name}"`) });
        } return { rows, seq };
      }
      await whole.exec("UPDATE system_config SET value='0' WHERE menu_name='logistics_type'");
      const before = await allState();
      await whole.withRuntimeRole!(async reader => {
        await whole.exec(`GRANT SELECT ON public.system_admin,public.system_supplier,public.system_role,public.system_menus,public.system_config,public.store_order TO "${reader.role}"`);
        wiring.container = createContainerFromDb(reader.db as DbClient);
        const response = await app.request('/supplierapi/order/express/' + shippedId, { headers: { Authorization: 'Bearer ' + f.tokens.viewer } }, env);
        expect(response.headers.get('cache-control')).toContain('private, no-store'); const readback = await response.json<Envelope>(); expect(readback.status, readback.msg).toBe(200);
        expect(readback.data).toMatchObject({ orderId: shippedNumber, delivery_name: '实际发货承运商', delivery_id: 'APP-ACTUAL-WAYBILL', trackingState: 'not_configured', packages: [{ expressNo: 'APP-ACTUAL-WAYBILL' }] });
      });
      expect(await allState()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
    } finally { await whole.close(); }
  }, 90000);
});
