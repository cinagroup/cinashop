/** Installed Browser over production PC/H5 builds, actual App/UserJWT and a
 * commissioned PG16 LOGIN. Templates/carts/sequence IDs are declared local
 * samples. One negative response drops an already committed acknowledgement. */
import { expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { storeCart, storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderStatus, userInvoice } from '@/models/schema';
import { storeOrderInvoiceEvidence } from '@/models/schema/invoice_evidence';
import { withBuyerInvoices } from '../helpers/buyerInvoices';
import { invoiceTitleRevision } from '@/services/order/InvoiceTitlePolicy';
type Surface = 'pc' | 'uni';

it('accepts versioned checkout invoices and unknown-result same-key recovery in both production storefronts', async () => withBuyerInvoices(async s => {
  await s.f.db.update(userInvoice).set({ isDel: 1 }).where(eq(userInvoice.id,1));
  await s.f.db.insert(userInvoice).values([
    { id:2,uid:11,name:'本机结算个人',drawerPhone:'13800000000',email:'personal@example.invalid',isDefault:1 },
    { id:3,uid:11,name:'本机结算公司',headerType:2,type:2,dutyNumber:'A'.repeat(18),drawerPhone:'13900000000',email:'company@example.invalid',address:'本机注册地址',tell:'010-00000000',bank:'本机银行',cardNumber:'000123456789',isDefault:1 },
  ]);
  await s.f.db.insert(storeCart).values([
    { id:3,uid:11,productId:70,productAttrUnique:'qared001',cartNum:2,status:1,isNew:1 },
    { id:4,uid:11,productId:71,productAttrUnique:'runtim71',cartNum:1,status:1,isNew:1 },
  ]);
  let sequence = 0;
  Object.assign(s.env,{SEQUENCE:{idFromName:()=> 'owned-browser-invoice-sequence',get:()=>({fetch:async()=>new Response('browser_invoice_'+ ++sequence)})}});
  const baseline = await s.f.state(), originalTitles = await s.f.db.select().from(userInvoice);
  const selected = { pc:originalTitles.find(t=>t.id===2)!,uni:originalTitles.find(t=>t.id===3)! };
  const revisions = { pc:await invoiceTitleRevision(selected.pc),uni:await invoiceTitleRevision(selected.uni) };
  const bearer = await s.token(), foreign = await s.token(22), control = '/__checkout_invoices/'+crypto.randomUUID();
  const progress: Record<Surface,{ attempts:number;orderNo:string;key:string;payload:string;changed:boolean;lost:boolean;denied:boolean }> = {
    pc:{attempts:0,orderNo:'',key:'',payload:'',changed:false,lost:false,denied:false},uni:{attempts:0,orderNo:'',key:'',payload:'',changed:false,lost:false,denied:false},
  };
  const calls: Array<{surface:Surface;path:string;method:string;status:number;deliveredStatus:number}> = [];
  const evidence = new Map<number,string>();
  let finished = false, failure = '', loseNext = false, chain = Promise.resolve();
  const negatives = { readFailure:false, foreignDTO:false };
  const stable = (state: typeof baseline) => Object.fromEntries(Object.entries(state).filter(([key])=>!new Set([
    'user_invoice','store_cart','store_product','store_product_attr_value','store_order','store_order_cart_info','store_order_status',
    'store_order_invoice','store_order_invoice_evidence','store_order_purchase_origin','store_order_purchase_physical_origin',
  ]).has(key)));
  async function verify() {
    const state = await s.f.state(); expect(stable(state)).toEqual(stable(baseline));
    const orders = await s.f.db.select().from(storeOrder), invoices = await s.f.db.select().from(storeOrderInvoice);
    const count = Object.values(progress).filter(p=>p.orderNo).length;
    expect(orders).toHaveLength(count); expect(invoices).toHaveLength(count);
    const carts = await s.f.db.select().from(storeOrderCartInfo), statuses = await s.f.db.select().from(storeOrderStatus);
    expect(carts).toHaveLength(count*2); expect(statuses).toHaveLength(count);
    for (const surface of ['pc','uni'] as const) {
      const p=progress[surface], title=selected[surface]; if (!p.orderNo) continue;
      const order=orders.find(o=>o.orderId===p.orderNo)!;expect(order).toBeDefined();expect(order).toMatchObject({uid:11,paid:0,status:0,pid:0,unique:p.key,payPrice:'56.00',totalPrice:'50.00',payIntegral:0,useIntegral:'0.00'});
      expect(carts.filter(c=>c.oid===order.id).map(c=>[c.uid,c.productId,c.cartNum]).sort((a,b)=>a[1]!-b[1]!)).toEqual([[11,70,2],[11,71,1]]);
      expect(statuses.find(r=>r.oid===order.id)).toMatchObject({changeType:'cache_key_create_order'});
      const invoice=invoices.find(i=>i.orderId===order.id)!;expect(invoice).toMatchObject({uid:11,category:'order',invoiceId:title.id,name:title.name,headerType:title.headerType,type:title.type,dutyNumber:title.dutyNumber,drawerPhone:title.drawerPhone,email:title.email,address:title.address,tell:title.tell,bank:title.bank,cardNumber:title.cardNumber,isPay:0,isRefund:0,isInvoice:0,invoiceAmount:'56.00',invoiceNumber:'',remark:''});
    }
    const captured = await s.f.db.select().from(storeOrderInvoiceEvidence);expect(captured).toHaveLength(count);
    for(const row of captured){expect(row).toMatchObject({uid:11,kind:'created',documentNumber:''});const invoice=invoices.find(i=>i.id===row.invoiceId)!;expect(invoice).toBeDefined();expect(row.orderId).toBe(invoice.orderId);const data=JSON.parse(row.snapshot);expect(data).toMatchObject({v:1,invoice:{id:invoice.id,order_id:invoice.orderId,uid:11,invoice_id:invoice.invoiceId,name:invoice.name,invoice_amount:56,is_pay:0,is_invoice:0}});const bytes=JSON.stringify(row);if(evidence.has(row.invoiceId))expect(bytes).toBe(evidence.get(row.invoiceId));else evidence.set(row.invoiceId,bytes);}
    expect(evidence.size).toBe(count);
    const expectedTitles = (baseline.user_invoice as Array<{row:Record<string,unknown>}>).map(r=>{const surface=r.row.id===2?'pc':r.row.id===3?'uni':null;return{row:{...r.row,...(surface&&progress[surface].changed?{name:'本机后改抬头'+surface}:{})}};});expect(state.user_invoice).toEqual(expectedTitles);
    // Compare every cart/product/SKU field, allowing only the actual claimed
    // rows and stock/sales arithmetic for these four declared local carts.
    const completed = new Set(Object.entries(progress).filter(([,p])=>p.orderNo).flatMap(([name])=>name==='pc'?[1,2]:[3,4]));
    const expectedCarts = (baseline.store_cart as Array<{row:Record<string,unknown>}>).map(r=>({row:{...r.row,is_pay:completed.has(Number(r.row.id))?1:r.row.is_pay}}));
    expect(state.store_cart).toEqual(expectedCarts);
    for(const table of ['store_product','store_product_attr_value'] as const){
      const expected = (baseline[table] as Array<{row:Record<string,unknown>}>).map(r=>{const product=table==='store_product'?Number(r.row.id):Number(r.row.product_id),quantity=product===70?count*2:product===71?count:0;return{row:{...r.row,stock:Number(r.row.stock)-quantity,sales:Number(r.row.sales)+quantity}};});expect(state[table]).toEqual(expected);
    }
    for(const table of ['store_order_purchase_origin','store_order_purchase_physical_origin'])expect((state[table] as unknown[]).length).toBe(count);
  }
  let done!:()=>void, fail!:(e:Error)=>void;const completion=new Promise<void>((yes,no)=>{done=yes;fail=no;});
  const send=(res:ServerResponse,body:string|Buffer,status=200,type='text/html; charset=utf-8')=>{res.writeHead(status,{'content-type':type,'cache-control':'private, no-store'});res.end(body);};
  const servers:Array<ReturnType<typeof createServer>>=[], origins:Record<string,string>={};
  const state=()=>({calls,progress,negatives,finished});
  for(const surface of ['pc','uni'] as const){
    const root=resolve(import.meta.dirname,surface==='pc'?'../../../view/pc-ts/dist':'../../../view/uniapp-ts/dist/build/h5');expect((await stat(resolve(root,'index.html'))).isFile()).toBe(true);
    const server=createServer((req,res)=>{void(async()=>{
      const origin=origins[surface];if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
      const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method??'GET',p=progress[surface];
      if(path===control&&method==='GET')return send(res,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>结算发票真实链验收 ${surface}</title><style>body{margin:0;font:14px sans-serif;background:#edf0f4}nav{padding:8px;display:flex;gap:6px;flex-wrap:wrap}button{padding:6px}iframe{display:block;border:0;width:100%;height:calc(100vh - 100px)}pre{margin:0;font-size:11px;max-height:24px;overflow:auto}</style><nav>${['checkout','order','invoice','foreign','lose','failList','malformed','changeTitle','finish'].map(name=>'<button id="'+name+'">'+name+'</button>').join('')}</nav><pre id="state">实际 App/JWT/隔离 SQL，声明的本机购物车和抬头；没有真实支付、开票或 Queue。</pre><iframe id="app" title="${surface} 正式结算页面"></iframe><script>const base=${JSON.stringify(control)};for(const name of ['checkout','order','invoice','foreign'])document.getElementById(name).onclick=()=>{document.getElementById('app').src=base+'/bootstrap?entry='+name;};for(const name of ['lose','failList','malformed','changeTitle','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(base+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();};</script>`);
      if(path===control+'/bootstrap'){
        expect(method).toBe('GET');const entry=url.searchParams.get('entry');expect(['checkout','order','invoice','foreign']).toContain(entry);
        const cartIds=surface==='pc'?'1,2':'3,4', target=entry==='checkout'?(surface==='pc'?'/checkout?mode=buy&cartIds='+cartIds:'/#/pages/order/confirm?mode=buy&cartId='+cartIds):entry==='order'?(surface==='pc'?'/order/'+p.orderNo:'/#/pages/order/detail?orderId='+p.orderNo):(surface==='pc'?'/user/invoice/order?orderId='+p.orderNo:'/#/pages/user/invoiceOrder?orderId='+p.orderNo);
        const token=entry==='foreign'?foreign:bearer,uid=entry==='foreign'?22:11;
        const storage=surface==='pc'?`sessionStorage.setItem('pc_token',${JSON.stringify(token)});sessionStorage.setItem('pc_uid','${uid}');`:`localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:${uid}}));`;
        return send(res,'<!doctype html><meta charset="utf-8"><script>'+storage+'location.replace('+JSON.stringify(target)+');</script>');
      }
      if(path.startsWith(control+'/')){
        expect(method).toBe('POST');expect(req.headers.origin).toBe(origin);chain=chain.then(async()=>{
          if(path.endsWith('/lose'))loseNext=true;if(path.endsWith('/failList'))failure='503';if(path.endsWith('/malformed'))failure='malformed';
          if(path.endsWith('/changeTitle')){expect(p.orderNo).not.toBe('');await s.f.db.update(userInvoice).set({name:'本机后改抬头'+surface}).where(eq(userInvoice.id,selected[surface].id));p.changed=true;}
          await verify();
          if(path.endsWith('/finish')){expect(progress.pc.attempts).toBe(1);expect(progress.uni.attempts).toBe(2);expect(progress.uni.lost).toBe(true);expect(negatives).toEqual({readFailure:true,foreignDTO:true});expect(Object.values(progress).every(p=>p.orderNo&&p.changed&&p.denied)).toBe(true);expect(calls.some(c=>c.deliveredStatus===503)).toBe(true);expect(calls.some(c=>[410000,410001,410002,400,404].includes(c.status))).toBe(true);finished=true;await writeFile('/tmp/cinashop-checkout-invoices-browser-result.json',JSON.stringify(state(),null,2)+'\n');}
          send(res,JSON.stringify(state()),200,'application/json');if(finished)done();
        });await chain;return;
      }
      if(path==='/favicon.ico')return send(res,'',204);
      if(path==='/api/qa/image.svg')return send(res,'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#eee"/><text x="10" y="43" font-size="13">本机样本</text></svg>',200,'image/svg+xml');
      if(path.startsWith('/api/')){
        const chunks:Buffer[]=[];let bytes=0;for await(const part of req){const chunk=Buffer.from(part);bytes+=chunk.length;expect(bytes).toBeLessThanOrEqual(8192);chunks.push(chunk);}
        const headers=new Headers();for(let n=0;n<req.rawHeaders.length;n+=2)headers.append(req.rawHeaders[n]!,req.rawHeaders[n+1]!);
        chain=chain.then(async()=>{
          const isCreate=path.startsWith('/api/order/create/'),isTitle=path==='/api/invoice'&&url.searchParams.get('view')==='buyer';
          if(method!=='GET')expect(isCreate||path==='/api/order/confirm'||path.startsWith('/api/order/computed/')).toBe(true);
          const raw=Buffer.concat(chunks).toString('utf8');
          if(isCreate){p.attempts++;const key=path.split('/').at(-1)!;if(p.key)expect(key).toBe(p.key);else p.key=key;if(p.payload)expect(raw).toBe(p.payload);else p.payload=raw;const body=JSON.parse(raw);expect(body.invoiceId).toBe(selected[surface].id);expect(body.invoiceRevision).toBe(revisions[surface]);expect(body.cartIds).toEqual(surface==='pc'?[1,2]:[3,4]);expect(body).not.toHaveProperty('payType');}
          if(isTitle&&failure==='503'){failure='';negatives.readFailure=true;calls.push({surface,path,method,status:503,deliveredStatus:503});await verify();return send(res,JSON.stringify({status:503,msg:'Owned invoice read unavailable',data:null}),503,'application/json');}
          const response=await s.fetch(new Request(origin+req.url,{method,headers,...(raw?{body:raw}:{})}));let text=await response.text();const body=response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):null;
          if(isCreate&&body?.status===200){if(p.orderNo)expect(body.data.orderId).toBe(p.orderNo);else p.orderNo=body.data.orderId;}
          if(path.startsWith('/api/order/invoice_detail/')&&(headers.get('authori-zation')||headers.get('authorization')||'').replace(/^Bearer\s+/,'').trim()===foreign&&body?.status===404)p.denied=true;
          await verify();
          if(isTitle&&failure==='malformed'){failure='';negatives.foreignDTO=true;expect(body.status).toBe(200);body.data.uid=22;text=JSON.stringify(body);}
          if(isCreate&&body?.status===200&&loseNext){loseNext=false;p.lost=true;calls.push({surface,path,method,status:body.status,deliveredStatus:503});return send(res,JSON.stringify({status:503,msg:'本机样本：订单响应未送达，请确认原请求',data:null}),503,'application/json');}
          calls.push({surface,path,method,status:body?.status??response.status,deliveredStatus:response.status});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(text);
        });await chain;return;
      }
      expect(method).toBe('GET');const target=resolve(root,'.'+path);expect(target===root||target.startsWith(root+sep)).toBe(true);const file=await stat(target).catch(()=>null),selectedFile=file?.isFile()?target:resolve(root,'index.html');
      send(res,await readFile(selectedFile),200,({'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.ttf':'font/ttf'}as Record<string,string>)[extname(selectedFile)]??'text/html; charset=utf-8');
    })().catch(e=>{if(!res.headersSent)send(res,'Owned fixture failed',500,'text/plain');fail(e);});});
    servers.push(server);await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const addr=server.address();if(!addr||typeof addr==='string')throw Error('Owned listener missing');origins[surface]='http://127.0.0.1:'+addr.port;
  }
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try{process.stdout.write('CHECKOUT_INVOICES_BROWSER_READY '+JSON.stringify({pc:origins.pc+control,uni:origins.uni+control})+'\n');deadline=setTimeout(()=>fail(Error('Checkout invoice Browser finish missing')),35*60000);await completion;}
  finally{if(deadline)clearTimeout(deadline);for(const server of servers){server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}}
}),36*60000);
