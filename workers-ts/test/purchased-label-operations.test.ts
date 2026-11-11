import { describe, expect, it } from 'vitest';
import { capturePurchasedLabelTaskList, capturePurchasedLabelReplayResult, purchasedLabelRecovery, purchasedLabelReplayReason,
  type PurchasedLabelTaskItem } from '../../view/common/purchasedProductLabelTasks';
const now=1700000000,uuid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const row=():PurchasedLabelTaskItem=>({taskId:uuid,eventKey:'order.product.labels:1:2',orderId:2,userId:11,createdAt:now-1,status:'FAILED',
  attemptCount:1,dispatchCount:1,replayCount:0,availableAt:now+30,leaseUntil:0,processedAt:0,lastError:'待维护',receiptCompletedAt:null,recovery:'eligible'});
const list=()=>({items:[row()],nextAfterId:null,observedAt:now});
describe('purchased label operations read and recovery contract',()=>{
  it('classifies replay using the server observation, immutable receipt, lease and hard limit',()=>{
    expect(purchasedLabelRecovery(row(),now)).toBe('eligible');
    expect(purchasedLabelRecovery({...row(),status:'ENQUEUED',leaseUntil:now},now)).toBe('active');
    expect(purchasedLabelRecovery({...row(),status:'PROCESSING',leaseUntil:now-1},now)).toBe('eligible');
    expect(purchasedLabelRecovery({...row(),status:'PENDING'},now)).toBe('automatic');
    expect(purchasedLabelRecovery({...row(),status:'COMPLETED'},now)).toBe('maintenance');
    expect(purchasedLabelRecovery({...row(),status:'DEAD',replayCount:20},now)).toBe('limit');
    expect(purchasedLabelRecovery({...row(),receiptCompletedAt:now,status:'FAILED',replayCount:20},now)).toBe('receipt');
  });
  it('captures detached complete page rows, canonical exact task identities and cursor',()=>{
    const value=list(),captured=capturePurchasedLabelTaskList(value);value.items[0]!.lastError='changed';
    expect(captured.items[0]?.lastError).toBe('待维护');
    expect(capturePurchasedLabelTaskList({...list(),nextAfterId:uuid}).nextAfterId).toBe(uuid);
  });
  it.each(['token','duplicate','cursor','order','recovery','status','clock','sparse','size'])('rejects %s rather than showing partial or misleading operations',kind=>{
    const value:any=list();
    if(kind==='token')value.items[0].leaseToken='not-public';if(kind==='duplicate')value.items.push(row());
    if(kind==='cursor')value.nextAfterId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';if(kind==='order')value.items[0].orderId=3;
    if(kind==='recovery')value.items[0].receiptCompletedAt=now;if(kind==='status')value.items[0].status='UNKNOWN';
    if(kind==='clock')value.observedAt=0;if(kind==='sparse')value.items.length=2;if(kind==='size')value.items=Array(101).fill(row());
    expect(()=>capturePurchasedLabelTaskList(value)).toThrow();
  });
  it('does not invoke getter bodies while parsing lists and receipts',()=>{
    let calls=0;expect(()=>capturePurchasedLabelTaskList({...list(),get observedAt(){calls++;return now;}})).toThrow();
    expect(()=>capturePurchasedLabelReplayResult({taskId:uuid,eventKey:row().eventKey,replayed:true,get completed(){calls++;return false;}},uuid,row().eventKey)).toThrow();expect(calls).toBe(0);
  });
  it('binds replay receipts to the selected original task and rejects contradictory results',()=>{
    const value={taskId:uuid,eventKey:row().eventKey,replayed:true,completed:false};
    expect(capturePurchasedLabelReplayResult(value,uuid,row().eventKey)).toEqual(value);
    for(const patch of [{taskId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},{eventKey:'order.product.labels:1:3'},{completed:true},{extra:true}])
      expect(()=>capturePurchasedLabelReplayResult({...value,...patch},uuid,row().eventKey)).toThrow();
  });
  it('counts Unicode reason characters without clipping and refuses empty, control or broken data',()=>{
    expect(purchasedLabelReplayReason(' '+ '🧭'.repeat(100)+' ')).toBe('🧭'.repeat(100));
    for(const reason of ['', ' ', '🧭'.repeat(101),'reason\nnew','\ud800',{},null])expect(()=>purchasedLabelReplayReason(reason)).toThrow();
  });
});
