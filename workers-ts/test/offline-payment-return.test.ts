import { describe, expect, it } from 'vitest';
import { offlineReturnOrigin, offlineReturnUrl, isOfflineReturnUrl, validOfflineTicketReturn } from '../../view/common/offlineReturn';
import { onRequest as pc } from '../../view/pc-ts/functions/offline-payment-return';
import { onRequest as h5 } from '../../view/uniapp-ts/functions/offline-payment-return';

const id = 'xx'+'a'.repeat(30), other = 'xx'+'b'.repeat(30);
describe('fixed offline provider return navigation (no payment authority)',()=>{
  it.each([undefined,'','http://shop.example','https://shop.example/','https://user:pass@shop.example','https://shop.example:443',
    'https://shop.example?x=y','https://shop.example#x','https://SHOP.example','https://127.0.0.1','https://localhost',
    'https://shop..example','https://-shop.example','https://'+'a'.repeat(64)+'.example','https://shop.example\\evil'])('rejects invalid operator origin %s',value=>{
    expect(()=>offlineReturnOrigin(value)).toThrow();
  });
  it('creates exact bounded order context and rejects extra/different context',()=>{
    const link=offlineReturnUrl('https://shop.example',id);
    expect(link).toBe(`https://shop.example/offline-payment-return?orderId=${id}`);expect(link.length).toBeLessThanOrEqual(256);
    expect(isOfflineReturnUrl(link,id)).toBe(true);
    for(const value of [link+'&paid=true',link+'#ok',link.replace(id,other),link.replace('/offline-payment-return','/result')])expect(isOfflineReturnUrl(value,id)).toBe(false);
    for(const bad of ['bad',id+'\n',id+'\r'])expect(()=>offlineReturnUrl('https://shop.example',bad)).toThrow();
  });
  for(const [client,handler,path] of [['pc',pc,'/user/offline-result'],['h5',h5,'/#/pages/annex/offline_result/index']] as const){
    it(`${client} GET/HEAD drops all provider claims and uses only a fixed same-origin 303`,async()=>{
      for(const method of ['GET','HEAD']){
        const params=new URLSearchParams({orderId:id,out_trade_no:id,paid:'true',status:'SUCCESS',total_amount:'0.01',uid:'999',sign:'not-trusted',redirect:'https://attacker.example'});
        const response=handler({request:new Request(`https://preview.example/offline-payment-return?${params}`,{method})});
        expect(response.status).toBe(303);expect(response.headers.get('Location')).toBe(`${path}?orderId=${id}`);
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
        expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");expect(await response.text()).toBe('');
        expect(response.headers.get('Set-Cookie')).toBeNull();
      }
    });
    it.each(['',`?orderId=${id}&orderId=${id}`,`?orderId=${id}&out_trade_no=${other}`,`?orderId=${id}&out_trade_no=${id}&out_trade_no=${id}`,
      `?orderId=${id}%0A`,'?orderId=https://attacker.example',`?orderId=${id}&padding=${'x'.repeat(8192)}`])(`${client} rejects missing/ambiguous/bad return %#`,async search=>{
      const response=handler({request:new Request('https://preview.example/offline-payment-return'+search)});
      expect(response.status).toBe(400);expect(response.headers.get('Location')).toBeNull();expect(await response.text()).not.toContain('attacker.example');
    });
    it(`${client} rejects POST, rather than treating it as a signed callback`,()=>{
      const response=handler({request:new Request(`https://preview.example/offline-payment-return?orderId=${id}`,{method:'POST',body:'paid=true'})});
      expect(response.status).toBe(405);expect(response.headers.get('Allow')).toBe('GET, HEAD');expect(response.headers.get('Location')).toBeNull();
    });
  }
  it('legacy absent context is not rewritten; supplied context must be unique and bound to the original order',()=>{
    for(const field of ['return_url','redirect_url'] as const){
      const url=new URL('https://provider.example/pay?original=a%2fb%2Bc');expect(validOfflineTicketReturn(url,field,id)).toBe(true);
      url.searchParams.set(field,offlineReturnUrl('https://shop.example',id));expect(validOfflineTicketReturn(url,field,id)).toBe(true);
      expect(validOfflineTicketReturn(url,field,other)).toBe(false);url.searchParams.append(field,offlineReturnUrl('https://shop.example',id));
      expect(validOfflineTicketReturn(url,field,id)).toBe(false);
    }
  });
});
