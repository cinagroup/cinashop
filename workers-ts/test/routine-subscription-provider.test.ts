/** Transport/resource units only. The dispatch consumer is an explicit fixture
 * stub; these tests prove no SQL authority, approved intent or real WeChat send. */
import { createHash } from 'node:crypto';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import type { RoutineSubscriptionSendAuthority } from '@/services/wechat/RoutineSubscriptionDispatch';

const admission=vi.hoisted(()=>({consume:vi.fn(),used:new WeakSet<object>(),slots:new WeakMap<object,Readonly<{
 attemptId:string;attemptSignature:string;token:string;request:Readonly<Record<string,unknown>>;
}>>() }));
vi.mock('@/services/wechat/RoutineSubscriptionDispatch',()=>({consumeRoutineSubscriptionSendAuthority:admission.consume}));
import { postRoutineSubscription,assertRoutineSubscriptionProviderResult } from '@/services/wechat/RoutineSubscriptionProvider';

const MAX_BYTES=32*1024,attemptId='b2312692-b2bd-4dce-a24b-c80578fc660d',signature='a'.repeat(64);
const token='inert-provider-fixture-token_+?&';
const request=Object.freeze({touser:'synthetic_target_a',template_id:'synthetic_template_a',page:'pages/order/detail?id=7',
 data:Object.freeze({thing1:Object.freeze({value:'仅传输边界标本'})})});
const message='小程序原账号订阅通知批准、凭据或证据尚未完整就绪';
function issued(){
 const authority=Object.freeze({transportOnly:true}) as unknown as RoutineSubscriptionSendAuthority;
 admission.slots.set(authority,Object.freeze({attemptId,attemptSignature:signature,token,request}));return authority;
}
const rejected=(pending:Promise<unknown>)=>expect(pending).rejects.toMatchObject({code:503,message});
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});

describe('subscription one-POST transport without dispatch/SQL claims',()=>{
 beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-02T07:00:00Z'));admission.used=new WeakSet();admission.slots=new WeakMap();
  admission.consume.mockReset().mockImplementation((authority:object)=>{
   const value=admission.slots.get(authority);
   if(!value||admission.used.has(authority))throw Error('fixture authority unavailable, inert-secret');
   admission.used.add(authority);return value;
  });
 });
 afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

 it('posts the pinned request to the fixed endpoint once and privately binds a frozen result to its attempt',async()=>{
  const raw='{"errcode":0,"errmsg":"ok，边界标本"}',started=Math.floor(Date.now()/1000),events:string[]=[];
  const fetcher=vi.fn<typeof fetch>(async()=>{events.push('fetch');vi.setSystemTime(Date.now()+1200);return new Response(raw);});
  const result=await postRoutineSubscription(issued(),fetcher,()=>{events.push('start');});
  expect(events).toEqual(['start','fetch']);expect(fetcher).toHaveBeenCalledTimes(1);expect(admission.consume).toHaveBeenCalledTimes(1);
  const [input,init]=fetcher.mock.calls[0],url=new URL(String(input));
  expect(url.origin+url.pathname).toBe('https://api.weixin.qq.com/cgi-bin/message/subscribe/send');
  expect([...url.searchParams]).toEqual([['access_token',token]]);
  expect(init).toMatchObject({method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
  expect(init?.signal?.aborted).toBe(false);
  expect(result).toEqual({code:0,httpStatus:200,rawDigest:digest(raw),requestStartedAt:started,verifiedAt:started+1});
  expect(Object.isFrozen(result)).toBe(true);expect(Object.keys(result)).toEqual(['code','httpStatus','rawDigest','requestStartedAt','verifiedAt']);
  expect(assertRoutineSubscriptionProviderResult(attemptId,signature,result)).toBe(result);
  for(const candidate of [{...result},JSON.parse(JSON.stringify(result))])
   expect(()=>assertRoutineSubscriptionProviderResult(attemptId,signature,candidate)).toThrow(message);
  expect(()=>assertRoutineSubscriptionProviderResult('wrong-attempt',signature,result)).toThrow(message);
  expect(()=>assertRoutineSubscriptionProviderResult(attemptId,'b'.repeat(64),result)).toThrow(message);
  expect(vi.getTimerCount()).toBe(0);
 });

 it.each([[40014,200],[-1,503],[43101,400],[-2147483648,502],[2147483647,200]])(
  'returns explicit int32 rejection %s at HTTP %s without refreshing or posting again',async(code,status)=>{
   const fetcher=vi.fn<typeof fetch>(async()=>json({errcode:code,errmsg:'inert provider message'},status));
   const result=await postRoutineSubscription(issued(),fetcher);
   expect(result).toMatchObject({code,httpStatus:status});expect(fetcher).toHaveBeenCalledTimes(1);
   expect(assertRoutineSubscriptionProviderResult(attemptId,signature,result)).toBe(result);expect(vi.getTimerCount()).toBe(0);
  });

 it('consumes even a failed transport once and refuses reuse or a cloned fixture capability without another POST',async()=>{
  const authority=issued(),fetcher=vi.fn<typeof fetch>(async()=>{throw Error('inert-secret raw token='+token);});
  await rejected(postRoutineSubscription(authority,fetcher));
  await rejected(postRoutineSubscription(authority,fetcher));
  await rejected(postRoutineSubscription({...authority} as RoutineSubscriptionSendAuthority,fetcher));
  expect(fetcher).toHaveBeenCalledTimes(1);expect(admission.consume).toHaveBeenCalledTimes(3);expect(vi.getTimerCount()).toBe(0);
 });

 it.each([{},[],null,{errcode:'0'},{errcode:0.1},{errcode:2147483648},{errcode:-2147483649},{errcode:null}].map(value=>({value})))(
  'rejects malformed JSON errcode %# without exposing response data',async({value})=>{
   const fetcher=vi.fn<typeof fetch>(async()=>json(value));await rejected(postRoutineSubscription(issued(),fetcher));
   expect(fetcher).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });

 it('rejects non-JSON, invalid UTF8 and HTTP error code zero as unknown',async()=>{
  const prefix=new TextEncoder().encode('{"errcode":0,"errmsg":"'),suffix=new TextEncoder().encode('"}');
  const bad=new Uint8Array(prefix.byteLength+2+suffix.byteLength);bad.set(prefix);bad.set([0xc3,0x28],prefix.byteLength);bad.set(suffix,prefix.byteLength+2);
  for(const response of [new Response('inert-secret non-json'),new Response(bad),json({errcode:0},503),Response.error()]){
   const fetcher=vi.fn<typeof fetch>(async()=>response);await rejected(postRoutineSubscription(issued(),fetcher));expect(fetcher).toHaveBeenCalledTimes(1);
  }
  expect(vi.getTimerCount()).toBe(0);
 });

 it('rejects a redirected response and never follows it',async()=>{
  const response=json({errcode:40014});Object.defineProperty(response,'redirected',{value:true});
  const fetcher=vi.fn<typeof fetch>(async()=>response);await rejected(postRoutineSubscription(issued(),fetcher));
  expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');expect(vi.getTimerCount()).toBe(0);
 });
 it.each([301,302,303,307,308])('rejects manual HTTP%s even with a syntactically valid provider rejection',async(status)=>{
  const fetcher=vi.fn<typeof fetch>(async()=>json({errcode:-1},status));await rejected(postRoutineSubscription(issued(),fetcher));
  expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');expect(vi.getTimerCount()).toBe(0);
 });

 it.each(['32769','-1','1.5','not-a-number','9007199254740992'])(
  'rejects invalid or excessive declared byte length %s and cancels the unread body',async(length)=>{
   let cancelled=0;
   const body=new ReadableStream<Uint8Array>({cancel(){cancelled++;}});
   const fetcher=vi.fn<typeof fetch>(async()=>new Response(body,{headers:{'content-length':length}}));
   await rejected(postRoutineSubscription(issued(),fetcher));expect(cancelled).toBe(1);expect(vi.getTimerCount()).toBe(0);
  });

 it('accepts exactly 32KiB but bounds streamed bytes even when the declared length lies',async()=>{
  const prefix='{"errcode":0,"errmsg":"',suffix='"}',raw=prefix+'x'.repeat(MAX_BYTES-prefix.length-suffix.length)+suffix;
  const good=vi.fn<typeof fetch>(async()=>new Response(raw));expect((await postRoutineSubscription(issued(),good)).rawDigest).toBe(digest(raw));
  let cancelled=0;
  const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(MAX_BYTES+1));},cancel(){cancelled++;}});
  const tooLarge=vi.fn<typeof fetch>(async()=>new Response(body,{headers:{'content-length':'1'}}));
  await rejected(postRoutineSubscription(issued(),tooLarge));expect(cancelled).toBe(1);expect(vi.getTimerCount()).toBe(0);
 });

 it('redacts a pre-POST callback failure without sending',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>json({errcode:0}));
  await rejected(postRoutineSubscription(issued(),fetcher,()=>{throw Error('inert-secret callback');}));
  expect(fetcher).not.toHaveBeenCalled();expect(admission.consume).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });

 it('aborts an ignore-abort POST at exactly eight seconds',async()=>{
  const fetcher=vi.fn<typeof fetch>(()=>new Promise<Response>(()=>undefined));let settled=false;
  const pending=postRoutineSubscription(issued(),fetcher),failure=rejected(pending);
  void pending.then(()=>{settled=true;},()=>{settled=true;});
  await vi.advanceTimersByTimeAsync(7999);expect(settled).toBe(false);expect(fetcher).toHaveBeenCalledTimes(1);
  const signal=fetcher.mock.calls[0][1]?.signal;expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);await failure;expect(signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
 });

 it('holds the same eight-second deadline through a never-finished stream and cancels its reader',async()=>{
  let pulled=0,cancelled=0;
  const body=new ReadableStream<Uint8Array>({pull(controller){
   if(!pulled++)controller.enqueue(new TextEncoder().encode('{"errcode":0,"errmsg":"partial'));
   return new Promise<void>(()=>undefined);
  },cancel(){cancelled++;}});
  const fetcher=vi.fn<typeof fetch>(async()=>new Response(body)),pending=postRoutineSubscription(issued(),fetcher),failure=rejected(pending);
  await vi.advanceTimersByTimeAsync(7999);expect(pulled).toBeGreaterThan(0);expect(cancelled).toBe(0);
  await vi.advanceTimersByTimeAsync(1);await failure;expect(cancelled).toBe(1);
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
 });

 it('cancels a late response after the hard rejection instead of issuing a result',async()=>{
  let complete!:(response:Response)=>void,cancelled=0;
  const fetcher=vi.fn<typeof fetch>(()=>new Promise<Response>(resolve=>{complete=resolve;}));
  const pending=postRoutineSubscription(issued(),fetcher),failure=rejected(pending);
  await vi.advanceTimersByTimeAsync(8000);await failure;
  complete(new Response(new ReadableStream<Uint8Array>({cancel(){cancelled++;}})));await vi.advanceTimersByTimeAsync(0);
  expect(cancelled).toBe(1);expect(fetcher).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
});
