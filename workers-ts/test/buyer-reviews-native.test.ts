import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeOrder, storeOrderCartInfo, storeProductReply, systemAttachment } from '@/models/schema';
import { withBuyerInvoices } from './helpers/buyerInvoices';
import { buyerReviewDraft, parseBuyerReviewAck, parseBuyerReviewPage } from '../../view/common/buyerReview';
type S=Parameters<Parameters<typeof withBuyerInvoices>[0]>[0];
const no='buyer_review_native_A',oid=860001;
async function seed(s:S,multiple=false){
  await s.seedOrder(oid,no,{status:2,totalNum:multiple?4:2});
  await s.f.db.update(storeOrderCartInfo).set({productId:70,type:2,relationId:7,skuUnique:'qared001',unique:'review_line_A'}).where(eq(storeOrderCartInfo.oid,oid));
  if(multiple)await s.f.db.insert(storeOrderCartInfo).values([
    {id:oid+101,oid,uid:11,productId:71,type:2,relationId:7,skuUnique:'runtim71',unique:'review_line_B',cartId:'review_b',cartNum:1,cartInfo:JSON.stringify({product:{storeName:'本机评价商品乙',image:''},sku:{suk:'标准',price:'30.00'}})},
    {id:oid+102,oid,uid:11,productId:70,type:2,relationId:7,skuUnique:'qared001',unique:'review_gift',cartId:'review_gift',cartNum:1,isGift:1,cartInfo:JSON.stringify({product:{storeName:'本机赠品',image:''},sku:{suk:'赠品',price:'0.00'}})},
  ]);
}
async function read(s:S){const r=await s.request('/api/order/reviews/'+no);expect(r.status,r.msg).toBe(200);expect(r.headers.get('cache-control')).toContain('no-store');return parseBuyerReviewPage(r.data,no,11);}
function body(page:Awaited<ReturnType<typeof read>>,n=0){const line=page.lines[n];return {...buyerReviewDraft(),version:1 as const,orderId:page.orderId,orderNo:page.orderNo,cartInfoId:line.id,unique:line.unique,revision:line.revision,comment:'本机逐商品评价'};}
it('reads owned order without writes and submits through actual App/JWT/restricted LOGIN into the existing review state machine',async()=>withBuyerInvoices(async s=>{
  await seed(s);const before=await s.f.state(),page=await read(s);expect(await s.f.state()).toEqual(before);expect(page).toMatchObject({uid:11,orderId:oid,paid:true,status:2,canReview:true});expect(page.lines).toHaveLength(1);
  const input=body(page),saved=await s.request('/api/reply/submit?view=buyer',input);expect(saved.status,saved.msg).toBe(200);expect(parseBuyerReviewAck(saved.data,input,11)).toMatchObject({completed:true});
  const after=await read(s);expect(after).toMatchObject({status:3,canReview:false});expect(after.lines[0]).toMatchObject({canReply:false,review:{comment:input.comment,uid:11,cartInfoId:input.cartInfoId}});
  const state=await s.f.state();expect((await s.request('/api/reply/submit?view=buyer',input)).status).not.toBe(200);expect(await s.f.state()).toEqual(state);
}),120000);
it('requires the whole order/line revision and current owner before materialization',async()=>withBuyerInvoices(async s=>{
  await seed(s);const page=await read(s),input=body(page),before=await s.f.state();
  for(const change of [{orderId:oid+1},{cartInfoId:oid+999},{orderNo:'other_order'},{revision:'b'.repeat(64)},{unique:'other_unique'},{pics:['/api/assets/1?signature=preview']},{replyScore:true}]){
    expect((await s.request('/api/order/comment?view=buyer',{...input,...change})).status).not.toBe(200);expect(await s.f.state()).toEqual(before);expect(await s.f.db.select().from(storeProductReply)).toEqual([]);
  }
  const foreign=await s.request('/api/order/reviews/'+no,undefined,await s.token(22));expect(foreign.status).toBe(404);expect(await s.f.state()).toEqual(before);
}),120000);
it('resumes remaining non-gift lines from SQL and completes only after the last required line',async()=>withBuyerInvoices(async s=>{
  await seed(s,true);let page=await read(s);const a=await s.request('/api/order/comment?view=buyer',body(page));expect(a.status,a.msg).toBe(200);expect(a.data.completed).toBe(false);
  page=await read(s);expect(page.lines[0].review).not.toBeNull();expect(page.lines[0].canReply).toBe(false);expect(page.lines[1].canReply).toBe(true);expect(page.lines[2]).toMatchObject({isGift:true,canReply:false});
  const b=await s.request('/api/reply/submit?view=buyer',{...body(page,1),comment:'独立的第二件评价',productScore:4,replyScore:2});expect(b.status,b.msg).toBe(200);expect(b.data.completed).toBe(true);
  expect((await s.f.db.select().from(storeProductReply)).map(r=>[r.unique,r.comment]).sort()).toEqual([['review_line_A','本机逐商品评价'],['review_line_B','独立的第二件评价']]);
  expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,oid)))[0].status).toBe(3);
}),120000);
it('publishes only own canonical images and returns consumable signed sources through both owner and public review readers',async()=>withBuyerInvoices(async s=>{
  await seed(s);await s.f.db.insert(systemAttachment).values({attId:991,type:3,moduleType:3,relationId:11,fileType:1,imageType:8,name:'attachments/user/11/local_review.png',attDir:'/api/assets/991',sattDir:'/api/assets/991',attType:'image/png',attSize:'24'});
  const page=await read(s),input={...body(page),pics:['/api/assets/991']},made=await s.request('/api/order/comment?view=buyer',input);expect(made.status,made.msg).toBe(200);
  const stored=(await s.f.db.select().from(storeProductReply))[0];expect(JSON.parse(stored.pics!)).toEqual(['/api/assets/991']);
  const own=await read(s);expect(own.lines[0].review!.pics[0]).toMatch(/^\/api\/assets\/991\?expires=\d+&signature=/);
  const publicResult=await s.request('/api/reply/list/70',undefined,null);expect(publicResult.status,publicResult.msg).toBe(200);expect(publicResult.data[0].pics[0]).toMatch(/^\/api\/assets\/991\?expires=\d+&signature=/);
}),120000);
it('uploads actual PNG bytes through the existing customer route, then serves the published review capability anonymously',async()=>withBuyerInvoices(async s=>{
  const {buyerReviewPng,buyerReviewR2}=await import('./helpers/buyerReviewR2'),r2=buyerReviewR2();Object.assign(s.env,{ASSETS_BUCKET:r2.bucket});await seed(s);
  const form=new FormData();form.append('file',new File([buyerReviewPng],'local-review.png',{type:'image/png'}));form.append('pid','0');
  const encoded=new Response(form),bytes=await encoded.arrayBuffer();const response=await s.fetch(new Request('http://127.0.0.1/api/upload/image',{method:'POST',headers:{'Authori-zation':'Bearer '+await s.token(),'content-type':encoded.headers.get('content-type')!,'content-length':String(bytes.byteLength)},body:bytes}));
  const uploaded=await response.json<{status:number;msg:string;data:{url:string;src:string}}>();expect(uploaded.status,uploaded.msg).toBe(200);expect(r2.writes).toHaveLength(1);expect(r2.deletes).toEqual([]);
  const input={...body(await read(s)),pics:[uploaded.data.url]},saved=await s.request('/api/reply/submit?view=buyer',input);expect(saved.status,saved.msg).toBe(200);
  const list=await s.request('/api/reply/list/70',undefined,null);expect(list.status,list.msg).toBe(200);const src=list.data[0].pics[0];expect(src).toContain(uploaded.data.url+'?');
  const image=await s.fetch(new Request('http://127.0.0.1'+src));expect(image.status).toBe(200);expect(image.headers.get('content-type')).toBe('image/png');expect(new Uint8Array(await image.arrayBuffer())).toEqual(buyerReviewPng);expect(r2.reads).toEqual(r2.writes);
  const unsigned=await s.fetch(new Request('http://127.0.0.1'+uploaded.data.url));expect(unsigned.status).not.toBe(200);expect(r2.reads).toHaveLength(1);
}),120000);
it('rejects a foreign private attachment without materializing a review',async()=>withBuyerInvoices(async s=>{
  await seed(s);await s.f.db.insert(systemAttachment).values({attId:992,type:3,moduleType:3,relationId:22,fileType:1,imageType:8,name:'attachments/user/22/foreign.png',attDir:'/api/assets/992',sattDir:'/api/assets/992',attType:'image/png'});
  const input=body(await read(s)),before=await s.f.state();const result=await s.request('/api/order/comment?view=buyer',{...input,pics:['/api/assets/992']});expect(result.status).not.toBe(200);expect(await s.f.db.select().from(storeProductReply)).toEqual([]);expect(await s.f.state()).toEqual(before);
}),120000);
it.each(['media','cart'] as const)('rolls back reply, completion and rating when an in-transaction trigger changes %s receipt facts',async target=>withBuyerInvoices(async s=>{
  await seed(s);await s.f.db.insert(systemAttachment).values({attId:993,type:3,moduleType:3,relationId:11,fileType:1,imageType:8,name:'attachments/user/11/drift.png',attDir:'/api/assets/993',sattDir:'/api/assets/993',attType:'image/png'});
  const input={...body(await read(s)),pics:['/api/assets/993']},before=await s.f.state();
  const mutation=target==='media'?"UPDATE public.system_attachment SET real_name='changed-in-trigger' WHERE att_id=993;":`UPDATE public.store_order_cart_info SET cart_info='{}' WHERE id=${oid+100};`;
  await s.f.exec(`CREATE FUNCTION public.local_buyer_review_drift() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN ${mutation} RETURN NEW; END $$; CREATE TRIGGER local_buyer_review_drift AFTER INSERT ON public.store_product_reply FOR EACH ROW EXECUTE FUNCTION public.local_buyer_review_drift();`);
  try{const result=await s.request('/api/reply/submit?view=buyer',input);expect(result.status).not.toBe(200);expect(result.msg).toContain(target==='media'?'图片资料已变化':'订单凭据已变化');expect(await s.f.db.select().from(storeProductReply)).toEqual([]);expect(await s.f.state()).toEqual(before);}
  finally{await s.f.exec('DROP TRIGGER local_buyer_review_drift ON public.store_product_reply; DROP FUNCTION public.local_buyer_review_drift();');}
}),120000);
it.each(['password','disabled','deleted','cart'] as const)('rechecks %s after a proved order-row wait and does not materialize a stale review',async change=>withBuyerInvoices(async s=>{
  const {outcome,waitForFinanceBlock}=await import('./helpers/financePeers');const {user}=await import('@/models/schema');
  await seed(s);const input=body(await read(s)),token=await s.token();if(!s.f.withPeer)throw Error('Independent peer required');
  await s.f.withPeer(async peer=>{
    await peer.exec(`BEGIN; SELECT id FROM public.store_order WHERE id=${oid} FOR UPDATE`);
    const waiting=outcome(s.request('/api/reply/submit?view=buyer',input,token));
    try{await waitForFinanceBlock(s.f.db,s.appPid,peer.pid);
      if(change==='cart')await peer.exec(`UPDATE public.store_order_cart_info SET cart_info='{"product":{"storeName":"Changed while waiting"}}' WHERE oid=${oid}`);
      else await s.f.db.update(user).set(change==='password'?{pwd:'replaced-local-password'}:change==='disabled'?{status:0}:{isDel:1}).where(eq(user.uid,11));
      await peer.exec('COMMIT');const result=await waiting;expect(result.ok).toBe(true);if(result.ok)expect(result.value.status).not.toBe(200);
      expect(await s.f.db.select().from(storeProductReply)).toEqual([]);expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,oid)))[0].status).toBe(2);
    }finally{await peer.exec('ROLLBACK');await waiting;}
  });
}),120000);
it('refuses corrupt historical review associations and oversized cart text before returning an owned DTO',async()=>withBuyerInvoices(async s=>{
  await seed(s);const input=body(await read(s));await s.f.db.insert(storeProductReply).values({id:995,uid:22,oid,orderCartInfoId:input.cartInfoId,productId:70,unique:input.unique,comment:'Foreign row must never render',pics:'[]',isDel:0,status:1});
  expect((await s.request('/api/order/reviews/'+no)).status).not.toBe(200);expect((await s.request('/api/reply/submit?view=buyer',input)).status).not.toBe(200);expect((await s.f.db.select().from(storeProductReply)).map(r=>r.id)).toEqual([995]);
  await s.f.db.delete(storeProductReply).where(eq(storeProductReply.id,995));await s.f.db.update(storeOrderCartInfo).set({cartInfo:JSON.stringify({product:{storeName:'x'.repeat(65537)}})}).where(eq(storeOrderCartInfo.oid,oid));
  expect((await s.request('/api/order/reviews/'+no)).status).not.toBe(200);expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,oid)))[0].status).toBe(2);
}),120000);

it('binds a supplier fulfilment review to its owned allocated payment parent',async()=>withBuyerInvoices(async s=>{
  await s.seedOrder(oid-1,'buyer_review_payment_parent',{pid:-1,supplierAllocationStatus:2});await seed(s);
  await s.f.db.update(storeOrder).set({pid:oid-1,supplierId:7,supplierAllocationStatus:2}).where(eq(storeOrder.id,oid));
  const input=body(await read(s));await s.f.db.update(storeOrder).set({uid:22}).where(eq(storeOrder.id,oid-1));
  expect((await s.request('/api/order/reviews/'+no)).status).not.toBe(200);expect((await s.request('/api/reply/submit?view=buyer',input)).status).not.toBe(200);expect(await s.f.db.select().from(storeProductReply)).toEqual([]);
  await s.f.db.update(storeOrder).set({uid:11}).where(eq(storeOrder.id,oid-1));const made=await s.request('/api/reply/submit?view=buyer',input);expect(made.status,made.msg).toBe(200);expect(made.data.completed).toBe(true);
  expect((await s.f.db.select().from(storeProductReply))[0]).toMatchObject({uid:11,oid,type:2,relationId:7});expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,oid-1)))[0]).toMatchObject({uid:11,paid:1,pid:-1,status:0});
}),120000);
