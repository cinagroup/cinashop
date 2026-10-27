import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { createHash,createHmac } from 'node:crypto';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { publicUserAvatars } from '@/services/user/UserProfilePublicAvatar';
import { resolvePublicUserAvatars,MAX_PUBLIC_USER_AVATARS } from '@/services/user/UserAvatarPolicy';
import { publicPinkAvatarPictures } from '@/services/activity/PinkAvatarMediaPolicy';
import { eq,sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb,type Container } from '@/lib/di';
import { user,systemConfig,systemAttachment,storePink,communityUser,communityRelevance,userFriends,userBrokerage,userExtract,systemUserLevel,storeCouponUser,userRelation,storeProductLog,storeProduct,storeProductReply,storeProductReplyComment } from '@/models/schema';
import { createToken,md5 } from '@/utils/jwt';
import { AttachmentService,adminAttachmentScope,supplierAttachmentScope,userAttachmentScope } from '@/services/system/AttachmentService';
import { CustomerProfileService,type ProfileField } from '@/services/user/CustomerProfileService';
import { financePostgres } from './helpers/financePostgres';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{if(!wiring.container)throw Error('Missing owned profile fixture');return wiring.container;}}));
type Row=Record<string,unknown>;
type Snapshot=Record<string,Row[]>;
type Rich={actor_uid:number;revision:string;version:string;profile:{uid:number;account:string;nickname:string;avatar:string;avatar_preview:string;phone:string;register_extend_info:ProfileField[];extend_info:Row[]}};
type Envelope={status:number;msg:string;data:unknown};
const password=md5('owned-profile-password'),sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const history=[{info:'隐藏字段',param:'',format:'text',value:'保留秘密',extra:{sentinel:42}},{info:'已移除字段',value:'历史不能丢'},{info:'自定义数值',value:12.5,legacy:'unchanged'}];
const field=(info:string,format:string,param='',extra:Row={})=>({info,format,param,label:info,tip:'请填写'+info,single:'',singlearr:format==='radio'?['男','女','保密']:[],required:0,use:1,user_show:1,sort:1,...extra});
const template=[field('姓名','text','real_name'),field('性别','radio','sex'),field('生日','date','birthday'),field('身份证','id','card_id'),field('地址','address','address'),field('备注','text','mark'),field('自定义数值','num'),field('联系邮箱','mail'),field('联系手机','phone'),field('颜色','radio','',{singlearr:['红','绿','蓝']}),field('隐藏字段','text','',{user_show:0})];
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2P4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));

describe('customer profile actual registered HTTP and owned SQL contract',()=>{
  let f:Awaited<ReturnType<typeof financePostgres>>,env:Env,app:ReturnType<typeof createApp>,tables:string[],sequences:string[];
  const tokens=new Map<string,string>(),objects=new Map<string,{bytes:Uint8Array;type:string}>(),requests:Row[]=[];
  const bucket={
    put:vi.fn(async(key:string,stream:ReadableStream<Uint8Array>,options:{httpMetadata?:{contentType?:string}})=>{const bytes=new Uint8Array(await new Response(stream).arrayBuffer());objects.set(key,{bytes,type:options.httpMetadata?.contentType??'image/png'});return{size:bytes.length};}),
    get:vi.fn(async(key:string)=>{const value=objects.get(key);return value?{body:new Response(value.bytes).body,size:value.bytes.length,httpEtag:'"owned-profile"',httpMetadata:{contentType:value.type},writeHttpMetadata:(headers:Headers)=>headers.set('Content-Type',value.type)}:null;}),
    head:vi.fn(async()=>{throw Error('unexpected profile object head');}),list:vi.fn(async()=>{throw Error('unexpected profile object list');}),delete:vi.fn(async()=>{throw Error('unexpected profile object delete');})
  };
  const queue={send:vi.fn(async()=>{throw Error('unexpected profile queue');}),sendBatch:vi.fn(async()=>{throw Error('unexpected profile queue batch');})};
  beforeAll(async()=>{
    const orm=[user,systemConfig,systemAttachment,storePink,communityUser,communityRelevance,userFriends,userBrokerage,userExtract,systemUserLevel,storeCouponUser,userRelation,storeProductLog,storeProduct,storeProductReply,storeProductReplyComment];
    f=await financePostgres(orm,{namespace:'public'});
    env={APP_KEY:'owned-profile-jwt-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',ASSETS_BUCKET:bucket,ORDER_QUEUE:queue} as unknown as Env;
    wiring.container=createContainerFromDb(f.db);app=createApp();
    tables=(await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(v=>v.name);
    sequences=(await f.db.execute<{name:string}>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(v=>v.name);
    expect(tables).toEqual(orm.map(table=>getTableConfig(table).name).sort());
    expect(sequences).toEqual(orm.flatMap(table=>{const config=getTableConfig(table);return config.columns.filter(column=>column.getSQLType()==='serial').map(column=>`${config.name}_${column.name}_seq`);}).sort());
    for(const [name,uid,realm]of [['mine',11,'api'],['other',22,'api'],['disabled',33,'api'],['deleted',44,'api'],['stale',55,'api'],['wrong-realm',11,'admin']]as const)tokens.set(name,(await createToken(uid,realm,md5(password),env.APP_KEY)).token);
    tokens.set('guest','');
  },30000);
  beforeEach(async()=>{
    await f.reset();objects.clear();for(const operation of [...Object.values(bucket),...Object.values(queue)])operation.mockClear();
    await f.db.insert(user).values([{uid:11,account:'profile-owner',pwd:password,nickname:'原昵称',phone:'13800138000',avatar:'/static/logo.png',realName:'旧姓名',sex:2,birthday:946656000,cardId:'110101199001011234',addres:'旧地址',mark:'旧备注',extendInfo:JSON.stringify(history),levelExtendInfo:'[{"sentinel":1}]',nowMoney:'12.50',integral:7},
      {uid:22,account:'profile-other',pwd:password,nickname:'他人昵称'},{uid:33,account:'profile-disabled',pwd:password,status:0},{uid:44,account:'profile-deleted',pwd:password,isDel:1},{uid:55,account:'profile-stale',pwd:md5('changed-password')}]);
    await f.db.insert(systemConfig).values([{menuName:'user_extend_info',value:JSON.stringify(template),sort:10},{menuName:'user_extend_info',value:'[]',sort:0},{menuName:'user_extend_info',value:'[]',sort:99,isStore:1},{menuName:'community_status',value:'1'}]);
    await f.db.insert(systemAttachment).values([
      {attId:101,type:3,relationId:11,moduleType:3,fileType:1,imageType:8,name:'attachments/user/11/avatar.png',attDir:'/api/assets/101',attType:'image/png'},
      {attId:102,type:3,relationId:22,moduleType:3,fileType:1,imageType:8,name:'attachments/user/22/avatar.png',attDir:'/api/assets/102',attType:'image/png'},
      {attId:103,type:3,relationId:11,moduleType:4,fileType:1,imageType:8,name:'attachments/tourist/11/avatar.png',attDir:'/api/assets/103',attType:'image/png'},
      {attId:104,...supplierAttachmentScope(11),fileType:1,imageType:8,name:'attachments/supplier/11/avatar.png',attDir:'/api/assets/104',attType:'image/png'},
      {attId:105,type:0,relationId:0,moduleType:1,fileType:1,imageType:8,name:'attachments/admin/1/avatar.png',attDir:'/api/assets/105',attType:'image/png'},
      {attId:106,...adminAttachmentScope(),fileType:1,imageType:8,name:'attachments/admin/1/real-platform.png',attDir:'/api/assets/106',attType:'image/png'}]);
    await f.db.insert(storePink).values({uid:11,status:2,isRefund:0});
  },30000);
  afterAll(async()=>{try{expect(requests.length).toBeGreaterThan(0);expect(queue.send).not.toHaveBeenCalled();expect(queue.sendBatch).not.toHaveBeenCalled();}finally{wiring.container=undefined;tokens.clear();await f?.close();}},30000);
  async function snapshot():Promise<Snapshot>{const value:Snapshot={};for(const table of tables)value[table]=(await f.db.execute<{row:Row}>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(table)} t ORDER BY to_jsonb(t)::text`)).map(v=>v.row);value.__sequences=await f.db.execute<Row>(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));return value;}
  const resources=()=>({objects:[...objects].map(([key,v])=>({key,sha:sha(v.bytes),type:v.type})),calls:Object.fromEntries(Object.entries(bucket).map(([key,op])=>[key,op.mock.calls.length])),queue:queue.send.mock.calls.length});
  async function request(path:string,body?:unknown,actor='mine',readonly=true,rawBody?:string){
    const before=await snapshot(),resourceBefore=resources(),rawRequest=rawBody??(body===undefined?'':JSON.stringify(body));
    const response=await app.fetch(new Request('https://owned-profile.local'+path,{method:body===undefined&&rawBody===undefined?'GET':'POST',headers:{...(tokens.get(actor)?{'Authori-zation':'Bearer '+tokens.get(actor)}:{}),'Content-Type':'application/json'},...(body!==undefined||rawBody!==undefined?{body:rawRequest}:{})}),env);
    const raw=await response.text(),diagnostic=JSON.stringify({path,actor,http:response.status,raw,sha:sha(raw)});requests.push({path,actor,request_sha:sha(rawRequest),http:response.status,body_sha:sha(raw)});
    expect(response.status,diagnostic).toBe(200);expect(response.headers.get('content-type'),diagnostic).toContain('application/json');
    expect(await resources(),diagnostic).toEqual(resourceBefore);if(readonly)expect(await snapshot(),diagnostic).toEqual(before);
    const envelope=JSON.parse(raw)as Envelope;return{...envelope,before,after:await snapshot(),response};
  }
  async function rich(){const read=await request('/api/user/info?profile=1');expect(read.status,read.msg).toBe(200);expect(read.response.headers.get('cache-control')).toContain('no-store');return read.data as Rich;}
  const payload=(read:Rich,edits:Record<string,string|number>={})=>({profile:1,revision:read.revision,version:read.version,nickname:read.profile.nickname,avatar:read.profile.avatar,extend_info:read.profile.register_extend_info.map(v=>({info:v.info,value:Object.hasOwn(edits,v.info)?edits[v.info]!:v.value}))});
  const mine=(state:Snapshot)=>state.user!.find(v=>v.uid===11)!;
  function onlyUserDelta(before:Snapshot,after:Snapshot,keys:string[]){expect(Object.keys(after)).toEqual(Object.keys(before));for(const key of Object.keys(before))if(key!=='user')expect(after[key],key).toEqual(before[key]);expect(after.user!.filter(v=>v.uid!==11)).toEqual(before.user!.filter(v=>v.uid!==11));const a=mine(before),b=mine(after);expect(Object.keys(a).filter(key=>JSON.stringify(a[key])!==JSON.stringify(b[key])).sort()).toEqual(keys.sort());}
  function ticket(value:string,path:string){const url=new URL(value,'https://owned-profile.local'),expires=Number(url.searchParams.get('expires'));expect(url.pathname).toBe(path);expect([...url.searchParams.keys()].sort()).toEqual(['expires','signature']);expect(expires).toBeGreaterThan(Math.floor(Date.now()/1000));expect(expires).toBeLessThanOrEqual(Math.floor(Date.now()/1000)+900);expect(url.searchParams.get('signature')).toBe(createHmac('sha256',env.APP_KEY).update(`GET\n${path}\n${expires}`).digest('base64url'));}
  it('preserves exact legacy DTO and opts into all8 formats with authoritative built-in columns and custom stored values',async()=>{
    const old=await request('/api/user/info');expect(old.status).toBe(200);expect(Object.keys(old.data as Row).sort()).toEqual(['uid','account','nickname','avatar','phone','now_money','integral','brokerage_price','spread_count','spread_uid','is_promoter'].sort());
    const value=await rich();expect(value.actor_uid).toBe(11);expect(value.profile.uid).toBe(11);expect(value.profile.avatar).toBe('/static/logo.png');expect(value.profile.avatar_preview).toBe('/static/logo.png');
    expect(new Set(value.profile.register_extend_info.map(v=>v.format))).toEqual(new Set(['text','num','date','radio','id','mail','phone','address']));
    expect(value.profile.register_extend_info.map(v=>[v.info,v.value])).toEqual([['姓名','旧姓名'],['性别','1'],['生日','2000-01-01'],['身份证','110101199001011234'],['地址','旧地址'],['备注','旧备注'],['自定义数值','12.5'],['联系邮箱',''],['联系手机',''],['颜色','']]);
    expect(value.profile.extend_info).toEqual(history);expect(value.revision).toMatch(/^[a-f0-9]{64}$/);expect(value.version).toMatch(/^[a-f0-9]{64}$/);
  });
  it('modern no-op leaves every whole row/sequence/resource and raw stored extension bytes unchanged',async()=>{const value=await rich(),result=await request('/api/user/edit',payload(value));expect(result.status,result.msg).toBe(200);expect(result.data).toBeNull();expect(mine(result.after).extend_info).toBe(JSON.stringify(history));});
  it('preserves whitespace, same-date nonmidnight timestamp, original numeric/custom metadata and long unchanged legacy values in no-op or nickname-only saves',async()=>{
    const extended=[...history,{info:'联系邮箱',value:'x'.repeat(3000),legacy:'invalid-long-but-not-edited'}];
    await f.db.update(user).set({realName:' 空格姓名 ',birthday:946684800,extendInfo:JSON.stringify(extended)}).where(eq(user.uid,11));
    const data=await rich();expect(data.profile.register_extend_info.find(v=>v.info==='生日')?.value).toBe('2000-01-01');
    expect((await request('/api/user/edit',payload(data))).status).toBe(200);
    const body=payload(data);body.nickname='仅改昵称';const result=await request('/api/user/edit',body,'mine',false);expect(result.status,result.msg).toBe(200);onlyUserDelta(result.before,result.after,['nickname']);expect(mine(result.after).extend_info).toBe(JSON.stringify(extended));expect(mine(result.after).real_name).toBe(' 空格姓名 ');expect(mine(result.after).birthday).toBe(946684800);
    expect((await request('/api/user/edit',payload(await rich(),{'联系邮箱':'y'.repeat(1025)}))).status).toBe(400);
  });
  it('still enforces required fields even when the original required value is empty',async()=>{
    const required=template.map(definition=>definition.param==='real_name'?{...definition,required:1}:definition);await f.db.update(systemConfig).set({value:JSON.stringify(required)}).where(eq(systemConfig.sort,10));await f.db.update(user).set({realName:''}).where(eq(user.uid,11));expect((await request('/api/user/edit',payload(await rich()))).status).toBe(400);
  });
  it('saves all8 formats and exact6 standard columns atomically while preserving hidden/removed metadata and level activation data',async()=>{
    const value=await rich(),body=payload(value,{'姓名':'新姓名','性别':'0','生日':'1999-12-31','身份证':'11010119900101123X','地址':'新地址','备注':'新备注','自定义数值':'0012.50','联系邮箱':'a@example.invalid','联系手机':'13900139000','颜色':'2'});body.nickname='资料新昵称';body.avatar='/api/assets/101?expires=1&signature=old';
    const result=await request('/api/user/edit',body,'mine',false);expect(result.status,result.msg).toBe(200);onlyUserDelta(result.before,result.after,['nickname','avatar','real_name','sex','birthday','card_id','addres','mark','extend_info']);
    const account=mine(result.after);expect(account.avatar).toBe('/api/assets/101');expect(account.birthday).toBe(946569600);expect(account.sex).toBe(1);expect(account.level_extend_info).toBe('[{"sentinel":1}]');const saved=JSON.parse(account.extend_info as string)as Row[];expect(saved.slice(0,2)).toEqual(history.slice(0,2));expect(saved.find(v=>v.info==='自定义数值')).toEqual({...history[2],value:'0012.50'});
    const after=await rich();ticket(after.profile.avatar_preview,'/api/assets/101');expect(after.version).not.toBe(value.version);expect(after.revision).toBe(value.revision);expect(after.profile.register_extend_info.find(v=>v.info==='颜色')?.value).toBe('2');
    const legacy=await request('/api/user/info');ticket((legacy.data as Row).avatar as string,'/api/assets/101');
    const pink=await request('/api/pink',undefined,'guest');expect(pink.status,pink.msg).toBe(200);expect((pink.data as {pink_count:number}).pink_count).toBe(1);ticket((pink.data as {avatars:string[]}).avatars[0]!,'/api/assets/101');
    const alias=await request('/api/userinfo');expect(alias.status,alias.msg).toBe(200);ticket((alias.data as Row).avatar as string,'/api/assets/101');
    const social=await request('/api/community/user_info/11');expect(social.status,social.msg).toBe(200);ticket((social.data as Row).author_image as string,'/api/assets/101');ticket((social.data as Row).avatar as string,'/api/assets/101');
  });
  it('allows legacy avatar-only/nickname-only patches and empty optional avatar compatibility without clearing unknown stored data',async()=>{
    for(const body of [{avatar:'/api/assets/101'},{nickname:'局部昵称',avatar:''},{nickname:'',avatar:'/api/assets/101'}]){const result=await request('/api/user/edit',body,'mine',false);expect(result.status,result.msg).toBe(200);const changed=Object.keys(mine(result.before)).filter(k=>JSON.stringify(mine(result.before)[k])!==JSON.stringify(mine(result.after)[k]));expect(changed.every(k=>['nickname','avatar'].includes(k))).toBe(true);onlyUserDelta(result.before,result.after,changed);}
  });
  it.each(['/api/assets/102','/api/assets/103','/api/assets/104','/api/assets/105','/api/assets/106','/api/assets/2147483647','https://untrusted.example.invalid/new.png','/static/copied.png'])('rejects replacement avatar outside exact own uploaded image scope: %s',async avatar=>{const value=await rich(),body=payload(value);body.avatar=avatar;const result=await request('/api/user/edit',body);expect(result.status,result.msg).toBe(400);});
  it.each([{moduleType:4},{relationId:22},{fileType:2},{imageType:1},{attDir:'/api/assets/999'},{name:'attachments/user/11/../22/avatar.png'},{attType:'image/jpeg'},{attType:''}])('rejects raster namespace/metadata mutation atomically: %j',async patch=>{await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId,101));const body=payload(await rich());body.avatar='/api/assets/101';expect((await request('/api/user/edit',body)).status).toBe(400);});
  it('rejects stale profile and template revisions without overwriting a concurrent change',async()=>{
    const value=await rich();await f.db.update(user).set({nickname:'后台新值'}).where(eq(user.uid,11));expect((await request('/api/user/edit',payload(value))).status).toBe(409);
    const fresh=await rich();await f.db.update(systemConfig).set({value:JSON.stringify([...template,field('新资料','text')])}).where(eq(systemConfig.sort,10));expect((await request('/api/user/edit',payload(fresh))).status).toBe(409);
  });
  it('serializes two actual same-version HTTP writes: exactly one winner and one409, no silent lost update',async()=>{
    const original=await rich(),a=payload(original),b=payload(original);a.nickname='并发A';b.nickname='并发B';const before=await snapshot(),resourceBefore=resources();
    const replies=await Promise.all([a,b].map(async body=>{const raw=JSON.stringify(body),response=await app.fetch(new Request('https://owned-profile.local/api/user/edit',{method:'POST',headers:{'Authori-zation':'Bearer '+tokens.get('mine'),'Content-Type':'application/json'},body:raw}),env);expect(response.status).toBe(200);const text=await response.text();requests.push({path:'/api/user/edit',actor:'mine',request_sha:sha(raw),http:response.status,body_sha:sha(text)});return JSON.parse(text)as Envelope;}));
    expect(replies.map(v=>v.status).sort()).toEqual([200,409]);const after=await snapshot();onlyUserDelta(before,after,['nickname']);expect(mine(after).nickname).toBe(replies[0]!.status===200?'并发A':'并发B');expect(resources()).toEqual(resourceBefore);
  });
  it('round-trips actual Shanghai DST and pre1970 birthdays against independent PostgreSQL timezone expressions',async()=>{
    for(const date of ['1990-07-01','1960-01-02','2038-01-19']){
      const body=payload(await rich(),{'生日':date}),result=await request('/api/user/edit',body,'mine',false);expect(result.status,result.msg).toBe(200);onlyUserDelta(result.before,result.after,['birthday','extend_info']);
      const [oracle]=await f.db.execute<{stamp:number;text:string}>(sql`SELECT extract(epoch FROM (${date}::timestamp AT TIME ZONE 'Asia/Shanghai'))::integer AS stamp,to_char(to_timestamp(${mine(result.after).birthday}::integer) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS text`);
      expect(mine(result.after).birthday).toBe(oracle!.stamp);expect(oracle!.text).toBe(date);expect((await rich()).profile.register_extend_info.find(v=>v.param==='birthday')?.value).toBe(date);
    }
    for(const date of ['1919-04-13','2038-01-20','1900-01-01'])expect((await request('/api/user/edit',payload(await rich(),{'生日':date}))).status).toBe(400);
  });
  it('does not conflict on unrelated financial balance updates and keeps an absent template/stored data intact',async()=>{
    const read=await rich();await f.db.update(user).set({nowMoney:'99.99'}).where(eq(user.uid,11));expect((await request('/api/user/edit',payload(read))).status).toBe(200);
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName,'user_extend_info'));const missing=await rich();expect(missing.profile.register_extend_info).toEqual([]);const body=payload(missing);body.nickname='无模板昵称';const result=await request('/api/user/edit',body,'mine',false);expect(result.status).toBe(200);onlyUserDelta(result.before,result.after,['nickname']);expect(mine(result.after).extend_info).toBe(JSON.stringify(history));
  });
  it.each(['guest','wrong-realm','disabled','deleted','stale'])('rejects %s using actual registered middleware with zero writes',async actor=>{for(const path of ['/api/user/info','/api/user/info?profile=1'])expect((await request(path,undefined,actor)).status).not.toBe(200);expect((await request('/api/user/edit',{nickname:'禁止'},actor)).status).not.toBe(200);});
  it('rechecks password/live-user at the write service boundary rather than trusting the earlier auth object',async()=>{const before=await snapshot();await expect(new CustomerProfileService(wiring.container!,env).edit({uid:55,pwd:password},{nickname:'不允许'})).rejects.toThrow('登录');expect(await snapshot()).toEqual(before);});
  it.each(['?profile=0','?profile=1&profile=1','?profile=01'])('rejects malformed or repeated explicit profile flag: %s',async query=>{expect((await request('/api/user/info'+query)).status).toBe(400);});
  it.each(['{"nickname":"a","nickname":"b"}','{"nickname":"a","\\u006eickname":"b"}','{"profile":1,"extend_info":[{"info":"x","value":"a","value":"b"}]}','[]','null','{"nickname":"x","uid":22}','{"nickname":"x","phone":"13900000000"}','{"nickname":"x","level":9}','{"nickname":"12345678901234567"}','{"nickname":""}','{}'])('rejects malformed/extra/duplicate keys and empty edits without mutation: %s',async raw=>{expect((await request('/api/user/edit',undefined,'mine',true,raw)).status).toBe(400);});
  it('rejects oversized body, wrong required/format values and partial or duplicated modern fields atomically',async()=>{
    expect((await request('/api/user/edit',undefined,'mine',true,'{"nickname":"'+ 'x'.repeat(66000)+'"}')).status).toBe(400);
    const invalidEdits:Record<string,string|number>[]=[{'联系邮箱':'bad'},{'联系手机':'12'},{'生日':'2026-02-30'},{'生日':'2100-01-01'},{'身份证':'abc'},{'自定义数值':'-1'},{'颜色':'3'}];
    for(const edits of invalidEdits)expect((await request('/api/user/edit',payload(await rich(),edits))).status).toBe(400);
    const body=payload(await rich());body.extend_info.pop();expect((await request('/api/user/edit',body)).status).toBe(400);const dup=payload(await rich());dup.extend_info.push(dup.extend_info[0]!);expect((await request('/api/user/edit',dup)).status).toBe(400);
  });
  it.each(['broken','[{"info":"未知","format":"unknown"}]',JSON.stringify([...template,template[0]]),JSON.stringify([...template,field('第二姓名','text','real_name')])])('diagnoses invalid/ambiguous template instead of silently dropping fields: %s',async value=>{await f.db.update(systemConfig).set({value}).where(eq(systemConfig.sort,10));expect((await request('/api/user/info?profile=1')).status).toBe(400);expect((await request('/api/user/info')).status).toBe(200);});
  it('resolves complete mixed-owner batches using one real metadata read, preserves Pink3 budget, and atomically rejects overflow',async()=>{
    const before=await snapshot(),resourceBefore=resources(),select=vi.spyOn(f.db,'select');
    try{
      const images=await resolvePublicUserAvatars(f.db,[{uid:11,image:'/api/assets/101'},{uid:22,image:'/api/assets/101'},{uid:22,image:'/api/assets/102'},{uid:11,image:'/api/assets/103'},{uid:11,image:'/api/assets/104'},{uid:11,image:'/api/assets/105'},{uid:11,image:'/api/assets/106'},{uid:11,image:'/static/logo.png'}]);
      expect(images).toEqual(['/api/assets/101','','/api/assets/102','','','','/api/assets/106','/static/logo.png']);expect(select).toHaveBeenCalledTimes(1);
      const overflow=Array.from({length:MAX_PUBLIC_USER_AVATARS+1},()=>({uid:11,image:'/api/assets/101'}));await expect(resolvePublicUserAvatars(f.db,overflow)).rejects.toThrow('容量');expect(select).toHaveBeenCalledTimes(1);
      await expect(publicPinkAvatarPictures(f.db,overflow.slice(0,4))).rejects.toThrow('容量');expect(select).toHaveBeenCalledTimes(1);
    }finally{select.mockRestore();}expect(await snapshot()).toEqual(before);expect(resources()).toEqual(resourceBefore);
  });
  it('keeps actual legacy relative/static/HTTPS consumer values unchanged while resolving canonical capabilities against authoritative scopes',async()=>{
    const values=[{uid:11,image:'account-11.svg'},{uid:11,image:'/static/logo.png'},{uid:11,image:'https://cdn.example.invalid/avatar.png'},{uid:11,image:'/api/assets/101'},{uid:11,image:'/api/assets/106'},{uid:11,image:'/api/assets/102'}],before=await snapshot(),resourceBefore=resources();
    const result=await publicUserAvatars(f.db,env.APP_KEY,values);expect(result.slice(0,3)).toEqual(values.slice(0,3).map(value=>value.image));ticket(result[3]!,'/api/assets/101');ticket(result[4]!,'/api/assets/106');expect(result[5]).toBe('');expect(await snapshot()).toEqual(before);expect(resources()).toEqual(resourceBefore);
  });
  it('uploads using the real AttachmentService then saves and exposes the same own raster through profile and actual public pink DTO/asset HTTP',async()=>{
    const upload=await new AttachmentService(wiring.container!,env).uploadImage(userAttachmentScope(11),new File([png],'avatar.png',{type:'image/png'}),0);
    const body=payload(await rich());body.avatar=upload.url;expect((await request('/api/user/edit',body,'mine',false)).status).toBe(200);
    const value=await rich();ticket(value.profile.avatar_preview,upload.url);
    const publicValue=await request('/api/pink',undefined,'guest');const image=(publicValue.data as {avatars:string[]}).avatars[0]!;ticket(image,upload.url);
    const before=await snapshot(),response=await app.fetch(new Request('https://owned-profile.local'+image),env);expect(response.status).toBe(200);expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);expect(await snapshot()).toEqual(before);
  });
  function onlyReviewViewDelta(before:Snapshot,after:Snapshot,id:number){
    const expected=structuredClone(before),row=expected.store_product_reply!.find(value=>value.id===id)!;
    row.views_num=Number(row.views_num)+1;expect(after).toEqual(expected);
  }
  it('adopts a truly uploaded own avatar through registered DIY, nested review comments and review detail without changing stored snapshots',async()=>{
    const upload=await new AttachmentService(wiring.container!,env).uploadImage(userAttachmentScope(11),new File([png],'avatar.png',{type:'image/png'}),0);
    const body=payload(await rich());body.avatar=upload.url;expect((await request('/api/user/edit',body,'mine',false)).status).toBe(200);
    await f.db.insert(storeProduct).values({id:601,storeName:'头像评价商品'});
    await f.db.insert(storeProductReply).values({id:71,productId:601,uid:11,avatar:upload.url,nickname:'评价快照',comment:'本人评价',viewsNum:5});
    await f.db.insert(storeProductReplyComment).values([{id:81,replyId:71,uid:11,avatar:'/static/previous.png',content:'实际根回复'},
      {id:82,replyId:71,pid:81,uid:11,avatar:'/static/previous-child.png',content:'实际子回复'}]);
    const diy=await request('/api/diy/user_info');expect(diy.status,diy.msg).toBe(200);ticket((diy.data as {avatar:string}).avatar,upload.url);
    const comments=await request('/api/reply/comment/71',undefined,'guest');expect(comments.status,comments.msg).toBe(200);
    const roots=comments.data as Array<{id:number;user:{avatar:string};children:{id:number;user:{avatar:string}}|null}>;
    expect(roots.map(value=>value.id)).toEqual([81]);ticket(roots[0]!.user.avatar,upload.url);expect(roots[0]!.children!.id).toBe(82);ticket(roots[0]!.children!.user.avatar,upload.url);
    const detail=await request('/api/reply/info/71',undefined,'mine',false);expect(detail.status,detail.msg).toBe(200);
    const data=detail.data as {reply:{avatar:string;views_num:number;pics:unknown};user:{avatar:string}};
    ticket(data.reply.avatar,upload.url);ticket(data.user.avatar,upload.url);expect(data.reply.views_num).toBe(5);expect(data.reply.pics).toEqual([]);
    onlyReviewViewDelta(detail.before,detail.after,71);
    const before=await snapshot(),response=await app.fetch(new Request('https://owned-profile.local'+data.reply.avatar),env);
    expect(response.status).toBe(200);expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);expect(await snapshot()).toEqual(before);
    expect((await f.db.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.id,81)))[0]!.avatar).toBe('/static/previous.png');
  });
  it('rejects copied foreign avatar capabilities per persisted author UID while retaining UID0 platform review media and its original view delta',async()=>{
    await f.db.update(user).set({avatar:'/api/assets/102'}).where(eq(user.uid,11));
    await f.db.insert(storeProduct).values({id:601,storeName:'头像归属商品'});
    await f.db.insert(storeProductReply).values([{id:71,productId:601,uid:11,avatar:'/api/assets/102',nickname:'外人图快照',viewsNum:3},
      {id:72,productId:601,uid:0,type:0,relationId:0,avatar:'/api/assets/106',nickname:'平台评价',viewsNum:7,pics:'["/static/review.png"]'}]);
    await f.db.insert(storeProductReplyComment).values([{id:81,replyId:71,uid:11,avatar:'/api/assets/102',content:'外人图根回复'},
      {id:82,replyId:71,pid:81,uid:22,avatar:'/api/assets/102',content:'本人图子回复'}]);
    const diy=await request('/api/diy/user_info');expect(diy.status,diy.msg).toBe(200);expect((diy.data as {avatar:string}).avatar).toBe('');
    const comments=await request('/api/reply/comment/71',undefined,'guest');expect(comments.status,comments.msg).toBe(200);
    const roots=comments.data as Array<{user:{avatar:string};children:{user:{avatar:string}}|null}>;
    expect(roots[0]!.user.avatar).toBe('');ticket(roots[0]!.children!.user.avatar,'/api/assets/102');
    const copied=await request('/api/reply/info/71',undefined,'mine',false);expect(copied.status,copied.msg).toBe(200);
    expect((copied.data as {reply:{avatar:string};user:{avatar:string}}).reply.avatar).toBe('');expect((copied.data as {user:{avatar:string}}).user.avatar).toBe('');onlyReviewViewDelta(copied.before,copied.after,71);
    const platform=await request('/api/reply/info/72',undefined,'mine',false);expect(platform.status,platform.msg).toBe(200);
    const data=platform.data as {reply:{avatar:string;pics:unknown;views_num:number}};ticket(data.reply.avatar,'/api/assets/106');expect(data.reply.pics).toEqual(['/static/review.png']);expect(data.reply.views_num).toBe(7);onlyReviewViewDelta(platform.before,platform.after,72);
  });
  it.each(['/static/logo.png','/api/assets/101'])('preserves a complete large reply tree with more than1000 repeated avatar identities: %s',async avatar=>{
    await f.db.update(user).set({avatar}).where(eq(user.uid,11));
    await f.db.insert(storeProductReply).values({id:71,uid:11,nickname:'根评价',comment:'完整子回复预算'});
    await f.db.insert(storeProductReplyComment).values([{id:81,replyId:71,uid:11,content:'根回复'},
      ...Array.from({length:1002},(_,index)=>({id:8200+index,replyId:71,pid:81,uid:11,content:'重复身份子回复'+index,addTime:index+1}))]);
    const response=await request('/api/reply/comment/71',undefined,'guest');expect(response.status,response.msg).toBe(200);
    const roots=response.data as Array<{id:number;user:{avatar:string};children:{id:number;user:{avatar:string}}|null}>;
    expect(roots).toHaveLength(1);expect(roots[0]!.id).toBe(81);expect(roots[0]!.children!.id).toBe(9201);
    if(avatar.startsWith('/api/assets/')){ticket(roots[0]!.user.avatar,avatar);ticket(roots[0]!.children!.user.avatar,avatar);}
    else{expect(roots[0]!.user.avatar).toBe(avatar);expect(roots[0]!.children!.user.avatar).toBe(avatar);}
    // The existing API intentionally exposes only the first ordered child;
    // all1002 persisted children remain present and the HTTP read is zero-write.
    expect(response.after.store_product_reply_comment).toHaveLength(1003);
  });
  it('does not authorize or impose a new media budget on more than1000 undisplayed distinct private child references',async()=>{
    await f.db.update(user).set({avatar:'/api/assets/101'}).where(eq(user.uid,11));
    await f.db.insert(storeProductReply).values({id:71,uid:11,comment:'只投影首个排序子回复'});
    await f.db.insert(storeProductReplyComment).values([{id:81,replyId:71,uid:11,content:'根回复'},
      ...Array.from({length:1002},(_,index)=>({id:8200+index,replyId:71,pid:81,uid:index===1001?22:1000+index,
        avatar:index===1001?'/api/assets/102':'/api/assets/'+(100000+index),content:'未展示字段不授权'+index,addTime:index+1}))]);
    const response=await request('/api/reply/comment/71',undefined,'guest');expect(response.status,response.msg).toBe(200);
    const roots=response.data as Array<{id:number;user:{avatar:string};children:{id:number;user:{avatar:string}}|null}>;
    expect(roots).toHaveLength(1);ticket(roots[0]!.user.avatar,'/api/assets/101');expect(roots[0]!.children!.id).toBe(9201);ticket(roots[0]!.children!.user.avatar,'/api/assets/102');
    expect(response.after.store_product_reply_comment).toHaveLength(1003);
  });
  it.each(['  历史 空格昵称  ','历'.repeat(20)])('preserves an unchanged historical nickname through full no-op, avatar-only and field-only modern saves: %s',async nickname=>{
    await f.db.update(user).set({nickname}).where(eq(user.uid,11));
    const initial=await rich();expect(initial.profile.nickname).toBe(nickname);
    const noop=await request('/api/user/edit',payload(initial));expect(noop.status,noop.msg).toBe(200);
    const avatar=payload(await rich());avatar.avatar='/api/assets/101';const saved=await request('/api/user/edit',avatar,'mine',false);
    expect(saved.status,saved.msg).toBe(200);onlyUserDelta(saved.before,saved.after,['avatar']);expect(mine(saved.after).nickname).toBe(nickname);
    const field=await request('/api/user/edit',payload(await rich(),{'姓名':'仅修改姓名'}),'mine',false);
    expect(field.status,field.msg).toBe(200);onlyUserDelta(field.before,field.after,['real_name','extend_info']);expect(mine(field.after).nickname).toBe(nickname);
    const changed=payload(await rich());changed.nickname=' 新昵称 ';const renamed=await request('/api/user/edit',changed,'mine',false);
    expect(renamed.status,renamed.msg).toBe(200);onlyUserDelta(renamed.before,renamed.after,['nickname']);expect(mine(renamed.after).nickname).toBe('新昵称');
    for(const invalid of ['   ','新'.repeat(20),'x'.repeat(256)]){const rejected=payload(await rich());rejected.nickname=invalid;expect((await request('/api/user/edit',rejected)).status).toBe(400);}
    // Legacy partial edits keep their existing trimmed16-character grammar.
    expect((await request('/api/user/edit',{nickname:'旧'.repeat(20)})).status).toBe(400);
  });
});
