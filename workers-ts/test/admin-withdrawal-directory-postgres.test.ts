import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemRole, systemAttachment, user, userBrokerage, userExtract } from '@/models/schema';
import { AdminWithdrawalDirectoryService, type AdminWithdrawalDirectoryActor, type AdminWithdrawalDirectoryDto,
  type AdminWithdrawalDirectoryMediaDto } from '@/services/admin/AdminWithdrawalDirectoryService';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

// Only connection wiring is substituted. Authentication, route permission,
// live role resolution, controller, transaction and all report SQL are real.
const wiring=vi.hoisted(()=>({context:undefined as AsyncLocalStorage<{app:Container;admin:Container}>|undefined,
  opens:0,closes:0}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),
  createContainer:()=>{const x=wiring.context?.getStore();if(!x)throw Error('Owned application LOGIN required');return x.app;},
  createAdminDatabaseSession:()=>{const x=wiring.context?.getStore();if(!x)throw Error('Owned independent Admin LOGIN required');wiring.opens++;return{container:x.admin,close:async()=>{wiring.closes++;}};},
}));
const day=Date.UTC(2026,9,1,16)/1000,base=510001,adminId=550001,roleId=550001,pwd=md5('synthetic-admin-directory');
const queryDefault={page:1,limit:20,status:null,extract_type:'',keyword:'',start:0,stop:0};
const periodDefault={start:0,stop:0,effective_stop:0,rule:'none'};
const topKeys=['version','actor_id','query','period','count','statistics','list'].sort();
const rowKeys=['id','uid','nickname','account','extract_type','real_name','bank_name','bank_code','bank_address',
  'alipay_code','wechat','extract_number','gross_amount','net_amount','fee_amount','balance_before','status','fail_msg',
  'fail_time','mark','add_time','time','media_available','revision'].sort();
const stable=(v:unknown):string=>JSON.stringify(v,(_key,x)=>x&&typeof x==='object'&&!Array.isArray(x)
  ?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
type Row=Record<string,unknown>;
type Fixture=Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer=Parameters<NonNullable<Fixture['withRuntimeRole']>>[0] extends (peer:infer T)=>unknown?T:never;
function pixelPng():Uint8Array{
  const chunk=(type:string,value:Uint8Array)=>{
    const bytes=Buffer.concat([Buffer.from(type,'ascii'),value]);let crc=0xffffffff;
    for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(-(crc&1)&0xedb88320);}
    const length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(value.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([length,bytes,sum]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return new Uint8Array(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('IDAT',deflateSync(Buffer.from([0,120,180,220,255]))),chunk('IEND',new Uint8Array())]));
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin withdrawal directory real PG16 readonly LOGIN and HTTP',()=>{
  let f:Fixture,tables:string[],sequences:string[],actor:AdminWithdrawalDirectoryActor,expectedAssetReads=0;
  const app=createApp();
  const io={get:vi.fn(),put:vi.fn(),delete:vi.fn(),head:vi.fn(),list:vi.fn(),queue:vi.fn(),sequence:vi.fn()};
  const resources=()=>Object.fromEntries(Object.entries(io).map(([key,fn])=>[key,fn.mock.calls.length]));
  beforeAll(async()=>{
    f=await refundRuntimeFixture();f.env.APP_KEY=crypto.randomUUID()+crypto.randomUUID();
    wiring.context=new AsyncLocalStorage<{app:Container;admin:Container}>();
    await f.db.insert(user).values({uid:33,nickname:'Deleted33',account:'deleted-account',isDel:1,status:0,deleteTime:new Date(0)});
    await f.db.insert(systemRole).values({id:roleId,type:0,relationId:0,roleName:'Synthetic extract reader',rules:'extract.view',status:1});
    await f.db.insert(systemAdmin).values({id:adminId,account:'synthetic-directory',pwd,roles:String(roleId),level:1,status:1,adminType:1,relationId:0});
    tables=(await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(r=>String(r.name));
    sequences=(await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(r=>String(r.name));
    expect(tables).toHaveLength(283);expect(sequences).toHaveLength(229);
    for(const name of [...tables,...sequences])expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
  },60000);
  beforeEach(async()=>{
    actor={id:adminId,authVersion:md5(pwd),expiresAt:Math.floor(Date.now()/1000)+3600};
    await f.db.update(systemAdmin).set({pwd,roles:String(roleId),level:1,status:1,isDel:0,adminType:1,relationId:0}).where(eq(systemAdmin.id,adminId));
    await f.db.update(systemRole).set({rules:'extract.view',status:1,type:0,relationId:0}).where(eq(systemRole.id,roleId));
    await f.db.update(user).set({nickname:'Owner11',account:'ACCOUNT_ONLY',phone:'13811111111',status:1,isDel:0}).where(eq(user.uid,11));
    await f.db.update(user).set({nickname:'Disabled customer',account:'disabled-account',status:0,isDel:0}).where(eq(user.uid,22));
    await f.db.delete(userExtract);await f.db.delete(userBrokerage);
    await f.db.delete(systemAttachment).where(sql`${systemAttachment.attId} BETWEEN 560001 AND 560099`);
    await f.db.insert(userExtract).values(Array.from({length:43},(_,i)=>({id:base+i,uid:[11,22,33,44][i%4],
      extractType:['bank','balance','weixin','alipay'][i%4],status:[0,1,-1,2][i%4],realName:'recipient',
      extractPrice:'1.00',extractFee:'0.01',balance:'100.00',addTime:i===42?0:day+i*60})));
    await f.db.insert(userBrokerage).values([
      {id:base,uid:11,type:'custom-income',pm:1,status:1,number:'100.00',addTime:day},
      {id:base+1,uid:22,type:'custom-future',pm:1,status:1,number:'50.00',frozenTime:2147483647,addTime:day},
      {id:base+2,uid:44,type:'custom-negative',pm:1,status:1,number:'-0.01',addTime:day},
      {id:base+3,uid:11,type:'custom-outside',pm:1,status:1,number:'3.33',addTime:day-1},
      ...[{status:0,pm:1,type:'frozen'},{status:1,pm:0,type:'outgoing'},
        {status:1,pm:1,type:'extract_fail'},{status:1,pm:1,type:'refund'},
        {status:-1,pm:1,type:'invalid'},{status:1,pm:2,type:'unknown-pm'}]
        .map((row,i)=>({id:base+4+i,uid:11,number:'999.00',addTime:day,...row})),
    ]);
    for(const fn of Object.values(io))fn.mockReset().mockImplementation(()=>{throw Error('External resource forbidden');});
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('External network forbidden'));
    wiring.opens=0;wiring.closes=0;
    expectedAssetReads=0;
  });
  afterEach(()=>{try{for(const [name,fn] of Object.entries(io))expect(fn).toHaveBeenCalledTimes(name==='get'?expectedAssetReads:0);expect(fetch).not.toHaveBeenCalled();
    expect(wiring.closes).toBe(wiring.opens);}finally{vi.restoreAllMocks();}});
  afterAll(async()=>{wiring.context=undefined;await f?.close();},30000);

  async function snapshot(){
    const state:Record<string,unknown>={};
    for(const row of await f.db.execute<{name:string;rows:Row[]}>(sql.join(tables.map(name=>sql`SELECT ${name}::text AS name,
      coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`),sql` UNION ALL `)))
      state[row.name]=row.rows.map(stable).sort();
    state.__sequences=Array.from(await f.db.execute(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,
      last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `))).map(stable).sort();
    return state;
  }
  async function readonly<T>(run:()=>Promise<T>,delta:Partial<Record<keyof typeof io,number>>={}){const before=await snapshot(),external=resources();
    try{return await run();}finally{expect(await snapshot()).toEqual(before);
      expect(resources()).toEqual(Object.fromEntries(Object.entries(external).map(([name,count])=>[name,count+(delta[name as keyof typeof io]??0)])));}}
  async function reader<T>(run:(peer:Peer)=>Promise<T>){return f.withRuntimeRole!(async peer=>{
    expect(peer.role).toMatch(/^cinashop_runtime_[a-f0-9]{32}$/);
    for(const name of ['system_admin','system_role','system_menus','system_config','user','user_extract','user_brokerage','system_attachment'])
      await f.exec(`GRANT SELECT ON public."${name}" TO "${peer.role}"`);
    const [identity]=await peer.exec('SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid');
    expect(identity).toEqual({role:peer.role,session:peer.role,pid:peer.pid});
    const [authority]=await peer.exec("SELECT count(*)::integer AS count FROM information_schema.role_table_grants WHERE grantee=current_user AND privilege_type<>'SELECT'");
    expect(authority.count).toBe(0);
    for(const sequence of sequences){const [grant]=await peer.db.execute<{allowed:boolean}>(sql`SELECT has_sequence_privilege(current_user,${'public.'+sequence},'USAGE,SELECT,UPDATE') AS allowed`);expect(grant.allowed,sequence).toBe(false);}
    return run(peer);
  });}
  const list=(db:DbClient,input:Record<string,string>={},claims=actor)=>new AdminWithdrawalDirectoryService(createContainerFromDb(db),f.env.APP_KEY).list(new URLSearchParams(input),claims);
  const media=(db:DbClient,id:number,revision:string,claims=actor)=>new AdminWithdrawalDirectoryService(createContainerFromDb(db),f.env.APP_KEY).media(id,new URLSearchParams({revision}),claims);
  const selected=async(db:DbClient,id=510043)=>{const dto=await list(db,{keyword:String(id)});expect(dto.count).toBe(1);return dto.list[0];};
  async function seedQr(uid=33,id=510043,attachment=560001){
    await f.db.insert(systemAttachment).values({attId:attachment,type:3,relationId:uid,moduleType:3,fileType:1,imageType:8,
      name:'attachments/user/'+uid+'/withdrawal-qr.png',attDir:'/api/assets/'+attachment,sattDir:'/api/assets/'+attachment,attType:'image/png'});
    await f.db.update(userExtract).set({qrcodeUrl:'/api/assets/'+attachment}).where(eq(userExtract.id,id));
  }
  function shape(dto:AdminWithdrawalDirectoryDto){expect(Object.keys(dto).sort()).toEqual(topKeys);for(const row of dto.list){
    expect(Object.keys(row).sort()).toEqual(rowKeys);expect(row.revision).toMatch(/^[a-f0-9]{64}$/);
    for(const key of ['gross_amount','net_amount','fee_amount','balance_before'] as const)expect(row[key]).toMatch(/^-?(?:0|[1-9]\d*)\.\d{2}$/);
    expect(JSON.stringify(row)).not.toMatch(/request_key|request_hash|qrcode_url|row_version|media_version|signature|attachments\//);
  }}

  it('returns exact complete projection, descending ID pages and all PHP summaries without customer-active filtering',async()=>reader(peer=>readonly(async()=>{
    const all=await list(peer.db);shape(all);
    expect({...all,list:undefined}).toEqual({version:1,actor_id:adminId,query:queryDefault,period:periodDefault,count:43,
      statistics:{price:'11.11',priced:'11.11',brokerage_count:'153.32',brokerage_not:'142.21'},list:undefined});
    expect(all.list.map(r=>r.id)).toEqual(Array.from({length:20},(_,i)=>510043-i));
    const {revision,...first}=all.list[0];expect(revision).toMatch(/^[a-f0-9]{64}$/);expect(first).toEqual({id:510043,uid:33,nickname:'Deleted33',account:'deleted-account',
      extract_type:'weixin',real_name:'recipient',bank_name:'',bank_code:'',bank_address:'',alipay_code:'',wechat:'',extract_number:'',
      gross_amount:'1.01',net_amount:'1.00',fee_amount:'0.01',balance_before:'100.00',status:-1,fail_msg:'',fail_time:0,mark:'',add_time:0,time:'',media_available:false});
    const second=await list(peer.db,{page:'2'}),third=await list(peer.db,{page:'3'}),empty=await list(peer.db,{page:'4'});
    expect(second.list.map(r=>r.id)).toEqual(Array.from({length:20},(_,i)=>510023-i));
    expect(third.list.map(r=>r.id)).toEqual([510003,510002,510001]);expect(empty.list).toEqual([]);expect(empty.count).toBe(43);
    expect(all.list.find(r=>r.uid===44)?.nickname).toBe('');expect(all.list.find(r=>r.uid===44)?.account).toBe('');
    expect(all.list.find(r=>r.uid===44)?.status).toBe(2);expect(all.list.find(r=>r.uid===22)?.nickname).toBe('Disabled customer');
  })),30000);

  it('keeps summary status independent of list status, and brokerage independent of channel and keyword',async()=>reader(peer=>readonly(async()=>{
    for(const status of ['0','1','-1']){const dto=await list(peer.db,{status});expect(dto.count).toBe(11);expect(dto.list.every(r=>r.status===Number(status))).toBe(true);
      expect(dto.statistics).toEqual({price:'11.11',priced:'11.11',brokerage_count:'153.32',brokerage_not:'142.21'});}
    const bank=await list(peer.db,{extract_type:'bank',status:'1'});expect(bank.count).toBe(0);expect(bank.list).toEqual([]);
    expect(bank.statistics).toEqual({price:'11.11',priced:'0.00',brokerage_count:'153.32',brokerage_not:'153.32'});
    const wx=await list(peer.db,{extract_type:'wx'});expect(wx.query.extract_type).toBe('weixin');expect(wx.count).toBe(11);
    expect(wx.statistics).toEqual({price:'0.00',priced:'0.00',brokerage_count:'153.32',brokerage_not:'153.32'});
    const missing=await list(peer.db,{keyword:'NO_MATCH'});expect(missing.count).toBe(0);
    expect(missing.statistics).toEqual({price:'0.00',priced:'0.00',brokerage_count:'153.32',brokerage_not:'153.32'});
  })),30000);

  it('uses only PHP search fields, raw keyword0 truthiness and unescaped LIKE patterns with bound SQL values',async()=>{
    await f.db.update(userExtract).set({realName:'SEARCH_REAL',bankCode:'SEARCH_BANK',alipayCode:'SEARCH_ALIPAY',bankName:'BANK_ONLY',
      wechat:'WECHAT_ONLY',mark:'MARK_ONLY',extractNumber:'EXTRACT_ONLY'}).where(eq(userExtract.id,510001));
    await f.db.insert(userExtract).values({id:-5,uid:-2147483648,status:-32768,addTime:-2147483648,failTime:2147483647,
      extractPrice:'-2.00',extractFee:'0.00',balance:'-3.00'});
    await reader(peer=>readonly(async()=>{
      for(const keyword of ['SEARCH_REAL','search_bank','SEARCH_ALIPAY','510001'])expect((await list(peer.db,{keyword})).list.map(r=>r.id)).toEqual([510001]);
      expect((await list(peer.db,{keyword:'Deleted33'})).count).toBe(11);
      for(const keyword of ['ACCOUNT_ONLY','13811111111','BANK_ONLY','WECHAT_ONLY','MARK_ONLY','EXTRACT_ONLY',"' OR true --"])
        expect((await list(peer.db,{keyword})).count,keyword).toBe(0);
      expect((await list(peer.db,{keyword:'22'})).list.map(r=>r.id)).toEqual([510022]);
      expect((await list(peer.db,{keyword:'0'})).count).toBe(44);expect((await list(peer.db,{keyword:'00'})).count).toBe(43);
      expect((await list(peer.db,{keyword:'0 '})).count).toBe(0);expect((await list(peer.db,{keyword:'%'})).count).toBe(44);
      expect((await list(peer.db,{keyword:'_'})).count).toBe(44);
      const old=(await list(peer.db,{keyword:'-5'})).list[0];shape(await list(peer.db,{keyword:'-5'}));
      expect({id:old.id,uid:old.uid,status:old.status,add_time:old.add_time,fail_time:old.fail_time,gross_amount:old.gross_amount,
        net_amount:old.net_amount,fee_amount:old.fee_amount,balance_before:old.balance_before,media_available:old.media_available})
        .toEqual({id:-5,uid:-2147483648,status:-32768,add_time:-2147483648,fail_time:2147483647,gross_amount:'-2.00',
          net_amount:'-2.00',fee_amount:'0.00',balance_before:'-3.00',media_available:false});
    }));
  },30000);

  it('implements closed raw endpoints, equal/midnight day expansion and widened SQL beyond signed int4',async()=>{
    const times=[day-1,day,day+60,day+61,day+86400,day+86401,day+86460,day+86461,day+172800,day+172801,2147483647];
    await f.db.insert(userExtract).values(times.map((addTime,i)=>({id:520001+i,uid:11,realName:'BOUNDARY',addTime,extractPrice:'0.00'})));
    await reader(peer=>readonly(async()=>{
      const range=async(start:number,stop:number)=>list(peer.db,{keyword:'BOUNDARY',start:String(start),stop:String(stop)});
      expect((await range(day,day+60)).list.map(r=>r.id)).toEqual([520003,520002]);
      const equal=await range(day+60,day+60);expect(equal.period.rule).toBe('equal-plus-day');
      expect(equal.list.map(r=>r.id)).toEqual([520007,520006,520005,520004,520003]);
      const midnight=await range(day,day+86400);expect(midnight.period.rule).toBe('midnight-plus-day');
      expect(midnight.period.effective_stop).toBe(day+172800);expect(midnight.list.map(r=>r.id)).toEqual([520009,520008,520007,520006,520005,520004,520003,520002]);
      const dayOnly=await list(peer.db,{start:String(day),stop:String(day)});expect(dayOnly.count).toBe(46);
      expect(dayOnly.statistics).toEqual({price:'11.11',priced:'11.11',brokerage_count:'149.99',brokerage_not:'138.88'});
      const maximum=await range(2147483640,2147483640);expect(maximum.period.effective_stop).toBe(2147570040);
      expect(maximum.list.map(r=>r.id)).toEqual([520011]);expect(maximum.statistics.brokerage_count).toBe('0.00');
    }));
  },30000);

  it('uses arbitrary precision gross/sums, preserves signed history and clamps only brokerage_not',async()=>{
    await f.db.insert(userExtract).values([{id:530001,uid:44,status:1,extractPrice:'9999999999.99',extractFee:'9999999999.99'},
      {id:530002,uid:0,status:1,extractPrice:'9999999999.99',extractFee:'9999999999.99'},
      {id:530003,uid:-2147483648,status:0,extractPrice:'-1.01',extractFee:'-0.02',balance:'-9.99'}]);
    await reader(peer=>readonly(async()=>{const dto=await list(peer.db);shape(dto);
      expect(dto.statistics).toEqual({price:'10.08',priced:'40000000011.07',brokerage_count:'153.32',brokerage_not:'0.00'});
      expect(dto.list[0].gross_amount).toBe('-1.03');expect(dto.list[0].balance_before).toBe('-9.99');
      expect(dto.list[1].uid).toBe(0);expect(dto.list[1].gross_amount).toBe('19999999999.98');
    }));
  },30000);

  it('aligns historical Shanghai DST report times, midnight expansion and both explicit autumn-fold instants with SQL IANA time',async()=>{
    const times=[581094000,581097600,581180400,581180401,589912200,589915800,577216740,577216800];
    await f.db.insert(userExtract).values(times.map((addTime,i)=>({id:535001+i,uid:44,realName:'DST_BOUNDARY',addTime,extractPrice:'0.00'})));
    await reader(peer=>readonly(async()=>{
      const query=(start:number,stop:number)=>list(peer.db,{keyword:'DST_BOUNDARY',start:String(start),stop:String(stop)});
      const midnight=await query(581090400,581094000);expect(midnight.period.rule).toBe('midnight-plus-day');
      expect(midnight.list.map(row=>row.id)).toEqual([535003,535002,535001]);
      expect(midnight.list.map(row=>row.time)).toEqual(['1988/06/02 00:00','1988/06/01 01:00','1988/06/01 00:00']);
      const one=await query(581090400,581097600);expect(one.period.rule).toBe('closed');expect(one.list.map(row=>row.id)).toEqual([535002,535001]);
      const fold=await query(589912200,589915800);expect(fold.list.map(row=>[row.id,row.add_time,row.time]))
        .toEqual([[535006,589915800,'1988/09/11 01:30'],[535005,589912200,'1988/09/11 01:30']]);
      const spring=await query(577216740,577216800);expect(spring.list.map(row=>row.time)).toEqual(['1988/04/17 03:00','1988/04/17 01:59']);
    }));
  },30000);

  it('actually runs REPEATABLE READ/READ ONLY and preserves stricter connection timeouts without leaking local settings',async()=>reader(async peer=>{
    await peer.exec("SET statement_timeout='750ms'; SET lock_timeout='500ms'; SET idle_in_transaction_session_timeout='1000ms'");
    const settings=async()=>Array.from(await peer.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
      current_setting('transaction_isolation') AS isolation,(SELECT setting FROM pg_settings WHERE name='statement_timeout') AS statement,
      (SELECT setting FROM pg_settings WHERE name='lock_timeout') AS lock,(SELECT setting FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`));
    const before=await settings(),observed:Row[]=[];
    const transaction=peer.db.transaction.bind(peer.db);
    const wrapped:typeof peer.db.transaction=(callback,config)=>transaction(async tx=>{
      const result=await callback(tx);
      observed.push(...Array.from(await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
        current_setting('transaction_isolation') AS isolation,(SELECT setting FROM pg_settings WHERE name='statement_timeout') AS statement,
        (SELECT setting FROM pg_settings WHERE name='lock_timeout') AS lock,(SELECT setting FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`)));
      return result;
    },config);
    const spy=vi.spyOn(peer.db,'transaction').mockImplementation(wrapped);
    try{await readonly(()=>list(peer.db));}finally{spy.mockRestore();}
    expect(observed).toEqual([{readonly:'on',isolation:'repeatable read',statement:'750',lock:'500',idle:'1000'}]);
    expect(await settings()).toEqual(before);
    await readonly(async()=>{
      await expect(peer.exec('UPDATE public.user_extract SET mark=mark')).rejects.toMatchObject({code:'42501'});
      await expect(peer.exec("SELECT nextval('public.user_extract_id_seq')")).rejects.toMatchObject({code:'42501'});
    });
  }),30000);

  it('reports metadata eligibility only, binds current row/attachment xmin, and leaks neither references nor signed previews',async()=>{
    await f.db.insert(systemAttachment).values({attId:560001,type:3,relationId:33,moduleType:3,fileType:1,imageType:8,
      name:'attachments/user/33/withdrawal-qr.png',attDir:'/api/assets/560001',sattDir:'/api/assets/560001',attType:'image/png'});
    await f.db.update(userExtract).set({qrcodeUrl:'/api/assets/560001'}).where(eq(userExtract.id,510043));
    await reader(async peer=>{
      const first=await readonly(()=>list(peer.db,{keyword:'510043'}));expect(first.list[0].media_available).toBe(true);shape(first);
      expect((await readonly(()=>list(peer.db,{keyword:'510043'}))).list[0].revision).toBe(first.list[0].revision);
      const tokenChanged=await readonly(()=>list(peer.db,{keyword:'510043'},{...actor,expiresAt:actor.expiresAt+1}));
      expect(tokenChanged.list[0].revision).not.toBe(first.list[0].revision);
      await f.db.update(userExtract).set({mark:''}).where(eq(userExtract.id,510043)); // same-value/ABA still changes xmin
      const sameValue=await readonly(()=>list(peer.db,{keyword:'510043'}));expect(sameValue.list[0].revision).not.toBe(first.list[0].revision);
      await f.db.update(systemAttachment).set({realName:'changed metadata'}).where(eq(systemAttachment.attId,560001));
      expect((await readonly(()=>list(peer.db,{keyword:'510043'}))).list[0].revision).not.toBe(sameValue.list[0].revision);
      const invalid=[{relationId:22},{type:1},{moduleType:2},{fileType:2},{imageType:1},{attDir:'/api/assets/0560001'},
        {name:'attachments/user/33/../secret.png'},{name:'attachments/user/33//secret.png'},
        {name:'attachments/user/33/secret.png.exe'},{name:'attachments/user/22/receipt.png'},{attType:'image/jpeg'}];
      for(const patch of invalid){await f.db.update(systemAttachment).set({type:3,relationId:33,moduleType:3,fileType:1,imageType:8,
        name:'attachments/user/33/withdrawal-qr.png',attDir:'/api/assets/560001',attType:'image/png',...patch}).where(eq(systemAttachment.attId,560001));
        expect((await readonly(()=>list(peer.db,{keyword:'510043'}))).list[0].media_available,JSON.stringify(patch)).toBe(false);}
      await f.db.update(systemAttachment).set({type:3,relationId:33,moduleType:3,fileType:1,imageType:8,
        name:'attachments/user/33/withdrawal-qr.png',attDir:'/api/assets/560001',attType:'image/png'}).where(eq(systemAttachment.attId,560001));
      for(const reference of ['/api/assets/9999999999','/api/assets/560001?signature=copied','https://foreign.invalid/qr.png','/api/assets/0560001']){
        await f.db.update(userExtract).set({qrcodeUrl:reference}).where(eq(userExtract.id,510043));
        expect((await readonly(()=>list(peer.db,{keyword:'510043'}))).list[0].media_available).toBe(false);
      }
    });
  },30000);

  it('rechecks live Admin/password/platform scope/current roles and expiry inside the read boundary',async()=>reader(async peer=>{
    for(const patch of [{status:0},{isDel:1},{adminType:4},{relationId:7},{level:-1},{level:10},{pwd:md5('changed')},{roles:''}]){
      await f.db.update(systemAdmin).set({pwd,roles:String(roleId),level:1,status:1,isDel:0,adminType:1,relationId:0,...patch}).where(eq(systemAdmin.id,adminId));
      await readonly(()=>expect(list(peer.db)).rejects.toThrow());
    }
    await f.db.update(systemAdmin).set({pwd,roles:String(roleId),level:1,status:1,isDel:0,adminType:1,relationId:0}).where(eq(systemAdmin.id,adminId));
    for(const patch of [{status:0},{type:2},{relationId:7},{rules:'user.view'}]){
      await f.db.update(systemRole).set({rules:'extract.view',status:1,type:0,relationId:0,...patch}).where(eq(systemRole.id,roleId));
      await readonly(()=>expect(list(peer.db)).rejects.toThrow());
    }
    await readonly(()=>expect(list(peer.db,{}, {...actor,expiresAt:Math.floor(Date.now()/1000)-1})).rejects.toThrow());
    await readonly(()=>expect(list(peer.db,{}, {...actor,authVersion:'0'.repeat(32)})).rejects.toThrow());
    await f.db.update(systemRole).set({rules:'extract.view',status:1,type:0,relationId:0}).where(eq(systemRole.id,roleId));
    expect((await readonly(()=>list(peer.db))).count).toBe(43);
    await f.db.update(systemAdmin).set({level:0,roles:''}).where(eq(systemAdmin.id,adminId));
    expect((await readonly(()=>list(peer.db))).count).toBe(43);
  }),30000);

  it('issues exact opt-in media DTO/900-second HMAC with no R2 read for deleted or missing historical users',async()=>{
    await seedQr();await seedQr(44,510004,560002);
    await reader(peer=>readonly(async()=>{
      for(const id of [510043,510004]){
        const row=await selected(peer.db,id);expect(row.media_available).toBe(true);
        const before=Math.floor(Date.now()/1000),dto=await media(peer.db,id,row.revision),after=Math.floor(Date.now()/1000);
        expect(Object.keys(dto).sort()).toEqual(['version','actor_id','id','revision','available','reference','preview','expires'].sort());
        expect(dto.version).toBe(1);expect(dto.actor_id).toBe(adminId);expect(dto.id).toBe(id);expect(dto.revision).toBe(row.revision);
        expect(dto.available).toBe(true);if(!dto.available)throw Error('Expected eligible metadata');
        expect(dto.reference).toBe('/api/assets/'+(id===510043?560001:560002));
        expect(dto.expires).toBeGreaterThanOrEqual(before+900);expect(dto.expires).toBeLessThanOrEqual(after+900);
        const url=new URL(dto.preview,'https://owned.local');expect(url.pathname).toBe(dto.reference);
        expect([...url.searchParams.keys()].sort()).toEqual(['expires','signature']);expect(url.hash).toBe('');
        expect(url.searchParams.get('expires')).toBe(String(dto.expires));
        expect(url.searchParams.get('signature')).toBe(createHmac('sha256',f.env.APP_KEY).update('GET\n'+dto.reference+'\n'+dto.expires).digest('base64url'));
        expect(io.get).not.toHaveBeenCalled();
      }
      const near={...actor,expiresAt:Math.floor(Date.now()/1000)+60},row=(await list(peer.db,{keyword:'510043'},near)).list[0];
      const dto=await media(peer.db,510043,row.revision,near);expect(dto.available).toBe(true);
      if(dto.available)expect(dto.expires).toBeGreaterThan(near.expiresAt); // Existing bearer policy, not an issuer-session lifetime guarantee.
    }));
  },30000);

  it('returns bounded unavailable media for missing/unsupported/foreign owner metadata and requires current row/attachment versions',async()=>{
    await seedQr();
    await reader(async peer=>{
      const first=await readonly(()=>selected(peer.db));
      const wrong=(first.revision[0]==='0'?'1':'0')+first.revision.slice(1);
      await readonly(()=>expect(media(peer.db,510043,wrong)).rejects.toMatchObject({code:409,httpStatus:409}));
      await f.db.update(userExtract).set({mark:''}).where(eq(userExtract.id,510043));
      await readonly(()=>expect(media(peer.db,510043,first.revision)).rejects.toMatchObject({code:409,httpStatus:409}));
      const rowChanged=await readonly(()=>selected(peer.db));
      await f.db.update(systemAttachment).set({realName:''}).where(eq(systemAttachment.attId,560001));
      await readonly(()=>expect(media(peer.db,510043,rowChanged.revision)).rejects.toMatchObject({code:409,httpStatus:409}));
      await f.db.update(systemAttachment).set({relationId:22}).where(eq(systemAttachment.attId,560001));
      const current=await readonly(()=>selected(peer.db));expect(current.media_available).toBe(false);
      expect(await readonly(()=>media(peer.db,510043,current.revision))).toEqual({version:1,actor_id:adminId,id:510043,
        revision:current.revision,available:false,reference:null,preview:null,expires:null});
      for(const patch of [{qrcodeUrl:''},{qrcodeUrl:'https://private-legacy.invalid/qr.png'},
        {qrcodeUrl:'/api/assets/560001?expires=1&signature=copied'},{qrcodeUrl:'/api/assets/0560001'},
        {qrcodeUrl:'/api/assets/9999999999'},{qrcodeUrl:'/api/assets/560099'},
        {extractType:'bank',qrcodeUrl:'/api/assets/560001'},{extractType:'old-unknown',qrcodeUrl:'/api/assets/560001'},
        {uid:0,qrcodeUrl:'/api/assets/560001'},{uid:-1,qrcodeUrl:'/api/assets/560001'}]){
        await f.db.update(systemAttachment).set({relationId:33}).where(eq(systemAttachment.attId,560001));
        await f.db.update(userExtract).set({uid:33,extractType:'weixin',...patch}).where(eq(userExtract.id,510043));
        const row=await readonly(()=>selected(peer.db));expect(row.media_available,JSON.stringify(patch)).toBe(false);
        const dto=await readonly(()=>media(peer.db,510043,row.revision));expect(dto).toEqual({version:1,actor_id:adminId,id:510043,
          revision:row.revision,available:false,reference:null,preview:null,expires:null});
        expect(JSON.stringify(dto)).not.toContain('private-legacy');
      }
      expect(await readonly(()=>media(peer.db,2147483647,'a'.repeat(64)))).toEqual({version:1,actor_id:adminId,id:2147483647,
        revision:'a'.repeat(64),available:false,reference:null,preview:null,expires:null});
      for(const id of [0,-1,2147483648])await readonly(()=>expect(media(peer.db,id,'a'.repeat(64))).rejects.toThrow());
      const revision=(await readonly(()=>selected(peer.db))).revision;
      await f.db.update(systemRole).set({rules:'user.view'}).where(eq(systemRole.id,roleId));
      await readonly(()=>expect(media(peer.db,510043,revision)).rejects.toThrow());
      await f.db.update(systemRole).set({rules:'extract.view'}).where(eq(systemRole.id,roleId));
      await f.db.update(systemAdmin).set({pwd:md5('changed-media-admin')}).where(eq(systemAdmin.id,adminId));
      await readonly(()=>expect(media(peer.db,510043,revision)).rejects.toThrow());
    });
  },30000);

  it('uses real HTTP409/media aliases and the generic signed GET for exact owned R2 bytes, with its existing bearer lifetime boundary',async()=>{
    await seedQr();
    await reader(application=>reader(async admin=>{
      const token=(await createToken(adminId,'admin',actor.authVersion,f.env.APP_KEY)).token;
      const env={...f.env,UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',ASSETS_BUCKET:io,
        CONFIG_KV:{get:io.get,put:io.put,delete:io.delete,list:io.list},ORDER_QUEUE:{send:io.queue,sendBatch:io.queue},
        SEQUENCE:{idFromName:io.sequence,get:io.sequence}} as unknown as Env;
      async function request(path:string,credential:string|null=token,method='GET'){
        const headers=new Headers();if(credential!==null)headers.set('Authori-zation','Bearer '+credential);
        const jobs:Promise<unknown>[]=[];
        const response=await wiring.context!.run({app:createContainerFromDb(application.db),admin:createContainerFromDb(admin.db)},
          ()=>app.fetch(new Request('https://owned.local'+path,{headers,method}),env,{waitUntil:(p:Promise<unknown>)=>jobs.push(p),passThroughOnException:()=>{}} as never));
        await Promise.all(jobs);return response;
      }
      async function json<T>(path:string,credential:string|null=token){const response=await request(path,credential);
        return{response,body:await response.json() as {status:number;msg:string;data:T|null}};}
      const path=(prefix:string,id:number,revision:string)=>prefix+'/extract/directory/'+id+'/media?revision='+revision;
      const selectedHttp=async()=>{const result=await json<AdminWithdrawalDirectoryDto>('/adminapi/extract/directory?keyword=510043');
        expect(result.body.status,result.body.msg).toBe(200);return result.body.data!.list[0];};
      let preview='';
      await readonly(async()=>{
        const row=await selectedHttp();
        for(const prefix of ['/adminapi','/api/admin']){
          const result=await json<AdminWithdrawalDirectoryMediaDto>(path(prefix,510043,row.revision));
          expect(result.response.status).toBe(200);expect(result.body.status,result.body.msg).toBe(200);
          expect(result.response.headers.get('cache-control')).toContain('no-store');expect(result.response.headers.get('pragma')).toBe('no-cache');
          expect(result.body.data?.available).toBe(true);if(!result.body.data?.available)throw Error('Expected owned historical metadata');
          expect(Object.keys(result.body.data).sort()).toEqual(['version','actor_id','id','revision','available','reference','preview','expires'].sort());
          preview=result.body.data.preview;expect(result.body.data.reference).toBe('/api/assets/560001');
          const wrong=(row.revision[0]==='0'?'1':'0')+row.revision.slice(1),stale=await json<null>(path(prefix,510043,wrong));
          expect(stale.response.status).toBe(409);expect(stale.body).toEqual({status:409,msg:'提现记录或收款码已变化，请刷新列表',data:null});
          for(const query of ['','revision=x','revision='+row.revision+'&uid=33','revision='+row.revision+'&revision='+row.revision])
            expect((await json<null>(prefix+'/extract/directory/510043/media?'+query)).body.status).toBe(400);
          for(const id of ['0','-1','01','2147483648','%35%31%30%30%34%33'])
            expect((await json<null>(prefix+'/extract/directory/'+id+'/media?revision='+row.revision)).body.status).toBe(400);
          const head=await request(path(prefix,510043,row.revision),token,'HEAD');expect(head.status).toBe(200);expect(await head.text()).toBe('');
          const opened=wiring.opens;expect((await json<null>(path(prefix,510043,row.revision),null)).body.status).not.toBe(200);expect(wiring.opens).toBe(opened);
        }
        expect(io.get).not.toHaveBeenCalled();
      });
      const png=pixelPng(),key='attachments/user/33/withdrawal-qr.png';let objectBytes=png;
      io.get.mockImplementation(async(requested:string,options?:unknown)=>{
        expect(requested).toBe(key);expect(options).toBeUndefined();
        return{size:objectBytes.length,body:new Response(new Uint8Array(objectBytes).buffer).body!,
          httpEtag:'"'+createHash('sha256').update(objectBytes).digest('hex')+'"',
          writeHttpMetadata(headers:Headers){headers.set('Content-Type','image/png');}};
      });
      expectedAssetReads++;
      await readonly(async()=>{
        const response=await request(preview,null);expect(response.status).toBe(200);expect(response.headers.get('Content-Type')).toBe('image/png');
        expect(response.headers.get('Content-Length')).toBe(String(png.length));expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(response.headers.get('ETag')).toBe('"'+createHash('sha256').update(png).digest('hex')+'"');
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
      },{get:1});
      await readonly(async()=>{
        const tampered=new URL(preview,'https://owned.local'),signature=tampered.searchParams.get('signature')!;
        tampered.searchParams.set('signature',(signature[0]==='A'?'B':'A')+signature.slice(1));
        expect((await request(tampered.pathname+tampered.search,null)).status).toBe(404);
        const expired=Math.floor(Date.now()/1000)-1,old='/api/assets/560001?expires='+expired+'&signature='+
          createHmac('sha256',f.env.APP_KEY).update('GET\n/api/assets/560001\n'+expired).digest('base64url');
        expect((await request(old,null)).status).toBe(404);
      });
      const row=await readonly(selectedHttp);
      await f.db.update(userExtract).set({mark:''}).where(eq(userExtract.id,510043));
      await readonly(async()=>expect((await json<null>(path('/adminapi',510043,row.revision))).response.status).toBe(409));
      const changed=await readonly(selectedHttp);
      await f.db.update(systemRole).set({rules:'user.view'}).where(eq(systemRole.id,roleId));
      await readonly(async()=>{const opened=wiring.opens;expect((await json<null>(path('/adminapi',510043,changed.revision))).body.status).not.toBe(200);expect(wiring.opens).toBe(opened);});
      // No immediate-revocation promise: a correctly issued 900-second bearer
      // asset URL uses the generic metadata+R2 boundary without rechecking Admin.
      expectedAssetReads++;
      await readonly(async()=>{const opened=wiring.opens,response=await request(preview,null);expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);expect(wiring.opens).toBe(opened);},{get:1});
      objectBytes=png.slice(0,1);expectedAssetReads++;
      await readonly(async()=>{const response=await request(preview,null);expect(response.status).toBe(200);expect(response.headers.get('Content-Length')).toBe('1');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(png.slice(0,1));},{get:1}); // Byte delivery is not browser image-decode proof.
      io.get.mockResolvedValueOnce(null);expectedAssetReads++;
      await readonly(async()=>{const response=await request(preview,null);expect(response.status).toBe(404);expect(await response.text()).toBe('');},{get:1});
    }));
  },30000);

  it('runs actual JWT/permission/controller on both route aliases using separate app/Admin SELECT-only LOGINs',async()=>reader(application=>reader(async admin=>{
    expect(application.role).not.toBe(admin.role);expect(application.pid).not.toBe(admin.pid);
    const token=(await createToken(adminId,'admin',actor.authVersion,f.env.APP_KEY)).token;
    const env={...f.env,UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',ASSETS_BUCKET:io,
      CONFIG_KV:{get:io.get,put:io.put,delete:io.delete,list:io.list},ORDER_QUEUE:{send:io.queue,sendBatch:io.queue},
      SEQUENCE:{idFromName:io.sequence,get:io.sequence}} as unknown as Env;
    async function get(path:string,credential:string|null=token,method='GET'){
      const headers=new Headers();if(credential!==null)headers.set('Authori-zation','Bearer '+credential);
      const jobs:Promise<unknown>[]=[];
      const response=await wiring.context!.run({app:createContainerFromDb(application.db),admin:createContainerFromDb(admin.db)},
        ()=>app.fetch(new Request('https://owned.local'+path,{headers,method}),env,{waitUntil:(p:Promise<unknown>)=>jobs.push(p),passThroughOnException:()=>{}} as never));
      await Promise.all(jobs);return{response,body:method==='HEAD'?null:await response.json() as {status:number;msg:string;data:AdminWithdrawalDirectoryDto|null}};
    }
    for(const prefix of ['/adminapi','/api/admin'])await readonly(async()=>{
      const result=await get(prefix+'/extract/directory?extract_type=wx');expect(result.body?.status,result.body?.msg).toBe(200);
      shape(result.body!.data!);expect(result.body!.data!.query.extract_type).toBe('weixin');expect(result.body!.data!.count).toBe(11);
      expect(result.response.headers.get('cache-control')).toContain('no-store');expect(result.response.headers.get('pragma')).toBe('no-cache');
      for(const query of ['uid=11','page=1&page=2','keyword=%FF','start=60','limit=100'])expect((await get(prefix+'/extract/directory?'+query)).body?.status).toBe(400);
      const head=await get(prefix+'/extract/directory',token,'HEAD');expect(head.response.status).toBe(200);expect(await head.response.text()).toBe('');
      const opened=wiring.opens;expect((await get(prefix+'/extract/directory',null)).body?.status).not.toBe(200);expect(wiring.opens).toBe(opened);
      const userToken=(await createToken(11,'api',md5('synthetic-user'),f.env.APP_KEY)).token;
      expect((await get(prefix+'/extract/directory',userToken)).body?.status).not.toBe(200);expect(wiring.opens).toBe(opened);
    });
    await f.db.update(systemRole).set({rules:'user.view'}).where(eq(systemRole.id,roleId));
    await readonly(async()=>{const opened=wiring.opens;expect((await get('/adminapi/extract/directory')).body?.status).not.toBe(200);expect(wiring.opens).toBe(opened);});
  })),30000);
});
