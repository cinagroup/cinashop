import { ReplyService } from '@/services/product/ReplyService';
import { expect,it } from 'vitest';
import { eq,sql } from 'drizzle-orm';
import { community, communityRelevance, storeOrder, storeOrderCartInfo, storeProductReply,systemConfig,user,systemAttachment } from '@/models/schema';
import { withBuyerInvoices } from './helpers/buyerInvoices';
import { buyerReviewDraft } from '../../view/common/buyerReview';
type S=Parameters<Parameters<typeof withBuyerInvoices>[0]>[0];
const no='review_community_sync_local',oid=890001;
async function seed(s:S){
  await s.seedOrder(oid,no,{status:2});
  await s.f.db.update(storeOrderCartInfo).set({productId:70,type:2,relationId:7,skuUnique:'qared001',unique:'sync_review_line'}).where(eq(storeOrderCartInfo.oid,oid));
  const read=await s.request('/api/order/reviews/'+no);expect(read.status,read.msg).toBe(200);const page=read.data,line=page.lines[0];
  return {...buyerReviewDraft(),version:1,orderId:page.orderId,orderNo:page.orderNo,cartInfoId:line.id,unique:line.unique,revision:line.revision,comment:'评价社区同步本机样本',syncToCommunity:true};
}
function retry(body:Awaited<ReturnType<typeof seed>>,ack:any){return {version:1,orderId:body.orderId,orderNo:body.orderNo,cartInfoId:body.cartInfoId,unique:body.unique,replyId:ack.replyId,syncRevision:ack.communitySync.revision};}
it('commits explicit opt-in and creates exactly one moderated user post through actual App/JWT/restricted LOGIN',async()=>withBuyerInvoices(async s=>{
  const body=await seed(s),saved=await s.request('/api/reply/submit?view=buyer',body);expect(saved.status,saved.msg).toBe(200);
  expect(saved.data.communitySync).toMatchObject({status:'awaiting_review'});const posts=await s.f.db.select().from(community);expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({id:saved.data.communitySync.postId,type:2,relationId:11,content:body.comment,isVerify:0,status:1,topicId:'[]',productId:'[70]'});
  expect((await s.f.db.select().from(communityRelevance)).map(r=>({left:r.leftId,right:r.rightId,type:r.type}))).toEqual([{left:posts[0].id,right:70,type:'community_product'}]);
  const [review]=await s.f.db.select().from(storeProductReply);expect(review).toMatchObject({communitySyncRequested:1,communitySyncPostId:posts[0].id,communitySyncDigest:saved.data.communitySync.revision});
  const again=await s.request('/api/order/reviews/'+no+'/community-sync',retry(body,saved.data));expect(again.status,again.msg).toBe(200);expect(again.data.communitySync).toEqual(saved.data.communitySync);expect(await s.f.db.select().from(community)).toEqual(posts);
  const own=await s.request('/api/order/reviews/'+no);expect(own.data.lines[0].review.communitySync).toEqual(saved.data.communitySync);
}),120000);
it('preserves committed review and order completion when publishing fails, and reconciles retries without another review POST',async()=>withBuyerInvoices(async s=>{
  const body=await seed(s);
  await s.f.exec("CREATE FUNCTION local_sync_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned publisher fault'; END $$; CREATE TRIGGER local_sync_fail BEFORE INSERT ON public.community FOR EACH ROW EXECUTE FUNCTION local_sync_fail()");
  const saved=await s.request('/api/order/comment?view=buyer',body);expect(saved.status,saved.msg).toBe(200);expect(saved.data.communitySync).toMatchObject({status:'pending',postId:null});
  expect(await s.f.db.select().from(community)).toEqual([]);expect(await s.f.db.select().from(storeProductReply)).toHaveLength(1);expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,oid)))[0].status).toBe(3);
  await s.f.exec('DROP TRIGGER local_sync_fail ON public.community; DROP FUNCTION local_sync_fail()');
  const request=retry(body,saved.data),first=await s.request('/api/order/reviews/'+no+'/community-sync',request);expect(first.status,first.msg).toBe(200);expect(first.data.communitySync.status).toBe('awaiting_review');
  const second=await s.request('/api/order/reviews/'+no+'/community-sync',request);expect(second.data.communitySync).toEqual(first.data.communitySync);expect(await s.f.db.select().from(community)).toHaveLength(1);expect(await s.f.db.select().from(storeProductReply)).toHaveLength(1);
}),120000);
it('keeps ordinary and automatic reviews outside synchronization and rejects invented retry receipts',async()=>withBuyerInvoices(async s=>{
  const body=await seed(s),saved=await s.request('/api/reply/submit?view=buyer',{...body,syncToCommunity:false});expect(saved.status,saved.msg).toBe(200);expect(saved.data.communitySync).toBeUndefined();expect(await s.f.db.select().from(community)).toEqual([]);
  const [review]=await s.f.db.select().from(storeProductReply);expect(review).toMatchObject({communitySyncRequested:0,communitySyncDigest:'',communitySyncPostId:0});
  await s.seedOrder(oid+1,'review_community_sync_auto',{status:2});await s.f.db.update(storeOrderCartInfo).set({productId:70,unique:'sync_automatic_line'}).where(eq(storeOrderCartInfo.oid,oid+1));
  expect(await new ReplyService(s.appContainer).autoCommentOrder(oid+1)).toMatchObject({inserted:1,completed:true});
  expect((await s.f.db.select().from(storeProductReply)).every(r=>r.communitySyncRequested===0&&r.communitySyncPostId===0&&r.communitySyncDigest==='')).toBe(true);
  const bad=await s.request('/api/order/reviews/'+no+'/community-sync',{version:1,orderId:oid,orderNo:no,cartInfoId:body.cartInfoId,unique:body.unique,replyId:review.id,syncRevision:'a'.repeat(64)});expect(bad.status).not.toBe(200);expect(await s.f.db.select().from(community)).toEqual([]);
}),120000);
async function blockedPublish(s:S,body:Awaited<ReturnType<typeof seed>>) {
  await s.f.exec("CREATE FUNCTION local_sync_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned publisher fault'; END $$; CREATE TRIGGER local_sync_fail BEFORE INSERT ON public.community FOR EACH ROW EXECUTE FUNCTION local_sync_fail()");
  const saved=await s.request('/api/reply/submit?view=buyer',body);expect(saved.status,saved.msg).toBe(200);expect(saved.data.communitySync.status).toBe('pending');
  await s.f.exec('DROP TRIGGER local_sync_fail ON public.community; DROP FUNCTION local_sync_fail()');return saved.data;
}
async function config(s:S,key:string,value:string){const changed=await s.f.db.update(systemConfig).set({value}).where(eq(systemConfig.menuName,key)).returning({id:systemConfig.id});if(!changed.length)await s.f.db.insert(systemConfig).values({menuName:key,value});}
it('supports the PHP is_sync flag, rejects invalid/conflicting aliases, and leaves unrelated user-like relations untouched',async()=>withBuyerInvoices(async s=>{
  const body=await seed(s);
  for(const flags of [{is_sync:null},{isSync:null},{is_sync:0,isSync:1},{is_sync:'invalid'}]){expect((await s.request('/api/reply/submit',{unique:body.unique,comment:body.comment,...flags})).status).not.toBe(200);expect(await s.f.db.select().from(storeProductReply)).toEqual([]);}
  await s.f.db.insert(communityRelevance).values({leftId:1,rightId:999,type:'community_like'});
  const saved=await s.request('/api/reply/submit',{unique:body.unique,comment:body.comment,is_sync:1});expect(saved.status,saved.msg).toBe(200);expect(saved.data.community_sync.status).toBe('awaiting_review');expect(await s.f.db.select().from(community)).toHaveLength(1);
  expect((await s.f.db.select().from(communityRelevance)).filter(r=>r.type==='community_like')).toMatchObject([{leftId:1,rightId:999}]);
}),120000);
it('publishes real uploaded PNGs when moderation is disabled, with canonical storage and signed anonymous community image reads',async()=>withBuyerInvoices(async s=>{
  const {buyerReviewPng,buyerReviewR2}=await import('./helpers/buyerReviewR2'),r2=buyerReviewR2();Object.assign(s.env,{ASSETS_BUCKET:r2.bucket});
  const body=await seed(s);for(const [key,value] of [['community_verify','0'],['community_status','1'],['station_open','1']])await config(s,key,value);
  const form=new FormData();form.append('file',new File([buyerReviewPng],'sync-local.png',{type:'image/png'}));form.append('pid','0');const encoded=new Response(form),bytes=await encoded.arrayBuffer();
  const response=await s.fetch(new Request('http://127.0.0.1/api/upload/image',{method:'POST',headers:{'Authori-zation':'Bearer '+await s.token(),'content-type':encoded.headers.get('content-type')!,'content-length':String(bytes.byteLength)},body:bytes}));
  const upload=await response.json<{status:number;msg:string;data:{url:string}}>();expect(upload.status,upload.msg).toBe(200);
  const saved=await s.request('/api/reply/submit?view=buyer',{...body,pics:[upload.data.url]});expect(saved.status,saved.msg).toBe(200);expect(saved.data.communitySync.status).toBe('published');
  const [post]=await s.f.db.select().from(community);expect(post).toMatchObject({image:upload.data.url,sliderImage:JSON.stringify([upload.data.url]),isVerify:1});
  const publicState=await s.request('/api/community/state/'+post.id,undefined,null);expect(publicState.status,publicState.msg).toBe(200);const src=publicState.data.slider_image[0];expect(src).toContain(upload.data.url+'?');
  const image=await s.fetch(new Request('http://127.0.0.1'+src));expect(image.status).toBe(200);expect(new Uint8Array(await image.arrayBuffer())).toEqual(buyerReviewPng);expect(r2.writes).toHaveLength(1);expect(r2.reads).toHaveLength(1);expect(r2.deletes).toEqual([]);
}),120000);
it('rejects foreign/revoked actors and refuses hidden, deleted or modified pending reviews without losing their saved evaluation',async()=>withBuyerInvoices(async s=>{
  const body=await seed(s),old=await s.token(),ack=await blockedPublish(s,body),request=retry(body,ack),url='/api/order/reviews/'+no+'/community-sync';
  expect((await s.request(url,request,await s.token(22))).status).not.toBe(200);
  await s.f.db.update(user).set({status:0}).where(eq(user.uid,11));expect((await s.request(url,request,old)).status).not.toBe(200);
  await s.f.db.update(user).set({status:1,pwd:'owned-sync-password-changed'}).where(eq(user.uid,11));expect((await s.request(url,request,old)).status).not.toBe(200);
  for(const change of [{status:0},{status:1,isDel:1},{isDel:0,comment:'different saved text'}]){await s.f.db.update(storeProductReply).set(change).where(eq(storeProductReply.id,ack.replyId));const result=await s.request(url,request);expect(result.status,result.msg).toBe(200);expect(result.data.communitySync.status).toBe('pending');expect(await s.f.db.select().from(community)).toEqual([]);}
  await s.f.db.update(storeProductReply).set({comment:body.comment}).where(eq(storeProductReply.id,ack.replyId));expect((await s.request(url,request)).data.communitySync.status).toBe('awaiting_review');expect(await s.f.db.select().from(storeProductReply)).toHaveLength(1);
}),120000);
for(const kind of ['post','receipt','relation'] as const)it('rolls back '+kind+' trigger drift in publication while keeping the committed review and retry intent',async()=>withBuyerInvoices(async s=>{
  const body=await seed(s);
  const action=kind==='post'?"UPDATE public.community SET content='owned drift' WHERE id=NEW.id;":kind==='receipt'?"UPDATE public.store_product_reply SET comment='owned drift' WHERE id=NEW.id;":"DELETE FROM public.community_relevance WHERE left_id=NEW.community_sync_post_id AND type='community_product';";
  const table=kind==='post'?'community':'store_product_reply',event=kind==='post'?'INSERT':'UPDATE',condition=kind==='post'?'pg_trigger_depth()=1':'pg_trigger_depth()=1 AND NEW.community_sync_post_id>0';
  await s.f.exec(`CREATE FUNCTION local_sync_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${action} END IF; RETURN NEW; END $$; CREATE TRIGGER local_sync_drift AFTER ${event} ON public.${table} FOR EACH ROW EXECUTE FUNCTION local_sync_drift()`);
  const saved=await s.request('/api/reply/submit?view=buyer',body);expect(saved.status,saved.msg).toBe(200);expect(saved.data.communitySync.status).toBe('pending');expect(await s.f.db.select().from(community)).toEqual([]);expect(await s.f.db.select().from(communityRelevance)).toEqual([]);
  const [review]=await s.f.db.select().from(storeProductReply);expect(review).toMatchObject({comment:body.comment,communitySyncRequested:1,communitySyncPostId:0});
  await s.f.exec(`DROP TRIGGER local_sync_drift ON public.${table}; DROP FUNCTION local_sync_drift()`);expect((await s.request('/api/order/reviews/'+no+'/community-sync',retry(body,saved.data))).data.communitySync.status).toBe('awaiting_review');
}),120000);
it('never recreates a synchronized post after its moderation refusal, deletion or missing-record state',async()=>withBuyerInvoices(async s=>{
  const body=await seed(s),saved=await s.request('/api/reply/submit?view=buyer',body);expect(saved.status,saved.msg).toBe(200);const request=retry(body,saved.data),id=saved.data.communitySync.postId;
  for(const change of [{isVerify:-1},{isVerify:1,isDel:1}]){await s.f.db.update(community).set(change).where(eq(community.id,id));const result=await s.request('/api/order/reviews/'+no+'/community-sync',request);expect(result.data.communitySync).toMatchObject({status:'unavailable',postId:id});expect(await s.f.db.select().from(community)).toHaveLength(1);}
  await s.f.db.delete(community).where(eq(community.id,id));const missing=await s.request('/api/order/reviews/'+no+'/community-sync',request);expect(missing.data.communitySync.status).toBe('unavailable');expect(await s.f.db.select().from(community)).toEqual([]);expect((await s.f.db.select().from(storeProductReply))[0].communitySyncPostId).toBe(id);
}),120000);
it('returns pending behind a proven product row lock and reconciles competing retries to one post after release',async()=>withBuyerInvoices(async s=>{
  const body=await seed(s),ack=await blockedPublish(s,body),request=retry(body,ack),url='/api/order/reviews/'+no+'/community-sync';
  await s.f.withPeer!(async peer=>{
    let release!:()=>void,locked!:()=>void,failed!:(e:unknown)=>void;const held=new Promise<void>((yes,no)=>{locked=yes;failed=no;}),gate=new Promise<void>(yes=>release=yes);
    const blocking=peer.db.transaction(async tx=>{await tx.execute(sql`SET LOCAL statement_timeout='3s'`);await tx.execute(sql`SELECT id FROM public.store_product WHERE id=70 FOR UPDATE NOWAIT`);locked();await gate;});void blocking.catch(failed);
    try{await held;const busy=await s.request(url,request);expect(busy.status,busy.msg).toBe(200);expect(busy.data.communitySync.status).toBe('pending');expect(await s.f.db.select().from(community)).toEqual([]);}finally{release();await blocking;}
  });
  const results=await Promise.all([s.request(url,request),s.request(url,request)]);expect(results.every(r=>r.status===200)).toBe(true);expect(await s.f.db.select().from(community)).toHaveLength(1);expect((await s.request(url,request)).data.communitySync.status).toBe('awaiting_review');
}),120000);

it('refuses a formerly owned private image after ownership metadata changes and publishes only after ownership is restored',async()=>withBuyerInvoices(async s=>{
  const body=await seed(s);await s.f.db.insert(systemAttachment).values({attId:991,type:3,moduleType:3,relationId:11,fileType:1,imageType:8,name:'attachments/user/11/sync-owned.png',attDir:'/api/assets/991',sattDir:'/api/assets/991',attType:'image/png',attSize:'68'});
  const ack=await blockedPublish(s,{...body,pics:['/api/assets/991']}),request=retry(body,ack),url='/api/order/reviews/'+no+'/community-sync';
  await s.f.db.update(systemAttachment).set({relationId:22}).where(eq(systemAttachment.attId,991));const denied=await s.request(url,request);expect(denied.data.communitySync.status).toBe('pending');expect(await s.f.db.select().from(community)).toEqual([]);
  const own=await s.request('/api/order/reviews/'+no);expect(own.data.lines[0].review.pics).toEqual(['']);
  await s.f.db.update(systemAttachment).set({relationId:11}).where(eq(systemAttachment.attId,991));const restored=await s.request(url,request);expect(restored.data.communitySync.status).toBe('awaiting_review');expect((await s.f.db.select().from(community))[0].image).toBe('/api/assets/991');
}),120000);
