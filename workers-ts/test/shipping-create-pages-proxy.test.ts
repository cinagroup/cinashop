import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { corsMiddleware } from '../src/middleware/cors';
import { onRequest as adminProxy } from '../../view/admin-ts/functions/adminapi/[[path]]';
import { onRequest as supplierProxy } from '../../view/supplier-ts/functions/supplierapi/[[path]]';

afterEach(()=>vi.restoreAllMocks());
describe.each(['admin','supplier'] as const)('actual %s Pages creation/receipt header transport', surface=>{
  it.each([true,false])('scope preflight preserves the existing origin allowlist (allowed=%s)',async allowed=>{
    const app=new Hono();app.use('*',corsMiddleware);app.post('*',c=>c.json({ok:true}));
    const origin=allowed ? `https://cinashop-${surface}.pages.dev` : 'https://untrusted.invalid';
    const response=await app.request(surface==='admin' ? '/adminapi/shipping_template/save' : '/supplierapi/setting/shipping_templates/save/0',{
      method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,idempotency-key,x-shipping-creation-scope'},
    },{NODE_ENV:'production',ALLOWED_ORIGINS:`https://cinashop-${surface}.pages.dev`});
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(allowed ? origin : null);
    if(allowed) expect(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('x-shipping-creation-scope');
  });
  for (const operation of ['create','lookup'] as const) it.each([200,409,412,500])(`${operation} preserves key, auth, status %s and no-store without retry`,async status=>{
    const supplier=surface==='supplier';
    const prefix=supplier ? '/supplierapi/setting/shipping_templates' : '/adminapi/shipping_template';
    const path=prefix+(operation==='lookup' ? '/creation-receipt' : supplier ? '/save/0' : '/save');
    // Transport-only probe: omitted body does not assert JSON/form correctness.
    // Duplicate keys must reach the API unchanged, where UUID validation rejects them.
    const key=`${crypto.randomUUID()}, ${crypto.randomUUID()}`;
    const request: Parameters<typeof adminProxy>[0]['request']=new Request(`https://cinashop-${surface}.pages.dev${path}`,{method:'POST',headers:{
      Host:`cinashop-${surface}.pages.dev`,Authorization:'Bearer isolated-fixture','Idempotency-Key':key,
      'X-Shipping-Creation-Scope': supplier ? 'v1:2:20:27' : 'v1:0:0:7',
    }});
    const upstream=new Response(JSON.stringify({status,data:null}),{status,headers:{'Cache-Control':'private, no-store','Content-Type':'application/json'}});
    const outbound=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      const sent=new Request(input,init);
      expect(sent.url).toBe('https://cinashop-api.cinagroup.workers.dev'+(supplier ? path : path.replace('/adminapi/','/api/admin/')));
      expect(sent.method).toBe('POST');expect(sent.redirect).toBe('manual');
      expect(sent.headers.get('idempotency-key')).toBe(key);
      expect(sent.headers.get('X-Shipping-Creation-Scope')).toBe(supplier ? 'v1:2:20:27' : 'v1:0:0:7');
      expect(sent.headers.get('authorization')).toBe('Bearer isolated-fixture');
      expect(sent.headers.get('host')).toBeNull();
      return upstream;
    });
    const context: Parameters<typeof adminProxy>[0]={request,env:{ASSETS:{fetch:async()=>new Response(null)}},
      params:{},data:{},functionPath:path,waitUntil:()=>{},passThroughOnException:()=>{},next:async()=>new Response(null)};
    const response=await (supplier ? supplierProxy : adminProxy)(context);
    expect(response).toBe(upstream);expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.bodyUsed).toBe(false);expect(outbound).toHaveBeenCalledTimes(1);
  });
});
