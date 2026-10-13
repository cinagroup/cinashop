import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { readLegacyShareProvider } from '@/services/other/LegacyShareProviderRead';
import { boundedProductShareFetch } from '@/services/wechat/ProductShareProviderPolicy';
import { enforceLegacyShareBudget } from '@/services/other/LegacyShareBudget';
import * as Controller from '@/controllers/api/v1/LegacyShareCodeController';
import { legacyShareHmac } from '@/services/other/LegacyShareCodeProtocol';
import { ApiException } from '@/utils/errors';

describe('share provider wall-clock deadlines and fail-closed public budgets',()=>{
  afterEach(()=>vi.useRealTimers());
  it('rejects and aborts an ignored-signal fetch at the entire-request deadline, then cancels its late body',async()=>{
    vi.useFakeTimers();let resolve!: (value:Response)=>void,canceled=false,signal:AbortSignal|undefined;
    const provider:typeof fetch=async(_input,init)=>{signal=init?.signal??undefined;return new Promise(done=>{resolve=done;});};
    const result=readLegacyShareProvider(provider,'https://api.weixin.qq.com/cgi-bin/token',undefined,{json:100,image:100,timeout:10});
    const failure=expect(result).rejects.toThrow('超时');await vi.advanceTimersByTimeAsync(11);await failure;expect(signal?.aborted).toBe(true);
    resolve(new Response(new ReadableStream({cancel(){canceled=true;}}),{headers:{'Content-Type':'application/json'}}));
    await Promise.resolve();await Promise.resolve();expect(canceled).toBe(true);
  });
  it('cancels a body that stalls after headers and rejects despite a fetcher ignoring AbortSignal',async()=>{
    vi.useFakeTimers();let canceled=false;
    const provider:typeof fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));},cancel(){canceled=true;}}),{headers:{'Content-Type':'image/png'}});
    const result=readLegacyShareProvider(provider,'https://api.weixin.qq.com/wxa/getwxacodeunlimit',undefined,{json:100,image:100,timeout:10});
    const failure=expect(result).rejects.toThrow('超时');await vi.advanceTimersByTimeAsync(11);await failure;expect(canceled).toBe(true);
  });
  it('gives the existing product provider policy the same hard read deadline and cancels streamed oversize bodies',async()=>{
    vi.useFakeTimers();let canceled=false;
    const provider=boundedProductShareFetch(async()=>new Response(new ReadableStream({cancel(){canceled=true;}}),{headers:{'Content-Type':'application/json'}}));
    const result=provider('https://api.weixin.qq.com/cgi-bin/token'),failure=expect(result).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(10001);await failure;expect(canceled).toBe(true);
    await expect(readLegacyShareProvider(async()=>new Response(new Uint8Array(101),{headers:{'Content-Type':'image/png'}}),
      'https://api.weixin.qq.com/wxa/getwxacodeunlimit',undefined,{json:100,image:100})).rejects.toThrow('过大');
  });
  it('consumes a HMAC CF-address bucket and a 300/minute global bucket without exposing raw IP',async()=>{
    const calls:Array<{name:string;rules:unknown;seconds:number}>=[];
    const env={APP_KEY:'owned-share-budget-key',TOKEN_BUCKET:{getByName:(name:string)=>({consumeRateLimit:async(rules:unknown,seconds:number)=>{calls.push({name,rules,seconds});return{allowed:true,resetAt:Date.now()+60000};}})}} as unknown as Env;
    await enforceLegacyShareBudget(env,'192.0.2.7');expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({name:`legacy-share:${legacyShareHmac(env.APP_KEY,'budget','192.0.2.7')}`,rules:[{key:'request',limit:30}],seconds:60});
    expect(calls[1]).toEqual({name:'legacy-share:global',rules:[{key:'request',limit:300}],seconds:60});
    expect(JSON.stringify(calls)).not.toContain('192.0.2.7');
    await expect(enforceLegacyShareBudget({APP_KEY:'owned'} as Env,'192.0.2.7')).rejects.toThrow('不可用');
    for(const decision of[undefined,{allowed:'yes',resetAt:1},{allowed:true,resetAt:NaN}]){
      const broken={...env,TOKEN_BUCKET:{getByName:()=>({consumeRateLimit:async()=>decision})}} as unknown as Env;
      await expect(enforceLegacyShareBudget(broken,'192.0.2.7')).rejects.toThrow('不可用');
    }
  });
  it('validates private identity and image signatures before taking quota, and never reaches a provider when quota is refused',async()=>{
    let quotas=0;
    const env={APP_KEY:'owned-share-budget-key',TOKEN_BUCKET:{getByName:()=>({consumeRateLimit:async()=>{quotas++;return{allowed:false,resetAt:Date.now()+60000};}})}} as unknown as Env;
    const app=new Hono<{Bindings:Env;Variables:AppVariables}>();
    app.onError((error,c)=>c.json({status:error instanceof ApiException?error.code:500,msg:error.message}));
    app.get('/get_qrcode/:type/:id',Controller.code);app.get('/share/code/image/:token/:channel',Controller.image);
    const request=async(path:string)=>(await app.request(path,{},env)).json<{status:number}>();
    expect((await request('/get_qrcode/90/0')).status).not.toBe(200);expect(quotas).toBe(0);
    expect((await request('/get_qrcode/0/70?uid=12')).status).not.toBe(200);expect(quotas).toBe(0);
    expect((await request('/share/code/image/'+'a'.repeat(24)+'/wechat?expires=1&signature='+'0'.repeat(64))).status).not.toBe(200);expect(quotas).toBe(0);
    expect((await request('/get_qrcode/0/70')).status).not.toBe(200);expect(quotas).toBe(1);
    const expires=String(Math.floor(Date.now()/1000)+900),token='a'.repeat(24),signature=legacyShareHmac(env.APP_KEY,'image',`${token}:wechat:${expires}`);
    expect((await request(`/share/code/image/${token}/wechat?expires=${expires}&signature=${signature}`)).status).not.toBe(200);expect(quotas).toBe(2);
  });
});
