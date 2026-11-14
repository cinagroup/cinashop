/** Installed Browser over both production bundles, actual App/JWT and separate
 * runtime LOGIN. Historical shipments and local carrier replies are explicit
 * isolated fixtures; all positive business responses come from the actual App. */
import { expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { storeOrder, user } from '@/models/schema';
import { withBuyerOrderTracking } from '../helpers/buyerOrderTracking';

it('accepts both buyer production logistics pages and return detail entries with native readonly business data',async()=>withBuyerOrderTracking(async s=>{
  await s.seedOrder();await s.seedRefund();await s.seedOrder(850001,'tracking_split',{pid:-1,deliveryType:'split'});
  await s.seedOrder(850002,'tracking_packet_A',{pid:850001,deliveryId:'PACKET-A'});await s.seedOrder(850003,'tracking_packet_B',{pid:850001,deliveryId:'PACKET-B'});await s.enableProvider();
  const bearer=await s.token(),control='/__buyer_tracking/'+crypto.randomUUID(),calls:Array<{surface:string;path:string;method:string;status:number}>=[];
  let expected=await s.state(),failure='',changed=false,revoked=false,recovered=false,finished=false;
  let done!:()=>void,fail!:(e:Error)=>void;const completion=new Promise<void>((yes,no)=>{done=yes;fail=no;});
  const state=()=>({calls,changed,revoked,recovered,finished,providerCalls:s.providerCalls});
  const send=(res:ServerResponse,body:string|Buffer,status=200,type='text/html; charset=utf-8')=>{res.writeHead(status,{'content-type':type,'cache-control':'private, no-store'});res.end(body);};
  const origins:Record<string,string>={},servers:Array<ReturnType<typeof createServer>>=[];
  for(const surface of ['pc','uni']){
    const root=resolve(import.meta.dirname,surface==='pc'?'../../../view/pc-ts/dist':'../../../view/uniapp-ts/dist/build/h5');expect((await stat(resolve(root,'index.html'))).isFile()).toBe(true);
    const server=createServer((req,res)=>{void(async()=>{
      const origin=origins[surface];if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
      const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method??'GET';
      if(path===control&&method==='GET')return send(res,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>买家物流 PG16 联合验收 ${surface}</title><style>body{margin:0;font:14px sans-serif;background:#edf0f4}nav{padding:8px;display:flex;gap:6px;flex-wrap:wrap}button{padding:6px}iframe{display:block;border:0;width:100%;height:calc(100vh - 100px)}pre{margin:0;font-size:11px;max-height:24px;overflow:auto}</style><nav>${['outgoing','returnDetail','split','fail','malformed','changeNo','revoke','recover','finish'].map(name=>'<button id="'+name+'">'+name+'</button>').join('')}</nav><pre id="state">真实 App/JWT/SQL；历史运单与本机承运商样本；无真实支付、物流或 Queue。</pre><iframe id="app" title="${surface} 正式构建页面"></iframe><script>
      const base=${JSON.stringify(control)};for(const name of ['outgoing','returnDetail','split'])document.getElementById(name).onclick=()=>{document.getElementById('app').src=base+'/bootstrap?entry='+name;};
      for(const name of ['fail','malformed','changeNo','revoke','recover','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(base+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();};</script>`);
      if(path===control+'/bootstrap'){
        expect(method).toBe('GET');const entry=url.searchParams.get('entry');expect(['outgoing','returnDetail','split']).toContain(entry);
        const id=entry==='split'?'tracking_split':'tracking_order_A',destination=surface==='pc'?(entry==='returnDetail'?'/user/refunds/840101':'/express?orderId='+id):(entry==='returnDetail'?'/#/pages/order/refundDetail?id=840101':'/#/pages/order/express?orderId='+id);
        const storage=surface==='pc'?`sessionStorage.setItem('pc_token',${JSON.stringify(bearer)});sessionStorage.setItem('pc_uid','11');`:`localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(bearer)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));`;
        return send(res,'<!doctype html><meta charset="utf-8"><script>'+storage+'location.replace('+JSON.stringify(destination)+');</script>');
      }
      if(path.startsWith(control+'/')){
        expect(method).toBe('POST');expect(req.headers.origin).toBe(origin);
        if(path.endsWith('/fail'))failure='503';if(path.endsWith('/malformed'))failure='malformed';
        if(path.endsWith('/changeNo')){await s.f.db.update(storeOrder).set({deliveryId:'OUTGOING-REFRESHED'}).where(eq(storeOrder.id,840001));changed=true;expected=await s.state();}
        if(path.endsWith('/revoke')){await s.f.db.update(user).set({status:0}).where(eq(user.uid,11));revoked=true;expected=await s.state();}
        if(path.endsWith('/recover')){await s.f.db.update(user).set({status:1}).where(eq(user.uid,11));recovered=true;expected=await s.state();}
        if(path.endsWith('/finish')){
          expect(changed&&revoked&&recovered).toBe(true);expect(await s.state()).toEqual(expected);
          for(const client of ['pc','uni']){expect(calls.some(c=>c.surface===client&&c.path.includes('/order/express/tracking_order_A')&&c.status===200)).toBe(true);expect(calls.some(c=>c.surface===client&&c.path.includes('/order/express/840101/refund')&&c.status===200)).toBe(true);expect(calls.some(c=>c.surface===client&&c.path.includes('/order/express/tracking_split')&&c.status===200)).toBe(true);}
          expect(calls.some(c=>c.status===503)).toBe(true);expect(calls.some(c=>c.status===410001||c.status===410000||c.status===410002)).toBe(true);finished=true;await writeFile('/tmp/cinashop-buyer-order-tracking-browser-result.json',JSON.stringify(state(),null,2)+'\n');
        }send(res,JSON.stringify(state()),200,'application/json');if(finished)done();return;
      }
      if(path==='/favicon.ico')return send(res,'',204);
      if(path.startsWith('/api/')){
        expect(method).toBe('GET');const tracking=path.startsWith('/api/order/express/');
        if(tracking&&failure==='503'){failure='';calls.push({surface,path,method,status:503});return send(res,JSON.stringify({status:503,msg:'Owned tracking read failure',data:null}),503,'application/json');}
        const headers=new Headers();for(let n=0;n<req.rawHeaders.length;n+=2)headers.append(req.rawHeaders[n]!,req.rawHeaders[n+1]!);
        const response=await s.fetch(new Request(origin+req.url,{method,headers}));let text=await response.text();const body=response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):null;
        calls.push({surface,path,method,status:body?.status??response.status});if(tracking){expect(response.headers.get('cache-control')).toContain('no-store');if(failure==='malformed'){failure='';expect(body.status).toBe(200);body.data.identity.uid=22;text=JSON.stringify(body);}}
        expect(await s.state()).toEqual(expected);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(text);return;
      }
      expect(method).toBe('GET');const target=resolve(root,'.'+path);expect(target===root||target.startsWith(root+sep)).toBe(true);const file=await stat(target).catch(()=>null),selected=file?.isFile()?target:resolve(root,'index.html');
      send(res,await readFile(selected),200,({'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.ttf':'font/ttf'}as Record<string,string>)[extname(selected)]??'text/html; charset=utf-8');
    })().catch(e=>{if(!res.headersSent)send(res,'Owned fixture failed',500,'text/plain');fail(e);});});
    servers.push(server);await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const addr=server.address();if(!addr||typeof addr==='string')throw Error('Owned listener missing');origins[surface]='http://127.0.0.1:'+addr.port;
  }
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try{process.stdout.write('BUYER_TRACKING_BROWSER_READY '+JSON.stringify({pc:origins.pc+control,uni:origins.uni+control})+'\n');deadline=setTimeout(()=>fail(Error('Buyer tracking Browser finish missing')),35*60000);await completion;}
  finally{if(deadline)clearTimeout(deadline);for(const server of servers){server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}}
}),36*60000);
