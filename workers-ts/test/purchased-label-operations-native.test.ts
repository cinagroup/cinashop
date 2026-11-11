import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { purchasedLabelOperationsFixture } from './helpers/purchasedLabelOperationsFixture';
import { capturePurchasedLabelTaskList } from '../../view/common/purchasedProductLabelTasks';
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real purchased-label task operations reads and recovery',()=>{
  let f:Awaited<ReturnType<typeof purchasedLabelOperationsFixture>>,network:ReturnType<typeof vi.spyOn>;
  beforeAll(async()=>{network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No real provider in operations acceptance'));f=await purchasedLabelOperationsFixture();},180000);
  afterAll(async()=>{try{expect(network).not.toHaveBeenCalled();}finally{network?.mockRestore();await f?.close();}},30000);
  it('lists original tasks with consistent clock/recovery hints and no processing token',async()=>{
    const before=await f.facts();const result=await f.adminRequest('/admin/order/product-label-tasks');expect(result.body.status).toBe(200);
    const page=capturePurchasedLabelTaskList(result.body.data);expect(page.items).toHaveLength(4);
    expect(page.items.filter(r=>r.recovery==='eligible')).toHaveLength(2);expect(page.items.filter(r=>r.recovery==='receipt')).toHaveLength(1);
    expect(page.items.filter(r=>r.recovery==='active')).toHaveLength(1);expect(page.items[0]).not.toHaveProperty('leaseToken');expect(await f.facts()).toEqual(before);
  });
  it('uses stable UUID seek pagination and exact-task lookup outside a failed-status filter',async()=>{
    const first=capturePurchasedLabelTaskList((await f.adminRequest('/admin/order/product-label-tasks?limit=1')).body.data);
    expect(first.nextAfterId).toBe(first.items[0]?.taskId);
    const next=capturePurchasedLabelTaskList((await f.adminRequest('/admin/order/product-label-tasks?limit=1&after_id='+first.nextAfterId)).body.data);
    expect(next.items[0]?.taskId).not.toBe(first.items[0]?.taskId);
    const exact=capturePurchasedLabelTaskList((await f.adminRequest('/admin/order/product-label-tasks?task_id='+f.tasks[2]!.ref.taskId)).body.data);
    expect(exact.items).toHaveLength(1);expect(exact.items[0]?.recovery).toBe('receipt');expect(exact.nextAfterId).toBeNull();
    for(const query of ['task_id=bad','task_id='+f.tasks[0]!.ref.taskId+'&after_id='+first.nextAfterId])expect((await f.adminRequest('/admin/order/product-label-tasks?'+query)).body.status).toBe(400);
  });
  it('keeps viewer reads authorized and refuses its replay, then recovers the original task after maintenance',async()=>{
    expect((await f.adminRequest('/admin/order/product-label-tasks',undefined,92)).body.status).toBe(200);
    const ref=f.tasks[0]!.ref,body={confirm:'REPLAY_PURCHASED_LABEL_TASK',reason:'已核对标签归属'};
    expect((await f.adminRequest('/admin/order/product-label-tasks/'+ref.taskId+'/replay',body,92)).body.status).not.toBe(200);
    await f.maintain();expect((await f.adminRequest('/admin/order/product-label-tasks/'+ref.taskId+'/replay',body)).body.status).toBe(200);
    const current=capturePurchasedLabelTaskList((await f.adminRequest('/admin/order/product-label-tasks?task_id='+ref.taskId)).body.data).items[0]!;
    expect(current).toMatchObject({replayCount:1,status:'ENQUEUED',recovery:'active'});
    expect(await f.appTasks.process(ref)).toBe('completed');
    expect(capturePurchasedLabelTaskList((await f.adminRequest('/admin/order/product-label-tasks?task_id='+ref.taskId)).body.data).items[0])
      .toMatchObject({replayCount:1,status:'COMPLETED',recovery:'receipt'});
    const rows=await f.maintenanceDb.execute(sql`SELECT change_message FROM public.store_order_status WHERE oid=${f.tasks[0]!.orderId} AND change_type='product_label_replay'`);expect(rows).toHaveLength(1);
  });
});
