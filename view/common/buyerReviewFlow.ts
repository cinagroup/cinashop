import { orderDetailId } from './orderDetailIdentity';
import { buyerReviewCommunityMessage, parseBuyerReviewCommunityRetryAck, validateBuyerReviewCommunityRetry, type BuyerReviewCommunityRetry } from './buyerReviewCommunitySync';
import { buyerReviewDraft, buyerReviewImageReference, buyerReviewImageSource, parseBuyerReviewAck, parseBuyerReviewPage,
  validateBuyerReviewBody, MAX_BUYER_REVIEW_IMAGES, type BuyerReviewAck, type BuyerReviewBody, type BuyerReviewDraft, type BuyerReviewPage } from './buyerReview';
export interface BuyerReviewSession { uid:number; token:string; current():boolean }
export interface BuyerReviewUpload { url:string; preview:string; release?():void }
export interface BuyerReviewEditing { revision:string; body:BuyerReviewDraft; images:BuyerReviewUpload[]; uploadError:string }
export interface BuyerReviewFlowState {
  page:BuyerReviewPage|null; selected:number|null; drafts:Record<number,BuyerReviewEditing>;
  loading:boolean; busy:boolean; syncing:boolean; uploading:boolean; uncertain:boolean; error:string; message:string;
}
export const initialBuyerReviewFlow=():BuyerReviewFlowState=>({page:null,selected:null,drafts:{},loading:false,busy:false,syncing:false,uploading:false,uncertain:false,error:'',message:''});
interface Pending { inFlight:boolean; line:number; kind:'review'|'community' }
// Same-session page reconstruction must not silently forget an outstanding
// write. Only identifiers live here; drafts, pictures and text stay in the flow.
const pending=new Map<string,Pending>();
const key=(s:BuyerReviewSession,order:string)=>JSON.stringify([s.uid,s.token,order]);
const error=(e:unknown)=>e instanceof Error?e.message:'评价请求未确认，请重新读取';
const dispose=(image:BuyerReviewUpload)=>{try{image.release?.();}catch{/* Always finish private-state cleanup. */}};
export function parseBuyerReviewUpload(raw:unknown):{url:string;src:string;name:string}{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('图片上传回执无效');const r=raw as Record<string,unknown>;
  const url=buyerReviewImageReference(r.url),src=buyerReviewImageSource(r.src);
  if(!src.startsWith(url+'?')||typeof r.name!=='string'||r.name.length>255)throw Error('图片上传回执无效');
  return {url,src,name:r.name};
}
export function createBuyerReviewFlow<T>(state:BuyerReviewFlowState,dep:{
  capture():BuyerReviewSession; read(reference:string):Promise<unknown>; submit(body:BuyerReviewBody):Promise<unknown>;
  retryCommunity?(body:BuyerReviewCommunityRetry):Promise<unknown>;
  upload(file:T,current:()=>boolean):Promise<BuyerReviewUpload>; confirmed?(ack:BuyerReviewAck):void;
}){
  let reference:string|null=null,epoch=0,ownerKey='';
  function discard(draft:BuyerReviewEditing){draft.images.forEach(dispose);}
  function clear(){epoch++;Object.values(state.drafts).forEach(discard);state.page=null;state.selected=null;state.drafts={};state.loading=false;state.busy=false;state.syncing=false;state.uploading=false;state.uncertain=false;state.error='';state.message='';ownerKey='';}
  function capture(){const s=dep.capture(),generation=epoch,order=reference;return {...s,current:()=>!!order&&order===reference&&generation===epoch&&s.current()};}
  const authenticated=(s:BuyerReviewSession)=>Number.isInteger(s.uid)&&s.uid>0&&!!s.token&&s.current();
  function setOrder(value:unknown){clear();reference=null;try{const id=orderDetailId(value);if(id.length>50)throw Error();reference=id;}catch{state.error='评价链接无效，请返回订单列表';}}
  const selected=()=>state.page?.lines.find(line=>line.id===state.selected)??null;
  const currentDraft=()=>state.selected===null?null:state.drafts[state.selected]??null;
  function blocked(s:BuyerReviewSession){return state.loading||state.busy||state.syncing||state.uploading||state.uncertain||!reference||pending.has(key(s,reference));}
  function editable(){const s=capture(),line=selected();return authenticated(s)&&!blocked(s)&&state.page?.uid===s.uid&&line?.canReply===true;}
  function select(id:number){const s=capture();if(!authenticated(s)||state.loading||state.busy||state.syncing||state.uploading)return;const line=state.page?.lines.find(line=>line.id===id);if(!line)return;state.selected=id;}
  async function load(){
    if(!reference)return;const order=reference,raw=dep.capture(),nextKey=key(raw,order),previous=ownerKey===nextKey?state.drafts:{};
    if(ownerKey!==nextKey)Object.values(state.drafts).forEach(discard);
    epoch++;const s=capture();state.page=null;state.selected=null;state.drafts={};state.error='';state.message='';state.busy=false;state.syncing=false;state.uploading=false;state.uncertain=false;state.loading=true;ownerKey=nextKey;
    if(!authenticated(s)){Object.values(previous).forEach(discard);state.loading=false;state.error='请登录后评价订单';return;}
    try{
      const page=parseBuyerReviewPage(await dep.read(order),order,s.uid);if(!s.current()){Object.values(previous).forEach(discard);return;}
      const drafts:Record<number,BuyerReviewEditing>={};
      for(const line of page.lines)if(line.canReply){const old=previous[line.id];drafts[line.id]=old&&old.revision===line.revision?old:{revision:line.revision,body:buyerReviewDraft(),images:[],uploadError:''};}
      for(const [id,draft] of Object.entries(previous))if(drafts[Number(id)]!==draft)discard(draft);
      state.page=page;state.drafts=drafts;const mark=pending.get(nextKey);
      state.selected=(mark&&page.lines.find(line=>line.id===mark.line)?.id)??page.lines.find(line=>line.canReply)?.id??page.lines[0]?.id??null;
      if(mark?.inFlight){state.uncertain=true;state.message=mark.kind==='community'?'上次社区同步仍在处理中，请稍后刷新核对':'上次评价仍在处理中，请稍后刷新核对';}
      else if(mark){pending.delete(nextKey);state.message='已重新读取当前评价，请核对后再操作';}
    }catch(e){Object.values(previous).forEach(discard);if(s.current()){state.page=null;state.drafts={};state.error=error(e);state.uncertain=pending.has(nextKey);}}
    finally{if(s.current())state.loading=false;}
  }
  async function upload(files:readonly T[]){
    if(!editable())return;const s=capture(),line=selected()!,draft=currentDraft()!;
    if(!files.length)return;if(files.length>MAX_BUYER_REVIEW_IMAGES-draft.images.length){draft.uploadError='每件商品最多上传8张图片';return;}
    state.uploading=true;draft.uploadError='';
    const current=()=>s.current()&&selected()?.id===line.id&&currentDraft()===draft;
    try{for(const file of files){if(!current())return;const image=await dep.upload(file,current);
      if(!current()){dispose(image);return;}try{buyerReviewImageReference(image.url);if(typeof image.preview!=='string'||!image.preview)throw Error('图片预览无效');}
      catch(e){dispose(image);throw e;}if(draft.images.some(old=>old.url===image.url)){dispose(image);throw Error('同一张图片不能重复选择');}draft.images.push(image);
    }}catch(e){if(current())draft.uploadError=error(e);}finally{if(current())state.uploading=false;}
  }
  function removeImage(index:number){if(!editable())return;const draft=currentDraft();if(!draft||!Number.isInteger(index)||index<0||index>=draft.images.length)return;const [image]=draft.images.splice(index,1);dispose(image);draft.uploadError='';}
  function ignoreUploadError(){if(editable()){const draft=currentDraft();if(draft)draft.uploadError='';}}
  async function submit(){
    if(!editable())return;const s=capture(),page=state.page!,line=selected()!,draft=currentDraft()!;if(draft.uploadError)return;
    let body:BuyerReviewBody;try{body=validateBuyerReviewBody({...draft.body,version:1,orderId:page.orderId,orderNo:page.orderNo,cartInfoId:line.id,unique:line.unique,revision:line.revision,pics:draft.images.map(image=>image.url)});}
    catch{state.error='请填写评价内容并完成评分，图片最多8张';return;}
    const target=reference!,identity=key(s,target),mark:Pending={inFlight:true,line:line.id,kind:'review'};
    if(pending.size>=128){state.error='待核对的评价请求过多，请先刷新相关订单';return;}
    pending.set(identity,mark);state.busy=true;state.error='';state.message='';let ack:BuyerReviewAck|undefined;
    try{ack=parseBuyerReviewAck(await dep.submit(body),body,s.uid);}catch(e){if(s.current()){state.error=error(e);state.uncertain=true;state.message='评价结果未确认，请刷新状态核对；不会自动再次提交';}}
    finally{mark.inFlight=false;if(ack&&s.current()&&pending.get(identity)===mark)pending.delete(identity);if(s.current())state.busy=false;}
    if(!ack||!s.current())return;const owner=dep.capture();await load();
    if(reference===target&&owner.current()&&owner.uid===s.uid&&owner.token===s.token){
      state.message=[ack.completed?'所有需要评价的商品均已提交':'该商品评价已提交，可继续评价其他商品',buyerReviewCommunityMessage(ack.communitySync)].filter(Boolean).join(' ');dep.confirmed?.(ack);
    }
  }
  function canRetryCommunity(){
    const s=capture(),line=selected(),sync=line?.review?.communitySync;
    return !!dep.retryCommunity&&authenticated(s)&&!blocked(s)&&state.page?.uid===s.uid&&line?.isGift===false&&line.review?.uid===s.uid&&sync?.status==='pending'&&!!sync.revision;
  }
  async function retryCommunity(){
    if(!canRetryCommunity())return;const s=capture(),page=state.page!,line=selected()!,review=line.review!;
    const body=validateBuyerReviewCommunityRetry({version:1,orderId:page.orderId,orderNo:page.orderNo,cartInfoId:line.id,unique:line.unique,replyId:review.id,syncRevision:review.communitySync!.revision});
    const target=reference!,identity=key(s,target),mark:Pending={inFlight:true,line:line.id,kind:'community'};
    if(pending.size>=128){state.error='待核对的请求过多，请先刷新相关订单';return;}
    pending.set(identity,mark);state.syncing=true;state.error='';state.message='';let message:string|undefined;
    try{
      const raw=await dep.retryCommunity!(body);
      const sync=parseBuyerReviewCommunityRetryAck(raw,body,s.uid);
      message=buyerReviewCommunityMessage(sync);
    }catch(e){if(s.current()){state.error=error(e);state.uncertain=true;state.message='社区同步结果未确认，请刷新状态核对；不会自动再次提交';}}
    finally{mark.inFlight=false;if(message&&s.current()&&pending.get(identity)===mark)pending.delete(identity);if(s.current())state.syncing=false;}
    if(!message||!s.current())return;const owner=dep.capture();await load();
    if(reference===target&&owner.current()&&owner.uid===s.uid&&owner.token===s.token){
      const saved=state.page?.lines.find(item=>item.id===line.id);if(saved?.review?.id===review.id){state.selected=line.id;state.message=buyerReviewCommunityMessage(saved.review.communitySync)||message;}
    }
  }
  return {setOrder,load,clear,suspend:clear,selected,currentDraft,select,editable,upload,removeImage,ignoreUploadError,submit,canRetryCommunity,retryCommunity};
}
