/** HTTP byte bounds only; workerd cryptography/SQL/ACK acceptance is separate. */
import { describe,it,expect } from 'vitest';
import { createRechargeRefundCallbackBudget as budget,readRechargeRefundCallbackHttpBody as body,rechargeRefundCallbackHttpHeaders as headers } from '@/services/payment/RechargeRefundCallbackHttpInput';
const req=(value:BodyInit,extra:HeadersInit={})=>new Request('https://example.test/api/pay/notify/recharge-refund/a',{method:'POST',body:value,headers:extra,duplex:'half'}as RequestInit);
describe('raw recharge callback HTTP bounds',()=>{
 it.each(['\n {"x":"中"} \r\n','\uFEFF{}',' '.repeat(16384)])('retains exact signed UTF8 bytes %#',async value=>{expect(await body(req(value),budget())).toBe(value);});
 it('retains multibyte characters split across chunks',async()=>{
  const raw=new TextEncoder().encode('中\n{}'),stream=new ReadableStream<Uint8Array>({start(c){for(const byte of raw)c.enqueue(Uint8Array.of(byte));c.close();}});
  expect(await body(req(stream),budget())).toBe('中\n{}');
 });
 it.each(['16385','-1','1.5','NaN','Infinity','1e2'])('rejects bad declared size%s before reading',async length=>{let reads=0;
  const stream=new ReadableStream<Uint8Array>({pull(){reads++;}},{highWaterMark:0});await expect(body(req(stream,{'content-length':length}),budget())).rejects.toThrow();expect(reads).toBe(0);
 });
 it.each(['x'.repeat(16385),'中'.repeat(5462)])('enforces actual bytes instead of character count %#',async raw=>{await expect(body(req(raw),budget())).rejects.toThrow();});
 it.each([Uint8Array.of(0xff),Uint8Array.of(0xc3),Uint8Array.of(0xc0,0xaf)])('rejects invalid UTF8 bytes %#',async raw=>{await expect(body(req(raw),budget())).rejects.toThrow();});
 it.each(['','{}'])('rejects empty or mismatched declared length %#',async raw=>{await expect(body(req(raw,{'content-length':'1'}),budget())).rejects.toThrow();});
 it('honors an actual abort while reading without starting SQL or a detached write',async()=>{
  const ac=new AbortController();let cancelled=0;const stream=new ReadableStream<Uint8Array>({cancel(){cancelled++;}},{highWaterMark:0});
  const request=new Request('https://example.test/',{method:'POST',body:stream,signal:ac.signal,duplex:'half'}as RequestInit);
  const pending=body(request,budget());ac.abort();await expect(pending).rejects.toThrow();expect(cancelled).toBe(1);
 });
 const base={'wechatpay-timestamp':'1794214800','wechatpay-nonce':'nonce','wechatpay-serial':'serial','wechatpay-signature':'AAAA'};
 it('copies only the four bounded verifier headers',()=>{expect(headers(new Headers({...base,'X-AppId':'untrusted','X-Role':'admin'}))).toEqual(base);});
 it.each(Object.keys(base))('rejects absent%s',name=>{const h=new Headers(base);h.delete(name);expect(()=>headers(h)).toThrow();});
 it.each(Object.keys(base))('rejects oversized%s',name=>{const h=new Headers(base);h.set(name,'a'.repeat(1025));expect(()=>headers(h)).toThrow();});
 it('creates a fresh nonextendible five-second budget',()=>{const b=budget();expect(Object.isFrozen(b)).toBe(true);expect(b.remainingMs()).toBeGreaterThan(0);expect(b.remainingMs()).toBeLessThanOrEqual(5000);b.check();});
});
