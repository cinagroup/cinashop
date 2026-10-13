import { afterEach,describe,expect,it,vi } from 'vitest';
import { erpCanonical,erpCapabilityHash,erpOrderedQuery,erpPhpJson,erpPopSign,erpPushSign,erpSha256,erpVerifyCallbackQuery } from '@/services/erp/ErpProtocol';
import { ErpProviderClient } from '@/services/erp/ErpProviderPolicy';
import { ErpSecretCodec } from '@/services/erp/ErpSecretCodec';

const uuid='00000000-0000-4000-8000-000000000001',cap=Buffer.alloc(32,7).toString('base64url'),time=1730000000;
function signedQuery(extra=''){
  const pairs=`method=logistics.upload&partnerid=erp&ts=${time}&connection=${uuid}&cap=${cap}${extra}`;
  return `https://erp.invalid/erpapi/order/deliver_callback?${pairs}&sign=${erpPushSign(erpOrderedQuery(`https://erp.invalid/?${pairs}`))}`;
}
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
afterEach(()=>vi.useRealTimers());
describe('actual readable PHP 8 signing vectors and independent push authority',()=>{
  it('matches PHP 8.4.25 pure CLI auth vector',()=>expect(erpPopSign({app_key:'fixture-app',timestamp:time,state:'',charset:'utf-8'},'fixture-secret')).toBe('4b17efe96300d13685ed77e2c68b09fc'));
  it('matches PHP zero/bool/null omission rather than JS loose empty comparison',()=>expect(erpPopSign({z:0,a:'0',false:false,true:true,null:null,empty:'',sign:'ignored'},'fixture-secret')).toBe('217c9154feae4b138bd6852f3dd8e7e4'));
  it('matches Unicode, slash, emoji and line separator PHP JSON encoding',()=>{
    expect(erpPopSign({biz:{name:'雪/😀',nested:{zero:0,false:false,empty:''},line:'x\u2028y\u2029z'},timestamp:time},'fixture-secret')).toBe('a10e1960ede230da16d6e28214cf7a7b');
    expect(erpPhpJson({url:'https://erp.invalid/'})).toBe('{"url":"https:\\/\\/erp.invalid\\/"}');
  });
  it('matches official public push signature example exactly',()=>expect(erpPushSign([['method','logistics.upload'],['partnerid','erp'],['ts','1608000837']])).toBe('8c33d804272823485218bbfd15a49569'));
  it('keeps URL order for push extras and different order for canonical SQL hashes',()=>{
    const a=erpOrderedQuery(signedQuery()),b=[...a].reverse();expect(erpPushSign(a)).not.toBe(erpPushSign(b));
    expect(erpCanonical({b:2,a:1})).toBe(erpCanonical({a:1,b:2}));
  });
  it('authenticates only a bounded private capability in addition to public sign',()=>{
    expect(erpVerifyCallbackQuery('deliver',signedQuery(),time)).toMatchObject({connectionId:uuid,capability:cap,timestamp:time});
    expect(erpCapabilityHash(cap)).toBe(erpSha256(cap));
  });
  it.each([['expired',signedQuery(),time+601],['future',signedQuery(),time-601],['method',signedQuery().replace('logistics.upload','cancel.order'),time],
    ['cap',signedQuery().replace(cap,'public'),time],['unknown',signedQuery('&admin_id=1'),time]])('rejects %s query',(_name,url,at)=>expect(()=>erpVerifyCallbackQuery('deliver',url,at as number)).toThrow());
  it.each(['&ts=1730000000','&%74s=1730000000','&partnerkey=erp','&bad=%ZZ','&cap=other','&=oops','&unknown='.padEnd(5000,'x')])('rejects repeated/invalid query %s',extra=>expect(()=>erpVerifyCallbackQuery('deliver',signedQuery()+extra,time)).toThrow());
  it.each([undefined,NaN,Infinity,-0,1n,new Date(),{x:'\ud800'}])('rejects non portable JSON values',value=>expect(()=>erpPhpJson(value)).toThrow());
  it('uses independent AES-GCM key and connection/purpose AAD; never plaintext',async()=>{
    const codec=new ErpSecretCodec({ERP_CONFIG_KEY:Buffer.alloc(32,2).toString('base64url')}),cipher=await codec.seal('fixture-access-token','connectionA:access');
    expect(cipher).not.toContain('fixture-access-token');expect(await codec.open(cipher,'connectionA:access')).toBe('fixture-access-token');
    await expect(codec.open(cipher,'connectionB:access')).rejects.toThrow('密钥');await expect(codec.open(cipher,'connectionA:refresh')).rejects.toThrow('密钥');
  });
  it('rejects absent or malformed cipher configuration',()=>{
    expect(()=>new ErpSecretCodec({})).toThrow('密钥');expect(()=>new ErpSecretCodec({ERP_CONFIG_KEY:'public-key'})).toThrow('密钥');
  });
});
describe('single fixed provider transport; all responses synthetic',()=>{
  it('posts only the documented fixed POP endpoint and bounded form',async()=>{
    const calls:Array<{url:string;init:RequestInit}>=[];const provider=new ErpProviderClient(async(url,init)=>{calls.push({url,init});return json({code:0,data:{orders:[],has_next:false}});});
    expect(await provider.query('order',{appKey:'fixture-app',appSecret:'fixture-secret',accessToken:'fixture-token'},{o_ids:[12]},time)).toEqual({orders:[],has_next:false});
    expect(calls).toHaveLength(1);expect(calls[0].url).toBe('https://openapi.jushuitan.com/open/orders/single/query');
    expect(calls[0].init).toMatchObject({method:'POST',redirect:'manual'});expect(String(calls[0].init.body)).not.toContain('fixture-secret');
  });
  it.each([json({code:1,msg:'SECRET fixture-token',data:{}}),new Response('SECRET',{status:302,headers:{location:'https://evil.invalid'}}),
    new Response('{"code":0,"data":{},"data":{"secret":"BAD"}}',{headers:{'content-type':'application/json'}}),
    new Response('{"code":0,"data":{}}',{headers:{'content-type':'text/html'}}),
    new Response('{"code":0,"data":{}}',{headers:{'content-type':'application/json','content-length':'262145'}})])('fails closed and redacts invalid provider output',async(response)=>{
      const provider=new ErpProviderClient(async()=>response);await expect(provider.post('shops',{})).rejects.toThrow('供应商暂不可用');
  });
  it('bounds the streamed body even without Content-Length',async()=>{
    const provider=new ErpProviderClient(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(262145));controller.close();}}),{headers:{'content-type':'application/json'}}));
    await expect(provider.post('shops',{})).rejects.toThrow('供应商暂不可用');
  });
  it('keeps the timeout active across the complete response body',async()=>{
    vi.useFakeTimers();let calls=0;const provider=new ErpProviderClient(async()=>{calls++;return new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}});});
    const pending=provider.post('shops',{});const assertion=expect(pending).rejects.toThrow('供应商暂不可用');await vi.advanceTimersByTimeAsync(8000);await assertion;expect(calls).toBe(1);
  });
});
