/** Production Admin bundle + installed in-app Browser + genuine App/JWT/PG16. */
import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue, systemRole, user } from '@/models/schema';
import { withEditScenario } from '../helpers/adminOrderEdit';

it('edits six fields, reloads a lost acknowledgement, saves once, rejects a stale revision and withdraws the manager', async () => {
  const root=resolve(import.meta.dirname,'../../../view/admin-ts/dist');expect((await stat(resolve(root,'index.html'))).isFile()).toBe(true);
  await withEditScenario(async s=>{
    await s.f.db.update(storeProduct).set({image:''}); await s.f.db.update(storeProductAttrValue).set({image:''});
    const order=await s.checkout(),id=order.id,control='/__admin_order_edit_fixture/'+crypto.randomUUID();
    const before=(await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,id)))[0];
    const buyer=await s.f.db.select().from(user).where(eq(user.uid,11));
    const originalCarts=await s.f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id));
    const paths:Array<{method:string;path:string;status:number;envelope?:number}>=[];
    let origin='',dropNext=false,dropped=false,stale=false,withdrawn=false,finished=false;
    let finish!:()=>void,fail!:(error:Error)=>void;
    const completion=new Promise<void>((yes,no)=>{finish=yes;fail=no;});
    const state=async()=>({paths,dropped,stale,withdrawn,finished,order:(await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,id)))[0],
      operations:await s.f.exec(`SELECT actor_id,supplier_id,order_id,result FROM admin_order_edit_operation_v1 WHERE order_id=${id} ORDER BY (evidence->>'status_id')::integer`)});
    const session={userInfo:{id:102,account:'remark-manager',head_pic:'',real_name:'本机订单管理员',level:1,roles:'820001'},menus:[],uniqueAuth:['order.view','order.manage']};
    const send=(res:import('node:http').ServerResponse,body:string|Buffer,status=200,type='text/html; charset=utf-8')=>{
      res.writeHead(status,{'Content-Type':type,'Cache-Control':'private, no-store'});res.end(body);
    };
    const server=createServer((req,res)=>{void(async()=>{
      if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
      const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method??'GET';
      if(path===control&&method==='GET')return send(res,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>管理员六字段订单编辑 PG16 验收</title><h1>管理员订单编辑联合验收</h1><p>真实 App、JWT、独立受限 LOGIN、本机合成订单。</p><button id="login">进入待付款订单详情</button><button id="drop">丢弃下一次保存响应</button><button id="stale">令已打开表单过期</button><button id="withdraw">撤销管理权限</button><button id="readonly">切换只读界面</button><button id="status">读取 SQL 状态</button><button id="finish">完成并关闭夹具</button><pre id="state"></pre><script>
        const session=${JSON.stringify(session)};document.getElementById('login').onclick=()=>{localStorage.setItem('admin_token',${JSON.stringify(s.token('manager'))});localStorage.setItem('admin_session',JSON.stringify(session));location.href=${JSON.stringify('/order/'+order.orderId)};};
        document.getElementById('readonly').onclick=()=>{localStorage.setItem('admin_token',${JSON.stringify(s.token('manager'))});session.uniqueAuth=['order.view'];localStorage.setItem('admin_session',JSON.stringify(session));window.dispatchEvent(new Event('admin-session-changed'));location.href=${JSON.stringify('/order/'+order.orderId)};};
        for(const name of ['drop','stale','withdraw','status','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(${JSON.stringify(control)}+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();};</script>`);
      if(path.startsWith(control+'/')){
        expect(method).toBe('POST');expect(req.headers.origin).toBe(origin);
        if(path.endsWith('/drop'))dropNext=true;
        if(path.endsWith('/stale')){await s.f.db.update(storeOrder).set({remark:'Owned independent revision'}).where(eq(storeOrder.id,id));stale=true;}
        if(path.endsWith('/withdraw')){await s.f.db.update(systemRole).set({rules:'order.view'}).where(eq(systemRole.id,820001));withdrawn=true;}
        if(path.endsWith('/finish')){
          const after=(await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,id)))[0],carts=await s.f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id));
          expect(after).toEqual({...before,payPrice:'19.00',changePrice:(Number(before.payPrice)+Number(before.changePrice)-19).toFixed(2),gainIntegral:'19.00',remark:'Owned independent revision'});
          expect(carts.reduce((sum,row)=>sum+Number(JSON.parse(row.cartInfo!).gain_integral),0)).toBe(19);
          for(const row of carts){const prior=originalCarts.find(value=>value.id===row.id)!;expect({...row,cartInfo:prior.cartInfo}).toEqual(prior);
            const a=JSON.parse(prior.cartInfo!),b=JSON.parse(row.cartInfo!);delete a.gain_integral;delete b.gain_integral;expect(b).toEqual(a);}
          expect(await s.f.db.select().from(user).where(eq(user.uid,11))).toEqual(buyer);
          const result=await state();expect(result.operations).toHaveLength(2);expect(result.operations.every(row=>row.actor_id===102&&row.order_id===id)).toBe(true);
          const puts=paths.filter(row=>row.method==='PUT'&&row.path===`/adminapi/order/update/${id}`);
          expect(puts).toHaveLength(4);expect(puts.filter(row=>row.envelope===200)).toHaveLength(2);expect(puts.some(row=>row.envelope===409)).toBe(true);
          expect(puts.some(row=>row.envelope!==200&&row.envelope!==409)).toBe(true);expect(dropped&&stale&&withdrawn).toBe(true);finished=true;
          await writeFile('/tmp/cinashop-admin-order-edit-browser-result.json',JSON.stringify(await state(),null,2)+'\n');
        }
        send(res,JSON.stringify(await state()),200,'application/json');if(finished)finish();return;
      }
      if(path==='/favicon.ico')return send(res,'',204);
      if(path.startsWith('/adminapi/')||path.startsWith('/api/')){
        const chunks:Buffer[]=[];let length=0;for await(const chunk of req){length+=chunk.length;expect(length).toBeLessThanOrEqual(16384);chunks.push(Buffer.from(chunk));}
        const bytes=Buffer.concat(chunks),headers=new Headers();for(let i=0;i<req.rawHeaders.length;i+=2)headers.append(req.rawHeaders[i]!,req.rawHeaders[i+1]!);
        const response=await s.fetch(new Request(origin+req.url,{method,headers,...(bytes.length?{body:new Uint8Array(bytes).buffer}:{})})),text=await response.text();
        const body=response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):null;
        paths.push({method,path,status:response.status,...(body?{envelope:body.status}:{})});
        if(dropNext&&method==='PUT'&&path===`/adminapi/order/update/${id}`&&body?.status===200){dropNext=false;dropped=true;return send(res,JSON.stringify({status:502,msg:'Owned committed acknowledgement deliberately discarded',data:null}),502,'application/json');}
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(text);return;
      }
      if(path.startsWith('/uploads/'))return send(res,'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#d9edf3"/></svg>',200,'image/svg+xml');
      const target=path.startsWith('/assets/')?resolve(root,'.'+path):resolve(root,'index.html');expect(target===resolve(root,'index.html')||target.startsWith(root+sep)).toBe(true);
      send(res,await readFile(target),200,({'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'} as Record<string,string>)[extname(target)]??'text/html; charset=utf-8');
    })().catch(error=>{send(res,'Owned fixture failed',500,'text/plain');fail(error);});});
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try{
      await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();if(!address||typeof address==='string')throw Error('Missing owned loopback address');origin=`http://127.0.0.1:${address.port}`;
      process.stdout.write('ADMIN_ORDER_EDIT_BROWSER_READY '+JSON.stringify({control:origin+control,detail:origin+'/order/'+order.orderId})+'\n');
      deadline=setTimeout(()=>fail(Error('Admin order edit Browser finish not received')),15*60_000);await completion;
      process.stdout.write('ADMIN_ORDER_EDIT_BROWSER_RESULT '+JSON.stringify(await state())+'\n');
    }finally{if(deadline)clearTimeout(deadline);server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}
  });
},16*60_000);
