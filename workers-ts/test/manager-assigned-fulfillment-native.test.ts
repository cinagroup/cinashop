/** Formal PG16 receipt storage and privilege commissioning only. Every row
 * inserted by this file is a structural specimen. It is not an actual Manager
 * delivery, Admin grant, order, payment, outbox event or provider fact. Actual
 * business-chain acceptance belongs to a separate suite and cannot be inferred
 * from these direct-SQL specimens. No HTTP handler or provider is exercised. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { financeNativePostgres } from './helpers/financePostgres';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
import {
  captureManagerAssignedWholeExpressAddon, inspectManagerAssignedFulfillment,
  MANAGER_ASSIGNED_FULFILLMENT_SQL, MANAGER_ASSIGNED_FULFILLMENT_CATALOG_SQL,
  MANAGER_ASSIGNED_FULFILLMENT_CATALOG_SHA256, MANAGER_ASSIGNED_FULFILLMENT_GATE,
} from '@/migrations/managerAssignedFulfillment';
import { upgradeManagerAssignedWholeExpress, upgradeManagerAssignedWholeExpressInTransaction } from '@/migrations/upgradeManagerAssignedWholeExpress';
import { upgradeStoreOrderFulfillmentAssignments } from '@/migrations/upgradeStoreOrderFulfillmentAssignments';
import { STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE } from '@/migrations/storeOrderFulfillmentAssignment';
import { upgradeFulfillmentCityConflictReaders } from '@/migrations/upgradeFulfillmentCityConflictReaders';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges } from '@/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import { auditManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';

type Query = Pick<DbClient, 'execute'>;
type Transaction = Parameters<Parameters<DbClient['transaction']>[0]>[0];
type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
const addon = { receipts: true } as const;
const assignments = { assignments: true } as const;
const hex = 'a'.repeat(64);
const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);

export interface ManagerAssignedFulfillmentStructuralSpecimen {
  actorUid: number; requestKey: string; formatVersion: number; kind: string; outcome: string;
  requestHash: string; targetStoreId: number; staffId: number; scopeKey: string;
  rootOrderId: number; orderId: number; customerUid: number; financialStoreId: number; supplierId: number;
  assignmentOperationId: string; assignmentOrdinal: number; assignmentPayloadHash: string;
  assignmentSourceHash: string; assignmentOrderRevision: string; expectedOrderRevision: string;
  postOrderRevision: string; deliveryOutboxId: number; deliveryEventKey: string; deliveryPayloadHash: string;
  intent: unknown;
}
/** Produces only a structural SQL specimen; there are deliberately no real
 * referenced users, staff, assignments, orders or outbox facts behind it. */
export function managerAssignedFulfillmentStructuralSpecimen(
  overrides: Partial<ManagerAssignedFulfillmentStructuralSpecimen> = {},
): ManagerAssignedFulfillmentStructuralSpecimen {
  const row = {
    actorUid: 101, requestKey: randomUUID(), formatVersion: 1,
    kind: 'assigned_whole_express', outcome: 'delivery-recorded', requestHash: hex,
    targetStoreId: 77, staffId: 12, scopeKey: hex,
    rootOrderId: 9901, orderId: 9901, customerUid: 11, financialStoreId: 0, supplierId: 0,
    assignmentOperationId: randomUUID(), assignmentOrdinal: 1,
    assignmentPayloadHash: hex, assignmentSourceHash: hex, assignmentOrderRevision: hex,
    expectedOrderRevision: hex, postOrderRevision: hex,
    deliveryOutboxId: 9902, deliveryEventKey: 'order.delivery.notice:9901', deliveryPayloadHash: hex,
    ...overrides,
  };
  return { ...row, intent: Object.hasOwn(overrides, 'intent') ? overrides.intent : {
    version: 'merchant-assigned-whole-express-v1', order_id: row.orderId, store_id: row.targetStoreId,
    scope_key: row.scopeKey, assignment_operation_id: row.assignmentOperationId,
    assignment_ordinal: row.assignmentOrdinal, assignment_payload_hash: row.assignmentPayloadHash,
    expected_assignment_source_hash: row.assignmentSourceHash, expected_order_revision: row.expectedOrderRevision,
    payload: { type: 1, express_record_type: 1, delivery_name: '结构样本快递', delivery_code: 'STRUCTURAL', delivery_id: 'SPECIMEN-ONLY' },
  } };
}
/** Raw SQL append for the explicitly structural cases below. It supplies 25
 * typed columns; created_at is tested through its actual SQL clock default. */
export function insertManagerAssignedFulfillmentStructuralSpecimen(
  tx: Query, r: ManagerAssignedFulfillmentStructuralSpecimen = managerAssignedFulfillmentStructuralSpecimen(),
) {
  return tx.execute(sql`INSERT INTO public.manager_assigned_fulfillment_request
    (actor_uid,request_key,format_version,kind,outcome,request_hash,target_store_id,staff_id,scope_key,
      root_order_id,order_id,customer_uid,financial_store_id,supplier_id,assignment_operation_id,
      assignment_ordinal,assignment_payload_hash,assignment_source_hash,assignment_order_revision,
      expected_order_revision,post_order_revision,delivery_outbox_id,delivery_event_key,delivery_payload_hash,intent)
    VALUES(${r.actorUid},${r.requestKey}::uuid,${r.formatVersion},${r.kind},${r.outcome},${r.requestHash},
      ${r.targetStoreId},${r.staffId},${r.scopeKey},${r.rootOrderId},${r.orderId},${r.customerUid},
      ${r.financialStoreId},${r.supplierId},${r.assignmentOperationId}::uuid,${r.assignmentOrdinal},
      ${r.assignmentPayloadHash},${r.assignmentSourceHash},${r.assignmentOrderRevision},${r.expectedOrderRevision},
      ${r.postOrderRevision},${r.deliveryOutboxId},${r.deliveryEventKey},${r.deliveryPayloadHash},${JSON.stringify(r.intent)}::jsonb)`);
}

it.runIf(native)('captures canonical-only Manager assigned receipt shape in owned PG16 without claiming an unpinned hash', async () => {
  const f = await financeNativePostgres([], process.env.TEST_FINANCE_POSTGRES_URL!, { namespace: 'public' });
  try {
    await f.db.execute(sql.raw(MANAGER_ASSIGNED_FULFILLMENT_SQL));
    const [row] = await f.db.execute<{ shape: { columns: unknown[] } }>(sql.raw(MANAGER_ASSIGNED_FULFILLMENT_CATALOG_SQL));
    const hash = await outRequestHash(row.shape);
    console.log('Manager assigned fulfillment canonical PG16 SHA256', hash);
    console.log('Manager assigned fulfillment canonical PG16 shape', JSON.stringify(row.shape));
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(row.shape.columns).toHaveLength(26);
    // The complete successor cases below require the source-pinned constant.
    // Capturing a shape here does not install it or prove that an empty pin is ready.
  } finally { await f.close(); }
}, 30000);

describe.runIf(native)('formal Manager assigned whole express receipt storage successor', () => {
  let f: Fixture, peers: RuntimeGiftPeerDeclarations, other: string;
  let city: { owner: string; app: true; admin: true; manager: true };
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const desired = (): RuntimeGiftPeerDeclarations => ({ ...peers, managerAssignedWholeExpress: { ...addon } });
  const named = () => ({ maintenance: f.target.maintenance, manager: f.managerRuntime.role });
  const targetIdentity = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin,
    ...(f.target.local ? { local: [...f.target.local] } : {}),
    ...(f.target.caseLock ? { caseLock: { owner: f.target.caseLock.owner, runtimeRoles: [...f.target.caseLock.runtimeRoles] } } : {}) });
  async function snapshot(db: Query) {
    const [row] = await db.execute<{ value: unknown }>(sql`SELECT pg_catalog.jsonb_build_object(
      'relations',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.oid::text,c.relname,c.relowner::text,c.relacl::text,c.reloptions,c.relchecks) ORDER BY c.oid)
        FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace),
      'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attrelid::text,a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attacl::text,a.attisdropped) ORDER BY a.attrelid,a.attnum)
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attnum>0),
      'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(k.oid::text,k.conname,pg_catalog.pg_get_constraintdef(k.oid,false)) ORDER BY k.oid)
        FROM pg_catalog.pg_constraint k WHERE k.connamespace='public'::regnamespace),
      'functions',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(p.oid::text,p.proname,p.proowner::text,p.proacl::text,pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))) ORDER BY p.oid)
        FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind<>'a'),
      'defaults',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid) FROM pg_catalog.pg_default_acl d)
    ) AS value`);
    return row.value;
  }
  async function refusedWithoutRepair(change: (tx: Query) => Promise<unknown>) {
    const before = await snapshot(f.maintenanceDb);
    await expect(f.maintenanceDb.transaction(async tx => {
      await change(tx); const changed = await snapshot(tx);
      await expect(tx.transaction(inner => upgradeManagerAssignedWholeExpressInTransaction(inner, f.target, addon, desired(), f.appReaders))).rejects.toThrow();
      expect(await snapshot(tx)).toEqual(changed);
      throw Error('owned assigned receipt drift rollback');
    })).rejects.toThrow('owned assigned receipt drift rollback');
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  }
  async function hold(lock: (tx: Query) => Promise<unknown>, work: () => Promise<void>) {
    await f.withMaintenancePeer(async peer => {
      let ready!: () => void, release!: () => void;
      const acquired = new Promise<void>(resolve => { ready = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
      const held = peer.transaction(async tx => { await lock(tx); ready(); await released; });
      try { await Promise.race([acquired, held.then(() => { throw Error('Owned assigned receipt holder exited early'); })]); await work(); }
      finally { release(); await held; }
    });
  }
  async function structuralRollback(work: (tx: Transaction) => Promise<unknown>, db: DbClient = f.managerRuntime.db) {
    await expect(db.transaction(async tx => { await work(tx); throw Error('owned receipt structural rollback'); }))
      .rejects.toThrow('owned receipt structural rollback');
  }
  async function invalidSpecimen(row: ManagerAssignedFulfillmentStructuralSpecimen) {
    await structuralRollback(async tx => {
      await expect(tx.transaction(inner => insertManagerAssignedFulfillmentStructuralSpecimen(inner, row)))
        .rejects.toMatchObject({ cause: { code: '23514' } });
    });
  }
  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider transport in assigned receipt storage acceptance'));
    f = await customerCashierRuntimeHttpFixture(); peers = f.peers;
    other = (await f.createOwnedRole('assignedother', true)).role;
    const pids = await Promise.all([f.appRuntime, f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime].map(p => p.verify()));
    expect(new Set(pids).size).toBe(5);
    city = { owner: (await f.createOwnedRole('assignedcity')).role, app: true, admin: true, manager: true };
    const cityPeers = { ...peers, cityConflictReaders: city };
    expect((await upgradeFulfillmentCityConflictReaders(f.maintenanceDb, f.target, { readers: city }, cityPeers, f.appReaders)).applied).toBe(true);
    const assignmentPeers = { ...cityPeers, fulfillmentAssignments: assignments };
    const installed = await upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb, f.target, assignments, assignmentPeers, f.appReaders);
    expect(installed.applied).toBe(true); peers = installed.peers;
  }, 180000);
  afterAll(async () => { try { if (f) await f.close(); } finally { network?.mockRestore(); } }, 30000);

  it('rejects non-data, extra and incomplete receipt declarations before SQL', async () => {
    let getters = 0;
    for (const input of [{}, { receipts: false }, { receipts: new Boolean(true) }, { receipts: true, extra: 1 }, [],
      { get receipts() { getters++; return true; } }])
      expect(() => captureManagerAssignedWholeExpressAddon(input as typeof addon)).toThrow();
    expect(getters).toBe(0);
    const getterPeers = { ...peers, get managerAssignedWholeExpress() { getters++; return addon; } };
    expect(() => captureRuntimeGiftPeerDeclarations(getterPeers)).toThrow(); expect(getters).toBe(0);
    const before = await snapshot(f.maintenanceDb);
    for (const bad of [peers, { ...desired(), manager: undefined }, { ...desired(), financial: undefined },
      { ...desired(), cashierSecondCard: undefined }, { ...desired(), fulfillmentAssignments: undefined }])
      await expect(upgradeManagerAssignedWholeExpress(f.maintenanceDb, f.target, addon, bad, f.appReaders)).rejects.toThrow();
    await expect(upgradeManagerAssignedWholeExpress(f.maintenanceDb, f.target,
      { get receipts() { getters++; return true; } } as typeof addon, desired(), f.appReaders)).rejects.toThrow();
    const getterTarget = { ...f.target, get deployment() { getters++; return 'untrusted'; } };
    await expect(upgradeManagerAssignedWholeExpress(f.maintenanceDb, getterTarget, addon, desired(), f.appReaders)).rejects.toThrow();
    expect(getters).toBe(0);
    expect(await inspectManagerAssignedFulfillment(f.maintenanceDb, named())).toMatchObject({ present: false, ready: false });
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  });

  it('rolls fresh complete DDL and exact grants back with its caller and changes no business facts', async () => {
    const before = await snapshot(f.maintenanceDb), facts = await f.facts();
    await expect(f.maintenanceDb.transaction(async tx => {
      expect((await upgradeManagerAssignedWholeExpressInTransaction(tx, f.target, addon, desired(), f.appReaders)).applied).toBe(true);
      expect(await inspectManagerAssignedFulfillment(tx, named())).toMatchObject({ present: true, ready: true });
      throw Error('owned assigned receipt complete rollback');
    })).rejects.toThrow('owned assigned receipt complete rollback');
    expect(await snapshot(f.maintenanceDb)).toEqual(before); expect(await f.facts()).toEqual(facts);
  }, 90000);

  it('refuses a partial reserved namespace instead of completing or repairing it', async () => {
    await refusedWithoutRepair(tx => tx.execute(sql`CREATE TYPE public.manager_assigned_fulfillment_request AS ENUM('partial')`));
  });

  it('detaches intent before the first await and installs only exact fixed-Manager SELECT INSERT', async () => {
    const target = { ...structuredClone(f.target), metadata: 'not_authority' }, input: { receipts: true } = { ...addon };
    const wanted = structuredClone(desired()), expected = captureRuntimeGiftPeerDeclarations(structuredClone(wanted)), reader = structuredClone(f.appReaders);
    const facts = await f.facts(), pending = upgradeManagerAssignedWholeExpress(f.maintenanceDb, target, input, wanted, reader);
    target.database = 'mutated_after_call'; Reflect.set(input, 'receipts', false); wanted.target.local = [];
    delete wanted.managerAssignedWholeExpress; Reflect.set(reader, 'cashierOrigin', false);
    const result = await pending; expect(result.applied).toBe(true); expect(result.target).toEqual(targetIdentity());
    expect(Object.hasOwn(result.target, 'metadata')).toBe(false); expect(Object.hasOwn(result.target, 'pricingOwner')).toBe(false);
    expect(result.peers).toEqual(expected); peers = result.peers;
    const installed = await inspectManagerAssignedFulfillment(f.maintenanceDb, named());
    expect(installed).toMatchObject({ present: true, ready: true, binding: {
      database: f.database, maintenance: f.target.maintenance, manager: f.managerRuntime.role,
    } });
    const [shape] = await f.maintenanceDb.execute<{ shape: { columns: unknown[] } }>(sql.raw(MANAGER_ASSIGNED_FULFILLMENT_CATALOG_SQL));
    expect(shape.shape.columns).toHaveLength(26);
    expect(await outRequestHash(shape.shape)).toBe(MANAGER_ASSIGNED_FULFILLMENT_CATALOG_SHA256);
    expect(MANAGER_ASSIGNED_FULFILLMENT_CATALOG_SHA256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await f.facts()).toEqual(facts);
  }, 90000);

  it('keeps full five actual LOGIN profiles exact after the declared successor', async () => {
    for (const audit of [
      await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, peers, f.appReaders),
      await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, peers),
      await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db, f.target, f.manual, f.readers),
      await auditManagerRuntimePrivileges(f.managerRuntime.db, f.target, undefined, city, assignments, addon),
      await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db, f.cashierRuntime.role, f.target,
        { abandon: true, conditionalGuards: true, formImages: true }),
    ]) expect(audit).toMatchObject({ ready: true, failures: [] });
  }, 90000);

  it('treats an exact installed repeat as read-only', async () => {
    const before = await snapshot(f.maintenanceDb), facts = await f.facts();
    expect((await upgradeManagerAssignedWholeExpress(f.maintenanceDb, f.target, addon, peers, f.appReaders)).applied).toBe(false);
    expect(await snapshot(f.maintenanceDb)).toEqual(before); expect(await f.facts()).toEqual(facts);
  }, 90000);

  it('refuses undeclared installed receipt successors in App Admin and Manager profiles', async () => {
    const { managerAssignedWholeExpress: _, ...old } = peers;
    for (const audit of [
      await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, old, f.appReaders),
      await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, old),
      await auditManagerRuntimePrivileges(f.managerRuntime.db, f.target, undefined, city, assignments),
    ]) expect(audit.ready).toBe(false);
  }, 90000);

  it.each(['appRuntime', 'adminRuntime', 'financialRuntime', 'managerRuntime', 'cashierRuntime'] as const)
  ('enforces actual %s SELECT INSERT and mutation column grant-option trigger denials', async peerName => {
    const peer = f[peerName], manager = peerName === 'managerRuntime';
    const [p] = await f.maintenanceDb.execute<{ read: boolean; append: boolean; mutate: boolean; delegate: boolean; execute: boolean }>(sql`SELECT
      pg_catalog.has_table_privilege(${peer.role},'public.manager_assigned_fulfillment_request','SELECT') AS read,
      pg_catalog.has_table_privilege(${peer.role},'public.manager_assigned_fulfillment_request','INSERT') AS append,
      pg_catalog.has_table_privilege(${peer.role},'public.manager_assigned_fulfillment_request','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(${peer.role},'public.manager_assigned_fulfillment_request','UPDATE,REFERENCES') AS mutate,
      pg_catalog.has_table_privilege(${peer.role},'public.manager_assigned_fulfillment_request','SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION') AS delegate,
      pg_catalog.has_function_privilege(${peer.role},'public.manager_assigned_fulfillment_request_immutable_v1()','EXECUTE') AS execute`);
    expect(p).toEqual({ read: manager, append: manager, mutate: false, delegate: false, execute: false });
    if (manager) await peer.db.execute(sql`SELECT * FROM public.manager_assigned_fulfillment_request LIMIT 0`);
    else {
      await expect(peer.db.execute(sql`SELECT * FROM public.manager_assigned_fulfillment_request LIMIT 0`)).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(peer.db.execute(sql`INSERT INTO public.manager_assigned_fulfillment_request DEFAULT VALUES`)).rejects.toMatchObject({ cause: { code: '42501' } });
    }
    for (const command of ['UPDATE public.manager_assigned_fulfillment_request SET assignment_ordinal=assignment_ordinal',
      'DELETE FROM public.manager_assigned_fulfillment_request WHERE false', 'TRUNCATE public.manager_assigned_fulfillment_request'])
      await expect(peer.db.execute(sql.raw(command))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('stores only structural specimens under Manager and uses its actual SQL clock default', async () => {
    await structuralRollback(async tx => {
      const sample = managerAssignedFulfillmentStructuralSpecimen();
      await insertManagerAssignedFulfillmentStructuralSpecimen(tx, sample);
      const [row] = await tx.execute<{ actor: number; key: string; created: string; intent: unknown }>(sql`SELECT actor_uid AS actor,request_key::text AS key,created_at::text AS created,intent
        FROM public.manager_assigned_fulfillment_request WHERE actor_uid=${sample.actorUid} AND request_key=${sample.requestKey}::uuid`);
      expect(row).toMatchObject({ actor: sample.actorUid, key: sample.requestKey, intent: sample.intent });
      expect(Number(row.created)).toBeGreaterThan(0);
    });
  });

  it.each(['Manager', 'maintenance owner'] as const)('keeps a real inserted structural row immutable for %s', async principal => {
    await structuralRollback(async tx => {
      const sample = managerAssignedFulfillmentStructuralSpecimen(); await insertManagerAssignedFulfillmentStructuralSpecimen(tx, sample);
      for (const statement of [sql`UPDATE public.manager_assigned_fulfillment_request SET intent=intent WHERE actor_uid=${sample.actorUid} AND request_key=${sample.requestKey}::uuid`,
        sql`DELETE FROM public.manager_assigned_fulfillment_request WHERE actor_uid=${sample.actorUid} AND request_key=${sample.requestKey}::uuid`,
        sql`TRUNCATE public.manager_assigned_fulfillment_request`])
        await expect(tx.transaction(inner => inner.execute(statement))).rejects.toMatchObject({ cause: { code: '42501' } });
    }, principal === 'Manager' ? f.managerRuntime.db : f.maintenanceDb);
  });

  it('rejects a duplicate actor request key without inventing a second success', async () => {
    await structuralRollback(async tx => {
      const sample = managerAssignedFulfillmentStructuralSpecimen(); await insertManagerAssignedFulfillmentStructuralSpecimen(tx, sample);
      const duplicate = managerAssignedFulfillmentStructuralSpecimen({ requestKey: sample.requestKey,
        rootOrderId: 9903, orderId: 9903, deliveryOutboxId: 9904, deliveryEventKey: 'order.delivery.notice:9903' });
      await expect(tx.transaction(inner => insertManagerAssignedFulfillmentStructuralSpecimen(inner, duplicate)))
        .rejects.toMatchObject({ cause: { code: '23505' } });
    });
  });

  it('rejects a second whole-success specimen for the same order', async () => {
    await structuralRollback(async tx => {
      await insertManagerAssignedFulfillmentStructuralSpecimen(tx);
      await expect(tx.transaction(inner => insertManagerAssignedFulfillmentStructuralSpecimen(inner,
        managerAssignedFulfillmentStructuralSpecimen({ deliveryOutboxId: 9904 })))).rejects.toMatchObject({ cause: { code: '23505' } });
    });
  });

  it('rejects sharing one outbox identity across two successful order specimens', async () => {
    await structuralRollback(async tx => {
      await insertManagerAssignedFulfillmentStructuralSpecimen(tx);
      const duplicate = managerAssignedFulfillmentStructuralSpecimen({ rootOrderId: 9903, orderId: 9903, deliveryEventKey: 'order.delivery.notice:9903' });
      await expect(tx.transaction(inner => insertManagerAssignedFulfillmentStructuralSpecimen(inner, duplicate)))
        .rejects.toMatchObject({ cause: { code: '23505' } });
    });
  });

  it.each([
    ['zero actor', { actorUid: 0 }], ['zero target', { targetStoreId: 0 }], ['zero staff', { staffId: 0 }],
    ['zero customer', { customerUid: 0 }], ['zero root', { rootOrderId: 0, orderId: 0, deliveryEventKey: 'order.delivery.notice:0' }],
    ['unequal root', { rootOrderId: 9903 }], ['nonzero financial owner', { financialStoreId: 77 }],
    ['nonzero supplier', { supplierId: 77 }], ['format two', { formatVersion: 2 }],
    ['legacy kind', { kind: 'manual_delivery' }], ['negative outcome', { outcome: 'not_applied' }],
    ['non-v4 request key', { requestKey: '12345678-1234-1234-9234-123456789012' }],
    ['non-v4 grant key', { assignmentOperationId: '12345678-1234-1234-9234-123456789012' }],
    ['zero grant ordinal', { assignmentOrdinal: 0 }], ['unbounded grant ordinal', { assignmentOrdinal: 65 }],
    ['bad request digest', { requestHash: 'A'.repeat(64) }], ['bad scope digest', { scopeKey: 'x'.repeat(64) }],
    ['bad grant payload digest', { assignmentPayloadHash: 'x'.repeat(64) }],
    ['bad grant source digest', { assignmentSourceHash: 'x'.repeat(64) }],
    ['bad grant revision', { assignmentOrderRevision: 'x'.repeat(64), expectedOrderRevision: 'x'.repeat(64) }],
    ['different expected grant revision', { expectedOrderRevision: 'b'.repeat(64) }],
    ['bad post revision', { postOrderRevision: 'x'.repeat(64) }], ['zero outbox', { deliveryOutboxId: 0 }],
    ['wrong event key', { deliveryEventKey: 'order.paid:9901' }], ['bad delivery digest', { deliveryPayloadHash: 'x'.repeat(64) }],
  ] satisfies Array<[string, Partial<ManagerAssignedFulfillmentStructuralSpecimen>]>)('rejects structural %s', async (_label, change) => {
    await invalidSpecimen(managerAssignedFulfillmentStructuralSpecimen(change));
  });

  const intentMutation = (mutate: (intent: Record<string, any>) => unknown) => {
    const row = managerAssignedFulfillmentStructuralSpecimen(); const intent = structuredClone(row.intent) as Record<string, any>;
    const replacement = mutate(intent); return { ...row, intent: replacement === undefined ? intent : replacement };
  };
  it.each([
    ['missing root field', (v: Record<string, any>) => { delete v.order_id; }],
    ['extra outer PII', (v: Record<string, any>) => { v.phone = 'forbidden'; }],
    ['unknown request version', (v: Record<string, any>) => { v.version = 'merchant-order-operation-v1'; }],
    ['string order coercion', (v: Record<string, any>) => { v.order_id = '9901'; }],
    ['different order', (v: Record<string, any>) => { v.order_id = 9903; }],
    ['different store', (v: Record<string, any>) => { v.store_id = 78; }],
    ['different scope', (v: Record<string, any>) => { v.scope_key = 'b'.repeat(64); }],
    ['different grant key', (v: Record<string, any>) => { v.assignment_operation_id = randomUUID(); }],
    ['different grant ordinal', (v: Record<string, any>) => { v.assignment_ordinal = 2; }],
    ['different grant digest', (v: Record<string, any>) => { v.assignment_payload_hash = 'b'.repeat(64); }],
    ['different source digest', (v: Record<string, any>) => { v.expected_assignment_source_hash = 'b'.repeat(64); }],
    ['different reviewed revision', (v: Record<string, any>) => { v.expected_order_revision = 'b'.repeat(64); }],
    ['null intent', () => null], ['array intent', () => []],
    ['null payload', (v: Record<string, any>) => { v.payload = null; }],
    ['missing payload type', (v: Record<string, any>) => { delete v.payload.type; }],
    ['electronic record type', (v: Record<string, any>) => { v.payload.express_record_type = 2; }],
    ['different fulfillment type', (v: Record<string, any>) => { v.payload.type = 2; }],
    ['extra payload address', (v: Record<string, any>) => { v.payload.address = 'forbidden'; }],
    ['null carrier name', (v: Record<string, any>) => { v.payload.delivery_name = null; }],
    ['empty carrier name', (v: Record<string, any>) => { v.payload.delivery_name = ''; }],
    ['long carrier name', (v: Record<string, any>) => { v.payload.delivery_name = 'x'.repeat(65); }],
    ['untrimmed carrier name', (v: Record<string, any>) => { v.payload.delivery_name = ' carrier'; }],
    ['control carrier name', (v: Record<string, any>) => { v.payload.delivery_name = 'car\nrier'; }],
    ['empty carrier code', (v: Record<string, any>) => { v.payload.delivery_code = ''; }],
    ['long carrier code', (v: Record<string, any>) => { v.payload.delivery_code = 'x'.repeat(51); }],
    ['untrimmed tracking', (v: Record<string, any>) => { v.payload.delivery_id = 'SPECIMEN '; }],
    ['control tracking', (v: Record<string, any>) => { v.payload.delivery_id = 'SPEC\tIMEN'; }],
    ['long tracking', (v: Record<string, any>) => { v.payload.delivery_id = 'x'.repeat(65); }],
    ['oversize bytes', (v: Record<string, any>) => { v.payload.delivery_name = '汉'.repeat(9000); }],
  ] as const)('rejects closed structural intent %s', async (_label, mutate) => {
    await invalidSpecimen(intentMutation(mutate));
  });

  it('accepts structural boundary text and maximum declared assignment ordinal', async () => {
    const sample = managerAssignedFulfillmentStructuralSpecimen({ assignmentOrdinal: 64 });
    const intent = structuredClone(sample.intent) as Record<string, any>;
    intent.payload = { type: 1, express_record_type: 1, delivery_name: '汉'.repeat(64), delivery_code: 'x'.repeat(50), delivery_id: 'x'.repeat(64) };
    await structuralRollback(tx => insertManagerAssignedFulfillmentStructuralSpecimen(tx, { ...sample, intent }));
  });

  it('fails a busy new receipt maintenance gate without changing metadata', async () => {
    const before = await snapshot(f.maintenanceDb);
    await hold(tx => tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${MANAGER_ASSIGNED_FULFILLMENT_GATE[0]},${MANAGER_ASSIGNED_FULFILLMENT_GATE[1]})`), async () => {
      await expect(upgradeManagerAssignedWholeExpress(f.maintenanceDb, f.target, addon, peers, f.appReaders)).rejects.toThrow();
    });
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  }, 30000);

  it('retains the existing assignment maintenance gate in the commissioning lock order', async () => {
    const before = await snapshot(f.maintenanceDb);
    await hold(tx => tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE[0]},${STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE[1]})`), async () => {
      await expect(upgradeManagerAssignedWholeExpress(f.maintenanceDb, f.target, addon, peers, f.appReaders)).rejects.toThrow();
    });
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  }, 30000);

  it('fails on a real ACCESS EXCLUSIVE receipt table holder even for an exact repeat', async () => {
    const before = await snapshot(f.maintenanceDb);
    await hold(tx => tx.execute(sql`LOCK TABLE ONLY public.manager_assigned_fulfillment_request IN ACCESS EXCLUSIVE MODE NOWAIT`), async () => {
      await expect(upgradeManagerAssignedWholeExpress(f.maintenanceDb, f.target, addon, peers, f.appReaders)).rejects.toThrow();
    });
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  }, 30000);

  it.each([
    ['extra Admin SELECT', (tx: Query) => tx.execute(sql`GRANT SELECT ON public.manager_assigned_fulfillment_request TO ${sql.identifier(f.adminRuntime.role)}`)],
    ['Manager UPDATE', (tx: Query) => tx.execute(sql`GRANT UPDATE ON public.manager_assigned_fulfillment_request TO ${sql.identifier(f.managerRuntime.role)}`)],
    ['Financial column SELECT', (tx: Query) => tx.execute(sql`GRANT SELECT(intent) ON public.manager_assigned_fulfillment_request TO ${sql.identifier(f.financialRuntime.role)}`)],
    ['grant option', (tx: Query) => tx.execute(sql`GRANT SELECT ON public.manager_assigned_fulfillment_request TO ${sql.identifier(f.managerRuntime.role)} WITH GRANT OPTION`)],
    ['owner replacement', (tx: Query) => tx.execute(sql`ALTER TABLE public.manager_assigned_fulfillment_request OWNER TO ${sql.identifier(other)}`)],
    ['RLS', (tx: Query) => tx.execute(sql`ALTER TABLE public.manager_assigned_fulfillment_request ENABLE ROW LEVEL SECURITY`)],
    ['function flags', (tx: Query) => tx.execute(sql`ALTER FUNCTION public.manager_assigned_fulfillment_request_immutable_v1() COST 101`)],
    ['PUBLIC function grant', (tx: Query) => tx.execute(sql`GRANT EXECUTE ON FUNCTION public.manager_assigned_fulfillment_request_immutable_v1() TO PUBLIC`)],
    ['disabled immutable trigger', (tx: Query) => tx.execute(sql`ALTER TABLE public.manager_assigned_fulfillment_request DISABLE TRIGGER mafr_immutable_rows`)],
    ['missing intent check', (tx: Query) => tx.execute(sql`ALTER TABLE public.manager_assigned_fulfillment_request DROP CONSTRAINT mafr_intent_ck`)],
    ['extra index', (tx: Query) => tx.execute(sql`CREATE INDEX manager_assigned_extra_index ON public.manager_assigned_fulfillment_request(staff_id)`)],
    ['same-prefix namespace residue', (tx: Query) => tx.execute(sql`CREATE TABLE public.manager_assigned_fulfillment_request_shadow(id integer)`)],
  ] as const)('refuses %s drift without any repair', async (_label, change) => { await refusedWithoutRepair(change); });

  it.each(['appRuntime', 'adminRuntime', 'financialRuntime', 'managerRuntime', 'cashierRuntime'] as const)
  ('refuses the actual %s LOGIN as maintenance', async principal => {
    const before = await snapshot(f.maintenanceDb);
    await expect(upgradeManagerAssignedWholeExpress(f[principal].db, f.target, addon, peers, f.appReaders)).rejects.toThrow();
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  });

  it('refuses a maintenance session using SET ROLE', async () => {
    await expect(f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.adminRuntime.role)}`);
      return upgradeManagerAssignedWholeExpressInTransaction(tx, f.target, addon, peers, f.appReaders);
    })).rejects.toThrow();
  });

  it('refuses replica mode even on the actual maintenance LOGIN', async () => {
    await expect(f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`SET LOCAL session_replication_role=replica`);
      return upgradeManagerAssignedWholeExpressInTransaction(tx, f.target, addon, peers, f.appReaders);
    })).rejects.toThrow();
  });

  it('refuses a wrong database even when target and peers declare the same wrong database', async () => {
    const wrong = { ...f.target, database: 'wrong_owned_fixture_database' };
    await expect(upgradeManagerAssignedWholeExpress(f.maintenanceDb, wrong, addon, { ...peers, target: wrong }, f.appReaders)).rejects.toThrow();
  });

  it('refuses read committed read only maintenance transactions', async () => {
    await expect(f.maintenanceDb.transaction(tx => upgradeManagerAssignedWholeExpressInTransaction(tx, f.target, addon, peers, f.appReaders),
      { isolationLevel: 'read committed', accessMode: 'read only' })).rejects.toThrow();
  });

  it('refuses repeatable read read write maintenance transactions', async () => {
    await expect(f.maintenanceDb.transaction(tx => upgradeManagerAssignedWholeExpressInTransaction(tx, f.target, addon, peers, f.appReaders),
      { isolationLevel: 'repeatable read', accessMode: 'read write' })).rejects.toThrow();
  });

  it('keeps catalog inspection independent of TEMP shadows and performs no provider transport', async () => {
    const installed = await inspectManagerAssignedFulfillment(f.maintenanceDb, named());
    await f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`CREATE TEMP TABLE pg_class(fake integer) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE manager_assigned_fulfillment_request(fake integer) ON COMMIT DROP`);
      await tx.execute(sql`SET LOCAL search_path=pg_temp,pg_catalog`);
      expect(await inspectManagerAssignedFulfillment(tx, named())).toEqual(installed);
    });
    const [count] = await f.maintenanceDb.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM public.manager_assigned_fulfillment_request`);
    expect(count.n).toBe(0); expect(network).not.toHaveBeenCalled();
  });
});
