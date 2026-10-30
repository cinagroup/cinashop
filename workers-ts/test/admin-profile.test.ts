import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemRole, systemMenus } from '@/models/schema';
import { adminProfileOperation, adminProfileAvatar } from '@/models/schema/adminProfile';
import { ADMIN_PROFILE_SQL } from '@/migrations/adminProfile';
import { AdminProfileService, legacyProfilePayload, normalizeProfileInput } from '@/services/admin/AdminProfileService';
import { isAdminProfileRoute } from '@/services/admin/AdminPermissionService';
import { adminapiRoutes } from '@/routes/adminapi';
import { v1Routes } from '@/routes/v1';
import { createToken, md5 } from '@/utils/jwt';
import { errorHandler } from '@/middleware/error';
import { financeMemoryPostgres } from './helpers/financePostgres';
const wiring=vi.hoisted(()=>({open:vi.fn()}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createAdminDatabaseSession:wiring.open}));
const APP_KEY='local-admin-profile-signing-fixture',old='old',next='new-password-long-enough';
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);
const objects=new Map<string,{bytes:Uint8Array;mime:string}>();
const bucket={put:vi.fn(async(key:string,bytes:Uint8Array,options:{httpMetadata:{contentType:string}})=>{
  if(objects.has(key))return null;objects.set(key,{bytes:bytes.slice(),mime:options.httpMetadata.contentType});return {key,size:bytes.length};
}),get:vi.fn(async(key:string)=>{const row=objects.get(key);return row?{body:row.bytes.slice(),size:row.bytes.length,httpMetadata:{contentType:row.mime}}:null;})};
const env={APP_KEY,UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',ASSETS_BUCKET:bucket} as unknown as Env;
describe('Admin self profile real SQL business transactions and actual Hono/JWT boundary',()=>{
 let f:Awaited<ReturnType<typeof financeMemoryPostgres>>,container:Container,service:AdminProfileService,hash:string;
 const close=vi.fn(async()=>{}),app=new Hono<{Bindings:Env;Variables:AppVariables}>();
 app.onError(errorHandler);app.use('*',async(c,next)=>{c.set('container',container);await next();expect(c.get('applicationContainer')).toBeUndefined();});
 app.route('/adminapi',adminapiRoutes);app.route('/api',v1Routes);
 const actor=(id=11)=>({id,authVersion:md5(hash),expiresAt:Math.floor(Date.now()/1000)+3600});
 const rows=()=>f.db.select().from(systemAdmin).orderBy(systemAdmin.id);
 const body=async(operation:string,payload:Record<string,string>,a=actor())=>({operation_id:crypto.randomUUID(),operation,payload,revision:(await service.info(a)).revision});
 async function request(path:string,method='GET',data?:unknown,id=11,auth=md5(hash)){
  const token=(await createToken(id,'admin',auth,APP_KEY)).token;
  return app.request(path,{method,headers:{'Authori-zation':`Bearer ${token}`,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)},env);
 }
 beforeAll(async()=>{
  f=await financeMemoryPostgres([systemAdmin,systemRole,systemMenus],{namespace:'public'});
  await f.exec(ADMIN_PROFILE_SQL);hash=await bcrypt.hash(old,4);container=createContainerFromDb(f.db);service=new AdminProfileService(container,env);
 },30000);
 beforeEach(async()=>{
  await f.reset();objects.clear();vi.clearAllMocks();wiring.open.mockReturnValue({container:createContainerFromDb(f.db),close});
  await f.db.insert(systemAdmin).values([{id:11,account:'plain-admin',realName:'原姓名',phone:'13800138000',pwd:hash,roles:'',level:1},
   {id:12,account:'other-admin',pwd:hash,roles:'',level:1},{id:13,account:'supplier',adminType:4,pwd:hash},
   {id:14,account:'related',relationId:2,pwd:hash},{id:15,account:'disabled',status:0,pwd:hash},{id:16,account:'deleted',isDel:1,pwd:hash}]);
 });
 afterAll(async()=>{await f?.close();});
 it('projects only safe current-account fields and admits an ordinary no-role Admin on both real prefixes',async()=>{
  for(const prefix of ['/adminapi','/api/admin']){
   const response=await request(prefix+'/setting/info'),json=await response.json() as {status:number;data:Record<string,unknown>};expect(json.status).toBe(200);
   expect(Object.keys(json.data).sort()).toEqual(['account','avatar_id','head_pic','id','phone','real_name','revision']);
   expect(json.data.id).toBe(11);expect(JSON.stringify(json.data)).not.toMatch(/"(?:pwd|roles|admin_type|relation_id|status|is_del)"/);
   expect(response.headers.get('cache-control')).toContain('no-store');
  }
  expect(wiring.open).toHaveBeenCalledTimes(2);expect(close).toHaveBeenCalledTimes(2);
 });
 it('does not grant system management, aliases with extra segments, or client-selected identities',async()=>{
  for(const [method,path] of [['POST','/adminapi/system/admin/save'],['GET','/adminapi/setting/info/12'],['DELETE','/adminapi/setting/info']])expect(isAdminProfileRoute(method,path)).toBe(false);
  expect(isAdminProfileRoute('POST','/adminapi/system/profile/commit')).toBe(true);
  expect((await (await request('/adminapi/system/admin/save','POST',{id:12,real_name:'wrong'})).json() as {status:number}).status).not.toBe(200);
  expect(wiring.open).not.toHaveBeenCalled();
  const before=await rows();await expect(service.commit({...await body('name',{real_name:'wrong'}),id:12},actor())).rejects.toThrow('未知');expect(await rows()).toEqual(before);
 });
 it.each([13,14,15,16,999])('rejects live realm/status/deletion or missing identity %s with no writes',async id=>{
  const before=await rows();await expect(service.info(actor(id))).rejects.toThrow();expect(await rows()).toEqual(before);
 });
 it('rejects expired/changed credentials and forged tokens before opening Admin DB',async()=>{
  for(const a of [{...actor(),expiresAt:1},{...actor(),authVersion:md5('changed')}])await expect(service.info(a)).rejects.toThrow();
  const r=await request('/adminapi/setting/info','GET',undefined,11,md5('changed'));expect((await r.json() as {status:number}).status).toBe(410001);expect(wiring.open).not.toHaveBeenCalled();
 });
 it('updates only the current real_name, binds version and UUID, and stores no plaintext in durable evidence',async()=>{
  const before=await rows(),input=await body('name',{real_name:'新的姓名'}),result=await service.commit(input,actor());expect(result.state).toBe('committed');
  const after=await rows();expect(after[0]).toEqual({...before[0],realName:'新的姓名'});expect(after.slice(1)).toEqual(before.slice(1));
  expect(await service.commit(input,actor())).toEqual(result);
  await expect(service.commit({...input,payload:{real_name:'重放变更'}},actor())).rejects.toThrow('变化');
  const receipt=(await f.db.select().from(adminProfileOperation).where(eq(adminProfileOperation.operationId,input.operation_id)))[0];
  expect(receipt.requestHash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(receipt)).not.toContain('新的姓名');
  await expect(f.db.delete(adminProfileOperation).where(eq(adminProfileOperation.operationId,input.operation_id))).rejects.toThrow();
 });
 it('rejects lost-update revision and a credential replacement after the info snapshot',async()=>{
  const input=await body('name',{real_name:'stale'});await f.db.update(systemAdmin).set({phone:'13900139000'}).where(eq(systemAdmin.id,11));
  await expect(service.commit(input,actor())).rejects.toThrow('资料已变化');
  const fresh=await body('name',{real_name:'new'});await f.db.update(systemAdmin).set({pwd:'changed'}).where(eq(systemAdmin.id,11));await expect(service.commit(fresh,actor())).rejects.toThrow('凭据');
 });
 it.each([{real_name:''},{real_name:'中'.repeat(17)},{real_name:' padded '},{real_name:'x',roles:'1'}])('rejects invalid name/payload before mutation: %j',async payload=>{
  const before=await rows();await expect(service.commit(await body('name',payload as Record<string,string>),actor())).rejects.toThrow();expect(await rows()).toEqual(before);
 });
 it('verifies a historical short old password, writes bcrypt, invalidates old JWT and permits fresh same-owner receipt recovery',async()=>{
  const input=await body('password',{pwd:old,new_pwd:next,conf_pwd:next});
  await expect(service.commit({...input,payload:{...input.payload,pwd:'wrong'}},actor())).rejects.toThrow('原密码');
  const result=await service.commit(input,actor());expect(result.state).toBe('committed');
  const changed=(await rows())[0];expect(await bcrypt.compare(next,changed.pwd)).toBe(true);expect(changed.pwd).not.toBe(next);
  expect((await (await request('/adminapi/setting/info')).json() as {status:number}).status).toBe(410001);
  await expect(service.receipt(input.operation_id,'password',actor())).rejects.toThrow('凭据');
  const fresh={...actor(),authVersion:md5(changed.pwd)};expect((await service.receipt(input.operation_id,'password',fresh)).state).toBe('committed');
  await expect(service.receipt(input.operation_id,'password',actor(12))).rejects.toThrow('无权');
  expect(JSON.stringify(await f.db.select().from(adminProfileOperation))).not.toContain(next);
 });
 it.each(['x'.repeat(201),'historical\npassword'])('accepts a historical original password admitted by current login (%#)',async value=>{
  const historicalHash=await bcrypt.hash(value,4);await f.db.update(systemAdmin).set({pwd:historicalHash}).where(eq(systemAdmin.id,11));
  const claims={...actor(),authVersion:md5(historicalHash)},input=await body('password',{pwd:value,new_pwd:next,conf_pwd:next},claims);
  expect((await service.commit(input,claims)).state).toBe('committed');expect(await bcrypt.compare(next,(await rows())[0].pwd)).toBe(true);
 });
 it.each(['short','中'.repeat(25)])('rejects new passwords outside the current Admin policy (%s)',async value=>{
  const before=await rows();await expect(service.commit(await body('password',{pwd:old,new_pwd:value,conf_pwd:value}),actor())).rejects.toThrow('新密码');expect(await rows()).toEqual(before);
 });
 it('atomically rolls the real profile update back when receipt persistence fails',async()=>{
  const input=await body('name',{real_name:'must rollback'}),before=await rows();let reached=false;
  // Replace only the receipt persistence failure port. All profile DML and
  // transaction rollback execute in actual SQL; no SQL result is fabricated.
  const failed=new Proxy(container.db,{get(database,key){
   const method:unknown=Reflect.get(database,key);
   if(key!=='transaction')return typeof method==='function'?method.bind(database):method;
   return(callback:(tx:DbClient)=>Promise<unknown>)=>database.transaction(async original=>{
    const tx=original as unknown as DbClient;
    return callback(new Proxy(tx,{get(transaction,property){
     const operation:unknown=Reflect.get(transaction,property);
     if(property!=='insert')return typeof operation==='function'?operation.bind(transaction):operation;
     return(table:unknown)=>table===adminProfileOperation?{values:async()=>{
      const [changed]=await transaction.select().from(systemAdmin).where(eq(systemAdmin.id,11));
      expect(changed.realName).toBe('must rollback');reached=true;throw Error('fixture receipt persistence unavailable');
     }}:Reflect.apply(operation as (...args:unknown[])=>unknown,transaction,[table]);
    }}));
   });
  }});
  const broken=new AdminProfileService(createContainerFromDb(failed),env);
  await expect(broken.commit(input,actor())).rejects.toThrow('receipt persistence');expect(reached).toBe(true);expect(await rows()).toEqual(before);
  expect((await service.receipt(input.operation_id,'name',actor())).state).toBe('unknown');
 });
 it('seals an absent key under the same write barrier and prevents late application',async()=>{
  const input=await body('name',{real_name:'never'});expect((await service.receipt(input.operation_id,'name',actor())).state).toBe('unknown');
  expect((await service.receipt(input.operation_id,'name',actor(),true)).state).toBe('not_applied');
  await expect(service.commit(input,actor())).rejects.toThrow('封存');expect((await rows())[0].realName).toBe('原姓名');
 });
 it('preserves the PHP seven-field mutual priority and rejects identity injection/no-op',()=>{
  expect(legacyProfilePayload({head_pic:'one',real_name:'two',pwd:'three',phone:'four'})).toEqual({operation:'avatar',payload:{head_pic:'one'}});
  expect(legacyProfilePayload({real_name:'two',pwd:'three'}).operation).toBe('name');
  expect(legacyProfilePayload({pwd:'three',new_pwd:'n',conf_pwd:'n',phone:'four'}).operation).toBe('password');
  expect(legacyProfilePayload({phone:'four',code:'123456'}).operation).toBe('phone');
  expect(()=>legacyProfilePayload({})).toThrow();expect(()=>legacyProfilePayload({real_name:'two',account:'bad'})).toThrow('未知');
 });
 it('executes the actual legacy PUT on both prefixes with actor-only fields',async()=>{
  for(const prefix of ['/adminapi','/api/admin'])expect((await(await request(prefix+'/setting/update_admin','PUT',{real_name:'兼容姓名'})).json() as {status:number}).status).toBe(200);
  expect((await rows())[0].realName).toBe('兼容姓名');expect((await rows())[1].realName).toBe('');
 });
 it('uploads only detected raster bytes to an actor-private immutable key and saves the stable owner reference',async()=>{
  const id=crypto.randomUUID(),upload=await service.upload(actor(),id,png,'image/png');expect(upload.head_pic).toBe(`/admin-profile-avatar/${id}`);
  expect(bucket.put.mock.calls[0][0]).toBe(`admin-profile/11/${id}`);
  expect((await service.upload(actor(),id,png,'image/png')).avatar_id).toBe(id);expect(bucket.put).toHaveBeenCalledOnce();
  await service.commit(await body('avatar',{head_pic:upload.head_pic}),actor());expect((await service.info(actor())).head_pic).toBe(upload.head_pic);
  const response=await service.avatar(actor(),id);expect(response.headers.get('Content-Type')).toBe('image/png');expect(response.headers.get('Cache-Control')).toContain('no-store');expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  await expect(service.avatar(actor(12),id)).rejects.toThrow('不属于');await expect(service.commit(await body('avatar',{head_pic:upload.head_pic},actor(12)),actor(12))).rejects.toThrow('不属于');
  expect((await f.db.select().from(adminProfileAvatar).where(eq(adminProfileAvatar.avatarId,id)))[0].actorId).toBe(11);
 });
 it.each([['image/svg+xml',new TextEncoder().encode('<svg/>')],['image/png',new Uint8Array([1,2,3])],['image/jpeg',png]])('rejects unsupported/mismatched media %s',async(mime,bytes)=>{
  await expect(service.upload(actor(),crypto.randomUUID(),bytes,mime)).rejects.toThrow('头像');expect(bucket.put).not.toHaveBeenCalled();
 });
 it('does not authorize canonical platform/user attachment IDs, external URLs or signed URLs as avatars',async()=>{
  for(const head_pic of ['/api/assets/11','https://evil.invalid/photo.png','/api/assets/11?signature=anything'])expect(()=>normalizeProfileInput({operation_id:crypto.randomUUID(),revision:'a'.repeat(64),operation:'avatar',payload:{head_pic}})).toThrow('本人');
 });
 it('retains unknown historical avatars on read and never rewrites them during page loading',async()=>{
  await f.db.update(systemAdmin).set({headPic:'https://legacy.example/avatar.png'}).where(eq(systemAdmin.id,11));const before=await rows();
  const info=await service.info(actor());expect(info.avatar_id).toBeNull();expect(info.head_pic).toBe(before[0].headPic);expect(await rows()).toEqual(before);expect(bucket.get).not.toHaveBeenCalled();
 });
 it('fails closed before an unauthorized body can upload or mutate',async()=>{
  const response=await app.request('/adminapi/system/profile/avatar/'+crypto.randomUUID(),{method:'PUT',headers:{'Content-Type':'image/png'},body:png},env);
  expect((await response.json() as {status:number}).status).toBe(410000);expect(bucket.put).not.toHaveBeenCalled();expect(wiring.open).not.toHaveBeenCalled();
 });
});
