import { expect, it } from 'vitest';
import { buyerReviewDraft, buyerReviewImageReference, buyerReviewImageSource, parseBuyerReviewAck, parseBuyerReviewPage, validateBuyerReviewBody } from '../../view/common/buyerReview';
const revision='a'.repeat(64),line={id:101,unique:'review_A',productId:70,name:'本机商品',sku:'红色',price:'10.00',image:'/images/local.png',isGift:false,revision,canReply:true,reason:'',review:null};
const page=()=>({version:1,uid:11,orderId:91,orderNo:'review_order_A',paid:true,status:2,canReview:true,reason:'',lines:[{...line}]});
const body=()=>({...buyerReviewDraft(),version:1,orderId:91,orderNo:'review_order_A',cartInfoId:101,unique:'review_A',revision,comment:'单独的商品评价'});
it('requires exact owner, public order reference and unique current line identities',()=>{
  expect(parseBuyerReviewPage(page(),'review_order_A',11).lines[0]).toEqual(line);
  expect(()=>parseBuyerReviewPage(page(),'review_order_B',11)).toThrow();expect(()=>parseBuyerReviewPage(page(),'review_order_A',22)).toThrow();
  for(const lines of [[line,line],[line,{...line,id:102}],[{...line,isGift:true}],[{...line,review:{}}]])expect(()=>parseBuyerReviewPage({...page(),lines},'review_order_A',11)).toThrow();
});
it.each([{version:2},{uid:22},{paid:false},{status:3},{lines:{}},{reason:'cannot'},{lines:Array(201).fill(line)}])('rejects inconsistent page %j',change=>expect(()=>parseBuyerReviewPage({...page(),...change},'review_order_A',11)).toThrow());
it('preserves independent scoring and exact stable picture IDs without storing preview signatures',()=>{
  const input={...body(),replyScore:2,productScore:3,serviceScore:4,logisticsScore:5,pics:['/api/assets/1','/api/assets/22']};expect(validateBuyerReviewBody(input)).toEqual(input);
});
it.each([{uid:22},{revision:'stale'},{unique:''},{comment:' '},{comment:'a'.repeat(513)},{comment:'\ud800'},{replyScore:true},{productScore:'5'},{serviceScore:0},{logisticsScore:6},
  {pics:['/api/assets/1?signature=preview']},{pics:['https://other.invalid/a.png']},{pics:['/api/assets/1','/api/assets/1']},{pics:Array.from({length:9},(_,n)=>'/api/assets/'+(n+1))}])('rejects malformed/version-extended write %j',change=>expect(()=>validateBuyerReviewBody({...body(),...change})).toThrow());
it.each(['/api/assets/0','/api/assets/01','/api/assets/2147483648','/api/assets/%31','/api/assets/1/','//other.invalid/a'])('rejects noncanonical upload references %s',ref=>expect(()=>buyerReviewImageReference(ref)).toThrow());
it('accepts only signed, bounded canonical preview URLs for private pictures',()=>{
  const src='/api/assets/1?expires=1900000000&signature='+'a'.repeat(43);expect(buyerReviewImageSource(src)).toBe(src);
  for(const value of ['/api/assets/1/../2?expires=1900000000&signature='+'a'.repeat(43),'/api/assets/1',src+'&uid=22',src+'#x','javascript:alert(1)','//other.invalid/a'])expect(()=>buyerReviewImageSource(value)).toThrow();
});
it('requires a current account/order/line acknowledgement and retains actual lottery boolean',()=>{
  const input=validateBuyerReviewBody(body()),ack={version:1,uid:11,orderId:91,orderNo:'review_order_A',cartInfoId:101,unique:'review_A',replyId:501,completed:false,toLottery:true};
  expect(parseBuyerReviewAck(ack,input,11)).toEqual(ack);
  for(const change of [{uid:22},{orderId:92},{orderNo:'other'},{cartInfoId:102},{unique:'other'},{replyId:0},{completed:1},{toLottery:'true'}])expect(()=>parseBuyerReviewAck({...ack,...change},input,11)).toThrow();
});

import { buyerReviewPageRoute,buyerReviewQuery } from '../../view/common/buyerReviewRoute';
it('legacy review links retain the public order number and selected line with duplicate and foreign parameters rejected',()=>{
  expect(buyerReviewPageRoute({uni:'order_A',unique:'line_102'},true)).toBe('/pages/order/reply?orderId=order_A&unique=line_102');
  expect(buyerReviewQuery('orderId=order_A&unique=line_102')).toEqual({orderId:'order_A',unique:'line_102'});
  expect(buyerReviewQuery('?uni=order_A&unique=line%2B1',true)).toEqual({orderId:'order_A',unique:'line+1'});
  for(const raw of ['uni=a&__proto__=ignored','uni=a&%5f%5fproto%5f%5f=ignored','uni=a&%75ni=b','uni=a&unique=%ff','uni=a&uni=b','uni=a&uid=22','orderId=a','uni=a&unique=','uni=a&unique=%00','uni=a&unique=%zz'])expect(()=>buyerReviewQuery(raw,true)).toThrow();
});

it('reads an owned write-off-pending order as disabled while never admitting an editable line',()=>{const raw={...page(),status:5,canReview:false,reason:'请在确认收货后评价',lines:[{...line,canReply:false,reason:'请在确认收货后评价'}]};expect(parseBuyerReviewPage(raw,'review_order_A',11).status).toBe(5);expect(()=>parseBuyerReviewPage({...raw,canReview:true},'review_order_A',11)).toThrow();});

it('validates canonical signed review pictures without browser URL globals',()=>{const names=['URL','URLSearchParams'] as const,descriptors=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));try{names.forEach(name=>Object.defineProperty(globalThis,name,{configurable:true,value:undefined}));const source='/api/assets/1?expires=1900000000&signature='+'a'.repeat(43);expect(buyerReviewImageSource(source)).toBe(source);expect(()=>buyerReviewImageSource(source+'&expires=2')).toThrow();}finally{names.forEach((name,index)=>{const d=descriptors[index];if(d)Object.defineProperty(globalThis,name,d);else Reflect.deleteProperty(globalThis,name);});}});
