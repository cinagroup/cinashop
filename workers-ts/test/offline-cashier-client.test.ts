import { describe, expect, it } from 'vitest';
import { OfflineCashier, OfflineJournal, decodeOfflineDetail, decodeOfflineIntent, decodeOfflineCapabilities, decodeOfflineHistory, offlineMoney, offlineStorageKey, offlineUuid,
  type OfflineDetail, type OfflineDraft } from '../../view/common/offlineCashier';
const id = 'xx'+'1'.repeat(30), other = 'xx'+'2'.repeat(30), key='11111111-1111-4111-8111-111111111111';
const draft:OfflineDraft={money:'12.50',expected_pay_price:'10.00',from:'h5',request_key:key};
const detail = (extra:Partial<OfflineDetail>={}):OfflineDetail=>({order_id:id,money:'12.50',pay_price:'10.00',channel:'h5',hidden:false,
  pay_type:'',paid:false,created_at:100,state:'UNSELECTED',...extra});
const paid = ()=>detail({paid:true,pay_type:'yue',paid_at:101,state:'PAID'});
const capabilities=(d=detail())=>({order_id:d.order_id,channel:d.channel,pay_price:d.pay_price,now_money:'100.00',site_name:'测试收银',
  offline_pay_status:true,yue_pay_status:1,pay_weixin_open:1,ali_pay_status:d.channel==='routine'?0:1,
  methods:{yue:'available',weixin:'available',alipay:d.channel==='routine'?'channel_unsupported':'available'}});
function deferred<T>() { let resolve!:(v:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve}; }
function setup(extra:Partial<ConstructorParameters<typeof OfflineCashier>[0]>={}, storage=new Map<string,string>()) {
  let generation=0,uid=11,read:unknown=detail();const calls:{name:string;data?:unknown}[]=[];
  const journal=new OfflineJournal({get:k=>storage.get(k),set:(k,v)=>storage.set(k,v),remove:k=>storage.delete(k)});
  const model=new OfflineCashier({journal,owner:()=>{const g=generation,u=uid;return {uid:u,current:()=>generation===g&&uid===u&&u>0};},
    channel:()=> 'h5',key:async()=>{calls.push({name:'key'});return key;},quote:async()=>({pay_price:'10.00'}),
    create:async d=>{calls.push({name:'create',data:d});return {order_id:id,pay_price:'10.00',replayed:false};},
    read:async o=>{calls.push({name:'read',data:o});return read;},pay:async(o,m)=>{calls.push({name:'pay',data:{o,m}});return paid();},
    capabilities:async()=>capabilities(read as OfflineDetail),history:async()=>({items:[],next_cursor:''}),publish:()=>{},now:()=>100_000,...extra});
  return {model,journal,storage,calls,setRead:(v:unknown)=>{read=v;},identity:(next=22)=>{uid=next;generation++;},
    async admitted(){await model.show();model.edit('12.50');await model.quote();await model.create();}};
}
describe('offline cashier durable client protocol',()=>{
  it.each([undefined,'',null,[id],id+'&paid=true',id+'\n'])('read-only result requires one explicit original ID (%s), never the pending journal',async route=>{
    const f=setup({readOnly:true});f.journal.recover(11,other);const before=[...f.storage];await f.model.show(route);
    f.model.edit('50');await f.model.quote();await f.model.create();await f.model.refresh();await f.model.pay('yue');
    expect(f.calls).toEqual([]);expect(f.model.state.detail).toBeNull();expect(f.model.state.error).not.toBe('');expect([...f.storage]).toEqual(before);
  });
  it.each(['other-order','corrupt','storage-denied'])('read-only explicit return ignores %s journal without modifying it',async condition=>{
    const storage=new Map<string,string>([[offlineStorageKey(11),condition==='corrupt'?'broken':JSON.stringify({version:2,uid:11,orderId:other})]]);
    const journal=new OfflineJournal({get:()=>{if(condition==='storage-denied')throw Error('denied');return storage.get(offlineStorageKey(11));},
      set:()=>{throw Error('No writes');},remove:()=>{throw Error('No deletes');}});
    const f=setup({readOnly:true,journal},storage),before=[...storage];await f.model.show(id);await f.model.refresh();
    expect(f.model.state.detail?.order_id).toBe(id);expect(f.model.state.error).toBe('');expect(f.model.state.intent).toBeNull();expect([...storage]).toEqual(before);
    expect(f.calls.map(c=>c.name)).toEqual(['read','read']);
  });
  const historyItem=(orderId=id,created=100)=>({order_id:orderId,money:'12.50',pay_price:'10.00',channel:'h5',hidden:false,created_at:created});
  it('cross-device recovery persists only the verified order pointer and reloads without create or pay',async()=>{
    const f=setup();await f.model.show();await f.model.recover(id);
    expect(f.journal.read(11)).toEqual({version:2,uid:11,orderId:id});expect(f.calls.map(c=>c.name)).toEqual(['read']);
    expect(f.model.state.money).toBe('12.50');expect(f.model.state.quote).toBe('10.00');
    const second=setup({},f.storage);await second.model.show();second.model.edit('999');await second.model.quote();await second.model.create();
    expect(second.calls.map(c=>c.name)).toEqual(['read']);expect(second.model.state.money).toBe('12.50');
    await second.model.pay('yue');expect(second.journal.read(11)).toEqual({version:2,uid:11,orderId:id,method:'yue'});
    await second.model.newPurchase();expect(second.storage.size).toBe(0);
  });
  it('a linked payment journals its original order before POST, including lost responses',async()=>{
    const f=setup({pay:async()=>{expect(f.journal.read(11)).toEqual({version:2,uid:11,orderId:id,method:'weixin'});throw Error('lost');}});
    await f.model.show(id);expect(f.storage.size).toBe(0);await f.model.pay('weixin');
    const second=setup({},f.storage);await second.model.show();expect(second.calls.map(c=>c.name)).toEqual(['read']);
    expect(second.journal.read(11)?.orderId).toBe(id);
  });
  it('a linked payment cannot bypass a newer pending journal from another tab',async()=>{
    const f=setup();await f.model.show(id);f.journal.begin(11,draft);await f.model.pay('yue');
    expect(f.calls.some(c=>c.name==='pay')).toBe(false);expect(f.model.state.error).toMatch(/已有/);expect(f.journal.read(11)?.version).toBe(1);
  });
  it('recovery never overwrites another admission or an unresolved create',async()=>{
    const f=setup();await f.admitted();await f.model.recover(other);expect(f.journal.read(11)?.orderId).toBe(id);expect(f.model.state.error).toMatch(/不会覆盖/);
    const pending=setup();pending.journal.begin(11,draft);await pending.model.show();await pending.model.recover(id);
    expect(pending.calls).toEqual([]);expect(pending.journal.read(11)?.orderId).toBeUndefined();
  });
  it.each(['hide','identity','competing-journal'])('late recovery after %s cannot replace the journal',async ending=>{
    const pending=deferred<unknown>(),f=setup({read:()=>pending.promise});await f.model.show();const work=f.model.recover(id);
    if(ending==='hide')f.model.hide();else if(ending==='identity'){f.identity();f.model.hide();}else f.journal.begin(11,draft);
    pending.resolve(detail());await work;expect(f.journal.read(11)?.version).not.toBe(2);expect(f.model.state.detail).toBeNull();
  });
  it.each([{draft},{request_key:key},{uid:22},{method:'cash'},{orderId:other+'x'}])('recovery pointer rejects invented or foreign fields %j',change=>{
    expect(()=>decodeOfflineIntent(JSON.stringify({version:2,uid:11,orderId:id,...change}),11)).toThrow();
  });
  it('failed persistence prevents linked pay and SDK launch',async()=>{
    const denied=new OfflineJournal({get:()=>null,set:()=>{},remove:()=>{}}),f=setup({journal:denied});await f.model.show(id);await f.model.pay('yue');
    expect(f.calls.some(c=>c.name==='pay')).toBe(false);expect(f.model.state.error).toMatch(/保存失败/);
    f.setRead(detail({state:'READY',pay_type:'weixin',display_until:200,ticket:{kind:'wechat-h5',url:'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?a=b'}}));await f.model.refresh();
    let launched=0;await f.model.open(async()=>{launched++;});expect(launched).toBe(0);
  });
  it('history uses bounded replace-page cursors; a failed next page retries the same cursor without writes',async()=>{
    const items=Array.from({length:20},(_,i)=>historyItem('xx'+String(i+1).padStart(30,'0'),100-i)),cursor=items[19].order_id;
    const requests:unknown[]=[];let fail=true;const f=setup({history:async input=>{
      requests.push(input);if(!input.cursor)return {items,next_cursor:cursor};if(fail)throw Error('503');return {items:[historyItem(other,79)],next_cursor:''};}});
    await f.model.show();await f.model.loadHistory();expect(f.model.state.history.items).toHaveLength(20);expect(f.storage.size).toBe(0);
    await f.model.loadHistory(true);expect(f.model.state.history.items).toEqual([]);expect(f.model.state.history.pageCursor).toBe(cursor);expect(f.model.state.errorSource).toBe('history');
    fail=false;await f.model.loadHistory();expect(requests).toEqual([{},{cursor},{cursor}]);expect(f.model.state.history.items).toHaveLength(1);expect(f.calls).toEqual([]);
    f.model.searchHistory(other);await f.model.loadHistory();expect(requests.at(-1)).toEqual({order_id:other});expect(f.model.state.history.loaded).toBe(false);
  });
  it.each(['hide','identity'])('late history after %s cannot display another account records',async ending=>{
    const pending=deferred<unknown>(),f=setup({history:()=>pending.promise});await f.model.show();const work=f.model.loadHistory();
    if(ending==='identity')f.identity();f.model.hide();pending.resolve({items:[historyItem()],next_cursor:''});await work;
    expect(f.model.state.history.items).toEqual([]);expect(f.model.state.history.query).toBe('');
  });
  it('history rejects status/ticket/private fields, invalid pages and non-exact search',()=>{
    for(const value of [{items:[{...historyItem(),paid:true}],next_cursor:''},{items:[{...historyItem(),request_key:key}],next_cursor:''},
      {items:[historyItem(),historyItem()],next_cursor:''},{items:[historyItem()],next_cursor:id},{items:[historyItem(),historyItem(other,101)],next_cursor:''},
      {items:[historyItem()],next_cursor:'',uid:11}])expect(()=>decodeOfflineHistory(value)).toThrow();
    expect(()=>decodeOfflineHistory({items:[historyItem()],next_cursor:''},other)).toThrow();
  });
  it('read-only result never searches, journals recovery or submits payment',async()=>{
    let histories=0;const f=setup({readOnly:true,history:async()=>{histories++;return {items:[],next_cursor:''};}});
    await f.model.show(id);await f.model.loadHistory();await f.model.recover(id);await f.model.pay('yue');
    expect(histories).toBe(0);expect(f.storage.size).toBe(0);expect(f.calls.map(c=>c.name)).toEqual(['read']);
  });
  it('failed availability clears old permissions while retaining the original order for readonly retry',async()=>{
    let failure=false;const f=setup({capabilities:async()=>{if(failure)throw Error('availability lost');return capabilities();}});
    await f.admitted();expect(f.model.state.capabilities?.methods.yue).toBe('available');failure=true;await f.model.refresh();await f.model.pay('yue');
    expect(f.model.state.detail?.order_id).toBe(id);expect(f.model.state.capabilities).toBeNull();expect(f.calls.filter(c=>c.name==='pay')).toHaveLength(0);
    expect(f.model.state.error).toMatch(/支付方式暂时无法核验/);
  });
  it('a switch changed after render is rechecked before persisting a method or paying',async()=>{
    let n=0;const f=setup({capabilities:async()=>++n===1?capabilities():{...capabilities(),yue_pay_status:0,methods:{...capabilities().methods,yue:'disabled'}}});
    await f.admitted();await f.model.pay('yue');expect(n).toBe(2);expect(f.journal.read(11)?.method).toBeUndefined();
    expect(f.model.state.capabilities?.methods.yue).toBe('disabled');expect(f.model.state.error).toMatch(/本页未发送/);expect(f.calls.filter(c=>c.name==='pay')).toHaveLength(0);
  });
  it.each(['order_id','channel','pay_price','now_money','yue_pay_status','offline_pay_status','methods'])('rejects malformed/mismatched availability field %s',field=>{
    expect(()=>decodeOfflineCapabilities({...capabilities(),[field]:'invalid'},detail())).toThrow();
  });
  it('availability never persists in the journal, and an old-account response cannot republish balance or pay',async()=>{
    const pending=deferred<unknown>();let n=0;const f=setup({capabilities:()=>++n===1?Promise.resolve(capabilities()):pending.promise});
    await f.admitted();const payment=f.model.pay('yue');f.identity();f.model.hide();pending.resolve(capabilities());await payment;
    expect(f.model.state.capabilities).toBeNull();expect(f.journal.read(11)?.method).toBeUndefined();expect(f.calls.some(c=>c.name==='pay')).toBe(false);
    expect([...f.storage.values()][0]).not.toMatch(/now_money|methods|capabilities/);
  });
  it('result-only controller never discovers or initiates even when the server says UNSELECTED',async()=>{
    let discovers=0;const f=setup({readOnly:true,capabilities:async()=>{discovers++;return capabilities();}});await f.model.show(id);
    await f.model.pay('yue');await f.model.create();expect(discovers).toBe(0);expect(f.calls.map(c=>c.name)).toEqual(['read']);
  });
  it.each(['0','-1','01','1e2','1.001','100000000','NaN',' 1','1.','0x10'])('rejects malformed amount %s',money=>expect(()=>offlineMoney(money)).toThrow());
  it('preserves numeric-zero quote sentinel and refuses real zero price',async()=>{
    const f=setup({quote:async()=>({pay_price:0})});await f.model.show();f.model.edit('12.5');await f.model.quote();expect(f.model.state.quote).toBe('12.50');
    const zero=setup({quote:async()=>({pay_price:'0.00'})});await zero.model.show();zero.model.edit('0.01');await zero.model.quote();await zero.model.create();expect(zero.calls).toEqual([]);
    expect(zero.model.state.quote).toBe('');expect(zero.model.state.error).toContain('至少为0.01元');expect(zero.storage.size).toBe(0);
  });
  it('rejects fresh zero journals, preserves old ones and never retries their POST',async()=>{
    const f=setup(),zeroDraft={...draft,money:'0.01',expected_pay_price:'0.00'};
    expect(()=>f.journal.begin(11,zeroDraft)).toThrow('至少为0.01元');expect(f.storage.size).toBe(0);
    f.storage.set(offlineStorageKey(11),JSON.stringify({version:1,uid:11,draft:zeroDraft}));const before=[...f.storage];
    await f.model.show();await f.model.create();await f.model.pay('yue');
    expect(f.calls).toEqual([]);expect([...f.storage]).toEqual(before);expect(f.model.state.error).toContain('至少为0.01元');
  });
  it('historical zero details can only be unavailable and never create, pay, launch or erase the record',async()=>{
    const zero=detail({money:'0.01',pay_price:'0.00',state:'UNAVAILABLE'}),f=setup();f.setRead(zero);
    f.journal.recover(11,id);const before=[...f.storage];await f.model.show();await f.model.create();await f.model.pay('yue');
    await f.model.open(async()=>{throw Error('No SDK launch');});await f.model.newPurchase();
    expect(f.calls.map(c=>c.name)).toEqual(['read']);expect([...f.storage]).toEqual(before);expect(f.model.state.detail).toEqual(zero);
    for(const wrong of [{state:'UNSELECTED'},{state:'PAID',paid:true,pay_type:'yue',paid_at:101},{state:'RECOVERY_REQUIRED',pay_type:'weixin'}])
      expect(()=>decodeOfflineDetail({...zero,...wrong},id)).toThrow();
  });
  it('a rejected zero quote can be corrected to exactly one cent without any implicit create or pay',async()=>{
    const small=detail({money:'0.02',pay_price:'0.01'});
    const f=setup({quote:async amount=>({pay_price:amount==='0.01'?'0.00':'0.01'}),
      create:async d=>{f.calls.push({name:'create',data:d});return {order_id:id,pay_price:'0.01',replayed:false};},
      capabilities:async()=>capabilities(small)});f.setRead(small);
    await f.model.show();f.model.edit('0.01');await f.model.quote();await f.model.create();expect(f.calls).toEqual([]);
    f.model.edit('0.02');await f.model.quote();expect(f.model.state.quote).toBe('0.01');expect(f.calls).toEqual([]);
    await f.model.create();expect(f.calls.map(c=>c.name)).toEqual(['key','create','read']);
    expect(f.journal.read(11)?.draft).toEqual({...draft,money:'0.02',expected_pay_price:'0.01'});
  });
  it('a stale zero reprice never replaces the positive journal or resends its create request',async()=>{
    let attempts=0;const f=setup({create:async()=>{attempts++;throw Object.assign(Error('changed'),{status:409,data:{pay_price:'0.00'}});}});
    await f.admitted();const before=[...f.storage];await f.model.create(true);
    expect(attempts).toBe(1);expect([...f.storage]).toEqual(before);expect(f.model.state.error).toContain('至少为0.01元');
  });
  it('writes/readbacks the journal before dispatch; payment and result are separate',async()=>{
    const f=setup();await f.admitted();expect(f.model.state.intent?.draft).toEqual(draft);expect(f.model.state.detail?.paid).toBe(false);
    expect(f.calls.map(c=>c.name)).toEqual(['key','create','read']);await f.model.pay('yue');expect(f.model.state.detail).toEqual(paid());
    expect(f.journal.read(11)?.method).toBe('yue');expect(f.calls.filter(c=>c.name==='pay')).toHaveLength(1);
  });
  it('new consumption requires explicit confirmed paid action',async()=>{
    const f=setup();await f.admitted();await f.model.newPurchase();expect(f.journal.read(11)).not.toBeNull();
    await f.model.pay('yue');expect(f.journal.read(11)).not.toBeNull();await f.model.newPurchase();expect(f.journal.read(11)).toBeNull();expect(f.model.state.quote).toBe('');
  });
  it('lost create response survives a new controller, no automatic POST on show',async()=>{
    const f=setup({create:async()=>{throw Error('lost response');}});await f.admitted();expect(f.model.state.intent?.draft?.request_key).toBe(key);
    const next=setup({},f.storage);await next.model.show();expect(next.calls).toEqual([]);expect(next.model.state.money).toBe('12.50');
    next.model.edit('900');expect(next.model.state.money).toBe('12.50');await next.model.create();expect(next.calls.map(c=>c.name)).toEqual(['create','read']);expect(next.calls[0].data).toEqual(draft);
  });
  it('lost payment response allows only a fresh read before another payment request',async()=>{
    const f=setup({pay:async()=>{throw Error('lost');}});await f.admitted();await f.model.pay('weixin');expect(f.model.state.detail).toBeNull();
    await f.model.pay('yue');expect(f.journal.read(11)?.method).toBe('weixin');
    f.setRead(detail({state:'RECOVERY_REQUIRED',pay_type:'weixin'}));await f.model.refresh();await f.model.pay('yue');expect(f.model.state.detail?.state).toBe('RECOVERY_REQUIRED');
  });
  it('corrupt storage or failed storage prevents new key/network submission',async()=>{
    const f=setup();f.storage.set(offlineStorageKey(11),'{}');await f.model.show();f.model.edit('12.50');await f.model.quote();await f.model.create();expect(f.calls).toEqual([]);
    const denied=setup({journal:new OfflineJournal({get:()=>null,set:()=>{},remove:()=>{}})});await denied.admitted();expect(denied.calls.map(c=>c.name)).toEqual(['key']);expect(denied.model.state.error).toMatch(/保存失败/);
  });
  it.each([null,[],{},'../x','xx','a'.repeat(100)].map(route=>({route})))('invalid route $route cannot quote or submit',async ({route})=>{
    const f=setup();await f.model.show(route);f.model.edit('12.50');await f.model.quote();await f.model.create();expect(f.calls).toEqual([]);expect(f.model.state.error).toBeTruthy();
  });
  it('foreign route cannot replace a pending admission',async()=>{
    const f=setup();await f.admitted();await f.model.show(other);expect(f.model.state.detail).toBeNull();expect(f.model.state.error).toMatch(/另有/);expect(f.journal.read(11)?.orderId).toBe(id);
  });
  it('server detail binds route, amount and channel; returned success flags are not trusted',()=>{
    for(const wrong of [{order_id:other},{pay_price:'0.01'},{channel:'routine'},{paid:1},{state:'PAID'},{paid:true},{ticket:{kind:'wechat-h5',url:'https://attacker.example'}}])
      expect(()=>decodeOfflineDetail({...detail(),...wrong},id,draft)).toThrow();
    expect(decodeOfflineDetail(paid(),id,draft).paid).toBe(true);
  });
  it('current read failure removes previously verified paid status',async()=>{
    const f=setup();await f.admitted();await f.model.pay('yue');f.setRead({paid:true});await f.model.refresh();expect(f.model.state.detail).toBeNull();expect(f.model.state.error).toBeTruthy();
  });
  it('server repricing needs explicit reconfirmation with the same original request key',async()=>{
    let attempts=0;const f=setup({create:async d=>{attempts++;if(attempts===1)throw Object.assign(Error('quote changed'),{status:409,data:{pay_price:'9.00'}});
      expect(d).toEqual({...draft,expected_pay_price:'9.00'});return {order_id:id,pay_price:'9.00',replayed:false};}});
    await f.admitted();expect(f.model.state.reprice).toBe('9.00');expect(f.journal.read(11)?.draft?.expected_pay_price).toBe('10.00');
    f.setRead(detail({pay_price:'9.00'}));await f.model.create(true);expect(f.journal.read(11)?.draft?.request_key).toBe(key);expect(f.model.state.detail?.pay_price).toBe('9.00');
  });
  it.each(['hide','identity','same-uid'] as const)('late creation after %s does not store order or read another session',async ending=>{
    const pending=deferred<unknown>(),f=setup({create:()=>pending.promise});await f.model.show();f.model.edit('12.50');await f.model.quote();const request=f.model.create();await Promise.resolve();
    if(ending==='hide')f.model.hide();else f.identity(ending==='same-uid'?11:22);
    pending.resolve({order_id:id,pay_price:'10.00',replayed:false});await request;expect(f.journal.read(11)?.orderId).toBeUndefined();expect(f.calls.filter(c=>c.name==='read')).toHaveLength(0);
  });
  it('late crypto key cannot create a journal after hiding',async()=>{
    const waiting=deferred<string>(),f=setup({key:()=>waiting.promise});await f.model.show();f.model.edit('12.50');await f.model.quote();const request=f.model.create();f.model.hide();waiting.resolve(key);await request;expect(f.storage.size).toBe(0);
  });
  it('a queued cross-tab write revalidates the active journal inside the lock',async()=>{
    const waiting=deferred<void>();const f=setup({exclusive:async work=>{await waiting.promise;await work();}});
    await f.model.show();f.model.edit('12.50');await f.model.quote();const request=f.model.create();f.journal.begin(11,draft);waiting.resolve();await request;expect(f.calls).toEqual([]);expect(f.model.state.error).toMatch(/已有/);
  });
  it('READY continuation only reads then launches the original ticket, SDK success still requires server read',async()=>{
    const entrance=detail({state:'READY',pay_type:'weixin',display_until:200,ticket:{kind:'wechat-h5',url:'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=original'}});
    const f=setup();await f.admitted();f.setRead(entrance);await f.model.refresh();const launch:unknown[]=[];
    await f.model.open(async ticket=>{launch.push(ticket);});expect(launch).toEqual([entrance.ticket]);expect(f.model.state.detail?.paid).toBe(false);
    expect(f.calls.filter(c=>c.name==='create')).toHaveLength(1);expect(f.calls.filter(c=>c.name==='pay')).toHaveLength(0);
    f.setRead(detail({state:'RECOVERY_REQUIRED',pay_type:'weixin'}));await f.model.open(async()=>{throw Error('must not launch');});expect(launch).toHaveLength(1);
  });
  it('expired or hostile tickets are never launched',async()=>{
    for(const url of ['https://wx.tenpay.com.attacker.example/cgi-bin/mmpayweb-bin/checkmweb?a=b','https://wx.tenpay.com:444/cgi-bin/mmpayweb-bin/checkmweb?a=b','javascript:alert(1)'])
      expect(()=>decodeOfflineDetail(detail({state:'READY',pay_type:'weixin',display_until:200,ticket:{kind:'wechat-h5',url}}),id)).toThrow();
    const f=setup();await f.admitted();f.setRead(detail({state:'READY',pay_type:'weixin',display_until:99,ticket:{kind:'wechat-h5',url:'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?a=b'}}));await f.model.refresh();
    let launches=0;await f.model.open(async()=>{launches++;});expect(launches).toBe(0);expect(f.model.state.error).toMatch(/不再可用/);
  });
  it('journal is bound to exact UID and never stores a bearer or ticket',()=>{
    const f=setup();f.journal.begin(11,draft);expect(()=>decodeOfflineIntent(f.storage.get(offlineStorageKey(11)),22)).toThrow();
    expect([...f.storage.values()][0]).not.toMatch(/token|ticket|payer/);expect(offlineUuid(new Uint8Array(16))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
