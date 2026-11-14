import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderRefund, systemConfig, user, userInvoice } from '@/models/schema';
import { createToken } from '@/utils/jwt';
import { buyerInvoiceDraft, buyerInvoiceQuery, parseBuyerInvoiceOrder, parseBuyerInvoicePage } from '../../view/common/buyerInvoices';
import { withBuyerInvoices } from './helpers/buyerInvoices';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
const initial = () => ({ id: 0, revision: '', headerType: 1, type: 1, name: '本机买家', dutyNumber: '', drawerPhone: '13800000000', email: 'buyer@example.invalid', tell: '', address: '', bank: '', cardNumber: '', isDefault: false });
type S = Parameters<Parameters<typeof withBuyerInvoices>[0]>[0];
async function titles(s: S, prefix = '/api') { const r = await s.request(prefix + '/invoice?view=buyer'); expect(r.status, r.msg).toBe(200); return parseBuyerInvoicePage(r.data, buyerInvoiceQuery('titles'), 11).items as import('../../view/common/buyerInvoices').BuyerInvoiceTitle[]; }
async function create(s: S, changes = {}) { const r = await s.request('/api/invoice/save?view=buyer', { ...initial(), ...changes }); expect(r.status, r.msg).toBe(200); return (await titles(s)).find(t => t.id === r.data.id)!; }
async function view(s: S, reference = 'invoice_order_A') { const r = await s.request('/api/order/invoice_detail/' + reference + '?view=buyer'); expect(r.status, r.msg).toBe(200); return parseBuyerInvoiceOrder(r.data, reference, 11); }
const application = (o: Awaited<ReturnType<typeof view>>, t: Awaited<ReturnType<typeof create>>) => ({ orderId: o.orderId, orderNo: o.orderNo, revision: o.revision, titleId: t.id, titleRevision: t.revision });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('buyer invoices actual App/JWT/commissioned restricted LOGIN', () => {
  it('creates/edits/defaults/deletes owned titles through both HTTP aliases, preserving default groups and immutable order snapshots', async () => withBuyerInvoices(async s => {
    await s.seedOrder(); let a = await create(s, { isDefault: true });
    const b = await create(s, { name: '本机公司', headerType: 2, dutyNumber: 'A'.repeat(18), isDefault: true });
    const c = await create(s, { name: '另一个人', isDefault: true });
    expect((await titles(s)).filter(t => t.isDefault).map(t => t.id).sort()).toEqual([b.id, c.id].sort());
    a = (await titles(s)).find(t => t.id === a.id)!;
    const def = await s.request('/api/v2/invoice/set_default/' + a.id + '?view=buyer', { revision: a.revision }); expect(def.status, def.msg).toBe(200);
    a = (await titles(s, '/api/v2')).find(t => t.id === a.id)!;
    const o = await view(s), made = await s.request('/api/v2/order/make_up_invoice?view=buyer', application(o, a)); expect(made.status, made.msg).toBe(200);
    const snapshot = (await view(s)).invoice!; expect(snapshot).toMatchObject({ name: '本机买家', amount: '20.00', paid: true, state: 0 });
    const edit = await s.request('/api/v2/invoice/save?view=buyer', { ...buyerInvoiceDraft(a), name: '更名买家' }); expect(edit.status, edit.msg).toBe(200);
    a = (await titles(s)).find(t => t.id === a.id)!;
    const deleted = await s.request('/api/invoice/del/' + a.id + '?view=buyer', { revision: a.revision }, undefined, 'DELETE'); expect(deleted.status, deleted.msg).toBe(200);
    expect((await view(s)).invoice).toEqual(snapshot); expect((await titles(s)).some(t => t.id === a.id)).toBe(false);
    const records = await s.request('/api/order/invoice_list?view=buyer'); expect(records.status, records.msg).toBe(200);
    expect(parseBuyerInvoicePage(records.data, buyerInvoiceQuery('records'), 11).items).toEqual([snapshot]);
    for (const r of [records, made, deleted]) { expect(r.headers.get('cache-control')).toContain('no-store'); expect(r.headers.get('pragma')).toBe('no-cache'); expect(r.headers.get('referrer-policy')).toBe('no-referrer'); }
  }), 120000);

  it('rejects foreign/staff/anonymous identities, malformed bodies/views, stale revisions and GET deletion without writes', async () => withBuyerInvoices(async s => {
    await s.seedOrder(); const t = await create(s), o = await view(s), before = await s.f.state();
    const other = await s.token(22), staff = (await createToken(11, 'admin', 'local', s.env.APP_KEY)).token;
    for (const token of [other, staff, null]) {
      for (const path of ['/api/order/invoice_detail/invoice_order_A?view=buyer', '/api/invoice?view=buyer']) { const r = await s.request(path, undefined, token); if (token === other && path.includes('/invoice?')) expect(r.data.items).toEqual([]); else expect(r.status).not.toBe(200); }
      expect((await s.request('/api/invoice/save?view=buyer', buyerInvoiceDraft(t), token)).status).not.toBe(200);
    }
    for (const body of [{ ...buyerInvoiceDraft(t), uid: 22 }, { ...buyerInvoiceDraft(t), revision: 'b'.repeat(64) }, { ...buyerInvoiceDraft(t), email: '' }, { ...buyerInvoiceDraft(t), name: 'x'.repeat(8193) }])
      expect((await s.request('/api/invoice/save?view=buyer', body)).status).not.toBe(200);
    for (const tail of ['view=buyer&view=buyer', 'view=other', 'view=buyer&limit=21', 'view=buyer&cursor=', 'view=buyer&uid=22']) expect((await s.request('/api/invoice?' + tail)).status).not.toBe(200);
    expect((await s.request('/api/v2/invoice/del/' + t.id + '?view=buyer')).status).not.toBe(200);
    expect((await s.request('/api/order/make_up_invoice?view=buyer', { ...application(o,t), titleRevision: 'b'.repeat(64) })).status).not.toBe(200);
    expect(await s.f.state()).toEqual(before);
  }), 120000);

  it('uses fresh SQL flags for both legacy and new make-up and preserves special fields and private record projection', async () => withBuyerInvoices(async s => {
    await s.seedOrder(); const t = await create(s, { name: '本机专票公司', headerType: 2, type: 2, dutyNumber: 'B'.repeat(18), bank: '本机银行', cardNumber: '000123', address: '本机注册地址', tell: '010-00000000' }), o = await view(s);
    await s.flags('1','0'); const before = await s.f.state();
    for (const body of [application(o,t), { order_id: o.orderNo, invoice_id: t.id }]) {
      const r = await s.request('/api/order/make_up_invoice' + ('revision' in body ? '?view=buyer' : ''), body); expect(r.status).not.toBe(200); expect(r.msg).toContain('专用发票');
    }
    expect(await s.f.state()).toEqual(before); await s.flags();
    const fresh = await view(s), made = await s.request('/api/order/make_up_invoice?view=buyer', application(fresh,t)); expect(made.status,made.msg).toBe(200);
    await s.f.db.update(storeOrderInvoice).set({ isInvoice: 1, remark: 'INTERNAL-PRIVATE-NOTE', invoiceNumber: 'LOCAL-ISSUED', invoiceTime: 1700000000 }).where(eq(storeOrderInvoice.id,made.data.id));
    let result = await view(s); expect(result.invoice).toMatchObject({ bank: '本机银行', cardNumber:'000123', remark:'', state:1, invoiceNumber:'LOCAL-ISSUED' }); expect(JSON.stringify(result)).not.toContain('INTERNAL-PRIVATE-NOTE');
    await s.f.db.update(storeOrderInvoice).set({ isInvoice:-1, remark:'请重新核对税号', invoiceAmount:'0.00' }).where(eq(storeOrderInvoice.id,made.data.id));
    result=await view(s); expect(result.invoice).toMatchObject({ state:-1, remark:'请重新核对税号', amount:null });
    await s.flags('0'); const closed=await view(s); expect(closed.invoice).not.toBeNull(); expect(closed.canApply).toBe(false);
  }), 120000);

  it('paginates deterministically at tied times and rejects a foreign cursor without private or sequence writes', async () => withBuyerInvoices(async s => {
    for(let n=0;n<5;n++) await create(s,{ name:'本机抬头'+String.fromCharCode(0x4e00+n), isDefault:false });
    const before=await s.f.state(), first=await s.request('/api/invoice?view=buyer&limit=2'); expect(first.status,first.msg).toBe(200);
    const q=buyerInvoiceQuery('titles',null,2), a=parseBuyerInvoicePage(first.data,q,11); expect(a.nextCursor).not.toBeNull();
    const next=await s.request('/api/invoice?view=buyer&limit=2&cursor='+a.nextCursor), b=parseBuyerInvoicePage(next.data,buyerInvoiceQuery('titles',a.nextCursor,2),11);
    expect(new Set([...a.items,...b.items].map(t=>t.id)).size).toBe(4);
    expect((await s.request('/api/invoice?view=buyer&limit=2&cursor='+a.nextCursor,undefined,await s.token(22))).status).not.toBe(200); expect(await s.f.state()).toEqual(before);
  }),120000);

  it('uses only global flags and the existing sort/latest priority for historical duplicate defaults',async()=>withBuyerInvoices(async s=>{
    await s.seedOrder();const t=await create(s);
    await s.f.db.insert(systemConfig).values([
      {menuName:'invoice_func_status',isStore:1,value:'0',sort:100},
      {menuName:'special_invoice_status',isStore:1,value:'0',sort:100},
      {menuName:'invoice_func_status',isStore:0,value:'0',sort:-1},
    ]);
    let o=await view(s);expect(o.capabilities).toEqual({enabled:true,special:true});expect(o.canApply).toBe(true);
    await s.f.db.insert(systemConfig).values({menuName:'invoice_func_status',isStore:0,value:'0',sort:20});expect((await view(s)).capabilities.enabled).toBe(false);
    await s.f.db.insert(systemConfig).values({menuName:'invoice_func_status',isStore:0,value:'1',sort:20});o=await view(s);expect(o.canApply).toBe(true);
    await s.f.db.insert(systemConfig).values({menuName:'invoice_func_status',isStore:0,value:'true',sort:20});expect((await view(s)).capabilities.enabled).toBe(false);
    for(const body of [application(o,t),{order_id:o.orderNo,invoice_id:t.id}]){
      const r=await s.request('/api/order/make_up_invoice'+('revision' in body?'?view=buyer':''),body);expect(r.status).not.toBe(200);expect(r.msg).toContain('未开启开票');
    }
    expect(await s.f.db.select().from(storeOrderInvoice)).toEqual([]);
    await s.f.db.insert(systemConfig).values({menuName:'invoice_func_status',isStore:0,value:'"1"',sort:30});o=await view(s);expect(o.canApply).toBe(true);
    const made=await s.request('/api/order/make_up_invoice?view=buyer',application(o,t));expect(made.status,made.msg).toBe(200);
  }),120000);

  it.each(['title','password','disabled','deleted'] as const)('rechecks %s after a real title-row lock wait and rolls back stale writes', async change => withBuyerInvoices(async s => {
    const t=await create(s), token=await s.token(); if(!s.f.withPeer)throw Error('Independent peer required');
    await s.f.withPeer(async peer=>{
      await peer.exec('BEGIN; SELECT id FROM user_invoice WHERE id='+t.id+' FOR UPDATE');
      const wait=outcome(s.request('/api/invoice/save?view=buyer',{...buyerInvoiceDraft(t),email:'new@example.invalid'},token));
      try{
        await waitForFinanceBlock(s.f.db,s.appPid,peer.pid);
        if(change==='title')await peer.exec("UPDATE user_invoice SET name='并发更名' WHERE id="+t.id);
        else await s.f.db.update(user).set(change==='password'?{pwd:'replaced-password'}:change==='disabled'?{status:0}:{isDel:1}).where(eq(user.uid,11));
        await peer.exec('COMMIT');const done=await wait;expect(done.ok).toBe(true);if(done.ok)expect(done.value.status).not.toBe(200);
        expect((await s.f.db.select().from(userInvoice).where(eq(userInvoice.id,t.id)))[0].email).toBe('buyer@example.invalid');
      }finally{await peer.exec('ROLLBACK');await wait;}
    });
  }),120000);

  it('rejects oversized refund/cart basis, open refunds, stale amounts and payment roots while keeping unpaid application semantics', async () => withBuyerInvoices(async s => {
    await s.seedOrder(); const t=await create(s), o=await view(s);
    await s.f.db.insert(storeOrderRefund).values({storeOrderId:o.orderId,uid:11,refundType:5}); expect((await view(s)).canApply).toBe(false);
    await s.f.db.delete(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,o.orderId));
    await s.f.db.update(storeOrderCartInfo).set({cartInfo:'x'.repeat(65537)}).where(eq(storeOrderCartInfo.oid,o.orderId)); expect((await view(s)).reason).toContain('依据过大');
    const before=await s.f.state();expect((await s.request('/api/order/make_up_invoice?view=buyer',application(o,t))).status).not.toBe(200);expect(await s.f.state()).toEqual(before);
    await s.seedOrder(850002,'invoice_unpaid',{paid:0}); const unpaid=await view(s,'invoice_unpaid'); expect(unpaid.canApply).toBe(true);
    const made=await s.request('/api/order/make_up_invoice?view=buyer',application(unpaid,t));expect(made.status,made.msg).toBe(200);expect((await view(s,'invoice_unpaid')).invoice).toMatchObject({paid:false,state:0});
    expect((await s.request('/api/order/invoice_list?view=buyer')).data.items).toEqual([]);
  }),120000);

  it('rejects changed private data between two short read-only snapshots', async()=>withBuyerInvoices(async s=>{
    const t=await create(s);let reached=false;const original=PostgresJsSession.prototype.prepareQuery;
    const spy=vi.spyOn(PostgresJsSession.prototype,'prepareQuery').mockImplementation(function(this:InstanceType<typeof PostgresJsSession>,...args){const prepared=original.apply(this,args);
      if(/from "user_invoice" where/i.test(args[0].sql)){const execute=prepared.execute.bind(prepared);prepared.execute=async values=>{const result=await execute(values);if(!reached){reached=true;
        const [settings]=await this.client.unsafe("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation,current_setting('statement_timeout') AS timeout");
        expect(settings).toEqual({readonly:'on',isolation:'repeatable read',timeout:'5s'});await s.f.db.update(userInvoice).set({email:'peer@example.invalid'}).where(eq(userInvoice.id,t.id));}return result;};}return prepared;});
    try{const r=await s.request('/api/invoice?view=buyer');expect(r.status).not.toBe(200);expect(r.data).toBeNull();}finally{spy.mockRestore();}expect(reached).toBe(true);
  }),120000);

  it('binds a numeric public order number to its exact PK and refuses root documents or broken parent lineage',async()=>withBuyerInvoices(async s=>{
    await s.seedOrder();await s.seedOrder(850003,'850001');const t=await create(s),numeric=await view(s,'850001');expect(numeric.orderId).toBe(850003);
    const made=await s.request('/api/order/make_up_invoice?view=buyer',application(numeric,t));expect(made.status,made.msg).toBe(200);
    expect((await view(s)).invoice).toBeNull();
    await s.seedOrder(850004,'invoice_parent',{pid:-1});await s.seedOrder(850005,'invoice_child',{pid:850004});
    expect((await view(s,'invoice_parent')).canApply).toBe(false);expect((await view(s,'invoice_child')).canApply).toBe(true);
    await s.f.db.insert(storeOrderInvoice).values({id:999,orderId:850004,uid:11,isPay:1});
    const blocked=await view(s,'invoice_child');expect(blocked.canApply).toBe(false);expect(blocked.reason).toContain('原支付主单');
    await s.f.db.update(storeOrder).set({uid:22}).where(eq(storeOrder.id,850004));expect((await s.request('/api/order/invoice_detail/invoice_child?view=buyer')).status).not.toBe(200);
  }),120000);

  it.each(['title','account','flags'] as const)('rechecks application %s after its actual template share-lock wait',async change=>withBuyerInvoices(async s=>{
    await s.seedOrder();const t=await create(s),o=await view(s),token=await s.token();if(!s.f.withPeer)throw Error('Independent peer required');
    await s.f.withPeer(async peer=>{
      await peer.exec('BEGIN; SELECT id FROM user_invoice WHERE id='+t.id+' FOR UPDATE');const wait=outcome(s.request('/api/order/make_up_invoice?view=buyer',application(o,t),token));
      try{await waitForFinanceBlock(s.f.db,s.appPid,peer.pid);
        if(change==='title')await peer.exec("UPDATE user_invoice SET email='peer@example.invalid' WHERE id="+t.id);
        else if(change==='account')await s.f.db.update(user).set({status:0}).where(eq(user.uid,11));else await s.flags('0');
        await peer.exec('COMMIT');const result=await wait;expect(result.ok).toBe(true);if(result.ok)expect(result.value.status).not.toBe(200);expect(await s.f.db.select().from(storeOrderInvoice)).toEqual([]);
      }finally{await peer.exec('ROLLBACK');await wait;}
    });
  }),120000);

  it.each(['order-text','cart-promotion','refund-image'] as const)('bounds all unbounded %s SQL fields before invoice admission transport',async field=>withBuyerInvoices(async s=>{
    await s.seedOrder();const t=await create(s),o=await view(s);
    if(field==='order-text')await s.f.db.update(storeOrder).set({virtualInfo:'x'.repeat(65537)}).where(eq(storeOrder.id,o.orderId));
    if(field==='cart-promotion')await s.f.db.update(storeOrderCartInfo).set({promotionsId:'x'.repeat(65537)}).where(eq(storeOrderCartInfo.oid,o.orderId));
    if(field==='refund-image')await s.f.db.insert(storeOrderRefund).values({storeOrderId:o.orderId,uid:11,refundType:3,refundImg:'x'.repeat(65537)});
    const read=await s.request('/api/order/invoice_detail/invoice_order_A?view=buyer');if(field==='order-text')expect(read.status).not.toBe(200);else expect(read.data.canApply).toBe(false);
    expect((await s.request('/api/order/make_up_invoice?view=buyer',application(o,t))).status).not.toBe(200);expect(await s.f.db.select().from(storeOrderInvoice)).toEqual([]);
  }),120000);
});
