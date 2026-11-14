/** Installed Browser, both production bundles and actual App/JWT/restricted
 * PG16 LOGIN. Declared historical orders and merchant state changes are local
 * fixtures; every successful buyer read/write comes from the real App. */
import { expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { storeOrderInvoice, user, userInvoice } from '@/models/schema';
import { storeOrderInvoiceEvidence } from '@/models/schema/invoice_evidence';
import { withBuyerInvoices } from '../helpers/buyerInvoices';

it('accepts both buyer invoice hubs, existing-order applications and immutable invoice details through installed Browser',async()=>withBuyerInvoices(async s=>{
  await s.seedOrder(850001,'invoice_order_pc');await s.seedOrder(850002,'invoice_order_uni');
  await s.f.db.update(userInvoice).set({isDel:1}).where(eq(userInvoice.id,1));
  const bearer=await s.token(),foreign=await s.token(22),control='/__buyer_invoices/'+crypto.randomUUID();
  const calls:Array<{surface:string;path:string;method:string;status:number}>=[],progress:Record<string,{saves:number;defaults:number;deletes:number;applications:number;issued:boolean;refused:boolean;changed:boolean}>={};
  let expected=await s.f.state(),failure='',revoked=false,recovered=false,finished=false;
  const baseline=await s.f.state();
  const protectedState=(value:unknown)=>Object.fromEntries(Object.entries(value as Record<string,unknown>)
    .filter(([key])=>!['user_invoice','store_order_invoice','store_order_invoice_evidence'].includes(key))
    .map(([key,rows])=>[key,key==='user'?(rows as Array<{row:Record<string,unknown>}>).map(item=>({row:{...item.row,status:item.row.uid===11?1:item.row.status}})):rows]));
  const immutableEvidence=new Map<string,string>();
  async function verifyEvidence(){
    const invoices=await s.f.db.select().from(storeOrderInvoice),records=await s.f.db.select().from(storeOrderInvoiceEvidence);
    expect(invoices.length).toBeLessThanOrEqual(2);const keys=new Set<string>();
    for(const invoice of invoices){
      const surface=invoice.orderId===850001?'pc':invoice.orderId===850002?'uni':'';expect(surface).not.toBe('');expect(invoice.uid).toBe(11);
      const owned=records.filter(row=>row.invoiceId===invoice.id);expect(owned).toHaveLength(progress[surface].issued?2:1);
      expect(owned.filter(row=>row.kind==='created')).toHaveLength(1);
      if(progress[surface].issued)expect(owned.filter(row=>row.kind==='issued')).toHaveLength(1);
      for(const row of owned){
        expect(row).toMatchObject({uid:11,orderId:invoice.orderId});expect(['created','issued']).toContain(row.kind);
        const snapshot=JSON.parse(row.snapshot);expect(snapshot).toMatchObject({v:1,invoice:{id:invoice.id,uid:11,order_id:invoice.orderId,category:'order',invoice_id:invoice.invoiceId,
          name:surface==='pc'?'本机买家甲改':'本机买家乙改',is_pay:1,invoice_amount:20,drawer_phone:'13800000000'}});
        if(row.kind==='created'){expect(row.documentNumber).toBe('');expect(snapshot.invoice).toMatchObject({is_invoice:0,invoice_number:'',remark:''});}
        else{expect(row.documentNumber).toBe('LOCAL-ISSUED-'+surface);expect(snapshot.invoice).toMatchObject({is_invoice:1,invoice_number:row.documentNumber,remark:'INTERNAL-MERCHANT-NOTE'});}
        const key=[row.invoiceId,row.kind,row.documentNumber].join(':'),serialized=JSON.stringify(row);keys.add(key);
        if(immutableEvidence.has(key))expect(serialized).toBe(immutableEvidence.get(key));else immutableEvidence.set(key,serialized);
      }
    }
    expect(records).toHaveLength(immutableEvidence.size);expect(keys.size).toBe(records.length);
    for(const key of immutableEvidence.keys())expect(keys.has(key)).toBe(true);
  }
  let done!:()=>void,fail!:(e:Error)=>void;const completion=new Promise<void>((yes,no)=>{done=yes;fail=no;});
  const state=()=>({calls,progress,revoked,recovered,finished});
  const send=(res:ServerResponse,body:string|Buffer,status=200,type='text/html; charset=utf-8')=>{res.writeHead(status,{'content-type':type,'cache-control':'private, no-store'});res.end(body);};
  const origins:Record<string,string>={},servers:Array<ReturnType<typeof createServer>>=[];
  for(const surface of ['pc','uni']){
    progress[surface]={saves:0,defaults:0,deletes:0,applications:0,issued:false,refused:false,changed:false};
    const root=resolve(import.meta.dirname,surface==='pc'?'../../../view/pc-ts/dist':'../../../view/uniapp-ts/dist/build/h5');expect((await stat(resolve(root,'index.html'))).isFile()).toBe(true);
    const server=createServer((req,res)=>{void(async()=>{
      const origin=origins[surface];if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
      const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method??'GET',p=progress[surface],orderId=surface==='pc'?850001:850002,orderNo='invoice_order_'+surface;
      if(path===control&&method==='GET')return send(res,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>买家发票 PG16 联合验收 ${surface}</title><style>body{margin:0;font:14px sans-serif;background:#edf0f4}nav{padding:8px;display:flex;gap:6px;flex-wrap:wrap}button{padding:6px}iframe{display:block;border:0;width:100%;height:calc(100vh - 100px)}pre{margin:0;font-size:11px;max-height:24px;overflow:auto}</style><nav>${['hub','order','foreign','issued','refused','changeTitle','fail','malformed','revoke','recover','finish'].map(name=>'<button id="'+name+'">'+name+'</button>').join('')}</nav><pre id="state">真实 App/JWT/SQL；本机历史订单和商家状态样本；无真实开票、支付或 Queue。</pre><iframe id="app" title="${surface} 正式构建页面"></iframe><script>
      const base=${JSON.stringify(control)};for(const name of ['hub','order','foreign'])document.getElementById(name).onclick=()=>{document.getElementById('app').src=base+'/bootstrap?entry='+name;};for(const name of ['issued','refused','changeTitle','fail','malformed','revoke','recover','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(base+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();};</script>`);
      if(path===control+'/bootstrap'){
        expect(method).toBe('GET');const entry=url.searchParams.get('entry');expect(['hub','order','foreign']).toContain(entry);
        const target=entry==='hub'?(surface==='pc'?'/user/invoice':'/#/pages/user/invoice'):entry==='order'?(surface==='pc'?'/order/'+orderNo:'/#/pages/order/detail?orderId='+orderNo):(surface==='pc'?'/user/invoice/order?orderId='+orderNo:'/#/pages/user/invoiceOrder?orderId='+orderNo);
        const token=entry==='foreign'?foreign:bearer,uid=entry==='foreign'?22:11;
        const storage=surface==='pc'?`sessionStorage.setItem('pc_token',${JSON.stringify(token)});sessionStorage.setItem('pc_uid','${uid}');`:`localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:${uid}}));`;
        return send(res,'<!doctype html><meta charset="utf-8"><script>'+storage+'location.replace('+JSON.stringify(target)+');</script>');
      }
      if(path.startsWith(control+'/')){
        expect(method).toBe('POST');expect(req.headers.origin).toBe(origin);
        if(path.endsWith('/fail'))failure='503';if(path.endsWith('/malformed'))failure='malformed';
        if(path.endsWith('/issued')||path.endsWith('/refused')){
          const issued=path.endsWith('/issued');const rows=await s.f.db.update(storeOrderInvoice).set({isInvoice:issued?1:-1,invoiceNumber:issued?'LOCAL-ISSUED-'+surface:'',invoiceTime:issued?1700000000:0,remark:issued?'INTERNAL-MERCHANT-NOTE':'本机样本：请核对税号'})
            .where(eq(storeOrderInvoice.orderId,orderId)).returning({id:storeOrderInvoice.id});expect(rows).toHaveLength(1);if(issued)p.issued=true;else p.refused=true;expected=await s.f.state();
        }
        if(path.endsWith('/changeTitle')){
          const [invoice]=await s.f.db.select().from(storeOrderInvoice).where(eq(storeOrderInvoice.orderId,orderId));expect(invoice).toBeDefined();
          await s.f.db.update(userInvoice).set({name:'本机后改抬头'+surface}).where(eq(userInvoice.id,invoice.invoiceId));p.changed=true;expected=await s.f.state();
        }
        if(path.endsWith('/revoke')){await s.f.db.update(user).set({status:0}).where(eq(user.uid,11));revoked=true;expected=await s.f.state();}
        if(path.endsWith('/recover')){await s.f.db.update(user).set({status:1}).where(eq(user.uid,11));recovered=true;expected=await s.f.state();}
        if(path.endsWith('/finish')){
          expect(revoked&&recovered).toBe(true);for(const name of ['pc','uni']){const r=progress[name];expect(r.saves).toBeGreaterThanOrEqual(3);expect(r.defaults).toBeGreaterThanOrEqual(1);expect(r.deletes).toBeGreaterThanOrEqual(1);expect(r.applications).toBe(1);expect(r.issued&&r.refused&&r.changed).toBe(true);}
          expect(calls.some(c=>c.status===503)).toBe(true);expect(calls.some(c=>[410000,410001,410002].includes(c.status))).toBe(true);
          expect(await s.f.state()).toEqual(expected);expect(protectedState(expected)).toEqual(protectedState(baseline));finished=true;await writeFile('/tmp/cinashop-buyer-invoices-browser-result.json',JSON.stringify(state(),null,2)+'\n');
        }
        await verifyEvidence();expect(protectedState(await s.f.state())).toEqual(protectedState(baseline));
        send(res,JSON.stringify(state()),200,'application/json');if(finished)done();return;
      }
      if(path==='/favicon.ico')return send(res,'',204);
      if(path.startsWith('/api/')){
        const invoice=url.searchParams.get('view')==='buyer';if(invoice&&failure==='503'){failure='';calls.push({surface,path,method,status:503});return send(res,JSON.stringify({status:503,msg:'Owned invoice read failure',data:null}),503,'application/json');}
        const chunks:Buffer[]=[];let bytes=0;for await(const part of req){const chunk=Buffer.from(part);bytes+=chunk.length;expect(bytes).toBeLessThanOrEqual(8192);chunks.push(chunk);}
        const headers=new Headers();for(let n=0;n<req.rawHeaders.length;n+=2)headers.append(req.rawHeaders[n]!,req.rawHeaders[n+1]!);
        if(method!=='GET')expect(['/api/invoice/save','/api/invoice/set_default/','/api/invoice/del/','/api/order/make_up_invoice'].some(prefix=>path.startsWith(prefix))).toBe(true);
        const response=await s.fetch(new Request(origin+req.url,{method,headers,...(chunks.length?{body:Buffer.concat(chunks).toString('utf8')}:{})}));let text=await response.text();const body=response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):null;
        calls.push({surface,path,method,status:body?.status??response.status});if(invoice){expect(response.headers.get('cache-control')).toContain('no-store');if(failure==='malformed'){failure='';expect(body.status).toBe(200);body.data.uid=22;text=JSON.stringify(body);}}
        if(method!=='GET'&&body?.status===200){if(path.includes('/invoice/save'))p.saves++;if(path.includes('/set_default/'))p.defaults++;if(path.includes('/invoice/del/'))p.deletes++;if(path.includes('/make_up_invoice')){
          p.applications++;const rows=await s.f.db.select().from(storeOrderInvoice).where(eq(storeOrderInvoice.orderId,orderId));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({uid:11,isPay:1,isInvoice:0,invoiceAmount:'20.00'});
        }expected=await s.f.state();}
        await verifyEvidence();expect(await s.f.state()).toEqual(expected);expect(protectedState(expected)).toEqual(protectedState(baseline));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(text);return;
      }
      expect(method).toBe('GET');const target=resolve(root,'.'+path);expect(target===root||target.startsWith(root+sep)).toBe(true);const file=await stat(target).catch(()=>null),selected=file?.isFile()?target:resolve(root,'index.html');
      send(res,await readFile(selected),200,({'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.ttf':'font/ttf'}as Record<string,string>)[extname(selected)]??'text/html; charset=utf-8');
    })().catch(e=>{if(!res.headersSent)send(res,'Owned fixture failed',500,'text/plain');fail(e);});});
    servers.push(server);await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const addr=server.address();if(!addr||typeof addr==='string')throw Error('Owned listener missing');origins[surface]='http://127.0.0.1:'+addr.port;
  }
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try{process.stdout.write('BUYER_INVOICES_BROWSER_READY '+JSON.stringify({pc:origins.pc+control,uni:origins.uni+control})+'\n');deadline=setTimeout(()=>fail(Error('Buyer invoices Browser finish missing')),35*60000);await completion;}
  finally{if(deadline)clearTimeout(deadline);for(const server of servers){server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}}
}),36*60000);
