import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '@/lib/di';
import type { AppVariables, Env } from '@/env';
import { authMiddleware } from '@/middleware/auth';
import { createToken, md5 } from '@/utils/jwt';
import * as tokenCache from '@/utils/cache';
import { HttpApiException } from '@/utils/errors';
import * as controller from '@/controllers/api/v1/DeliveryWorkbenchWriteoffController';
import * as oldController from '@/controllers/api/v1/StoreOrderWriteoffController';
import { deliveryOrderRevision, requireDeliveryScope } from '@/services/store/DeliveryPrincipalScope';
import { DeliveryOrderOperationRequest, prepareDeliveryOperation, type DeliveryOperationContext, type DeliveryOperationInput } from '@/services/store/DeliveryOrderOperationRequest';
import { DeliveryOrderWriteoffService, parseDeliveryWriteoffPayload } from '@/services/store/DeliveryOrderWriteoffService';
import { DELIVERY_ORDER_OPERATION_CATALOG_SHA256, deliveryOperationReadiness, inspectDeliveryOrderOperation, runDeliveryOrderOperation } from '@/migrations/runDeliveryOrderOperation';
import { deliveryService, memberRight, storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderStatus, storeOrderWriteoff, storePink, supplierFlowingWater, systemConfig, systemStore, user, userBill, userBrokerage, storeOrderPromotions, storePromotions, storeCouponIssue, systemAttachment, systemSupplier } from '@/models/schema';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers, waitForFinanceBlock } from './helpers/financePeers';
import { createDeliveryWorkbenchRuntime } from './helpers/deliveryWorkbenchRuntime';
import { deliveryWorkbenchReadFixture, observeDeliveryReadDb } from './helpers/deliveryWorkbenchReadFixture';
import { DeliveryReadService } from '@/services/store/DeliveryReadService';
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const pwd = 'a'.repeat(32), actor = { uid: 33, authVersion: md5(pwd), expiresAt: 2147483647 };
const env = { APP_KEY: 'delivery-owned-local-only', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} } } as unknown as Env;
const platform = { kind: 'platform', delivery_id: 1, store_id: 0 } as const;
const store = { kind: 'store', delivery_id: 2, store_id: 77 } as const;

describe('delivery exact original wire intent', () => {
  it('rejects coercive or duplicate quantities and preserves immutable copies before awaiting', async () => {
    const payload = { code: '123456789012', items: [{ order_cart_id: 1, quantity: 1 }] };
    expect(parseDeliveryWriteoffPayload(payload)).toEqual(payload);
    for (const bad of [{ ...payload, items: [{ order_cart_id: '1', quantity: 1 }] }, { ...payload, items: [{ order_cart_id: 1, quantity: true }] }, { ...payload, items: [payload.items[0], payload.items[0]] }, { ...payload, uid: 22 }, { ...payload, code: ' 123456789012' }]) expect(() => parseDeliveryWriteoffPayload(bad)).toThrow();
    const input = { version: 'delivery-writeoff-operation-v1', scope_kind: 'platform', delivery_id: 1, store_id: 0, order_id: 1, scope_key: 'a'.repeat(64), expected_order_revision: 'b'.repeat(64), payload };
    const promise = prepareDeliveryOperation({ actor, request_key: crypto.randomUUID() }, input); payload.items[0].quantity = 9;
    expect((await promise).input.payload).toMatchObject({ items: [{ quantity: 1 }] });
    await expect(prepareDeliveryOperation({ actor, request_key: crypto.randomUUID() }, { ...input, scope_kind: ['platform'] })).rejects.toThrow();
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native courier scoped writeoff and immutable recovery', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, runtime: Awaited<ReturnType<typeof createDeliveryWorkbenchRuntime>>, guard: ReturnType<typeof vi.spyOn>;
  const service = (db = runtime.db) => new DeliveryOrderWriteoffService(createContainerFromDb(db), env);
  const ledger = (db = runtime.db) => new DeliveryOrderOperationRequest(createContainerFromDb(db));
  const context = (): DeliveryOperationContext => ({ actor, request_key: crypto.randomUUID() });
  const current = async (id = 1) => (await f.db.select().from(storeOrder).where(eq(storeOrder.id, id)))[0];
  const carts = async (id = 1) => f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(storeOrderCartInfo.id);
  const intent = async (quantity = 1, id = 1, selected: typeof platform | typeof store = platform): Promise<DeliveryOperationInput> => ({ version: 'delivery-writeoff-operation-v1', scope_kind: selected.kind, delivery_id: selected.delivery_id, store_id: selected.store_id,
    scope_key: (await requireDeliveryScope(f.db, actor, selected)).scope_key, order_id: id, expected_order_revision: await deliveryOrderRevision(await current(id), await carts(id)), payload: { code: (await current(id)).verifyCode, items: [{ order_cart_id: id, quantity }] } });
  const readInput = async (selected: typeof platform | typeof store = platform) => ({ version: 'delivery-workbench-v1', scope_kind: selected.kind, delivery_id: selected.delivery_id, store_id: selected.store_id, scope_key: (await requireDeliveryScope(f.db, actor, selected)).scope_key });
  const state = async () => ({ orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id), carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id), records: await f.db.select().from(storeOrderWriteoff).orderBy(storeOrderWriteoff.id), statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id), flows: await f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id), bills: await f.db.select().from(userBill).orderBy(userBill.id), accounts: await f.db.select({ uid: user.uid, integral: user.integral, exp: user.exp, brokerage: user.brokeragePrice }).from(user).orderBy(user.uid) });
  beforeAll(async () => {
    const tables = [user, systemStore, deliveryService, storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderStatus, storeOrderWriteoff, storePink, systemConfig, memberRight, userBill, userBrokerage, supplierFlowingWater];
    const readTables = [storeOrderPromotions, storePromotions, storeCouponIssue, systemAttachment, systemSupplier];
    f = await financePostgres([...tables, ...readTables], { namespace: 'public' }); await runDeliveryOrderOperation(f.db);
    await f.exec('CREATE UNIQUE INDEX delivery_fixture_bill_event ON user_bill(uid,link_id,event_key)');
    runtime = await createDeliveryWorkbenchRuntime(f.db, tables);
    if(!/^delivery_runtime_[a-f0-9]{32}$/.test(runtime.role))throw Error('Unexpected owned original delivery role');
    await f.db.execute(sql`GRANT SELECT ON public.${sql.identifier('store_order_promotions')},public.${sql.identifier('store_promotions')},public.${sql.identifier('store_coupon_issue')},public.${sql.identifier('system_attachment')},public.${sql.identifier('system_supplier')} TO ${sql.identifier(runtime.role)}`);
  }, 30000);
  afterAll(async () => { try { await runtime?.close(); } finally { await f?.close(); } }, 30000);
  beforeEach(async () => {
    guard = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No courier external provider request'));
    await f.reset(); await f.exec('TRUNCATE delivery_order_operation_request');
    await f.db.insert(user).values([{ uid: 22, pwd, nickname: '配送本地顾客', barCode: 'MEMBER-LOCAL' }, { uid: 33, pwd, nickname: '配送本地账号' }, { uid: 44, pwd, nickname: '另一配送账号' }]);
    await f.db.insert(systemStore).values([{ id: 77, name: '配送门店', isShow: 1, isStore: 1 }, { id: 88, name: '另一门店', isShow: 1, isStore: 1 }]);
    await f.db.insert(deliveryService).values([{ id: 1, uid: 33, type: 0, relationId: 0, status: 1 }, { id: 2, uid: 33, type: 1, relationId: 77, status: 1 }, { id: 3, uid: 44, type: 0, relationId: 0, status: 1 }]);
    await f.db.insert(storeOrder).values([1, 2, 3].map(id => ({ id, orderId: `DELIVERY-LOCAL-${id}`, unique: `delivery-${id}`, uid: 22, storeId: id === 2 ? 88 : 77, paid: 1, status: 1, deliveryType: 'send', deliveryUid: id === 3 ? 44 : 33, shippingType: 1, verifyCode: `12345678901${id + 1}`, totalNum: 3, totalPrice: '30.00', payPrice: '21.00', realName: '配送本地顾客', userPhone: '13000000022', userAddress: '仅原生本地测试地址', productType: 4 })));
    await f.db.insert(storeOrderCartInfo).values([1, 2, 3].map(id => ({ id, oid: id, uid: 22, productId: 70, productType: 4, cartId: String(id), cartNum: 3, writeTimes: 3, writeSurplusTimes: 3, unique: `delivery-cart-${id}`, cartInfo: JSON.stringify({ truePrice: '7.00', productInfo: { id: 70, store_name: '次数商品', price: '10.00', image: '', attrInfo: { suk: '本地规格' } } }) })));
  });
  afterEach(() => { try { expect(guard).not.toHaveBeenCalled(); } finally { guard?.mockRestore(); } });

  it('READ_COMPAT_DELIVERY_CONTEXT actual context and qualified writeoff readers share the same readonly snapshot', async () => {
    const actual=await deliveryWorkbenchReadFixture();
    try {
      // The mature complete read fixture owns all shared snapshot tables.
      // Add only actual writeoff catalog/tables on its owned maintenance login.
      const kit=await import('drizzle-kit/api');
      for(const statement of await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson({storeOrderWriteoff})))await actual.exec(statement);
      await runDeliveryOrderOperation(actual.db);
      await actual.withRuntimeRole(async peer=>{
        await actual.installReadSlice(peer);
        if(!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role))throw Error('Unexpected owned read role');
        await actual.exec(`GRANT SELECT ON public.store_order_writeoff,public.delivery_order_operation_request TO "${peer.role}"`);
        for(const table of ['store_order_promotions','store_promotions','store_coupon_issue','system_attachment','system_supplier','delivery_order_operation_request']){
          const [rights]=await peer.db.execute(sql`SELECT has_table_privilege(current_user,${'public.'+table},'SELECT') AS read,
            (has_table_privilege(current_user,${'public.'+table},'INSERT') OR has_table_privilege(current_user,${'public.'+table},'UPDATE') OR has_table_privilege(current_user,${'public.'+table},'DELETE')) AS write`);
          expect(rights).toEqual({read:true,write:false});
        }
        const [identity]=await peer.db.execute(sql`SELECT current_user AS current,session_user AS session,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super`);
        expect(identity).toEqual({current:peer.role,session:peer.role,super:false});
        let snapshots=0;
        const db=observeDeliveryReadDb(peer.db,async(tx,statement)=>{
          if(!/^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ,\s*READ ONLY/i.test(statement))return;
          const [mode]=await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`);
          expect(mode).toEqual({readonly:'on',isolation:'repeatable read'});snapshots++;
        });
        const container=createContainerFromDb(db),reader=new DeliveryReadService(container,actual.env),writeoff=new DeliveryOrderWriteoffService(container,actual.env),realActor=actual.actor();
        const fullState=async()=>({tables:await actual.snapshot(),writeoffRows:await actual.db.select().from(storeOrderWriteoff).orderBy(storeOrderWriteoff.id),ledger:await actual.db.execute(sql`SELECT * FROM public.delivery_order_operation_request ORDER BY actor_uid,request_key`)}),before=await fullState();
        const reports=[];
        for(const selected of [{kind:'platform',delivery_id:501,store_id:0},{kind:'store',delivery_id:502,store_id:77}]as const){
          const selection={scope_kind:selected.kind,delivery_id:String(selected.delivery_id),store_id:String(selected.store_id)};
          const context=await reader.context(realActor,selection);
          const info=await writeoff.info(realActor,{version:'delivery-workbench-v1',...selection,delivery_id:selected.delivery_id,store_id:selected.store_id,scope_key:context.scope_key,code:'123456789012'});
          const records=await writeoff.records(realActor,{...selection,scope_key:context.scope_key,order_id:'1'});
          expect(context.actor_uid).toBe(realActor.uid);expect(info.actor_uid).toBe(realActor.uid);expect(records.actor_uid).toBe(realActor.uid);
          expect(info.scope_key).toBe(context.scope_key);expect(records.scope_key).toBe(context.scope_key);
          expect(info.data.list.map(row=>row.id)).toEqual([1]);expect(info.data.list[0].cart_info.length).toBeGreaterThan(0);expect(info.data.list[0].cart_info[0].cart_num).toBeGreaterThan(0);
          reports.push({selected,context,info,records});
        }
        expect(snapshots).toBeGreaterThanOrEqual(6);expect(await fullState()).toEqual(before);
        const destination=process.env.TEST_DELIVERY_READ_ENVELOPE_FILE;
        if(destination){
          if(!isAbsolute(destination))throw Error('Fixture envelope destination must be absolute');
          const sanitized=JSON.parse(JSON.stringify(reports,(key,value)=>{
            if(/password|pwd|token|auth_version|authVersion/i.test(key))return undefined;
            if(['avatar','image'].includes(key))return '';
            if(['nickname','account','name','phone','address','detailed_address','real_name','user_phone','user_address','store_name'].includes(key)&&typeof value==='string')return 'fixture-display';
            if(['verify_code','code'].includes(key)&&typeof value==='string')return value?'000000000001':'';
            return value;
          }));
          writeFileSync(destination,JSON.stringify({format:'sanitized-owned-delivery-read-envelope-v1',fixture_actor_uid:realActor.uid,financialExecutionPerformed:false,
            sanitization:'fixture display text/code redacted; avatar/image cleared; no password/auth/token; computed keys and UID/scopes unchanged',reports:sanitized},null,2)+'\n');
        }
        for(const report of reports){expect(report.info.consistency_key).toBe(report.context.consistency_key);expect(report.records.consistency_key).toBe(report.context.consistency_key);}
      });
    }finally{await actual.close();}
  },60000);
  it('READ_COMPAT_DELIVERY persisted member codes retain exact assigned SQL read scope and strict financial intent', async () => {
    const [identity] = await runtime.db.execute(sql`SELECT current_user AS current,session_user AS session,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super`);
    expect(identity).toEqual({current:runtime.role,session:runtime.role,super:false});
    for(const name of ['store_order_promotions','store_promotions','store_coupon_issue','system_attachment','system_supplier']){
      const [permissions]=await runtime.db.execute(sql`SELECT has_table_privilege(current_user,${'public.'+name},'SELECT') AS read,(has_table_privilege(current_user,${'public.'+name},'INSERT') OR has_table_privilege(current_user,${'public.'+name},'UPDATE') OR has_table_privilege(current_user,${'public.'+name},'DELETE')) AS write`);
      expect(permissions).toEqual({read:true,write:false});
    }
    const platformRead=await readInput(),storeRead=await readInput(store);
    const snapshot=async()=>({state:await state(),users:await f.db.select().from(user).orderBy(user.uid),brokerage:await f.db.select().from(userBrokerage).orderBy(userBrokerage.id),requests:await f.db.execute(sql`SELECT * FROM public.delivery_order_operation_request ORDER BY actor_uid,request_key`)});
    const original=await snapshot();
    for(const code of ['A B','A#B','A\\B','A?B','A&B','A/B']){
      await f.db.update(user).set({barCode:code}).where(eq(user.uid,22));const before=await snapshot();
      const result=await service().info(actor,{...platformRead,code});expect(result.data.lookup_kind).toBe('member-barcode');
      expect(result.data.list.map(row=>row.id)).toEqual([2,1]);
      expect((await service().info(actor,{...storeRead,code})).data.list.map(row=>row.id)).toEqual([1]);
      const physical=await f.db.select().from(storeOrder).orderBy(storeOrder.id);
      expect(result.data.list.every(row=>physical.some(order=>order.id===row.id&&order.uid===22&&order.deliveryUid===33))).toBe(true);
      expect(result.data.list.some(row=>row.id===3)).toBe(false);
      await expect(service().info(actor,{...platformRead,code:code+'X'})).rejects.toThrow();
      await expect(service().info(actor,{...platformRead,scope_key:'0'.repeat(64),code})).rejects.toThrow();
      // UID44 is a real active account with its own different delivery row;
      // passing UID33's selected scope must never widen that current authority.
      await expect(service().info({...actor,uid:44},{...platformRead,code})).rejects.toThrow();
      expect(()=>parseDeliveryWriteoffPayload({code,items:[{order_cart_id:1,quantity:1}]})).toThrow('12位');
      expect(await snapshot()).toEqual(before);
    }
    for(const code of [' A B','A B ','A\u0000B','A\nB','undefined'])await expect(service().info(actor,{...platformRead,code})).rejects.toThrow();
    // A persisted 12-digit member value must still select only the order-code
    // branch. It does not match a real order, so it cannot expose member rows.
    await f.db.update(user).set({barCode:'111111111111'}).where(eq(user.uid,22));const beforeOrder=await snapshot();
    await expect(service().info(actor,{...platformRead,code:'111111111111'})).rejects.toThrow();
    const order=await service().info(actor,{...platformRead,code:'123456789012'});expect(order.data.lookup_kind).toBe('order-code');expect(order.data.list.map(row=>row.id)).toEqual([1]);
    expect(await snapshot()).toEqual(beforeOrder);
    const withoutBarcode=(value:Awaited<ReturnType<typeof snapshot>>)=>({...value,users:value.users.map(({barCode:_,...account})=>account)});
    expect(withoutBarcode(await snapshot())).toEqual(withoutBarcode(original));expect((await snapshot()).requests).toEqual([]);
  },60000);
  it('observes the actual native canonical catalog fingerprint', async () => {
    const observed = await inspectDeliveryOrderOperation(f.db); console.log('DELIVERY_CATALOG_CALIBRATION', observed.fingerprint);
    expect(observed).toMatchObject({ present: true }); expect(observed.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('verifies canonical catalog and append-only independent ordinary LOGIN privileges', async () => {
    expect(await inspectDeliveryOrderOperation(runtime.db)).toMatchObject({ complete: true, fingerprint: DELIVERY_ORDER_OPERATION_CATALOG_SHA256 });
    expect(await deliveryOperationReadiness(runtime.db)).toMatchObject({ ready: true, privileges: { read: true, append: true, mutable: false, append_only_acl: true, ordinary_login: true } });
    await expect(runtime.db.execute(sql`DELETE FROM public.delivery_order_operation_request`)).rejects.toThrow();
  });
  it.each(['ended', 'future', 'invalid'] as const)('previews installed presale %s through an ordinary LOGIN readonly snapshot without acquiring a cart lock', async kind => {
    await f.db.update(storeOrder).set({ type: 6 }).where(eq(storeOrder.id, 1));
    const cart = (await carts())[0], snapshot = JSON.parse(cart.cartInfo!);
    snapshot.presale = { version: 'presale-full-payment-v1', productId: 70, startsAt: 0,
      endsAt: kind === 'future' ? 2147483647 : 1, shippingDaysAfterEnd: 0, paidMemberOnly: false, perOrderLimit: null };
    if (kind === 'invalid') snapshot.presale.productId = 71;
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(snapshot) }).where(eq(storeOrderCartInfo.id, 1));
    const before = await state(), read = await readInput();
    const result = await service().info(actor, { ...read, order_id: 1 });
    expect(result.data.list[0].actions.writeoff.available).toBe(kind === 'ended');
    if (kind !== 'ended') expect(result.data.list[0].actions.writeoff.reason).toContain(kind === 'future' ? '尚未结束' : '快照');
    expect(await state()).toEqual(before);
    const outcome = await service().execute(context(), await intent());
    expect(outcome.receipt.outcome).toBe(kind === 'ended' ? 'partial-delivered' : 'rollback-rejected');
    if (kind !== 'ended') expect(await state()).toEqual(before);
  });
  it('partially consumes a real type-four cart at its sale price rotates its code and replays exactly once', async () => {
    const c = context(), input = await intent(), result = await service().execute(c, input);
    expect(result).toMatchObject({ replayed: false, receipt: { actor_uid: 33, delivery_id: 1, outcome: 'partial-delivered', evidence: { completed: false, status: 5, quantities: [{ order_cart_id: 1, quantity: 1 }] } } });
    expect(await current()).toMatchObject({ status: 5, clerkId: 33 }); expect((await current()).verifyCode).not.toBe(input.payload && (input.payload as { code: string }).code);
    expect((await carts())[0]).toMatchObject({ writeSurplusTimes: 2, deliveryId: 1 });
    expect((await state()).records).toMatchObject([{ writeoffNum: 1, writeoffPrice: '7.00' }]);
    const before = await state(); expect(await service().execute(c, input)).toEqual({ receipt: result.receipt, replayed: true }); expect(await state()).toEqual(before);
    expect(JSON.stringify(result.receipt)).not.toMatch(/顾客|13000000022|地址|verify|123456789|pwd/);
  });
  it('completes actual remaining quantities and settles supplier payment once in the same parent transaction', async () => {
    await f.db.update(storeOrder).set({ supplierId: 7, gainIntegral: '2' }).where(eq(storeOrder.id, 1));
    await f.db.insert(supplierFlowingWater).values({ supplierId: 7, uid: 22, linkId: 'DELIVERY-LOCAL-1', orderId: 'FLOW-LOCAL', type: 1, pm: 1, status: 0, number: '6.00' });
    const c = context(), input = await intent(3), result = await service().execute(c, input); expect(result.receipt.outcome).toBe('delivered');
    expect(await current()).toMatchObject({ status: 2 }); expect((await carts())[0].writeSurplusTimes).toBe(0); expect((await state()).flows[0].status).toBe(1); expect((await state()).bills).toMatchObject([{ uid: 22, eventKey: 'pay_give_integral', number: '2.00' }]); expect((await state()).accounts.find(row => row.uid === 22)?.integral).toBe(2);
    expect((await state()).statuses.map(row => row.changeType)).toEqual(expect.arrayContaining(['take_delivery', 'delivery_scope_writeoff']));
    const before = await state(); await service().execute(c, input); expect(await state()).toEqual(before);
  });
  it('uses the actual selected store identity and refuses another store without aliasing platform identity', async () => {
    const result = await service().execute(context(), await intent(1, 1, store)); expect(result.receipt).toMatchObject({ delivery_id: 2, scope_kind: 'store', store_id: 77 });
    const input = await intent(1, 2); const bad = { ...input, scope_kind: 'store', delivery_id: 2, store_id: 77 } as DeliveryOperationInput;
    const before = await state(); expect((await service().execute(context(), bad)).receipt.outcome).toBe('rollback-rejected'); expect(await state()).toEqual(before);
  });
  it.each(['quantity', 'foreign-cart', 'foreign-assignment', 'stale-revision', 'revoked-role', 'duplicate-role', 'refund', 'future-window', 'expired-window', 'parent', 'deleted'] as const)('durably rejects %s only after the entire business rollback', async kind => {
    let input = await intent();
    if (kind === 'quantity') input = { ...input, payload: { code: (await current()).verifyCode, items: [{ order_cart_id: 1, quantity: 4 }] } };
    if (kind === 'foreign-cart') input = { ...input, payload: { code: (await current()).verifyCode, items: [{ order_cart_id: 2, quantity: 1 }] } };
    if (kind === 'foreign-assignment') await f.db.update(storeOrder).set({ deliveryUid: 44 }).where(eq(storeOrder.id, 1));
    if (kind === 'stale-revision') await f.db.update(storeOrder).set({ remark: '真实对端变更' }).where(eq(storeOrder.id, 1));
    if (kind === 'revoked-role') await f.db.update(deliveryService).set({ status: 0 }).where(eq(deliveryService.id, 1));
    if (kind === 'duplicate-role') await f.db.insert(deliveryService).values({ id: 4, uid: 33, type: 0, relationId: 0, status: 1 });
    if (kind === 'refund') { await f.db.insert(storeOrderRefund).values({ storeOrderId: 1, uid: 22, refundType: 1 }); input = await intent(); }
    if (kind === 'future-window') { await f.db.update(storeOrderCartInfo).set({ writeStart: 2147483647 }).where(eq(storeOrderCartInfo.id, 1)); input = await intent(); }
    if (kind === 'expired-window') { await f.db.update(storeOrderCartInfo).set({ writeEnd: 1 }).where(eq(storeOrderCartInfo.id, 1)); input = await intent(); }
    if (kind === 'parent') await f.db.update(storeOrder).set({ pid: -1 }).where(eq(storeOrder.id, 1));
    if (kind === 'deleted') await f.db.update(storeOrder).set({ isSystemDel: 1 }).where(eq(storeOrder.id, 1));
    const before = await state(), c = context(), result = await service().execute(c, input); expect(result.receipt.outcome).toBe('rollback-rejected'); expect(result.receipt.delivery_id).toBe(0); expect(await state()).toEqual(before); expect(await ledger().getOutcome(actor, c.request_key)).toEqual(result.receipt);
  });
  it('serializes two peer LOGINs with the same original UUID without repeating cart or money writes', async () => {
    const c = context(), input = await intent(); const results = await Promise.all([runtime.withPeer(db => service(db).execute(c, input)), runtime.withPeer(db => service(db).execute(c, input))]);
    expect(results.map(r => r.replayed).sort()).toEqual([false, true]); expect(results[0].receipt).toEqual(results[1].receipt); expect((await state()).records).toHaveLength(1);
  });
  it('completes two different orders while the same courier is also their buyer without table or user lock upgrades deadlocking', async () => {
    await f.db.update(storeOrder).set({ uid: 33 }); await f.db.update(storeOrderCartInfo).set({ uid: 33 });
    const inputs = await Promise.all([intent(3, 1), intent(3, 2)]);
    const results = await Promise.all(inputs.map(input => runtime.withPeer(db => service(db).execute(context(), input))));
    expect(results.map(r => r.receipt.outcome)).toEqual(['delivered', 'delivered']); expect((await state()).records).toHaveLength(2);
  });
  it('waits on a real resource lock then rechecks a role withdrawn by another SQL session', async () => {
    const input = await intent();
    await withFinancePeers(f.db, async ([holder, , observer]) => runtime.withPeer(async (db, pid) => {
      let release!: () => void, locked!: () => void; const ready = new Promise<void>(r => { locked = r; }), gate = new Promise<void>(r => { release = r; });
      const holding = withTx(createContainerFromDb(holder.db), async tx => { await tx.select().from(storeOrder).where(eq(storeOrder.id, 1)).for('update'); locked(); await gate; }); await ready;
      const execution = service(db).execute(context(), input); try { await waitForFinanceBlock(observer.db, pid, holder.pid); await f.db.update(deliveryService).set({ status: 0 }).where(eq(deliveryService.id, 1)); } finally { release(); await holding; }
      expect((await execution).receipt.outcome).toBe('rollback-rejected'); expect((await state()).records).toEqual([]);
    }));
  });
  it('recovers only the original account receipt after role removal and preserves absent outcomes as unknown', async () => {
    const c = context(), input = await intent(), first = await service().execute(c, input);
    await f.db.update(deliveryService).set({ status: 0 }).where(eq(deliveryService.id, 1));
    expect(await ledger().getOutcome(actor, c.request_key)).toEqual(first.receipt); expect(await ledger().getOutcome({ ...actor, uid: 22 }, c.request_key)).toBeNull(); expect(await ledger().getOutcome(actor, crypto.randomUUID())).toBeNull();
    expect((await service().execute(c, input)).replayed).toBe(true);
  });
  it('abandons an unchanged original UUID without performing a writeoff and prevents later execution', async () => {
    const c = context(), input = await intent(), before = await state(), receipt = await ledger().abandon(c, input);
    expect(receipt).toMatchObject({ outcome: 'abandoned', delivery_id: 0 }); expect(await service().execute(c, input)).toEqual({ replayed: true, receipt }); expect(await state()).toEqual(before);
    await expect(ledger().abandon(c, { ...input, order_id: 2 })).rejects.toThrow('不同配送操作');
  });
  it('does not convert an actual SQL failure into rollback-rejected or let parent savepoints commit business writes', async () => {
    await f.db.update(storeOrder).set({ supplierId: 7, gainIntegral: '2' }).where(eq(storeOrder.id, 1));
    await f.db.insert(supplierFlowingWater).values({ supplierId: 7, uid: 22, linkId: 'DELIVERY-LOCAL-1', orderId: 'ROLLBACK-FLOW', type: 1, pm: 1, status: 0, number: '6.00' });
    await f.exec("CREATE FUNCTION delivery_fixture_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned receipt failure'; END $$; CREATE TRIGGER delivery_fixture_fail_receipt BEFORE INSERT ON delivery_order_operation_request FOR EACH ROW EXECUTE FUNCTION delivery_fixture_fail_receipt()");
    // Catalog drift itself closes admission. Remove the trigger for this separate
    // commit-boundary failure injection on a real audited status insert.
    await f.exec('DROP TRIGGER delivery_fixture_fail_receipt ON delivery_order_operation_request');
    await f.exec('CREATE TRIGGER delivery_fixture_fail_status BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION delivery_fixture_fail_receipt()');
    const c = context(), input = await intent(3), before = await state();
    try { await expect(service().execute(c, input)).rejects.toThrow(); expect(await state()).toEqual(before); expect(await ledger().getOutcome(actor, c.request_key)).toBeNull(); } finally { await f.exec('DROP TRIGGER delivery_fixture_fail_status ON store_order_status; DROP FUNCTION delivery_fixture_fail_receipt()'); }
  });
  it.each(['hash', 'intent', 'string-id', 'metadata', 'evidence'] as const)('rejects a really INSERTed malformed immutable %s row during owner recovery', async kind => {
    const c = context(), input = await intent(), prepared = await prepareDeliveryOperation(c, input);
    const stored = kind === 'intent' ? { ...input, order_id: 2 } : kind === 'string-id' ? { ...input, delivery_id: '1' } : input;
    await runtime.db.execute(sql`INSERT INTO public.delivery_order_operation_request(actor_uid,request_key,request_hash,scope_kind,delivery_id,store_id,order_id,outcome,scope_key,expected_revision,intent,evidence) VALUES(33,${c.request_key}::uuid,${kind === 'hash' ? 'f'.repeat(64) : prepared.hash},'platform',0,0,${kind === 'metadata' ? 2 : 1},'abandoned',${input.scope_key},${input.expected_order_revision},${JSON.stringify(stored)}::jsonb,${kind === 'evidence' ? '{"code":"invented"}' : '{}'}::jsonb)`);
    await expect(ledger().getOutcome(actor, c.request_key)).rejects.toThrow('回执异常');
  });
  it('projects member barcode multiple orders and current type-four quantities with readonly actions and true record operator proof', async () => {
    const before = await state(), read = await readInput(), member = await service().info(actor, { ...read, code: 'MEMBER-LOCAL' });
    expect(member.data.list.map(r => r.id)).toEqual([2, 1]); expect(member.data.list[0]).toMatchObject({ product_type: 4, actions: { writeoff: { available: true } }, cart_info: [{ write_surplus_times: 3 }] }); expect(await state()).toEqual(before);
    await service().execute(context(), await intent());
    const records = await service().records(actor, { scope_kind: 'platform', delivery_id: '1', store_id: '0', scope_key: read.scope_key, order_id: '1' });
    expect(records.data).toMatchObject({ count: 1, list: [{ operator: { kind: 'delivery', delivery_id: 1 }, writeoff_num: 1, writeoff_price: '7.00' }] });
    await expect(service().info(actor, { ...read, order_id: 3 })).rejects.toThrow();
  });
  it('binds real record rows to reversed wire item order without rewriting the frozen original quantities', async () => {
    await f.db.insert(storeOrderCartInfo).values({ id: 4, oid: 1, uid: 22, productId: 71, productType: 4, cartId: '4', cartNum: 2, writeTimes: 2, writeSurplusTimes: 2, unique: 'second-real-cart', cartInfo: '{"truePrice":"2.00","productInfo":{"id":71,"store_name":"第二商品","price":"9.00"}}' });
    const original = await intent(), input = { ...original, payload: { code: (await current()).verifyCode, items: [{ order_cart_id: 4, quantity: 1 }, { order_cart_id: 1, quantity: 2 }] } };
    const c = context(), receipt = (await service().execute(c, input)).receipt;
    expect(receipt.evidence.quantities).toEqual((input.payload as { items: unknown[] }).items);
    const read = await readInput(), result = await service().records(actor, { scope_kind: 'platform', delivery_id: '1', store_id: '0', scope_key: read.scope_key, order_id: '1', limit: '1' });
    expect(result.data).toMatchObject({ count: 2, has_more: true, list: [{ order_cart_id: 4, writeoff_num: 1, writeoff_price: '2.00', operator: { delivery_id: 1 } }] });
    expect(await ledger().getOutcome(actor, c.request_key)).toEqual(receipt);
  });
  it('reads original platform proof through an independently valid same-account store scope after the platform role is withdrawn', async () => {
    const c = context(), receipt = (await service().execute(c, await intent())).receipt;
    await f.db.update(deliveryService).set({ status: 0 }).where(eq(deliveryService.id, 1));
    const read = await readInput(store), result = await service().records(actor, { scope_kind: 'store', delivery_id: '2', store_id: '77', scope_key: read.scope_key, order_id: '1' });
    expect(result.data.list).toMatchObject([{ operator: { kind: 'delivery', delivery_id: 1 } }]); expect(await ledger().getOutcome(actor, c.request_key)).toEqual(receipt);
    await expect(service().records({ ...actor, uid: 44 }, { scope_kind: 'platform', delivery_id: '3', store_id: '0', scope_key: read.scope_key, order_id: '1' })).rejects.toThrow();
  });
  it('checks current account password status deletion and expiry even for a previously confirmed UUID', async () => {
    const c = context(); await ledger().abandon(c, await intent());
    await expect(ledger().getOutcome({ ...actor, expiresAt: 1 }, c.request_key)).rejects.toThrow();
    for (const patch of [{ pwd: 'b'.repeat(32) }, { status: 0 }, { isDel: 1 }, { deleteTime: new Date() }]) {
      await f.db.update(user).set({ pwd, status: 1, isDel: 0, deleteTime: null, ...patch }).where(eq(user.uid, 33));
      await expect(ledger().getOutcome(actor, c.request_key)).rejects.toThrow();
    }
  });
  it('never recovers a temporary shadow ledger or account as public authority', async () => {
    const c = context(), receipt = await ledger().abandon(c, await intent());
    await runtime.withPeer(async db => {
      await db.execute(sql`CREATE TEMP TABLE delivery_order_operation_request(request_key uuid,evidence jsonb)`);
      await db.execute(sql`CREATE TEMP TABLE "user"(uid integer,pwd varchar,status integer,is_del integer,delete_time timestamptz)`);
      await db.execute(sql`INSERT INTO pg_temp."user" VALUES(33,'forged',1,0,NULL)`);
      await db.execute(sql`SET search_path=pg_temp,public`);
      expect(await ledger(db).getOutcome(actor, c.request_key)).toEqual(receipt);
      expect(await ledger(db).getOutcome(actor, crypto.randomUUID())).toBeNull();
    });
  });
  it('closes malformed price and catalog or ACL drift availability without writing or repairing privileges', async () => {
    const read = await readInput(); await f.db.update(storeOrderCartInfo).set({ cartInfo: '{}' }).where(eq(storeOrderCartInfo.id, 1));
    expect((await service().info(actor, { ...read, order_id: 1 })).data.list[0].actions.writeoff.available).toBe(false);
    await f.exec('ALTER TABLE delivery_order_operation_request ADD COLUMN unexpected_fixture integer');
    try { expect(await deliveryOperationReadiness(runtime.db)).toMatchObject({ ready: false, reason: 'delivery_operation_catalog_incompatible' }); } finally { await f.exec('ALTER TABLE delivery_order_operation_request DROP COLUMN unexpected_fixture'); }
    // The actual canonical public projection is restored; no runtime installer
    // or automatic permission repair is invoked.
    expect((await inspectDeliveryOrderOperation(runtime.db)).complete).toBe(true);
    await f.exec(`GRANT UPDATE ON delivery_order_operation_request TO "${runtime.role}"`);
    try { expect(await deliveryOperationReadiness(runtime.db)).toMatchObject({ ready: false, reason: 'delivery_operation_runtime_privileges_unreviewed' }); } finally { await f.exec(`REVOKE UPDATE ON delivery_order_operation_request FROM "${runtime.role}"`); }
  });
  it('accepts legacy password versions only through the actual signed JWT and exact active token bucket middleware contract', async () => {
    const legacyEnv = { ...env, UPSTASH_REDIS_URL: 'https://local-bucket.invalid', UPSTASH_REDIS_TOKEN: 'local-only' } as Env;
    const token = (await createToken(33, 'api', pwd, env.APP_KEY)).token;
    const bucket = vi.spyOn(tokenCache, 'getTokenBucket').mockImplementation(async key => key === md5(token) ? { uid: 33, type: 'api', token, exp: 2147483647 } : null);
    const clear = vi.spyOn(tokenCache, 'clearToken').mockResolvedValue(true);
    try {
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>(); app.use('*', async (c, next) => { c.set('container', createContainerFromDb(runtime.db)); await next(); }); app.use('*', authMiddleware({ force: true }));
      app.onError((error, c) => c.json({ error: error.message }, 400)); app.get('/operation/:requestKey', controller.outcome);
      const c = context(), receipt = await ledger().abandon(c, await intent());
      const request = () => app.request(`/operation/${c.request_key}`, { headers: { Authorization: `Bearer ${token}` } }, legacyEnv);
      expect(await (await request()).json()).toMatchObject({ status: 200, data: { receipt } });
      bucket.mockResolvedValue(null); expect((await request()).status).toBe(400);
      bucket.mockResolvedValue({ uid: 44, type: 'api', token, exp: 2147483647 }); expect((await request()).status).toBe(400);
      expect((await app.request(`/operation/${c.request_key}`, { headers: { Authorization: `Bearer ${token}` } }, env)).status).toBe(400);
    } finally { bucket.mockRestore(); clear.mockRestore(); }
  });
  it('runs real signed user JWT middleware and HTTP aliases with private responses and strict UUID/body boundaries', async () => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', createContainerFromDb(runtime.db)); await next(); }); app.use('*', controller.privateDeliveryResponse); app.use('*', authMiddleware({ force: true }));
    app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpApiException ? error.httpStatus as 400 : 400));
    app.post('/writeoff', controller.execute); app.post('/delivery/order/writeoff', oldController.deliveryExecute); app.get('/operation/:requestKey', controller.outcome);
    const token = (await createToken(33, 'api', md5(pwd), env.APP_KEY)).token, admin = (await createToken(33, 'admin', md5(pwd), env.APP_KEY)).token, c = context(), input = await intent();
    const post = (url: string, auth: string, body: unknown, key = c.request_key) => app.request(url, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) }, env);
    expect((await post('/writeoff', admin, input)).status).toBe(400); expect((await post('/writeoff', token, { ...input, actor_uid: 22 })).status).toBe(400);
    expect((await post('/delivery/order/writeoff', token, { code: (await current()).verifyCode, auth: 2 })).status).toBe(400);
    const response = await post('/writeoff', token, input); expect(response.headers.get('Cache-Control')).toBe('private, no-store'); expect(await response.json()).toMatchObject({ status: 200, data: { receipt: { actor_uid: 33, outcome: 'partial-delivered' } } });
    const recover = await app.request(`/operation/${c.request_key}`, { headers: { Authorization: `Bearer ${token}` } }, env); expect(await recover.json()).toMatchObject({ status: 200, data: { receipt: { outcome: 'partial-delivered' } } });
    expect((await state()).records).toHaveLength(1);
  });
});
