/** Installed Browser, production PC/H5 builds and actual App/JWT under the
 * commissioned application LOGIN. Every order/image is a declared local sample. */
import { expect,it } from 'vitest';
import { createServer,type ServerResponse } from 'node:http';
import { readFile,stat,writeFile } from 'node:fs/promises';
import { extname,resolve,sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { storeOrder,storeOrderCartInfo,storeProductReply,systemAttachment,storeProductLog,storeVisit } from '@/models/schema';
import { withBuyerInvoices } from '../helpers/buyerInvoices';
import { buyerReviewR2,buyerReviewPng } from '../helpers/buyerReviewR2';
type Surface='pc'|'uni';
it('accepts independent buyer review drafts, real image upload and unknown-result readback in production storefronts',async()=>withBuyerInvoices(async s=>{
  const r2=buyerReviewR2();Object.assign(s.env,{ASSETS_BUCKET:r2.bucket});
  const orderIds={pc:870001,uni:870002},orderNos={pc:'buyer_review_browser_pc',uni:'buyer_review_browser_uni'};
  for(const surface of ['pc','uni'] as const){const id=orderIds[surface];await s.seedOrder(id,orderNos[surface],{status:2,totalNum:4});
    await s.f.db.update(storeOrderCartInfo).set({productId:70,type:2,relationId:7,skuUnique:'qared001',unique:surface+'_line_A',cartInfo:JSON.stringify({product:{storeName:'评价验收商品甲',image:''},sku:{suk:'红色 · 标准款',price:'10.00'}})}).where(eq(storeOrderCartInfo.oid,id));
    await s.f.db.insert(storeOrderCartInfo).values([
      {id:id+200,oid:id,uid:11,productId:71,type:2,relationId:7,skuUnique:'runtim71',unique:surface+'_line_B',cartId:surface+'_b',cartNum:1,cartInfo:JSON.stringify({product:{storeName:'评价验收商品乙',image:''},sku:{suk:'蓝色 · 标准款',price:'30.00'}})},
      {id:id+300,oid:id,uid:11,productId:70,type:2,relationId:7,skuUnique:'qared001',unique:surface+'_gift',cartId:surface+'_gift',cartNum:1,isGift:1,cartInfo:JSON.stringify({product:{storeName:'验收赠品，无需评价',image:''},sku:{suk:'赠品',price:'0.00'}})},
    ]);
  }
  const baseline=await s.f.state(),bearer=await s.token(),foreign=await s.token(22),control='/__buyer_reviews/'+crypto.randomUUID();
  expect(await s.f.db.select().from(storeProductLog)).toEqual([]);expect(await s.f.db.select().from(storeVisit)).toEqual([]);let publicProductVisits=0;
  const progress={pc:{posts:0,uploads:0,lost:false,denied:false,readFailure:false,foreignDTO:false,publicRead:false},uni:{posts:0,uploads:0,lost:false,denied:false,readFailure:false,foreignDTO:false,publicRead:false}};
  const calls:Array<{surface:Surface;path:string;method:string;status:number;deliveredStatus:number}>=[];
  let chain=Promise.resolve(),finished=false;const lose={pc:false,uni:false},negative={pc:'',uni:''};
  const state=()=>({progress,calls,finished,r2:{writes:r2.writes.length,reads:r2.reads.length,deletes:r2.deletes.length}});
  const changed=new Set(['store_order','store_order_status','store_product','store_product_reply','system_attachment','store_product_log','store_visit']);
  async function verify(){const now=await s.f.state();for(const key of Object.keys(baseline))if(!changed.has(key))expect(now[key]).toEqual(baseline[key]);
    const visitLogs=await s.f.db.select().from(storeProductLog),visits=await s.f.db.select().from(storeVisit);expect(visitLogs).toHaveLength(publicProductVisits);for(const row of visitLogs)expect(row).toMatchObject({type:'visit',productId:70,uid:0,visitNum:1});expect(visits).toHaveLength(publicProductVisits?1:0);for(const row of visits)expect({...row,type:String(row.type).trimEnd()}).toMatchObject({productId:70,uid:0,productType:'product',cateId:70,type:'view',count:1,content:''});const rows=await s.f.db.select().from(storeProductReply);expect(rows).toHaveLength(progress.pc.posts+progress.uni.posts);
    for(const surface of ['pc','uni'] as const){const p=progress[surface],order=(await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,orderIds[surface])))[0];expect(order).toMatchObject({uid:11,paid:1,status:p.posts===2?3:2});
      const actual=rows.filter(r=>r.oid===order.id);expect(actual).toHaveLength(p.posts);for(const row of actual){expect(row.uid).toBe(11);expect(row.unique).not.toContain('gift');expect(row.comment).toBe(surface+(row.unique.endsWith('_A')?' 第一件独立图文评价':' 第二件独立文字评价'));expect(row.productScore).toBe(row.unique.endsWith('_A')?5:4);expect(row.replyScore).toBe(row.unique.endsWith('_A')?3:2);const pics=JSON.parse(row.pics!);expect(pics).toHaveLength(row.unique.endsWith('_A')?1:0);if(pics.length)expect(pics[0]).toMatch(/^\/api\/assets\/[1-9]\d*$/);}
      const original=(baseline.store_order as Array<{row:Record<string,unknown>}>).find(r=>r.row.id===order.id)!.row;const current=(now.store_order as Array<{row:Record<string,unknown>}>).find(r=>r.row.id===order.id)!.row;expect({...current,status:original.status}).toEqual(original);
    }
    expect(r2.writes).toHaveLength(progress.pc.uploads+progress.uni.uploads);expect(r2.deletes).toEqual([]);
  }
  let done!:()=>void,fail!:(e:Error)=>void;const completion=new Promise<void>((yes,no)=>{done=yes;fail=no;});
  const send=(res:ServerResponse,body:string|Buffer,status=200,type='text/html; charset=utf-8')=>{res.writeHead(status,{'content-type':type,'cache-control':'private, no-store'});res.end(body);};
  const servers:Array<ReturnType<typeof createServer>>=[],origins:Record<string,string>={};
  for(const surface of ['pc','uni'] as const){const root=resolve(import.meta.dirname,surface==='pc'?'../../../view/pc-ts/dist':'../../../view/uniapp-ts/dist/build/h5');expect((await stat(resolve(root,'index.html'))).isFile()).toBe(true);
    const server=createServer((req,res)=>{void(async()=>{const origin=origins[surface];if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
      const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method??'GET',p=progress[surface];
      if(path===control&&method==='GET')return send(res,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>买家评价真实链验收 ${surface}</title><style>body{margin:0;font:14px sans-serif;background:#edf0f4}nav{padding:6px;display:flex;gap:6px;flex-wrap:wrap}button{padding:6px}iframe{display:block;border:0;width:100%;height:calc(100vh - 90px)}pre{margin:0;font-size:11px;max-height:24px;overflow:auto}</style><nav>${['order','reply','legacy','foreign','public','lose','failRead','malformed','finish'].map(n=>'<button id="'+n+'">'+n+'</button>').join('')}</nav><pre id="state">实际 App/JWT/受限 SQL；本机样本，不连接支付、短信或 Queue。</pre><iframe id="app" title="${surface} 正式评价页面"></iframe><script>const base=${JSON.stringify(control)};for(const name of ['order','reply','legacy','foreign','public'])document.getElementById(name).onclick=()=>{document.getElementById('app').src=base+'/bootstrap?entry='+name;};for(const name of ['lose','failRead','malformed','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(base+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();};</script>`);
      if(path===control+'/bootstrap'){expect(method).toBe('GET');const entry=url.searchParams.get('entry');expect(['order','reply','legacy','foreign','public']).toContain(entry);
        const target=entry==='order'?(surface==='pc'?'/order/'+orderNos[surface]:'/#/pages/order/detail?orderId='+orderNos[surface]):entry==='public'?(surface==='pc'?'/goods/70':'/#/pages/goods/commentList?id=70'):entry==='legacy'&&surface==='uni'?'/#/pages/goods/goods_comment_con/index?uni='+orderNos[surface]+'&unique=uni_line_B':surface==='pc'?'/order/'+orderNos[surface]:'/#/pages/order/reply?orderId='+orderNos[surface];
        const token=entry==='foreign'?foreign:entry==='public'?'':bearer,uid=entry==='foreign'?22:entry==='public'?0:11;
        const storage=surface==='pc'?`sessionStorage.setItem('pc_token',${JSON.stringify(token)});sessionStorage.setItem('pc_uid','${uid}');`:`localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:${uid}}));`;
        return send(res,'<!doctype html><meta charset="utf-8"><script>'+storage+'location.replace('+JSON.stringify(target)+');</script>');
      }
      if(path.startsWith(control+'/')){expect(method).toBe('POST');expect(req.headers.origin).toBe(origin);chain=chain.then(async()=>{if(path.endsWith('/lose'))lose[surface]=true;if(path.endsWith('/failRead'))negative[surface]='503';if(path.endsWith('/malformed'))negative[surface]='malformed';await verify();
          if(path.endsWith('/finish')){expect(publicProductVisits).toBe(1);for(const surface of ['pc','uni'] as const){expect(calls.filter(c=>c.surface===surface&&c.method==='POST'&&c.path==='/api/reply/submit')).toHaveLength(2);expect(calls.filter(c=>c.surface===surface&&c.method==='POST'&&c.path==='/api/upload/image')).toHaveLength(1);}for(const item of Object.values(progress))expect(item).toMatchObject({posts:2,uploads:1,denied:true,readFailure:true,foreignDTO:true,publicRead:true});expect(progress.uni.lost).toBe(true);expect(r2.reads.length).toBeGreaterThanOrEqual(2);expect(await s.f.db.select().from(systemAttachment)).toHaveLength(2);finished=true;await writeFile('/tmp/cinashop-buyer-reviews-browser-result.json',JSON.stringify(state(),null,2)+'\n');}
          send(res,JSON.stringify(state()),200,'application/json');if(finished)done();});await chain;return;}
      if(path==='/favicon.ico')return send(res,'',204);
      if(path==='/api/qa/image.svg')return send(res,'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#eee"/><text x="10" y="43" font-size="13">本机样本</text></svg>',200,'image/svg+xml');
      if(path.startsWith('/api/')){const chunks:Buffer[]=[];let size=0;for await(const part of req){const chunk=Buffer.from(part);size+=chunk.length;expect(size).toBeLessThanOrEqual(2*1024*1024);chunks.push(chunk);}const bytes=Buffer.concat(chunks),headers=new Headers();for(let i=0;i<req.rawHeaders.length;i+=2)headers.append(req.rawHeaders[i]!,req.rawHeaders[i+1]!);
        chain=chain.then(async()=>{const isReview=path==='/api/reply/submit',isUpload=path==='/api/upload/image',isRead=path.startsWith('/api/order/reviews/');if(method!=='GET')expect(isReview||isUpload).toBe(true);
          if(isRead&&negative[surface]==='503'){negative[surface]='';p.readFailure=true;calls.push({surface,path,method,status:503,deliveredStatus:503});return send(res,JSON.stringify({status:503,msg:'本机评价读取暂不可用',data:null}),503,'application/json');}
          const response=await s.fetch(new Request(origin+req.url,{method,headers,...(bytes.length?{body:bytes}:{})})),data=Buffer.from(await response.arrayBuffer());const json=response.headers.get('content-type')?.includes('application/json')?JSON.parse(data.toString('utf8')):null;
          if(['/api/product/detail/70','/api/product/detail/70/0'].includes(path)&&json?.status===200){expect(headers.has('authori-zation')||headers.has('authorization')).toBe(false);publicProductVisits++;expect(publicProductVisits).toBeLessThanOrEqual(1);}if(isReview&&json?.status===200){const input=JSON.parse(bytes.toString('utf8'));expect(input.orderId).toBe(orderIds[surface]);expect(input.orderNo).toBe(orderNos[surface]);expect(input.cartInfoId).toBe(orderIds[surface]+(p.posts===0?100:200));p.posts++;}
          if(isUpload&&json?.status===200)p.uploads++;
          if((isRead||path.startsWith('/api/order/detail/'))&&(headers.get('authori-zation')||headers.get('authorization')||'').replace(/^Bearer\s+/,'').trim()===foreign&&json?.status===404)p.denied=true;
          if(path==='/api/reply/list/70'&&json?.status===200&&!headers.get('authori-zation')&&!headers.get('authorization')){p.publicRead=true;expect(json.data.some((r:{pics:string[]})=>r.pics.some(ref=>ref.includes('/api/assets/')))).toBe(true);}
          if(path.startsWith('/api/assets/')&&response.status===200){expect(headers.has('authori-zation')).toBe(false);expect(data).toEqual(Buffer.from(buyerReviewPng));}
          await verify();let outgoing=data,code=response.status;
          if(isRead&&negative[surface]==='malformed'&&json?.status===200){negative[surface]='';p.foreignDTO=true;json.data.uid=22;outgoing=Buffer.from(JSON.stringify(json));}
          if(isReview&&json?.status===200&&lose[surface]){lose[surface]=false;p.lost=true;code=503;outgoing=Buffer.from(JSON.stringify({status:503,msg:'本机样本：提交回执丢失，请刷新评价状态核对',data:null}));}
          calls.push({surface,path,method,status:json?.status??response.status,deliveredStatus:code});const resultHeaders=Object.fromEntries(response.headers);delete resultHeaders['content-length'];res.writeHead(code,resultHeaders);res.end(outgoing);
        });await chain;return;}
      expect(method).toBe('GET');const target=resolve(root,'.'+path);expect(target===root||target.startsWith(root+sep)).toBe(true);const file=await stat(target).catch(()=>null),selected=file?.isFile()?target:resolve(root,'index.html');send(res,await readFile(selected),200,({'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.ttf':'font/ttf'}as Record<string,string>)[extname(selected)]??'text/html; charset=utf-8');
    })().catch(e=>{if(!res.headersSent)send(res,'Owned fixture failed',500,'text/plain');fail(e);});});servers.push(server);await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const a=server.address();if(!a||typeof a==='string')throw Error('Missing owned listener');origins[surface]='http://127.0.0.1:'+a.port;
  }
  let deadline:ReturnType<typeof setTimeout>|undefined;try{process.stdout.write('BUYER_REVIEWS_BROWSER_READY '+JSON.stringify({pc:origins.pc+control,uni:origins.uni+control})+'\n');deadline=setTimeout(()=>fail(Error('Buyer review Browser finish missing')),35*60000);await completion;}finally{if(deadline)clearTimeout(deadline);for(const server of servers){server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}}
}),36*60000);
