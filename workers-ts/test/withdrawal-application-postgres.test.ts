import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@/models/schema';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { UserWithdrawalService } from '@/services/user/UserWithdrawalService';
import { user, userBrokerage, userExtract,systemConfig,systemAttachment } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { sortedDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ context: undefined as AsyncLocalStorage<Container> | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  const value = wiring.context?.getStore(); if (!value) throw Error('Owned real App LOGIN context required'); return value;
} }));
const base = 308000, password = md5('synthetic-withdrawal-application');
const modern='/api/extract/cash?view=withdrawal_application',configPath='/api/extract/bank?view=withdrawal_application';
const payload=(body:Row)=>body.data as Row;
const input=(extra:Row={})=>({request_id:'application-intent-0001',extract_type:'bank',extract_price:'20.00',real_name:'收款人',extract_number:'6222021234567890123',bank_name:'测试银行',bank_address:'',qrcode_url:'',...extra});
const receiptPath=(id:string)=>'/api/extract/records?view=withdrawal_receipt&request_id='+encodeURIComponent(id);
const mediaPath=(id=base+1)=>'/api/extract/bank?view=withdrawal_media&reference='+encodeURIComponent('/api/assets/'+id);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('withdrawal application real API JWT/App LOGIN and exact PG16 effects', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>, tables: string[], sequences: string[], now: number, fixtureOpen = false;
  let activeProfile: Promise<void> | undefined;
  const app = createApp(), tokens = new Map<number, string>();
  const writes = { get:vi.fn(), put:vi.fn(), delete:vi.fn(), head:vi.fn(), list:vi.fn(), queue:vi.fn(), sequence:vi.fn() };
  const resources = () => Object.fromEntries(Object.entries(writes).map(([key,fn])=>[key,fn.mock.calls.length]));
  beforeEach(async () => {
    fixtureOpen = false; f = await refundRuntimeFixture(); fixtureOpen = true;
    f.env.APP_KEY = crypto.randomUUID() + crypto.randomUUID(); now = Math.floor(Date.now() / 1000);
    wiring.context = new AsyncLocalStorage<Container>();
    await f.db.delete(userBrokerage);
    await f.db.update(user).set({pwd:password,nickname:'提现本人',account:'owner-account',phone:'13811111111',status:1,isDel:0,brokeragePrice:'100.00',nowMoney:'5.00'}).where(eq(user.uid,11));
    await f.db.update(user).set({pwd:password,nickname:'另一提现本人',account:'buyer-account',status:1,isDel:0,brokeragePrice:'200.00',nowMoney:'6.00'}).where(eq(user.uid,22));
    await f.db.insert(userBrokerage).values([{id:base+1,uid:11,type:'custom',pm:1,status:1,number:'20.00',frozenTime:now+3600},{id:base+2,uid:11,type:'custom',pm:1,status:0,number:'30.00',frozenTime:now+3600},{id:base+3,uid:11,type:'custom',pm:0,status:1,number:'99.00',frozenTime:now+3600},{id:base+4,uid:22,type:'custom',pm:1,status:1,number:'7.77',frozenTime:now+3600}]);
    await f.db.insert(systemAttachment).values([{attId:base+1,type:3,relationId:11,moduleType:3,fileType:1,imageType:8,name:'attachments/user/11/receipt.png',attDir:'/api/assets/'+(base+1),attType:'image/png'},{attId:base+2,type:3,relationId:22,moduleType:3,fileType:1,imageType:8,name:'attachments/user/22/receipt.png',attDir:'/api/assets/'+(base+2),attType:'image/png'}]);
    for(const[key,value]of Object.entries({station_open:'1',user_extract_min_price:'1.00',user_extract_max_price:'1000.00',withdraw_fee:'2.5555',brokerage_type:'0',user_extract_bank_status:'1',user_extract_balance_status:'1',user_extract_wechat_status:'1',user_extract_alipay_status:'1',user_extract_bank:'测试银行\n工商银行\n测试银行',extract_time:'3'}))await configure(key,value);
    tables = (await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(row => String(row.name));
    sequences = (await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(row => String(row.name));
    expect(tables).toHaveLength(283); expect(sequences).toHaveLength(229); for (const name of [...tables, ...sequences]) expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    for (const uid of [11, 22]) tokens.set(uid, (await createToken(uid, 'api', md5(password), f.env.APP_KEY)).token);
  }, 60000);
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External network forbidden'));
    for (const fn of Object.values(writes)) fn.mockReset().mockImplementation(() => { throw Error('Unexpected external resource'); });writes.queue.mockImplementation(async()=>{});
  });
  afterEach(async () => {
    try { await activeProfile; if (vi.isMockFunction(fetch)) expect(fetch).not.toHaveBeenCalled(); for (const [key,fn] of Object.entries(writes)) if(key!=='queue')expect(fn).not.toHaveBeenCalled(); }
    finally { wiring.context = undefined; tokens.clear(); vi.restoreAllMocks(); if (fixtureOpen) { fixtureOpen = false; await f.close(); } }
  }, 30000);
  type Peer = Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (role: infer T) => unknown ? T : never;
  async function profile(run: (env: Env, application: Peer) => Promise<void>) {
    const running = f.withRuntimeRole!(application => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS name');
      const names = { app: application.role, admin: admin.role, maintenance: 'finance_test', database: String(identity.name), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      expect(await auditRuntimeBusinessPrivileges(application.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      const env = { ...f.env, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', HYPERDRIVE: { connectionString: application.connectionString },
        HYPERDRIVE_ADMIN: { connectionString: admin.connectionString }, ASSETS_BUCKET: writes,
        CONFIG_KV: { get: writes.head, put: writes.put, delete: writes.delete, list: writes.list },
        ORDER_QUEUE: { send: writes.queue, sendBatch: writes.queue }, SEQUENCE: { idFromName: writes.sequence, get: writes.sequence } } as unknown as Env;
      Object.assign(env, { NODE_ENV: 'test' }); await run(env, application);
    }));
    activeProfile = running;
    try { await running; } finally { if (activeProfile === running) activeProfile = undefined; }
  }
  async function snapshot(): Promise<DiyStateSnapshot> {
    const state: DiyStateSnapshot = {};
    for (const row of await f.db.execute<{ name: string; rows: Row[] }>(sql.join(tables.map(name => sql`SELECT ${name}::text AS name,
      COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `))) state[row.name] = row.rows;
    state.__sequences = await f.db.execute(sql.join(sequences.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,
      is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
    return sortedDiyState(state);
  }
  async function readonly<T>(run: () => Promise<T>) {
    const before = await snapshot(), io = resources(), result = await run();
    expect(await snapshot()).toEqual(before); expect(resources()).toEqual(io); return result;
  }
  async function request(env: Env, db: DbClient, body: unknown = input(), uid: number | null = 11, token?: string,
    path = modern, contentType = 'application/json', method = 'POST') {
    const jobs:Promise<unknown>[]=[];const headers = new Headers({ 'Form-type': 'h5', 'Content-Type': contentType });
    if (uid !== null) headers.set('Authori-zation', 'Bearer ' + (token ?? tokens.get(uid)));
    const response = await wiring.context!.run(createContainerFromDb(db), () => app.fetch(new Request('https://owned.local' + path,
      { method, headers, ...(method==='GET'?{}:{body:typeof body === 'string' ? body : body instanceof Uint8Array ? new Uint8Array(body).buffer : JSON.stringify(body)}) }), env,
      { waitUntil: (p:Promise<unknown>) => {jobs.push(p);}, passThroughOnException: () => {} } as never));
    await Promise.all(jobs);return { response, body: await response.json() as Row };
  }
  async function configure(key:string,value:string){const changed=await f.db.update(systemConfig).set({value}).where(eq(systemConfig.menuName,key)).returning({id:systemConfig.id});if(!changed.length)await f.db.insert(systemConfig).values({menuName:key,value,isStore:0});}
  const get=(env:Env,db:DbClient,path:string,uid:number|null=11,token?:string)=>request(env,db,{},uid,token,path,'application/json','GET');
  async function financial(before:DiyStateSnapshot,after:DiyStateSnapshot,uid:number,id:number,gross='20.00',balance=false){
    const changed=new Set(['user','user_extract','user_brokerage','store_order_outbox',...(balance?['user_money','user_recharge','capital_flow']:[])]);
    for(const table of tables)if(!changed.has(table))expect(after[table],table+' outside exact financial scope').toEqual(before[table]);
    const oldUser=before.user.find(u=>u.uid===uid)!,newUser=after.user.find(u=>u.uid===uid)!;const cents=(s:unknown)=>{const text=String(s),negative=text.startsWith('-'),[whole,fraction='']=(negative?text.slice(1):text).split('.');expect(text).toMatch(/^-?\d+(?:\.\d{1,2})?$/);const n=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));return negative?-n:n;};
    expect(cents(newUser.brokerage_price)).toBe(cents(oldUser.brokerage_price)-cents(gross));expect(cents(newUser.now_money)).toBe(cents(oldUser.now_money)+(balance?cents(gross):0n));
    const expectedUser=structuredClone(before.user);const account=expectedUser.find(u=>u.uid===uid)!;account.brokerage_price=newUser.brokerage_price;account.now_money=newUser.now_money;expect(after.user).toEqual(sortedDiyState({user:expectedUser}).user);
    const previous=new Set(before.user_extract.map(r=>r.id)),inserted=after.user_extract.filter(r=>!previous.has(r.id));expect(inserted).toHaveLength(1);expect(inserted[0]).toMatchObject({id,uid,status:balance?1:0,add_time:now,fail_msg:'',fail_time:0});expect(String(inserted[0].request_hash)).toMatch(/^[a-f0-9]{64}$/);expect(after.user_extract.filter(r=>previous.has(r.id))).toEqual(before.user_extract);
    const ids=new Set(before.user_brokerage.map(r=>r.id)),debit=after.user_brokerage.filter(r=>!ids.has(r.id));expect(debit).toHaveLength(1);expect(debit[0]).toEqual({id:debit[0].id,uid,link_id:String(id),pm:0,title:'佣金提现',category:'extract',type:'extract',source_type:'',number:Number(gross),balance:newUser.brokerage_price,mark:'提现申请 #'+id,status:1,take:0,frozen_time:0,add_time:now});expect(after.user_brokerage.filter(r=>ids.has(r.id))).toEqual(before.user_brokerage);
    const oldEvents=new Set(before.store_order_outbox.map(r=>r.id)),events=after.store_order_outbox.filter(r=>!oldEvents.has(r.id));expect(events).toHaveLength(balance?2:1);expect(after.store_order_outbox.filter(r=>oldEvents.has(r.id))).toEqual(before.store_order_outbox);
    const application=events.find(r=>r.event_type==='withdrawal.applied.notice')!;expect(application).toMatchObject({aggregate_type:'withdrawal',aggregate_id:id,event_key:'withdrawal.applied.notice:'+id,status:'ENQUEUED',dispatch_count:1,attempt_count:0,lease_token:'',last_error:'',add_time:now,update_time:now,enqueued_time:now,payload:{withdrawalId:id,userId:uid,grossAmount:gross,occurredAt:now}});
    if(balance){expect(after.user_recharge.length).toBe(before.user_recharge.length+1);expect(after.user_money.length).toBe(before.user_money.length+1);expect(after.capital_flow.length).toBe(before.capital_flow.length+1);const approved=events.find(r=>r.event_type==='withdrawal.approved.notice')!;expect(approved).toMatchObject({aggregate_id:id,event_key:'withdrawal.approved.notice:'+id,status:'PENDING',dispatch_count:0});expect(after.capital_flow.find(r=>r.event_key==='withdrawal.approved.notice:'+id)).toMatchObject({uid,price:-Number(gross),trading_type:6,pay_type:'balance',order_id:'withdrawal:'+id});const recharge=after.user_recharge.find(r=>r.order_id==='wxextract'+id)!;expect(recharge).toMatchObject({uid,price:Number(gross),give_price:0,recharge_type:'balance',paid:1,pay_time:now,add_time:now});expect(after.user_money.find(r=>r.link_id===String(recharge.id)&&r.type==='extract')).toMatchObject({uid,pm:1,number:Number(gross),balance:newUser.now_money,status:1});}
    const increments:Record<string,number>={user_extract_id_seq:1,user_brokerage_id_seq:1,store_order_outbox_id_seq:balance?2:1,...(balance?{user_money_id_seq:1,user_recharge_id_seq:1,capital_flow_id_seq:1}:{})};
    for(const old of before.__sequences){const current=after.__sequences.find(s=>s.name===old.name)!;const n=increments[String(old.name)]??0;expect(current, String(old.name)).toEqual(n?{...old,last:String(BigInt(String(old.last))+BigInt(n)-(old.called?0n:1n)),called:true}:old);}
  }

  it('reads exact current SQL winner policy and clamped available amounts, including signed/large source balances',async()=>{
    await f.db.insert(systemConfig).values([{menuName:'withdraw_fee',value:'002.5000',sort:90,isStore:0},{menuName:'withdraw_fee',value:'99',sort:99,isStore:1}]);
    await profile(async(env,peer)=>{
      await readonly(async()=>{const result=await get(env,peer.db,configPath);expect(result.body.status).toBe(200);expect(result.response.headers.get('Cache-Control')).toBe('private, no-store');expect(payload(result.body)).toEqual({owner_uid:11,brokerage_amount:'100.00',withdrawable_amount:'80.00',frozen_amount:'20.00',min_amount:'1.00',max_amount:'1000.00',fee_rate:'2.5',freeze_days:3,channels:['bank','balance','weixin','alipay'],wechat_mode:'manual',banks:['测试银行','工商银行']});});
      await configure('user_extract_bank_status','0');await configure('user_extract_wechat_status','0');await configure('brokerage_type','1');await f.db.update(user).set({brokeragePrice:'-1.25'}).where(eq(user.uid,11));
      await readonly(async()=>expect(payload((await get(env,peer.db,configPath)).body)).toMatchObject({brokerage_amount:'-1.25',withdrawable_amount:'0.00',frozen_amount:'20.00',channels:['balance','alipay'],wechat_mode:'automatic'}));
      await f.db.delete(userBrokerage);await f.db.insert(userBrokerage).values(Array.from({length:101},(_,i)=>({uid:11,type:'custom',linkId:String(i),pm:1,status:1,frozenTime:now+100,number:'9999999999.99'})));
      await readonly(async()=>expect(payload((await get(env,peer.db,configPath)).body)).toMatchObject({frozen_amount:'1009999999998.99',withdrawable_amount:'0.00'}));
    });
  },30000);
  it('authorizes only owned canonical ordinary image metadata and signs a fresh exact900-second preview',async()=>{
    await profile(async(env,peer)=>{
      await readonly(async()=>{const result=await get(env,peer.db,mediaPath());expect(result.body.status).toBe(200);const data=payload(result.body);expect(Object.keys(data).sort()).toEqual(['owner_uid','preview','reference']);expect(data.owner_uid).toBe(11);expect(data.reference).toBe('/api/assets/'+(base+1));const url=new URL(String(data.preview),'https://owned.local');expect([...url.searchParams.keys()].sort()).toEqual(['expires','signature']);expect(url.pathname).toBe(data.reference);expect(url.searchParams.get('expires')).toBe(String(now+900));expect(url.searchParams.get('signature')).toBe(createHmac('sha256',env.APP_KEY).update('GET\n'+data.reference+'\n'+(now+900)).digest('base64url'));expect((await get(env,peer.db,mediaPath(base+2))).body.status).toBe(400);});
      for(const change of [{type:1,relationId:0,moduleType:1},{relationId:22},{moduleType:4},{fileType:2},{imageType:1},{attType:'image/jpeg'},{name:'attachments/user/11/../receipt.png'},{name:'attachments/user/22/receipt.png'},{attDir:'/api/assets/'+(base+2)}]){const[old]=await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId,base+1));await f.db.update(systemAttachment).set(change).where(eq(systemAttachment.attId,base+1));try{await readonly(async()=>expect((await get(env,peer.db,mediaPath())).body.status).toBe(400));}finally{await f.db.update(systemAttachment).set(old).where(eq(systemAttachment.attId,base+1));}}
    });
  },30000);
  it('commits one real bank request, exact fee/debit/outbox delta and a true owned server-time receipt, then replays readonly',async()=>{
    await profile(async(env,peer)=>{const before=await snapshot(),result=await request(env,peer.db);expect(result.body.status).toBe(200);const data=payload(result.body);expect(data).toEqual({owner_uid:11,request_id:input().request_id,id:data.id});await financial(before,await snapshot(),11,Number(data.id));expect(writes.queue).toHaveBeenCalledTimes(1);
      await readonly(async()=>{const receipt=payload((await get(env,peer.db,receiptPath(input().request_id))).body);expect(receipt).toEqual({owner_uid:11,request_id:input().request_id,found:true,receipt:{id:data.id,extract_type:'bank',gross_amount:'20.00',net_amount:'19.49',fee_amount:'0.51',status:0,add_time:now,time:new Date((now+28800)*1000).toISOString().slice(0,19).replace('T',' ').replaceAll('-','/'),withdrawal_message:''}});expect(payload((await get(env,peer.db,receiptPath(input().request_id),22)).body)).toEqual({owner_uid:22,request_id:input().request_id,found:false,receipt:null});expect((await request(env,peer.db)).body).toEqual(result.body);expect((await request(env,peer.db,input({extract_price:'21.00'}))).body.status).toBe(409);});
      await configure('user_extract_bank_status','0');await configure('user_extract_max_price','0');await readonly(async()=>expect((await request(env,peer.db)).body).toEqual(result.body));
    });
  },30000);
  it('uses the existing balance transaction for gross80, zero fee, immediate balance and exact financial effects',async()=>{
    await profile(async(env,peer)=>{const data=input({extract_type:'balance',extract_price:'80.00',real_name:'',extract_number:'',bank_name:''}),before=await snapshot(),result=await request(env,peer.db,data);expect(result.body.status).toBe(200);const id=Number(payload(result.body).id);await financial(before,await snapshot(),11,id,'80.00',true);await readonly(async()=>expect(payload((await get(env,peer.db,receiptPath(data.request_id))).body).receipt).toMatchObject({id,extract_type:'balance',gross_amount:'80.00',net_amount:'80.00',fee_amount:'0.00',status:1}));});
  },30000);
  it('requires actual owned codes for new manual WeChat/alipay, preserving stable intent replay after media or policy changes',async()=>{
    const data=input({extract_type:'alipay',extract_price:'1.99',extract_number:'synthetic-alipay',bank_name:'',qrcode_url:'/api/assets/'+(base+1)});
    await profile(async(env,peer)=>{const result=await request(env,peer.db,data);expect(result.body.status).toBe(200);const id=payload(result.body).id;await readonly(async()=>expect(payload((await get(env,peer.db,receiptPath(data.request_id))).body).receipt).toMatchObject({id,extract_type:'alipay',gross_amount:'1.99',fee_amount:'0.05',net_amount:'1.94'}));
      await configure('user_extract_alipay_status','0');await f.db.update(systemAttachment).set({relationId:22}).where(eq(systemAttachment.attId,base+1));await readonly(async()=>{expect((await request(env,peer.db,data)).body).toEqual(result.body);expect((await get(env,peer.db,mediaPath())).body.status).toBe(400);});
      await f.db.update(systemAttachment).set({relationId:11}).where(eq(systemAttachment.attId,base+1));const manual=input({request_id:'application-weixin-0002',extract_type:'weixin',extract_price:'2.00',real_name:'',extract_number:'synthetic-wechat',bank_name:'',qrcode_url:'/api/assets/'+(base+1)});expect((await request(env,peer.db,manual)).body.status).toBe(200);
    });
  },30000);
  it('rejects disabled channels, invalid bank and missing/foreign/unnecessary codes before any sequence or financial mutation',async()=>{
    await profile(async(env,peer)=>{
      for(const patch of [{extract_type:'bank',bank_name:'未配置银行'},{extract_type:'bank',qrcode_url:'/api/assets/'+(base+1)},{extract_type:'balance',extract_number:'',bank_name:'',qrcode_url:'/api/assets/'+(base+1)},{extract_type:'alipay',bank_name:'',qrcode_url:''},{extract_type:'weixin',bank_name:'',qrcode_url:''},{extract_type:'alipay',bank_name:'',qrcode_url:'/api/assets/'+(base+2)},{extract_type:'alipay',bank_name:'',qrcode_url:'https://owned.example/receipt.png'},{extract_type:'alipay',bank_name:'',qrcode_url:'/api/assets/'+(base+1)+'?expires=1&signature=copied'}])await readonly(async()=>expect((await request(env,peer.db,input(patch))).body.status).toBe(400));
      for(const [type,key]of[['bank','bank'],['balance','balance'],['weixin','wechat'],['alipay','alipay']]){await configure('user_extract_'+key+'_status','0');await readonly(async()=>expect((await request(env,peer.db,input({extract_type:type,bank_name:type==='bank'?'测试银行':''}))).body.status).toBe(400));}
      await readonly(async()=>expect(payload((await get(env,peer.db,configPath)).body).channels).toEqual([]));
    });
  },30000);
  it('shows automatic WeChat as an available request channel without pretending payout or requiring a manual recipient',async()=>{
    await configure('brokerage_type','1');await profile(async(env,peer)=>{
      const data=input({extract_type:'weixin',extract_price:'2.00',real_name:'',extract_number:'',bank_name:''});await readonly(async()=>{expect(payload((await get(env,peer.db,configPath)).body)).toMatchObject({wechat_mode:'automatic',channels:['bank','balance','weixin','alipay']});expect((await request(env,peer.db,{...data,extract_price:'1.00'})).body.status).toBe(400);expect((await request(env,peer.db,{...data,qrcode_url:'/api/assets/'+(base+1)})).body.status).toBe(400);});
      const result=await request(env,peer.db,data);expect(result.body.status).toBe(200);const id=Number(payload(result.body).id);await readonly(async()=>expect(payload((await get(env,peer.db,receiptPath(data.request_id))).body).receipt).toMatchObject({id,status:0,net_amount:'1.95',fee_amount:'0.05'}));await readonly(async()=>await expect(new UserWithdrawalService(createContainerFromDb(f.db)).review(id,1)).rejects.toThrow('渠道尚未完成'));expect(fetch).not.toHaveBeenCalled();
    });
  },30000);
  it('preserves legacy keyless submission and historical same-key/hash replay before all new channel/media/bank constraints',async()=>{
    await profile(async(env,peer)=>{const old=input({bank_name:'历史银行',qrcode_url:'https://historic.invalid/receipt.png'});const first=await request(env,peer.db,old,11,undefined,'/api/extract/cash');expect(first.body.status).toBe(200);await configure('user_extract_bank_status','0');await configure('user_extract_max_price','0');await readonly(async()=>{const current=await request(env,peer.db,old);expect(current.body.status).toBe(200);expect(payload(current.body)).toEqual({owner_uid:11,request_id:old.request_id,id:payload(first.body).id});});await configure('user_extract_max_price','1000.00');const keyless={...input(),request_id:''};expect((await request(env,peer.db,keyless,11,undefined,'/api/extract/cash')).body.status).toBe(200);});
  },30000);
  it('returns no fake receipt for unknown/foreign intents and only real owned rejection details/known status',async()=>{
    await f.db.insert(userExtract).values([{id:base+40,uid:11,requestKey:'owned-receipt-0001',extractType:'bank',extractPrice:'10.25',extractFee:'0.10',status:-1,failMsg:'本人需核对',addTime:0},{id:base+41,uid:22,requestKey:'foreign-receipt-001',status:-1,failMsg:'FOREIGN SECRET'},{id:base+42,uid:11,requestKey:'unknown-receipt-001',status:2,failMsg:'UNKNOWN SECRET',addTime:-1}]);
    await profile(async(env,peer)=>readonly(async()=>{expect(payload((await get(env,peer.db,receiptPath('not-found-receipt-1'))).body)).toEqual({owner_uid:11,request_id:'not-found-receipt-1',found:false,receipt:null});expect(payload((await get(env,peer.db,receiptPath('foreign-receipt-001'))).body).found).toBe(false);expect(payload((await get(env,peer.db,receiptPath('owned-receipt-0001'))).body).receipt).toMatchObject({id:base+40,gross_amount:'10.35',net_amount:'10.25',fee_amount:'0.10',status:-1,withdrawal_message:'本人需核对',time:''});expect(payload((await get(env,peer.db,receiptPath('unknown-receipt-001'))).body).receipt).toMatchObject({status:null,withdrawal_message:'',time:'1970/01/01 07:59:59'});}));
  },30000);
  it('refuses malformed/duplicate UTF8 JSON, coercions and all extra authority/query controls without writing',async()=>{
    await profile(async(env,peer)=>readonly(async()=>{
      for(const body of[null,[],1,'{','{"request_id":"application-intent-0001","request_id":"application-intent-0002"}','{"request_id":"application-intent-0001","request_\\u0069d":"application-intent-0002"}',input({request_id:1}),input({extract_price:20}),input({extract_price:'1e2'}),input({uid:22}),input({mode:'automatic'}),input({real_name:'\ud800'}),input({request_id:'short'}),input({real_name:'x'.repeat(65)}),input({qrcode_url:'x'.repeat(256)}),input({qrcode_url:'x'.repeat(9000)}),input({real_name:1}),input({request_id:' application-intent-0001'}),input({bank_address:'x'.repeat(257)}),input({extract_type:'wx'})])expect((await request(env,peer.db,body)).body.status).toBe(400);
      expect((await request(env,peer.db,Uint8Array.from([123,255,125]))).body.status).toBe(400);expect((await request(env,peer.db,input(),11,undefined,modern,'text/plain')).body.status).toBe(400);
      for(const query of ['view=other','view=withdrawal_application&view=withdrawal_application','view=withdrawal_application&uid=22','view=withdrawal_application&sort=1'])expect((await request(env,peer.db,input(),11,undefined,'/api/extract/cash?'+query)).body.status).toBe(400);
      for(const path of[configPath+'&uid=22',configPath+'&view=withdrawal_application',mediaPath()+'&reference=/api/assets/1',receiptPath('owned-receipt-0001')+'&uid=22',receiptPath('owned-receipt-0001')+'&request_id=owned-receipt-0001','/api/extract/records?view=withdrawal_receipt&request_id=short','/api/extract/bank?view=withdrawal_media&reference=/api/assets/01','/api/extract/bank?view=withdrawal_media&reference=/api/assets/2147483648'])expect((await get(env,peer.db,path)).body.status).toBe(400);
    }));
  },30000);
  it('requires current API JWT credentials for all three read projections and modern application',async()=>{
    await profile(async(env,peer)=>{const expired=(await createToken(11,'api',md5(password),env.APP_KEY,'cinashop',now-8*86400)).token,other=(await createToken(11,'admin',md5(password),env.APP_KEY)).token;await readonly(async()=>{for(const path of[configPath,mediaPath(),receiptPath('owned-receipt-0001')]){for(const[uid,token,status]of[[null,undefined,410000],[11,expired,410001],[11,other,410002]]as const)expect((await get(env,peer.db,path,uid,token)).body.status).toBe(status);}expect((await request(env,peer.db,input(),null)).body.status).toBe(410000);});for(const update of[{status:0},{isDel:1},{pwd:'changed'}]){await f.db.update(user).set(update).where(eq(user.uid,11));await readonly(async()=>expect([410001,410002]).toContain((await get(env,peer.db,configPath)).body.status));await f.db.update(user).set({status:1,isDel:0,pwd:password}).where(eq(user.uid,11));}});
  },30000);
  it('binds account, frozen money and config winners to one actual RR read even across a concurrent committed change',async()=>{
    await profile(async(env,peer)=>{const before=await snapshot();await f.withPeer!(async holder=>{let failure:unknown;let release!:()=>void,acquired!:()=>void;const gate=new Promise<void>(yes=>release=yes),ready=new Promise<void>(yes=>acquired=yes);const lock=holder.db.transaction(async tx=>{await tx.execute(sql`LOCK TABLE user_brokerage IN ACCESS EXCLUSIVE MODE`);await tx.update(userBrokerage).set({number:'30.00'}).where(eq(userBrokerage.id,base+1));acquired();await gate;});await ready;const pending=get(env,peer.db,configPath);try{let blocked=false;const end=performance.now()+1500;do{const[s]=await f.db.execute<{blockers:number[];query:string}>(sql`select pg_blocking_pids(${peer.pid}) as blockers,query from pg_stat_activity where pid=${peer.pid}`);if(s?.blockers.includes(holder.pid)&&/user_brokerage/.test(s.query)){blocked=true;break;}await delay(20);}while(performance.now()<end);expect(blocked).toBe(true);await f.db.update(user).set({brokeragePrice:'50.00'}).where(eq(user.uid,11));await configure('withdraw_fee','10');}catch(error){failure=error;}finally{release();await lock;}const result=await pending;if(failure)throw failure;const expected=structuredClone(before);expected.user.find(r=>r.uid===11)!.brokerage_price=50;expected.user_brokerage.find(r=>r.id===base+1)!.number=30;for(const row of expected.system_config.filter(r=>r.menu_name==='withdraw_fee'))row.value='10';expect(await snapshot()).toEqual(sortedDiyState(expected));expect(payload(result.body)).toMatchObject({brokerage_amount:'100.00',frozen_amount:'20.00',withdrawable_amount:'80.00',fee_rate:'2.5555'});await readonly(async()=>expect(payload((await get(env,peer.db,configPath)).body)).toMatchObject({brokerage_amount:'50.00',frozen_amount:'30.00',withdrawable_amount:'20.00',fee_rate:'10'}));});});
  },30000);
  it('serializes two real App LOGIN requests for the same intent into one financial commit and one event dispatch',async()=>{
    await profile(async(env,peer)=>{
      const sent:Array<{connection:string;query:string;parameters:unknown[]}>=[];
      const client=(connection:string)=>postgres(peer.connectionString,{max:1,prepare:false,debug:(_id,query,parameters)=>{sent.push({connection,query,parameters:[...parameters]});}});
      const firstClient=client('first'),secondClient=client('second');
      const first=drizzle(firstClient,{schema}) as unknown as DbClient,second=drizzle(secondClient,{schema}) as unknown as DbClient;
      try{
        const identities=await Promise.all([first,second].map(async db=>(await db.execute<{role:string;session:string;pid:number}>(sql`select current_user as role,session_user as session,pg_backend_pid() as pid`))[0]!));
        for(const identity of identities)expect(identity).toMatchObject({role:peer.role,session:peer.role});
        expect(new Set(identities.map(row=>row.pid)).size).toBe(2);
        const before=await snapshot();let results:Awaited<ReturnType<typeof request>>[]=[];
        await f.withPeer!(async holder=>{
          let release!:()=>void,acquired!:()=>void;const gate=new Promise<void>(yes=>release=yes),ready=new Promise<void>(yes=>acquired=yes);
          const lock=holder.db.transaction(async tx=>{await tx.execute(sql`select uid from public.user where uid=11 for update`);acquired();await gate;});
          await ready;const one=request(env,first),two=request(env,second);let failure:unknown;
          try{
            let blocked=false,observed:Array<{pid:number;blockers:number[];wait_type:string|null;state:string;query:string}>=[];
            const end=performance.now()+1500;
            do{
              observed=await f.db.execute<(typeof observed)[number]>(sql`select pid,pg_blocking_pids(pid) as blockers,wait_event_type as wait_type,state,query from pg_stat_activity where pid in(${identities[0]!.pid},${identities[1]!.pid})`);
              const graph=new Map(observed.map(row=>[row.pid,row]));
              const reachesHolder=(pid:number,seen=new Set<number>()):boolean=>{if(pid===holder.pid)return true;if(seen.has(pid))return false;seen.add(pid);return graph.get(pid)?.blockers.some(next=>reachesHolder(next,new Set(seen)))??false;};
              const actualUserLock=(row:(typeof observed)[number])=>{
                const connection=row.pid===identities[0]!.pid?'first':'second';
                return sent.some(q=>q.connection===connection&&q.parameters[0]===11&&/from "user" where/i.test(q.query)&&/for update/i.test(q.query)&&q.query.startsWith(row.query));
              };
              if(observed.length===2&&observed.every(r=>r.state==='active'&&r.wait_type==='Lock'&&actualUserLock(r)&&reachesHolder(r.pid))){blocked=true;break;}
              await delay(20);
            }while(performance.now()<end);
            process.stdout.write('WITHDRAWAL_APPLICATION_CONCURRENCY '+JSON.stringify({holder_pid:holder.pid,app_identities:identities,observed,sent_user_locks:sent.filter(q=>/from "user" where/i.test(q.query)&&/for update/i.test(q.query))})+'\n');
            expect(blocked,JSON.stringify(observed)).toBe(true);
          }catch(error){failure=error;}finally{release();await lock;}
          const settled=await Promise.allSettled([one,two]);if(failure)throw failure;
          results=settled.map(r=>{if(r.status==='rejected')throw r.reason;return r.value;});
        });
        expect(results.map(r=>r.body.status)).toEqual([200,200]);expect(results[0]!.body).toEqual(results[1]!.body);
        await financial(before,await snapshot(),11,Number(payload(results[0]!.body).id));expect(writes.queue).toHaveBeenCalledTimes(1);
      }finally{await Promise.all([firstClient.end({timeout:3}),secondClient.end({timeout:3})]);}
    });
  },30000);
});
