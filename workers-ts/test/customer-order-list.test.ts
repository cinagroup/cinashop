import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { customerOrderListFixture } from './helpers/customerOrderListFixture';
import { customerOrderStatus, canReceiveOrder, canTrackOrder, canReviewOrder, orderListQuery } from '../../view/common/orderListState';

describe('modern customer order list through real HTTP controller and SQL',()=>{
  let fixture: Awaited<ReturnType<typeof customerOrderListFixture>>;
  beforeAll(async()=>{fixture=await customerOrderListFixture();});
  afterAll(async()=>{await fixture?.close();});
  async function read(query='',uid='11') {
    return (await fixture.app.request('/api/order/list'+query,{headers:{'x-fixture-user':uid}},fixture.env)).json() as Promise<{status:number;data:Array<{id:number;uid:number;orderId:string;virtualInfo:unknown;cartInfo:unknown[]}>}>;
  }
  it('reads all 30 own orders across PC and UniApp page sizes with stable same-time ordering',async()=>{
    for(const limit of [10,20]) {
      const ids:number[]=[];
      for(let page=1;page<=4;page++){const result=await read(`?page=${page}&limit=${limit}`);expect(result.status).toBe(200);ids.push(...result.data.map(row=>row.id));if(result.data.length<limit)break;}
      expect(ids).toEqual(Array.from({length:30},(_,i)=>30-i));
    }
  });
  for(const [status,ids] of [[0,Array.from({length:24},(_,i)=>24-i)],[1,[30,25]],[2,[29,26]],[3,[27]],[4,[28]]] as const)it(`matches migrated status filter ${status}`,async()=>{
    expect((await read(`?status=${status}&limit=100`)).data.map(row=>row.id)).toEqual(ids);
  });
  it('binds ownership, hides deleted/system-deleted/split roots and retains product snapshots',async()=>{
    const result=await read('?limit=100');
    expect(result.data.every(row=>row.uid===11&&row.virtualInfo===null&&row.cartInfo.length===1)).toBe(true);
    expect((await read('?limit=100','22')).data.map(row=>row.id)).toEqual([31]);
    expect((await read('','')).status).not.toBe(200);
  });
  it('does not write order, account, stock, cart or bill state while browsing',async()=>{
    const initial=await fixture.snapshot();await read('?page=2&limit=10');await read('?status=4&limit=20');expect(await fixture.snapshot()).toEqual(initial);
  });
  it('shared labels/actions preserve pickup, partial, cancelled and completed distinctions',()=>{
    const base={id:1,uid:11,order_id:'local_list_1',paid:1,status:1,pay_price:'10.00',add_time:0,pid:0,supplier_allocation_status:0,shipping_type:1,delivery_type:'express',refund_status:0};
    expect(canReceiveOrder(base)).toBe(true);expect(canTrackOrder(base)).toBe(true);
    expect(canReceiveOrder({...base,shipping_type:2})).toBe(false);expect(canReceiveOrder({...base,delivery_type:'send'})).toBe(false);
    expect(canReviewOrder({...base,status:3})).toBe(false);expect(canReviewOrder({...base,status:2})).toBe(true);
    expect(customerOrderStatus({...base,paid:0,status:-2})).toBe('已取消');
    expect(customerOrderStatus({...base,status:4})).toBe('部分发货');
    expect(customerOrderStatus({...base,status:0,shipping_type:2})).toBe('待到店核销');
    for(const status of [null,'',-1,'1junk',['0','1']])expect(()=>orderListQuery({status})).toThrow();
  });
});
