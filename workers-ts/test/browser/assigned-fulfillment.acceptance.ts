/** Opt-in CUA host, no browser driver. Actual built Admin/Uni, registered
 * createApp/JWT and independent commissioned App/Admin/Manager LOGINs.
 * Session bootstrap, role toggles, response-loss and provider transport are
 * labelled QA controls. All assignment and fulfillment writes use product UI. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemAdmin, systemRole, systemStoreStaff, storeOrder, storeOrderCartInfo, storeOrderOutbox,
  storeProduct, storeProductAttrValue, orderNotificationDelivery } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { OrderOutboxService, isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { managerAssignedFulfillmentFixture, ASSIGNED_APP, ASSIGNED_PAYER, ASSIGNED_SHIPPING_SECRET, ASSIGNED_CARRIER } from '../helpers/managerAssignedFulfillmentFixture';

const wiring = vi.hoisted(() => ({ application: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  // Only the ordinary environment binding is selected here. Both operation
  // middleware factories remain actual and open their separate native LOGINs.
  createContainer: () => { if (!wiring.application) throw Error('Owned App binding absent'); return wiring.application; },
}));
type Row = Record<string, any>;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
async function files(dir: string): Promise<string[]> { return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e => e.isDirectory()
  ? files(resolve(dir,e.name)) : [resolve(dir,e.name)]))).flat().sort(); }
async function body(req: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; let size=0; for await (const part of req) {
  const b=Buffer.from(part); size+=b.length; if(size>16384)throw Error('Owned Browser request too large'); chunks.push(b);
} return Buffer.concat(chunks); }
function json(res: ServerResponse, value: unknown, status = 200) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value)); }

it('actual assignment and whole express UI recover real committed lost responses on owned PG16', async () => {
  const f = await managerAssignedFulfillmentFixture(), repository=resolve(import.meta.dirname,'../../..');
  const output = '/tmp/cinashop-assigned-fulfillment-browser-' + randomUUID(); await mkdir(output,{mode:0o700});
  const control='/__assigned_qa/'+randomUUID(), servers: Array<ReturnType<typeof createServer>>=[], origins: Record<string,string>={};
  const calls: Row[]=[], checkpoints: Row[]=[], staticPaths=new Set<string>(), failures: string[]=[], sourcePaths: string[]=[];
  let lostAdmin=false,lostManager=false,roleOff=false,staffOff=false,uploads=0,queueStarted=false,finished=false;
  let timer: ReturnType<typeof setTimeout> | undefined, complete!:()=>void, fail!: (reason:Error)=>void;
  const completion=new Promise<void>((yes,no)=>{complete=yes;fail=no;}); let network: ReturnType<typeof vi.spyOn<typeof globalThis,'fetch'>>|undefined;
  try {
    network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No external transport in owned assignment Browser'));
    // Only identity setup. No assignment, paid/cart/outbox or fulfillment row
    // is seeded here; two normal paid roots come from actual existing writers.
    await f.maintenanceDb.insert(systemRole).values({id:777,roleName:'分配浏览器作者',rules:'order.manage',status:1});
    await f.maintenanceDb.insert(systemAdmin).values([2,3].map(id=>({id,account:'owned-assignment-browser-'+id,
      pwd:'offline-native-admin-password',realName:'本机分配验收',level:1,roles:'777',adminType:1,relationId:0,status:1,isDel:0})));
    const orderA=await f.paid(),orderB=await f.paid(),beforeA=await f.actual(orderA.id),beforeB=await f.actual(orderB.id);
    const cartsBefore=await f.maintenanceDb.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id);
    const stockBefore={products:await f.maintenanceDb.select().from(storeProduct).orderBy(storeProduct.id),
      sku:await f.maintenanceDb.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id)};
    const token=(await createToken(2,'admin',md5('offline-native-admin-password'),f.env.APP_KEY)).token;
    const managerToken=(await createToken(103,'api',md5('owned-financial-password'),f.env.APP_KEY)).token;
    const adminSession=(allowed:boolean)=>({userInfo:{id:2,account:'owned-assignment-browser-2',head_pic:'',real_name:'本机分配验收',level:1,roles:allowed?'777':''},
      menus:[{id:1,pid:0,path:'/order',name:'订单管理',icon:'',sort:1,type:1,children:[]}],uniqueAuth:allowed?['order.view','order.manage']:[]});
    wiring.application=f.application();const app=createApp();
    for(const dir of ['workers-ts/src','workers-ts/test/helpers','view/admin-ts/src','view/admin-ts/public','view/uniapp-ts/src','view/common'])sourcePaths.push(...await files(resolve(repository,dir)));
    sourcePaths.push(resolve(repository,'workers-ts/test/browser/assigned-fulfillment.acceptance.ts'),resolve(repository,'workers-ts/vitest.assigned-fulfillment-browser.config.ts'));
    const fingerprint=async()=>Promise.all([...new Set(sourcePaths)].sort().map(async path=>({path:path.slice(repository.length+1),sha256:hash(await readFile(path))})));
    const sources=await fingerprint(), builds: Record<string,unknown>={};
    const buildFingerprint=async(kind:'admin'|'uni')=>{const dist=resolve(repository,kind==='admin'?'view/admin-ts/dist':'view/uniapp-ts/dist/build/h5');
      return Promise.all((await files(dist)).map(async path=>({path:path.slice(dist.length+1),sha256:hash(await readFile(path))})));};
    const assignments=async(id:number)=>Array.from(await f.maintenanceDb.execute<{row:Row}>(sql`SELECT to_jsonb(t) AS row FROM public.store_order_fulfillment_assignment t WHERE order_id=${id} ORDER BY ordinal`),r=>r.row);
    const managerRows=async()=>Array.from(await f.maintenanceDb.execute<{row:Row}>(sql`SELECT to_jsonb(t) AS row FROM public.manager_assigned_fulfillment_request t ORDER BY order_id`),r=>r.row);
    const verifyFinance=async()=>{expect(await f.maintenanceDb.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id)).toEqual(cartsBefore);
      expect(await f.maintenanceDb.select().from(storeProduct).orderBy(storeProduct.id)).toEqual(stockBefore.products);
      expect(await f.maintenanceDb.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id)).toEqual(stockBefore.sku);
      expect(await f.actual(orderA.id)).toEqual(beforeA);const actualB=await f.actual(orderB.id);
      expect(actualB).toEqual(actualB.status===0?beforeB:{...beforeB,status:1,deliveryType:'express',deliveryName:ASSIGNED_CARRIER.name,
        deliveryCode:ASSIGNED_CARRIER.code,deliveryId:'UI-ASSIGNED-REAL-001',deliveryUid:0,fictitiousContent:''});};
    async function ship() {
      expect(queueStarted).toBe(false);queueStarted=true;await f.configure(true);
      const rows=await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId,orderB.id),eq(storeOrderOutbox.eventType,'order.delivery.notice')));
      expect(rows).toHaveLength(1);const event=rows[0],outbox=new OrderOutboxService(f.application(),f.env),consumer=new OrderNotificationDeliveryService(f.application(),f.env);
      expect((await outbox.dispatchById(event.id)).enqueued).toBe(1);
      const message=f.messages.filter(isOrderNotificationOutboxMessage).find(m=>m.outboxId===event.id);expect(message).toBeDefined();
      expect(await outbox.processMessage(message!)).toBe('completed');
      await consumer.dispatchPending(20,event.eventKey);
      const [delivery]=await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey,event.eventKey),eq(orderNotificationDelivery.channel,'wechat_shipping')));
      expect(delivery).toBeDefined();const next=f.messages.filter(isOrderNotificationDeliveryMessage).find(m=>m.deliveryId===delivery.id&&m.channel==='wechat_shipping');expect(next).toBeDefined();
      network!.mockImplementation(async(urlInput,init)=>{const url=new URL(String(urlInput));expect(url.origin).toBe('https://api.weixin.qq.com');
        if(url.pathname==='/cgi-bin/token'){expect(url.searchParams.get('appid')).toBe(ASSIGNED_APP);expect(url.searchParams.get('secret')).toBe(ASSIGNED_SHIPPING_SECRET);return Response.json({access_token:'synthetic-owned-assignment-browser-token',expires_in:7200});}
        expect(url.searchParams.get('access_token')).toBe('synthetic-owned-assignment-browser-token');
        if(url.pathname.endsWith('/get_delivery_list'))return Response.json({errcode:0,errmsg:'ok',count:1,delivery_list:[{delivery_id:ASSIGNED_CARRIER.code,delivery_name:ASSIGNED_CARRIER.name}]});
        expect(url.pathname).toBe('/wxa/sec/order/upload_shipping_info');uploads++;
        const request=JSON.parse(String(init?.body));expect(request).toMatchObject({order_key:{transaction_id:beforeB.tradeNo},payer:{openid:ASSIGNED_PAYER},
          logistics_type:1,delivery_mode:1,shipping_list:[{tracking_no:'UI-ASSIGNED-REAL-001',express_company:ASSIGNED_CARRIER.code}]});
        await f.withMaintenancePeer(async peer=>{await peer.transaction(async tx=>{expect(await tx.select({id:storeOrder.id}).from(storeOrder).where(eq(storeOrder.id,orderB.id)).for('update',{noWait:true})).toHaveLength(1);});});
        return Response.json({errcode:0,errmsg:'ok'});
      });
      expect(await consumer.processMessage(next!)).toBe('sent');expect(await consumer.processMessage(next!)).toBe('already-sent');expect(uploads).toBe(1);
      const [sent]=await f.maintenanceDb.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id,delivery.id));expect(sent.status).toBe('SENT');
      const actual=await managerRows();expect(actual).toHaveLength(1);expect(actual[0].delivery_payload_hash).toBe(await outRequestHash(event.payload));
      const [dispatch]=await f.maintenanceDb.execute<{actor:Row;identity:Row}>(sql`SELECT payload->'actor' AS actor,payload->'identity' AS identity FROM public.routine_shipping_dispatch WHERE delivery_id=${delivery.id}`);
      expect(dispatch.actor.role).toBe(f.appRuntime.role);expect(dispatch.identity).toMatchObject({appId:ASSIGNED_APP,payerId:ASSIGNED_PAYER,rootId:orderB.id});
    }
    const stages=['admin-lost','admin-owner','admin-reassigned','admin-revoked','admin-second','manager-lost','manager-owner','uploaded','finished'];
    let stageIndex=0;
    async function checkpoint(name:string,data:Row) {
      expect(name).toBe(stages[stageIndex]);await verifyFinance();
      const first=await assignments(orderA.id),second=await assignments(orderB.id),manager=await managerRows();
      if(name==='admin-lost'){expect(first).toHaveLength(1);expect(first[0]).toMatchObject({actor_id:2,target_store_id:77,kind:'grant'});expect(data.text).toContain('待确认');}
      if(name==='admin-owner'){expect(first).toHaveLength(1);expect(roleOff).toBe(true);expect(data.text).toContain('已记录');}
      if(name==='admin-reassigned'){expect(first).toHaveLength(2);expect(first[1]).toMatchObject({actor_id:2,target_store_id:78,kind:'grant',previous_ref:first[0].operation_id});}
      if(name==='admin-revoked'){expect(first).toHaveLength(3);expect(first[2]).toMatchObject({kind:'revoke',target_store_id:78,previous_ref:first[1].operation_id});}
      if(name==='admin-second'){expect(second).toHaveLength(1);expect(second[0]).toMatchObject({actor_id:2,target_store_id:77,kind:'grant'});}
      if(name==='manager-lost'||name==='manager-owner'){expect(manager).toHaveLength(1);expect(manager[0]).toMatchObject({actor_uid:103,order_id:orderB.id,target_store_id:77,financial_store_id:0});
        expect(await f.actual(orderB.id)).toMatchObject({status:1,deliveryId:'UI-ASSIGNED-REAL-001',storeId:0,supplierId:0});
        if(name==='manager-lost')expect(data.text).toContain('需核对');else{expect(staffOff).toBe(true);expect(data.text).toContain('原发货记录已确认');}}
      if(name==='uploaded'){await ship();expect(uploads).toBe(1);}
      if(name==='finished'){
        expect(stageIndex).toBe(stages.length-1);expect(first).toHaveLength(3);expect(second).toHaveLength(1);expect(manager).toHaveLength(1);expect(uploads).toBe(1);
        expect(await fingerprint()).toEqual(sources);
        for(const kind of ['admin','uni'] as const)expect(await buildFingerprint(kind)).toEqual(builds[kind]);finished=true;
        await writeFile(resolve(output,'evidence.json'),JSON.stringify({stages:[...checkpoints,{name,...data,managerReceiptCount:manager.length}],calls,staticPaths:[...staticPaths],sources,builds,orders:{a:orderA.id,b:orderB.id},uploads,
          identities:await Promise.all([f.appRuntime,f.adminRuntime,f.managerRuntime,f.financialRuntime,f.cashierRuntime].map(p=>p.verify())),
          boundary:'Actual built DOM/createApp/JWT, independently authenticated commissioned App/Admin/Manager SQL, real checkout/default RSA-AES callback/paid consumers and UI-authored grants/delivery. Local session bootstrap/role toggles/committed response loss and provider/Queue/KV transport are labelled controls. No production, real login-form, Hyperdrive/workerd/device or real WeChat claim. App does not independently validate Manager assignment.'},null,2)+'\n',{mode:0o600});
      }
      checkpoints.push({name,...data,assignmentA:first.map(r=>({operation_id:r.operation_id,ordinal:r.ordinal,kind:r.kind,target_store_id:r.target_store_id})),assignmentB:second.map(r=>({operation_id:r.operation_id,ordinal:r.ordinal,kind:r.kind})),managerReceiptCount:manager.length});stageIndex++;
      return {checked:name,next:stages[stageIndex]??null};
    }
    let queue=Promise.resolve();
    for(const kind of ['admin','uni'] as const){
      const dist=resolve(repository,kind==='admin'?'view/admin-ts/dist':'view/uniapp-ts/dist/build/h5');
      builds[kind]=await buildFingerprint(kind);expect((builds[kind]as unknown[]).length).toBeGreaterThan(20);
      const shell=()=>`<!doctype html><html lang="zh"><meta charset="utf-8"><title>本机分配履约验收</title><style>body{font:14px sans-serif;margin:10px}button{margin:4px;padding:7px}iframe{display:block;width:100%;height:780px;border:1px solid #ccc;box-sizing:border-box}pre{white-space:pre-wrap;max-height:70px;overflow:auto}</style>
<h1>本机分配履约验收 · ${kind==='admin'?'Admin':'Manager'}</h1>
${kind==='admin'?`<button data-entry="a">打开第一笔订单详情</button><button data-entry="b">打开第二笔订单详情</button><button data-role="off">移除Admin角色（仅验收）</button><button data-role="on">恢复Admin角色（仅验收）</button><button data-entry="owner">原作者最小恢复页</button><button data-loss="admin">下一次批准响应丢失（仅验收）</button>`:
`<button data-entry="manager">打开Manager分配待办</button><button data-staff="off">移除店长角色（仅验收）</button><button data-staff="on">恢复店长角色（仅验收）</button><button data-loss="manager">下一次发货响应丢失（仅验收）</button>`}
<div>${stages.map(s=>`<button data-check="${s}">核对 ${s}</button>`).join('')}</div><pre id="qa-result"></pre><iframe title="实际${kind==='admin'?'Admin':'Manager'}页面"></iframe><script>
const frame=document.querySelector('iframe'),control=${JSON.stringify(control)},token=${JSON.stringify(token)},managerToken=${JSON.stringify(managerToken)},session=${JSON.stringify(adminSession(true))},ownerSession=${JSON.stringify(adminSession(false))};
const request=async(name,data={})=>{const r=await fetch(control+'/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const body=await r.json();document.getElementById('qa-result').textContent=JSON.stringify(body);return body;};
for(const b of document.querySelectorAll('[data-entry]'))b.onclick=()=>{const k=b.dataset.entry;if(k==='manager'){localStorage.setItem('uni_token',JSON.stringify({type:'string',data:managerToken}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:103}));frame.src='/?qa_reload='+Date.now()+'#/pages/merchant/assignedOrders?store_id=77';}else{localStorage.setItem('admin_token',token);localStorage.setItem('admin_session',JSON.stringify(k==='owner'?ownerSession:session));frame.src=k==='owner'?'/order/fulfillment-assignment?order_id=${orderA.id}':k==='b'?'/order/${orderB.orderId}':'/order/${orderA.orderId}';}};
for(const b of document.querySelectorAll('[data-role]'))b.onclick=()=>request('admin-role',{enabled:b.dataset.role==='on'});for(const b of document.querySelectorAll('[data-staff]'))b.onclick=()=>request('manager-role',{enabled:b.dataset.staff==='on'});for(const b of document.querySelectorAll('[data-loss]'))b.onclick=()=>request('loss',{kind:b.dataset.loss});
for(const b of document.querySelectorAll('[data-check]'))b.onclick=()=>{const d=frame.contentDocument;return request('checkpoint',{name:b.dataset.check,text:d?.body?.innerText??'',width:d?.documentElement.clientWidth??0,scrollWidth:d?.documentElement.scrollWidth??0,href:frame.contentWindow.location.href});};</script></html>`;
      const server=createServer((req,res)=>{void(async()=>{
        if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origins[kind]).host){res.writeHead(403);res.end();return;}
        const url=new URL(req.url??'/',origins[kind]);res.setHeader('Cache-Control','no-store');
        if(req.method==='GET'&&url.pathname===control){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(shell());return;}
        if(req.method==='POST'&&url.pathname.startsWith(control+'/')){
          if(req.headers.origin!==origins[kind])throw Error('Owned QA controls require same-origin UI');
          const value=JSON.parse((await body(req)).toString())as Row,operation=url.pathname.slice(control.length+1);
          queue=queue.then(async()=>{if(operation==='admin-role'){expect(typeof value.enabled).toBe('boolean');await f.maintenanceDb.update(systemAdmin).set({roles:value.enabled?'777':''}).where(eq(systemAdmin.id,2));roleOff=!value.enabled;json(res,{adminRole:!roleOff});}
            else if(operation==='manager-role'){expect(typeof value.enabled).toBe('boolean');await f.maintenanceDb.update(systemStoreStaff).set({isManager:value.enabled?1:0,isAdmin:0}).where(eq(systemStoreStaff.id,901));staffOff=!value.enabled;json(res,{managerRole:!staffOff});}
            else if(operation==='loss'){expect(['admin','manager']).toContain(value.kind);if(value.kind==='admin')lostAdmin=true;else lostManager=true;json(res,{nextCommittedResponseLost:value.kind});}
            else if(operation==='checkpoint'){const result=await checkpoint(value.name,value);if(finished)res.once('finish',complete);json(res,result);}else throw Error('Unknown owned control');});await queue;return;
        }
        if(url.pathname==='/api/site_config'&&req.method==='GET'){json(res,{status:200,msg:'Synthetic shell branding only',data:{site_name:'本机分配验收',site_logo:'',site_logo_square:'',login_logo:'',ico_path:'',record_No:'',admin_login_slide:[]}});return;}
        if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/adminapi/')){
          const raw=await body(req),headers=new Headers();for(let i=0;i<req.rawHeaders.length;i+=2)headers.append(req.rawHeaders[i],req.rawHeaders[i+1]);
          queue=queue.then(async()=>{const jobs:Promise<unknown>[]=[];const response=await app.fetch(new Request(origins[kind]+url.pathname+url.search,{method:req.method,headers,...(raw.length?{body:new Uint8Array(raw)}:{})}),f.env,
            {waitUntil:(p:Promise<unknown>)=>jobs.push(p),passThroughOnException(){}}as unknown as ExecutionContext);await Promise.all(jobs);
            const bytes=Buffer.from(await response.arrayBuffer());let parsed:Row={};try{parsed=JSON.parse(bytes.toString());}catch{/* Preserve actual nonJSON. */}
            const entry:Row={kind,path:url.pathname,method:req.method,status:response.status,envelopeStatus:parsed.status,sha256:hash(bytes),bytes:bytes.length};
            const drop=req.method==='POST'&&parsed.status===200&&((url.pathname==='/adminapi/order/fulfillment_assignment/commit'&&lostAdmin)||(url.pathname==='/api/store/manager/assigned-order/commit'&&lostManager));
            if(drop){entry.labelledCommittedResponseLoss=true;if(url.pathname.includes('/adminapi/'))lostAdmin=false;else lostManager=false;calls.push(entry);json(res,{status:503,msg:'Owned QA lost committed response',data:null},503);}
            else{calls.push(entry);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(bytes);}});await queue;return;
        }
        if(req.method!=='GET')throw Error('Unexpected static write');if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
        let target=resolve(dist,'.'+decodeURIComponent(url.pathname));if(target!==dist&&!target.startsWith(dist+sep))throw Error('Static path escapes owned build');
        try{if(target===dist||!(await stat(target)).isFile())target=resolve(dist,'index.html');}catch{target=resolve(dist,'index.html');}
        staticPaths.add(kind+':'+target.slice(dist.length+1));res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}as Record<string,string>)[extname(target)]??'application/octet-stream'});res.end(await readFile(target));
      })().catch(reason=>{failures.push(reason instanceof Error?reason.message:String(reason));fail(reason instanceof Error?reason:Error(String(reason)));if(!res.headersSent)json(res,{error:'Owned acceptance failure'},500);else res.destroy();});});
      servers.push(server);await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
      const address=server.address();if(!address||typeof address==='string')throw Error('Owned HTTP port absent');origins[kind]='http://127.0.0.1:'+address.port;
    }
    const ready={admin:origins.admin+control,manager:origins.uni+control,output,stages,orders:{a:orderA.id,b:orderB.id},windowSeconds:360,
      boundary:'Two actual build origins; synthetic shell sessions/roles/response loss only. Use real product DOM for every business mutation.'};
    await writeFile(resolve(output,'ready.json'),JSON.stringify(ready,null,2)+'\n',{mode:0o600});console.log('ASSIGNED_FULFILLMENT_BROWSER_READY '+JSON.stringify(ready));
    timer=setTimeout(()=>fail(Error('Owned six-minute Browser completion absent')),360000);await completion;await queue;expect(failures).toEqual([]);expect(finished).toBe(true);
  } finally {
    if(timer)clearTimeout(timer);for(const server of servers){server.closeAllConnections();if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));}
    wiring.application=undefined;network?.mockRestore();await f.close();
  }
},9*60000);
