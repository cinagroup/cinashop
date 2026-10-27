import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { memberCard, memberCardBatch, memberShip, otherOrder, otherOrderStatus, user, userBill,
  systemConfig, storeCouponIssue, storeCouponUser, storeOrder, storeOrderEconomize } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers, outcome } from './helpers/financePeers';

const wiring=vi.hoisted(()=>({context:undefined as AsyncLocalStorage<Container>|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
  const container=wiring.context?.getStore();if(!container)throw Error('Missing request-local owned activation container');return container;
}}));
type Row=Record<string,unknown>;
type Snapshot=Record<string,Row[]>;
type Envelope={status:number;msg:string;data:unknown};
const CARD=501,BATCH=601,code='ACT-CARD-11',secret='card-secret',password=md5('owned-card-customer-password');
const body=(from:string='h5'):Row=>({member_card_code:code,member_card_pwd:secret,from});
const one=(rows:Row[],key:string,id:number)=>{const found=rows.filter(row=>row[key]===id);expect(found).toHaveLength(1);return found[0]!;};
const changedColumns=(before:Row,after:Row)=>Object.keys(before).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key])).sort();
/** A later tuple waiter may block on the earlier queued writer rather than
 * directly on the holder. Both complete paths must be observed in one actual
 * PG blocker graph; timing, pending Promises and eventual success are no proof. */
async function waitForCardBlockingChains(observer:DbClient,writers:[number,number],holder:number){
  const owned=[...writers,holder];if(new Set(owned).size!==3||owned.some(pid=>!Number.isSafeInteger(pid)||pid<1))throw Error('Invalid owned card blocking PIDs');
  const deadline=performance.now()+4000;
  do{
    const rows=await observer.execute<{pid:number;blockers:number[]}>(sql`SELECT ${writers[0]}::int AS pid,pg_blocking_pids(${writers[0]}::int) AS blockers
      UNION ALL SELECT ${writers[1]}::int AS pid,pg_blocking_pids(${writers[1]}::int) AS blockers
      UNION ALL SELECT ${holder}::int AS pid,pg_blocking_pids(${holder}::int) AS blockers`);
    const graph=new Map(rows.map(row=>[row.pid,row.blockers]));
    if(graph.size!==3||rows.some(row=>!Array.isArray(row.blockers)||row.blockers.some(pid=>!owned.includes(pid))))throw Error('Unexpected external card blocker');
    const path=(pid:number,visited:number[]=[]):number[]|null=>{
      if(visited.includes(pid))return null;const next=[...visited,pid];if(pid===holder)return next;
      for(const blocker of graph.get(pid)??[]){const found=path(blocker,next);if(found)return found;}return null;
    };
    const left=path(writers[0]),right=path(writers[1]);
    if(left&&right)return{writers,holder,observed_blockers:rows.map(row=>({pid:row.pid,blockers:row.blockers})),paths:[left,right]};
    await delay(25);
  }while(performance.now()<deadline);
  throw Error('Expected both native card-waiter paths to the holder were not observed');
}


/** Actual registered HTTP/JWT/SQL transactions. AsyncLocalStorage binds each
 * complete request to its own Drizzle peer through every authentication await;
 * no global current-container switch or service/business response is mocked.
 * Native PG16 alone proves observed row blocking. Memory fallback proves the
 * same single-use business outcomes without claiming native concurrency, LOGIN
 * grants, provider I/O or a production Durable Object instance. */
describe('member-card activation registered HTTP and atomic single-use accounting',()=>{
  let f:Awaited<ReturnType<typeof financePostgres>>,app:ReturnType<typeof createApp>,env:Env,container:Container;
  let tables:string[],sequences:string[],network:ReturnType<typeof vi.spyOn>,sequenceNumber=0,adminToken='';
  const tokens=new Map<number,string>(),allocations:string[]=[],responses:Array<{http:number;status:number}>=[];
  const objects=new Map<string,string>([['owned/sentinel.png','immutable-owned-r2-bytes']]);
  const bucket={get:vi.fn(async()=>{throw Error('Activation must not read R2');}),head:vi.fn(async()=>{throw Error('Activation must not head R2');}),list:vi.fn(async()=>{throw Error('Activation must not list R2');}),
    put:vi.fn(async()=>{throw Error('Activation must not write R2');}),delete:vi.fn(async()=>{throw Error('Activation must not delete R2');})};
  const queue={send:vi.fn(async()=>{throw Error('Activation must not queue');}),sendBatch:vi.fn(async()=>{throw Error('Activation must not queue a batch');})};
  const cache={get:vi.fn(async():Promise<string|null>=>null),put:vi.fn(async()=>{throw Error('Activation must not write KV');}),delete:vi.fn(async()=>{throw Error('Activation must not delete KV');})};
  const sequenceFetch=vi.fn(async(input:string)=>{
    expect(input).toBe('https://internal/next-order-id?prefix=hy');const orderId='hy_activation_'+ ++sequenceNumber;allocations.push(orderId);return new Response(orderId);
  });
  const sequence={idFromName:vi.fn((name:string)=>{expect(name).toBe('seq');return'owned-activation-sequence';}),get:vi.fn((id:unknown)=>{expect(id).toBe('owned-activation-sequence');return{fetch:sequenceFetch};})};
  beforeAll(async()=>{
    network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Activation forbids external network'));
    const orm=[memberCard,memberCardBatch,memberShip,otherOrder,otherOrderStatus,user,userBill,systemConfig,storeCouponIssue,storeCouponUser,storeOrder,storeOrderEconomize];
    f=await financePostgres(orm,{namespace:'public'});container=createContainerFromDb(f.db);wiring.context=new AsyncLocalStorage<Container>();app=createApp();
    env={APP_KEY:'owned-card-activation-jwt-key',NODE_ENV:'test',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',ASSETS_BUCKET:bucket,ORDER_QUEUE:queue,CONFIG_KV:cache,SEQUENCE:sequence} as unknown as Env;
    for(const uid of[11,22])tokens.set(uid,(await createToken(uid,'api',md5(password),env.APP_KEY)).token);
    adminToken=(await createToken(11,'admin',md5(password),env.APP_KEY)).token;
    tables=(await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row=>row.name);
    sequences=(await f.db.execute<{name:string}>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row=>row.name);
    expect(tables).toEqual(orm.map(table=>getTableConfig(table).name).sort());
    expect(sequences).toEqual(orm.flatMap(table=>{const c=getTableConfig(table);return c.columns.filter(column=>column.getSQLType()==='serial').map(column=>`${c.name}_${column.name}_seq`);}).sort());
    expect(sequences).not.toContain('other_order_status_id_seq');
  },30000);
  beforeEach(async()=>{
    await f.reset();for(const operation of[...Object.values(bucket),...Object.values(queue),...Object.values(cache),...Object.values(sequence),sequenceFetch])operation.mockClear();sequenceNumber=0;allocations.length=0;
    const now=Math.floor(Date.now()/1000);
    await f.db.insert(systemConfig).values([{menuName:'station_open',value:'1'},{menuName:'member_card_status',value:'1'}]);
    await f.db.insert(user).values([
      {uid:11,account:'activation-own',nickname:'本次卡密会员',pwd:password,status:1,nowMoney:'91.23',integral:27,isMoneyLevel:0,isEverLevel:0,overdueTime:now-86400,levelExtendInfo:'[{"legacy":"owner bytes"}]'},
      {uid:22,account:'activation-other',nickname:'另一会员',pwd:password,status:1,nowMoney:'88.50',integral:13,isMoneyLevel:1,isEverLevel:0,overdueTime:now+3*86400,levelExtendInfo:'[{"legacy":"other bytes"}]'},
    ]);
    await f.db.insert(memberCardBatch).values({id:BATCH,title:'原生七天卡密',totalNum:3,useNum:0,useDay:7,status:1,remark:'批次历史原文'});
    await f.db.insert(memberCard).values({id:CARD,cardBatchId:BATCH,cardNumber:code,cardPassword:secret,status:1,addTime:123});
    await f.db.insert(memberShip).values({id:701,title:'不得写入的付费套餐',type:'month',vipDay:30,price:'20.00',prePrice:'10.00'});
    await f.db.insert(otherOrder).values({id:901,uid:22,orderId:'immutable-prior-member',memberType:'701',type:1,paid:1,payPrice:'10.00',money:'10.00'});
    await f.db.insert(otherOrderStatus).values({oid:901,changeType:'immutable_prior_status',changeMessage:'不可修改的原记录',changeTime:123});
    await f.db.insert(userBill).values({id:801,uid:11,category:'now_money',type:'immutable_activation_guard',number:'3.25',balance:'91.23',mark:'原账单不可改'});
    await f.db.insert(storeCouponIssue).values({id:811,couponTitle:'优惠券旁观',remainCount:10,status:1});
    await f.db.insert(storeCouponUser).values({id:812,uid:11,issueCouponId:811,couponTitle:'已领券旁观',couponPrice:'1.00',status:0});
    await f.db.insert(storeOrder).values({id:821,uid:11,orderId:'immutable-physical-order',unique:'immutable-physical-order',paid:1,payPrice:'4.00'});
    await f.db.insert(storeOrderEconomize).values({uid:11,orderId:'immutable-physical-order',memberPrice:'1.20'});
  },30000);
  afterAll(async()=>{try{expect(responses.length).toBeGreaterThan(0);expect(network).not.toHaveBeenCalled();for(const operation of[...Object.values(bucket),...Object.values(queue),cache.put,cache.delete])expect(operation).not.toHaveBeenCalled();}
    finally{wiring.context?.disable();wiring.context=undefined;network?.mockRestore();await f?.close();}},30000);
  async function snapshot():Promise<Snapshot>{
    const result:Snapshot={};for(const table of tables)result[table]=(await f.db.execute<{row:Row}>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(table)} t ORDER BY to_jsonb(t)::text`)).map(row=>row.row);
    result.__sequences=await f.db.execute<Row>(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));return result;
  }
  const resources=()=>({objects:[...objects],r2:Object.fromEntries(Object.entries(bucket).map(([key,operation])=>[key,operation.mock.calls.length])),queue:Object.fromEntries(Object.entries(queue).map(([key,operation])=>[key,operation.mock.calls.length])),kv:{put:cache.put.mock.calls.length,delete:cache.delete.mock.calls.length}});
  async function request(input:Row|string=body(),uid=11,options:{container?:Container;token?:string;form?:string;query?:string}={}){
    const before=await snapshot(),beforeResources=resources(),started=Math.floor(Date.now()/1000),token=options.token??tokens.get(uid)??'';
    const response=await wiring.context!.run(options.container??container,()=>app.request('/api/user/member/card/draw'+(options.query??''),{method:'POST',headers:{'content-type':'application/json','Form-type':options.form??'h5',...(token?{'Authori-zation':'Bearer '+token}:{})},body:typeof input==='string'?input:JSON.stringify(input)},env));
    const raw=await response.text(),value=JSON.parse(raw) as Envelope;responses.push({http:response.status,status:value.status});
    expect(response.status,raw).toBe(200);expect(response.headers.get('content-type')).toContain('application/json');expect(response.headers.get('cache-control')).toContain('no-store');expect(raw).not.toContain(secret);expect(raw).not.toMatch(/card_password|cardPassword|member_card_pwd/);expect(resources()).toEqual(beforeResources);
    return{...value,response,before,after:await snapshot(),started,completed:Math.floor(Date.now()/1000)};
  }
  function advancedSequence(before:Row[],name:string):Row[]{
    const found=before.filter(row=>row.name===name);expect(found).toHaveLength(1);const row=found[0]!,next=String(BigInt(String(row.last))+(row.called?1n:0n));return before.map(value=>value.name===name?{...value,last:next,called:true}:value);
  }
  function assertSingleActivation(before:Snapshot,after:Snapshot,uid:number,result:unknown,channel:string){
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());const changed=['member_card','member_card_batch','user','other_order','other_order_status','__sequences'];
    for(const table of tables)if(!changed.includes(table))expect(after[table],table).toEqual(before[table]);
    expect(result&&typeof result==='object').toBe(true);const dto=result as {order_id:string;overdue_time:number};expect(Object.keys(dto).sort()).toEqual(['order_id','overdue_time']);expect(typeof dto.order_id).toBe('string');expect(dto.order_id).toMatch(/^hy_activation_[1-9]\d*$/u);expect(Number.isSafeInteger(dto.overdue_time)&&dto.overdue_time>0).toBe(true);
    const oldCard=one(before.member_card!,'id',CARD),card=one(after.member_card!,'id',CARD),oldBatch=one(before.member_card_batch!,'id',BATCH),batch=one(after.member_card_batch!,'id',BATCH),oldUser=one(before.user!,'uid',uid),account=one(after.user!,'uid',uid);
    const orders=after.other_order!.filter(row=>!before.other_order!.some(old=>old.id===row.id));expect(orders).toHaveLength(1);const order=orders[0]!,now=Number(order.pay_time);
    expect(card).toEqual({...oldCard,use_uid:uid,use_time:now,update_time:now});expect(batch).toEqual({...oldBatch,use_num:Number(oldBatch.use_num)+1,update_time:now});
    expect(account).toEqual({...oldUser,is_money_level:2,is_ever_level:0,overdue_time:dto.overdue_time});expect(changedColumns(oldUser,account)).toEqual(['is_money_level','overdue_time']);
    expect(after.member_card!.filter(row=>row.id!==CARD)).toEqual(before.member_card!.filter(row=>row.id!==CARD));expect(after.member_card_batch!.filter(row=>row.id!==BATCH)).toEqual(before.member_card_batch!.filter(row=>row.id!==BATCH));expect(after.user!.filter(row=>row.uid!==uid)).toEqual(before.user!.filter(row=>row.uid!==uid));
    const expectedExpiry=(Number(oldUser.is_money_level)>0&&Number(oldUser.overdue_time)>now?Number(oldUser.overdue_time):now)+7*86400;expect(dto.overdue_time).toBe(expectedExpiry);
    expect(order).toEqual({id:order.id,store_id:0,staff_id:0,uid,type:2,order_id:dto.order_id,member_type:'free',code,pay_type:'',paid:1,pay_price:0,member_price:0,pay_time:now,trade_no:'',channel_type:channel,is_free:0,is_permanent:0,overdue_time:dto.overdue_time,is_del:0,vip_day:7,add_time:now,money:0,remarks:`卡密激活批次 ${BATCH}`});
    expect(after.other_order!.filter(row=>row.id!==order.id)).toEqual(before.other_order);
    expect(after.other_order_status!.filter(row=>row.oid!==order.id)).toEqual(before.other_order_status);expect(after.other_order_status!.filter(row=>row.oid===order.id)).toHaveLength(1);
    const status=after.other_order_status!.find(row=>row.oid===order.id);expect(status).toEqual({oid:order.id,change_type:'card_redeem',change_message:'用户卡密激活会员',shop_type:2,change_time:now});
    expect(after.__sequences).toEqual(advancedSequence(before.__sequences!,'other_order_id_seq'));expect(order.id).toBe(Number(after.__sequences!.find(row=>row.name==='other_order_id_seq')!.last));
  }
  async function refused(input:Row=body(),message:string,allocated=1,uid=11,options:Parameters<typeof request>[2]={}){
    const prior=sequenceFetch.mock.calls.length,result=await request(input,uid,options);expect(result.status,result.msg).toBe(400);expect(result.msg).toContain(message);expect(result.data).toBeNull();expect(result.after).toEqual(result.before);expect(sequenceFetch.mock.calls.length-prior).toBe(allocated);return result;
  }
  it('reads each activation owner nickname through the actual rich profile route with zero SQL, resource or order allocation changes',async()=>{
    for(const uid of[11,22]){
      const before=await snapshot(),beforeResources=resources(),beforeSequence={allocated:sequenceNumber,allocations:[...allocations],names:sequence.idFromName.mock.calls.length,stubs:sequence.get.mock.calls.length,fetches:sequenceFetch.mock.calls.length};
      const response=await wiring.context!.run(container,()=>app.request('/api/user/info?profile=1',{method:'GET',headers:{'Form-type':'h5','Authori-zation':'Bearer '+tokens.get(uid)!}},env));
      const raw=await response.text(),value=JSON.parse(raw) as Envelope;responses.push({http:response.status,status:value.status});
      expect(response.status,raw).toBe(200);expect(value.status,value.msg).toBe(200);expect(response.headers.get('content-type')).toContain('application/json');expect(response.headers.get('cache-control')).toContain('no-store');
      const data=value.data as {actor_uid:number;profile:{uid:number;nickname:string}};
      expect(data.actor_uid).toBe(uid);expect(data.profile.uid).toBe(uid);expect(data.profile.nickname).toBe(uid===11?'本次卡密会员':'另一会员');
      expect(raw).not.toContain(secret);expect(raw).not.toContain(password);expect(raw).not.toMatch(/card_password|cardPassword|member_card_pwd/);
      expect(await snapshot()).toEqual(before);expect(resources()).toEqual(beforeResources);
      expect({allocated:sequenceNumber,allocations:[...allocations],names:sequence.idFromName.mock.calls.length,stubs:sequence.get.mock.calls.length,fetches:sequenceFetch.mock.calls.length}).toEqual(beforeSequence);
    }
  });
  it.each([
    {label:'H5 ordinary',header:'h5',from:'h5',channel:'h5'},
    {label:'H5 WeChat',header:'h5',from:'weixin',channel:'wechat'},
    {label:'MP-WEIXIN',header:'routine',from:'routine',channel:'routine'},
    {label:'APP-PLUS PHP fallback',header:'app',from:'h5',channel:'h5'},
  ])('activates once through actual $label HTTP/JWT and retains independent accounting',async row=>{
    const result=await request(body(row.from),11,{form:row.header});expect(result.status,result.msg).toBe(200);expect(result.msg).toBe('激活成功');assertSingleActivation(result.before,result.after,11,result.data,row.channel);
    const order=one(result.after.member_card!,'id',CARD);expect(Number(order.use_time)).toBeGreaterThanOrEqual(result.started);expect(Number(order.use_time)).toBeLessThanOrEqual(result.completed);expect(allocations).toEqual([(result.data as {order_id:string}).order_id]);
    await refused(body(row.from),'已使用',1,11,{form:row.header});expect(allocations).toHaveLength(2);
  });
  it('extends an active membership from its exact existing expiry and keeps the other account untouched',async()=>{
    const result=await request(body(),22);expect(result.status).toBe(200);assertSingleActivation(result.before,result.after,22,result.data,'h5');
    expect((result.data as {overdue_time:number}).overdue_time).toBe(Number(one(result.before.user!,'uid',22).overdue_time)+7*86400);
  });
  it('preserves the legacy default weixin channel and trims historical short card credentials without imposing generated formats',async()=>{
    const result=await request({member_card_code:' '+code+' ',member_card_pwd:' '+secret+' '});expect(result.status,result.msg).toBe(200);assertSingleActivation(result.before,result.after,11,result.data,'wechat');
  });
  it('binds writes to the JWT owner despite legacy body/query UID fields',async()=>{
    const result=await request({...body(),uid:22,user_id:22},11,{query:'?uid=22'});expect(result.status).toBe(200);assertSingleActivation(result.before,result.after,11,result.data,'h5');
  });
  it.each([{label:'wrong secret',input:{member_card_pwd:'wrong-secret'},message:'密码有误'},{label:'case-sensitive secret',input:{member_card_pwd:'CARD-SECRET'},message:'密码有误'},{label:'missing card',input:{member_card_code:'MISSING-CARD'},message:'不存在'}])('rejects $label without any SQL/R2 mutation while recording the spent DO allocation',async row=>{await refused({...body(),...row.input},row.message);});
  it.each([{label:'empty code',input:{member_card_code:''},message:'请输入会员卡号'},{label:'empty secret',input:{member_card_pwd:''},message:'请输入领取卡密'},{label:'long code',input:{member_card_code:'x'.repeat(21)},message:'格式错误'},{label:'long secret',input:{member_card_pwd:'x'.repeat(13)},message:'格式错误'},{label:'unsupported app body channel',input:{from:'app'},message:'非法渠道'}])('rejects $label before order allocation',async row=>{await refused({...body(),...row.input},row.message,0);});
  it('honors live disabled membership configuration before any allocation despite an enabled cached flag',async()=>{
    cache.get.mockResolvedValue('1');try{await f.db.update(systemConfig).set({value:'0'}).where(eq(systemConfig.menuName,'member_card_status'));await refused(body(),'会员功能暂未开启',0);expect(cache.get).not.toHaveBeenCalled();}finally{cache.get.mockResolvedValue(null);}
  });
  it.each(['disabled-card','disabled-batch','missing-batch','used-uid-only','used-time-only','permanent-member','duplicate-card'] as const)('rejects authoritative %s state without partial accounting',async kind=>{
    if(kind==='disabled-card')await f.db.update(memberCard).set({status:0}).where(eq(memberCard.id,CARD));if(kind==='disabled-batch')await f.db.update(memberCardBatch).set({status:0}).where(eq(memberCardBatch.id,BATCH));if(kind==='missing-batch')await f.db.delete(memberCardBatch).where(eq(memberCardBatch.id,BATCH));
    if(kind==='used-uid-only')await f.db.update(memberCard).set({useUid:22,useTime:0}).where(eq(memberCard.id,CARD));if(kind==='used-time-only')await f.db.update(memberCard).set({useUid:0,useTime:123}).where(eq(memberCard.id,CARD));if(kind==='permanent-member')await f.db.update(user).set({isMoneyLevel:1,isEverLevel:1,overdueTime:0}).where(eq(user.uid,11));
    if(kind==='duplicate-card')await f.db.insert(memberCard).values({id:502,cardBatchId:BATCH,cardNumber:code,cardPassword:secret,status:1});
    await refused(body(),kind==='duplicate-card'?'存在重复':kind==='permanent-member'?'永久会员':kind.startsWith('used-')?'已使用':'未激活');
  });
  it.each(['anonymous','wrong-realm','password-replaced','disabled-user','deleted-user','soft-deleted-user'] as const)('rejects %s actual authentication before any redemption resource or allocation',async kind=>{
    if(kind==='password-replaced')await f.db.update(user).set({pwd:md5('replacement-password')}).where(eq(user.uid,11));if(kind==='disabled-user')await f.db.update(user).set({status:0}).where(eq(user.uid,11));if(kind==='deleted-user')await f.db.update(user).set({isDel:1}).where(eq(user.uid,11));if(kind==='soft-deleted-user')await f.db.update(user).set({deleteTime:new Date()}).where(eq(user.uid,11));
    const result=await request(body(),kind==='anonymous'?0:11,{...(kind==='wrong-realm'?{token:adminToken}:{})});expect([410000,410001,410002]).toContain(result.status);expect(result.data).toBeNull();expect(result.after).toEqual(result.before);expect(sequenceFetch).not.toHaveBeenCalled();
  });
  it('rolls back a claim, batch counter and membership change when real SQL order insertion fails; the allocated SQL/DO IDs remain consumed',async()=>{
    // Deliberately occupy the next real serial primary key using an explicit
    // fixture id. This raises a real INSERT constraint error after earlier DML,
    // without adding production constraints, fake DAO errors or row results.
    await f.db.insert(otherOrder).values({id:1,uid:22,orderId:'owned-rollback-blocker',memberType:'701',type:1,paid:1});
    const result=await request();expect(result.status).toBe(500);expect(result.data).toBeNull();expect(result.msg).toContain('系统繁忙');
    for(const table of tables)expect(result.after[table],table).toEqual(result.before[table]);expect(result.after.__sequences).toEqual(advancedSequence(result.before.__sequences!,'other_order_id_seq'));expect(allocations).toEqual(['hy_activation_1']);
  });
  it('observes two real native PG16 card-row waiters and admits only one JWT owner; memory fallback proves sequential single-use refusal only',async()=>{
    const before=await snapshot(),beforeResources=resources();
    if(!process.env.TEST_FINANCE_POSTGRES_URL){
      const first=await request(body(),11);expect(first.status).toBe(200);assertSingleActivation(before,first.after,11,first.data,'h5');await refused(body(),'已使用',1,22);expect(resources()).toEqual(beforeResources);return;
    }
    await withFinancePeers(f.db,async([blocker,left,right])=>{
      let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      const holder=blocker.db.transaction(async tx=>{await tx.select().from(memberCard).where(eq(memberCard.id,CARD)).for('update');entered();await gate;});
      await ready;const a=outcome(request(body(),11,{container:createContainerFromDb(left.db)})),b=outcome(request(body(),22,{container:createContainerFromDb(right.db)}));
      try{const blocking=await waitForCardBlockingChains(f.db,[left.pid,right.pid],blocker.pid);expect(blocking.paths.map(path=>path[0])).toEqual([left.pid,right.pid]);expect(blocking.paths.every(path=>path.length>=2&&path.at(-1)===blocker.pid)).toBe(true);console.info('NATIVE_CARD_BLOCKING_CHAINS '+JSON.stringify(blocking));}finally{release();await holder;}
      const results=await Promise.all([a,b]);expect(results.every(result=>result.ok)).toBe(true);
      const replies=results.flatMap(result=>result.ok?[result.value]:[]);expect(replies.map(result=>result.status).sort()).toEqual([200,400]);const winner=replies.find(result=>result.status===200)!,loser=replies.find(result=>result.status===400)!;
      expect(loser.msg).toContain('已使用');expect(loser.data).toBeNull();const after=await snapshot(),uid=Number(one(after.member_card!,'id',CARD).use_uid);expect([11,22]).toContain(uid);expect(uid).toBe(replies.indexOf(winner)===0?11:22);assertSingleActivation(before,after,uid,winner.data,'h5');
      expect(sequenceFetch).toHaveBeenCalledTimes(2);expect(new Set(allocations).size).toBe(2);expect(resources()).toEqual(beforeResources);
    });
  },20000);
});
