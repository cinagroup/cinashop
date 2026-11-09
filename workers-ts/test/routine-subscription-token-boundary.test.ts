/** HTTP deadline/resource unit checks only. Approval admission is a stub here;
 * actual PG16 authority, LOGINs and material isolation have a separate native suite. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Env} from '@/env';
import type {Container} from '@/lib/di';
import type {PreparedRoutineSubscriptionAccount} from '@/services/wechat/RoutineSubscriptionAccount';

const admission=vi.hoisted(()=>({check:vi.fn(async()=>undefined),materials:{
 ref:'deadline_fixture',version:1,appId:'wx_subscription_deadline',secret:'inert-deadline-secret',
}}));
vi.mock('@/services/wechat/RoutineSubscriptionAccount',async original=>({
 ...await original<typeof import('@/services/wechat/RoutineSubscriptionAccount')>(),
 assertPreparedRoutineSubscriptionAccount:admission.check,
 routineSubscriptionAccountMaterials:()=>admission.materials,
}));
vi.mock('@/utils/cache',()=>({getRedis:()=>null}));
import {getRoutineSubscriptionAccessToken} from '@/services/wechat/RoutineSubscriptionAccessToken';

const env={APP_KEY:'inert-deadline-authenticator'} as Env;
const container={db:{$client:{}}} as unknown as Container;
const account={account:{payload:{data:{credentialStamp:'a'.repeat(64)}}}} as unknown as PreparedRoutineSubscriptionAccount;
const failure=(promise:Promise<unknown>)=>expect(promise).rejects.toMatchObject({code:503,
 message:'小程序原账号订阅通知 access_token 暂不可用'});

describe('subscription token transport hard deadline without approval/SQL claims',()=>{
 beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-02T07:00:00Z'));admission.check.mockClear();});
 afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

 it('aborts an ignore-abort unresolved GET at exactly eight seconds',async()=>{
  const fetcher=vi.fn<typeof fetch>(()=>new Promise<Response>(()=>undefined));
  let settled=false;
  const pending=getRoutineSubscriptionAccessToken(container,env,account,{fetcher});
  void pending.then(()=>{settled=true;},()=>{settled=true;});const rejected=failure(pending);
  await vi.advanceTimersByTimeAsync(7999);expect(settled).toBe(false);expect(fetcher).toHaveBeenCalledTimes(1);
  const [input,init]=fetcher.mock.calls[0],url=new URL(String(input));
  expect(url.origin+url.pathname).toBe('https://api.weixin.qq.com/cgi-bin/token');
  expect(init).toMatchObject({method:'GET',redirect:'manual'});expect(init?.signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);await rejected;
  expect(init?.signal?.aborted).toBe(true);expect(admission.check).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });

 it('keeps the deadline active across a body stream that never completes and cancels its reader',async()=>{
  let pulled=0,cancelled=0;
  const body=new ReadableStream<Uint8Array>({pull(controller){
   if(!pulled++){controller.enqueue(new TextEncoder().encode('{"access_token":"partial'));}
   return new Promise<void>(()=>undefined);
  },cancel(){cancelled++;}});
  const fetcher=vi.fn<typeof fetch>(async()=>new Response(body));
  const pending=getRoutineSubscriptionAccessToken(container,env,account,{fetcher}),rejected=failure(pending);
  await vi.advanceTimersByTimeAsync(7999);expect(pulled).toBeGreaterThan(0);expect(cancelled).toBe(0);
  await vi.advanceTimersByTimeAsync(1);await rejected;
  expect(cancelled).toBe(1);expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(admission.check).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });

 it('cancels a late response after rejection and cannot turn it into an accepted token',async()=>{
  let complete!:(response:Response)=>void,cancelled=0;
  const fetcher=vi.fn<typeof fetch>(()=>new Promise<Response>(resolve=>{complete=resolve;}));
  const pending=getRoutineSubscriptionAccessToken(container,env,account,{fetcher}),rejected=failure(pending);
  await vi.advanceTimersByTimeAsync(8000);await rejected;
  const body=new ReadableStream<Uint8Array>({cancel(){cancelled++;}});
  complete(new Response(body));await vi.advanceTimersByTimeAsync(0);
  expect(cancelled).toBe(1);expect(admission.check).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
});
