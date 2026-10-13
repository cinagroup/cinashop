import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import type {AppVariables,Env} from '@/env';
import {createContainerFromDb,type Container} from '@/lib/di';
import {managerRuntimeAuthMiddleware} from '@/middleware/manager-runtime-auth';
import {user} from '@/models/schema';
import {createToken,md5,type TokenType} from '@/utils/jwt';
import {errorHandler} from '@/middleware/error';
import {financePostgres} from './helpers/financePostgres';

const wiring=vi.hoisted(()=>({open:vi.fn()}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createManagerDatabaseSession:wiring.open}));

describe('Manager runtime connection selection after complete UserJWT authentication',()=>{
 let f:Awaited<ReturnType<typeof financePostgres>>,application:Container,manager:Container;
 const close=vi.fn(async()=>{}),handler=vi.fn();
 const env={APP_KEY:'local-manager-boundary-signing-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''};
 const app=new Hono<{Bindings:Env;Variables:AppVariables}>();
 app.onError(errorHandler);
 app.use('*',async(c,next)=>{c.set('container',application);await next();expect(c.get('container')).toBe(application);expect(c.get('applicationContainer')).toBeUndefined();});
 app.get('/store/manager/order/operation/:requestKey',managerRuntimeAuthMiddleware(),c=>{
  handler();expect(c.get('container')).toBe(manager);return c.json({uid:c.get('uid'),verifiedUid:c.get('socketAuthId')});
 });
 app.post('/store/manager/order/financial/offline',managerRuntimeAuthMiddleware(),async c=>{
  handler();expect(c.get('container')).toBe(manager);return c.json(await c.req.json());
 });
 app.get('/store/manager/order/error',managerRuntimeAuthMiddleware(),()=>{throw Error('synthetic manager handler failure');});
 beforeAll(async()=>{
  f=await financePostgres([user]);application=createContainerFromDb(f.db);manager=createContainerFromDb(f.db);
  await f.db.insert(user).values([
   {uid:101,account:'active',pwd:'fixture-hash'},
   {uid:102,account:'disabled',pwd:'fixture-hash',status:0},
   {uid:103,account:'deleted',pwd:'fixture-hash',isDel:1},
   {uid:104,account:'soft-deleted',pwd:'fixture-hash',deleteTime:new Date()},
  ]);
 });
 afterAll(async()=>{await f?.close();});
 beforeEach(()=>{vi.clearAllMocks();wiring.open.mockReturnValue({container:manager,close});});
 async function status(response:Response){const value:unknown=await response.json();if(!value||typeof value!=='object'||!('status'in value))throw Error('Invalid error envelope');return value.status;}
 async function request(uid=101,type:TokenType='api',auth=md5('fixture-hash'),path='/store/manager/order/operation/00000000-0000-4000-8000-000000000001'){
  const{token}=await createToken(uid,type,auth,env.APP_KEY);return app.request(path,{headers:{Authorization:`Bearer ${token}`}},env);
 }
 it('opens for the authenticated owner and restores/closes the selected connection',async()=>{
  const response=await request();expect(response.status).toBe(200);expect(await response.json()).toEqual({uid:101,verifiedUid:101});
  expect(wiring.open).toHaveBeenCalledExactlyOnceWith(env);expect(handler).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
 });
 it.each([102,103,104,999])('never opens Manager for disabled/deleted/missing account %s',async uid=>{
  expect(await status(await request(uid))).not.toBe(200);expect(wiring.open).not.toHaveBeenCalled();expect(handler).not.toHaveBeenCalled();
 });
 it.each(['admin','supplier','kefu'] as const)('never opens Manager for a signed %s realm token',async type=>{
  expect(await status(await request(101,type))).not.toBe(200);expect(wiring.open).not.toHaveBeenCalled();
 });
 it('rejects a changed password claim before selecting privileged I/O',async()=>{
  expect(await status(await request(101,'api','obsolete'))).not.toBe(200);expect(wiring.open).not.toHaveBeenCalled();
 });
 it.each([undefined,'Bearer invalid-jwt'])('rejects missing/invalid tokens before opening Manager',async token=>{
  const response=await app.request('/store/manager/order/operation/anything',{headers:token?{Authorization:token}:{}},env);
  expect(await status(response)).not.toBe(200);expect(wiring.open).not.toHaveBeenCalled();
 });
 it('preserves the complete request body for the existing locked business admission',async()=>{
  const{token}=await createToken(101,'api',md5('fixture-hash'),env.APP_KEY),body={version:'merchant-order-operation-v1',payload:{},order_id:7};
  const response=await app.request('/store/manager/order/financial/offline',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)},env);
  expect(response.status).toBe(200);expect(await response.json()).toEqual(body);expect(close).toHaveBeenCalledOnce();
 });
 it('restores and closes after a downstream business error',async()=>{
  expect(await status(await request(101,'api',md5('fixture-hash'),'/store/manager/order/error'))).not.toBe(200);expect(close).toHaveBeenCalledOnce();
 });
 it('never runs business work when the independent Manager binding is unavailable',async()=>{
  wiring.open.mockImplementation(()=>{throw Error('Independent Manager database binding is required');});
  expect(await status(await request())).not.toBe(200);expect(handler).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
 });
 it('the actual factory rejects absent/main/Admin bindings before database I/O',async()=>{
  const actual=await vi.importActual<typeof import('@/lib/di')>('@/lib/di'),binding={connectionString:'postgres://local.invalid/unused'};
  expect(()=>actual.createManagerDatabaseSession({} as Env)).toThrow('独立配置');
  expect(()=>actual.createManagerDatabaseSession({HYPERDRIVE:binding,HYPERDRIVE_MANAGER:binding} as Env)).toThrow('独立配置');
  expect(()=>actual.createManagerDatabaseSession({HYPERDRIVE:binding,HYPERDRIVE_MANAGER:{...binding}} as Env)).toThrow('独立配置');
  expect(()=>actual.createManagerDatabaseSession({HYPERDRIVE_ADMIN:binding,HYPERDRIVE_MANAGER:binding} as Env)).toThrow('独立配置');
  expect(()=>actual.createManagerDatabaseSession({HYPERDRIVE_ADMIN:binding,HYPERDRIVE_MANAGER:{...binding}} as Env)).toThrow('独立配置');
 });
});
