import { expect, it } from 'vitest';
import { createBuyerReviewFlow, initialBuyerReviewFlow, parseBuyerReviewUpload } from '../../view/common/buyerReviewFlow';
import type { BuyerReviewBody } from '../../view/common/buyerReview';
const revision='a'.repeat(64);
const record=(id:number)=>({id:500+id,uid:11,orderId:91,cartInfoId:id,unique:'line_'+id,comment:'已在SQL保存的评价',replyScore:3,productScore:5,serviceScore:5,logisticsScore:5,pics:[],addTime:'2026-11-14 10:00:00',visible:true});
function page(done:number[]=[],rev=revision){return {version:1,uid:11,orderId:91,orderNo:'flow_order_A',paid:true,status:done.length===2?3:2,canReview:done.length!==2,reason:done.length===2?'订单已完成评价':'',
  lines:[101,102,103].map(id=>({id,unique:'line_'+id,productId:70,name:'本机商品 '+id,sku:'红色',price:'10.00',image:'',isGift:id===103,revision:rev,canReply:id!==103&&!done.includes(id),reason:done.includes(id)?'已提交评价':id===103?'赠品无需评价':'',review:done.includes(id)?record(id):null}))};}
const deferred=<T>()=>{let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;return {promise:new Promise<T>((yes,no)=>{resolve=yes;reject=no;}),resolve,reject};};
let serial=0;
function setup(){let uid=11,token='owned_'+ ++serial,live=true,done:number[]=[],rev=revision;
  const writes:BuyerReviewBody[]=[],releases:number[]=[],state=initialBuyerReviewFlow();
  let read:()=>Promise<unknown>=async()=>page(done,rev),submit:(b:BuyerReviewBody)=>Promise<unknown>=async b=>{done.push(b.cartInfoId);return ack(b,done.length===2);};
  let upload=async(n:number)=>({url:'/api/assets/'+n,preview:'blob:local-'+n,release:()=>{releases.push(n);}});
  const dep={capture:()=>{const u=uid,t=token;return {uid,token,current:()=>live&&u===uid&&t===token};},read:()=>read(),submit:async(b:BuyerReviewBody)=>{writes.push(b);return submit(b);},upload:(n:number)=>upload(n)};
  const flow=createBuyerReviewFlow<number>(state,dep);flow.setOrder('flow_order_A');
  return {state,flow,dep,writes,releases,read(fn:typeof read){read=fn;},submit(fn:typeof submit){submit=fn;},upload(fn:typeof upload){upload=fn;},complete(n:number){done.push(n);},changeRevision(){rev='b'.repeat(64);},hide(){live=false;flow.suspend();},show(){live=true;},switch(){uid=22;token='new';flow.clear();}};
}
function ack(b:BuyerReviewBody,completed=false){return {version:1,uid:11,orderId:b.orderId,orderNo:b.orderNo,cartInfoId:b.cartInfoId,unique:b.unique,replyId:500+b.cartInfoId,completed,toLottery:false};}
it('submits only the selected line and preserves another unchanged line draft after readback',async()=>{
  const f=setup();await f.flow.load();f.state.drafts[101].body.comment='第一件自己的文字';f.state.drafts[102].body.comment='第二件不同文字';
  await f.flow.upload([1]);await f.flow.submit();expect(f.writes).toHaveLength(1);expect(f.writes[0]).toMatchObject({cartInfoId:101,comment:'第一件自己的文字',pics:['/api/assets/1']});
  expect(JSON.stringify(f.writes)).not.toMatch(/blob:|release|preview/);expect(f.state.drafts[101]).toBeUndefined();expect(f.state.drafts[102].body.comment).toBe('第二件不同文字');expect(f.releases).toEqual([1]);
  expect(f.state.selected).toBe(102);await f.flow.submit();expect(f.writes[1]).toMatchObject({cartInfoId:102,comment:'第二件不同文字'});expect(f.state.page?.status).toBe(3);expect(Object.keys(f.state.drafts)).toEqual([]);
});
it('never submits gifts or already reviewed lines',async()=>{
  const f=setup();await f.flow.load();f.flow.select(103);await f.flow.submit();expect(f.writes).toEqual([]);f.complete(101);await f.flow.load();f.flow.select(101);await f.flow.submit();expect(f.writes).toEqual([]);
});
it('does not automatically retry an unknown commit and reconstructs remaining SQL state',async()=>{
  const f=setup();await f.flow.load();f.state.drafts[101].body.comment='先提交';f.submit(async b=>{f.complete(b.cartInfoId);throw Error('ack lost');});
  await f.flow.submit();expect(f.state.uncertain).toBe(true);await f.flow.submit();expect(f.writes).toHaveLength(1);await f.flow.load();expect(f.state.uncertain).toBe(false);expect(f.state.page?.lines[0].review).not.toBeNull();expect(f.state.selected).toBe(101);f.flow.select(102);expect(f.flow.editable()).toBe(true);
});
it('page reconstruction retains an in-flight guard until terminal and another authoritative read',async()=>{
  const f=setup(),pending=deferred<unknown>();await f.flow.load();f.state.drafts[101].body.comment='尚在请求';f.submit(()=>pending.promise);const writing=f.flow.submit();f.flow.suspend();
  const state=initialBuyerReviewFlow(),next=createBuyerReviewFlow<number>(state,f.dep);next.setOrder('flow_order_A');await next.load();expect(state.uncertain).toBe(true);await next.submit();expect(f.writes).toHaveLength(1);
  f.complete(101);pending.resolve(ack(f.writes[0]));await writing;expect(f.state.page).toBeNull();expect(state.uncertain).toBe(true);await next.load();expect(state.page?.lines[0].review).not.toBeNull();expect(state.uncertain).toBe(false);
});
it.each(['hide','switch'] as const)('late upload completion cannot populate private data after %s',async ending=>{
  const f=setup(),upload=deferred<{url:string;preview:string;release:()=>void}>();await f.flow.load();f.upload(()=>upload.promise);const request=f.flow.upload([1]);f[ending]();upload.resolve({url:'/api/assets/1',preview:'blob:local',release:()=>f.releases.push(1)});await request;
  expect(f.state.page).toBeNull();expect(f.state.drafts).toEqual({});expect(f.state.uploading).toBe(false);expect(f.releases).toEqual([1]);
});
it('a stale upload finally cannot release the newer upload lock',async()=>{
  const f=setup(),old=deferred<{url:string;preview:string;release:()=>void}>(),fresh=deferred<{url:string;preview:string;release:()=>void}>();await f.flow.load();f.upload(()=>old.promise);const a=f.flow.upload([1]);f.hide();f.show();await f.flow.load();f.upload(()=>fresh.promise);const b=f.flow.upload([2]);
  old.resolve({url:'/api/assets/1',preview:'blob:old',release:()=>f.releases.push(1)});await a;expect(f.state.uploading).toBe(true);fresh.resolve({url:'/api/assets/2',preview:'blob:new',release:()=>f.releases.push(2)});await b;expect(f.state.uploading).toBe(false);expect(f.state.drafts[101].images.map(i=>i.url)).toEqual(['/api/assets/2']);f.flow.clear();expect(f.releases).toEqual([1,2]);
});
it('revision changes discard old text and release old image previews before further edits',async()=>{
  const f=setup();await f.flow.load();f.state.drafts[101].body.comment='旧版本私有草稿';await f.flow.upload([1]);f.changeRevision();await f.flow.load();expect(f.state.drafts[101].body.comment).toBe('');expect(f.state.drafts[101].images).toEqual([]);expect(f.releases).toEqual([1]);
});
it('wrong owner page or acknowledgement never becomes a current success',async()=>{
  const f=setup();await f.flow.load();f.state.drafts[101].body.comment='原账号';f.submit(async b=>({...ack(b),uid:22}));await f.flow.submit();expect(f.state.uncertain).toBe(true);f.read(async()=>({...page(),uid:22}));await f.flow.load();expect(f.state.page).toBeNull();expect(f.state.drafts).toEqual({});f.read(async()=>page());await f.flow.load();
});
it('bounds image selection and requires explicit dismissal after an upload failure',async()=>{
  const f=setup();await f.flow.load();f.state.drafts[101].body.comment='图文';await f.flow.upload([1,2,3,4,5,6,7,8,9]);expect(f.state.drafts[101].uploadError).toBeTruthy();await f.flow.submit();expect(f.writes).toEqual([]);f.flow.ignoreUploadError();await f.flow.upload([1]);expect(f.state.drafts[101].images).toHaveLength(1);f.flow.removeImage(0);expect(f.releases).toEqual([1]);
});
it('rejects private upload receipts with mismatched reference or unrelated preview authority',()=>{
  const good={url:'/api/assets/1',src:'/api/assets/1?expires=1900000000&signature='+'a'.repeat(43),name:'local.png'};expect(parseBuyerReviewUpload(good)).toEqual(good);
  for(const change of [{url:'/api/assets/2'},{src:'/api/assets/1'},{src:'https://other.invalid/a.png'},{name:null}])expect(()=>parseBuyerReviewUpload({...good,...change})).toThrow();
});
