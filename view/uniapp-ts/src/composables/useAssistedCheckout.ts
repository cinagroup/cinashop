import { computed, ref, shallowRef, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAdminSession } from '@/stores/adminSession';
import { useAssistedDraft } from '@/stores/assistedDraft';
import { assistedJournal } from '@/utils/assistedIntent';
import { apiAssistedCart, type AssistedCartRow } from '@/api/assistedSelection';
import { apiAssistedQuote, apiAssistedCreate, apiAssistedAddresses, apiAssistedStores, apiAssistedCities, apiAssistedCoupons,
  apiAssistedFormUpload, apiAssistedFormPreviews,
  type AssistedQuote, type AssistedSavedAddress, type AssistedStore, type AssistedCity, type AssistedCoupon } from '@/api/assistedCheckout';
import { assistedAddress, assistedOptions, type AssistedOwner, type AssistedIntent, type AssistedOptions } from '../../../common/assistedCheckout';
import { RequestError } from '@/utils/request';
import { prepareAssistedFormAnswers } from '../../../common/assistedForm';
import { validAssistedOrderNo } from '@/api/assistedDetail';
import type { SystemFormComponent } from '@/types/systemForm';

const emptyManual = () => ({ realName:'',phone:'',province:'',city:'',district:'',street:'',detail:'',cityId:0 });
export function useAssistedCheckout() {
  const session=useAdminSession(),draft=useAssistedDraft(),journal=assistedJournal();
  const visible=ref(false),scope=shallowRef<AssistedOwner|null>(null),loading=ref(false),error=ref(''),notice=ref('');
  const items=ref<AssistedCartRow[]>([]),addresses=ref<AssistedSavedAddress[]>([]),stores=ref<AssistedStore[]>([]);
  const addressError=ref(''),storeError=ref(''),addressId=ref(0),storeId=ref(0),shipping=ref<1|2>(1),manualMode=ref(false);
  const manual=ref(emptyManual()),contact=ref({name:'',phone:''}),mark=ref(''),couponId=ref(0),useIntegral=ref(false);
  const payType=ref<AssistedOptions['payType']>('cash'),quote=shallowRef<AssistedQuote|null>(null),key=ref(''),quoteError=ref(''),quoteBusy=ref(false);
  const pending=shallowRef<AssistedIntent|null>(null),submitting=ref(false),confirming=ref(false),verified=ref(false),consent=ref(false);
  const regions=ref<AssistedCity[][]>([[],[],[],[]]),regionIds=ref([0,0,0,0]),regionBusy=ref(false),regionError=ref('');
  const coupons=ref<AssistedCoupon[]>([]),couponError=ref(''),couponBusy=ref(false);
  const customForm=ref<SystemFormComponent[]>([]),formName=ref(''),formRevision=ref(0),formPending=ref(0),formChoosing=ref(false);
  const previews=ref<Record<string,string>>({}),previewBusy=ref(false),previewError=ref('');
  const pickerSuspended=ref(false),needsRequote=ref(false);
  let formSignature='',previewEpoch=0;
  let generation=0,quoteEpoch=0,regionEpoch=0,couponEpoch=0,routeUid=-1,draftVersion=-1,resume=false,quotedInput='',couponScope='';
  const authorized=computed(()=>session.authenticated && session.canAssist);
  const freshContext=()=>draft.current && draft.version===draftVersion && draft.scope?.uid===routeUid
    && session.permissions.includes('product.view') && (routeUid===0 || session.permissions.includes('user.view'));
  const current=(epoch:number)=>visible.value && authorized.value && generation===epoch && scope.value?.adminId===session.id;
  const locked=computed(()=>!visible.value || !authorized.value || loading.value || !!pending.value || submitting.value || confirming.value || formPending.value>0);
  const formLocked=computed(()=>(!visible.value&&!pickerSuspended.value) || !authorized.value || loading.value || !!pending.value
    || submitting.value || confirming.value || !quote.value || quoteBusy.value);
  const formValidation=computed(()=>{
    if(!quote.value?.form)return '';
    try{prepareAssistedFormAnswers(quote.value.form.value,customForm.value,quote.value.formId);return '';}
    catch(e){return message(e);}
  });
  const productType=computed(()=>items.value[0]?.productType ?? 0);
  const shippingTypes=computed<readonly number[]>(()=>productType.value===4?[2]:[1,2,3].includes(productType.value)?[1]:[1,2]);
  const needsAddress=computed(()=>shipping.value===1 && ![1,2,3].includes(productType.value));
  function options():AssistedOptions {
    if (!shippingTypes.value.includes(shipping.value)) throw Error('当前商品不支持此配送方式');
    return assistedOptions({addressId:needsAddress.value && !manualMode.value?addressId.value:0,shipping_type:shipping.value,
      store_id:shipping.value===2?storeId.value:0,couponId:couponId.value,useIntegral:useIntegral.value,payType:payType.value,
      ...(needsAddress.value && manualMode.value?{manualAddress:assistedAddress(manual.value)}:{})});
  }
  const deliveryError=computed(()=>{
    if(shipping.value===2)return !stores.value.some(row=>row.id===storeId.value)?storeError.value||'请选择可用自提门店':!contact.value.name.trim()||!contact.value.phone.trim()?'请填写自提联系人及电话':'';
    if(!needsAddress.value)return '';
    if(!manualMode.value)return !addresses.value.some(row=>row.id===addressId.value)?addressError.value||'请选择收货地址，或填写结构化地址':'';
    try{assistedAddress(manual.value);return '';}catch(e){return message(e);}
  });
  const canSubmit=computed(()=>!locked.value && !quoteBusy.value && !!quote.value && !error.value && !deliveryError.value
    && !formValidation.value && !previewBusy.value && !needsRequote.value && consent.value && quotedInput===safeOptions());
  const canRecover=computed(()=>visible.value && authorized.value && !!pending.value && !submitting.value && !confirming.value);
  function safeOptions(){try{return JSON.stringify(options());}catch{return '';}}
  function invalidate(){quoteEpoch++;previewEpoch++;previewBusy.value=false;quote.value=null;quoteBusy.value=false;quoteError.value='';quotedInput='';consent.value=false;}
  function reset(){generation++;invalidate();regionEpoch++;couponEpoch++;scope.value=null;items.value=[];addresses.value=[];stores.value=[];
    pickerSuspended.value=false;needsRequote.value=false;formChoosing.value=false;formPending.value=0;
    customForm.value=[];formName.value='';formSignature='';formRevision.value++;previews.value={};previewError.value='';
    pending.value=null;verified.value=false;loading.value=false;submitting.value=false;confirming.value=false;error.value='';notice.value='';
    manual.value=emptyManual();contact.value={name:'',phone:''};mark.value='';addressId.value=0;storeId.value=0;shipping.value=1;
    manualMode.value=false;couponId.value=0;useIntegral.value=false;payType.value='cash';key.value='';addressError.value='';storeError.value='';
    regions.value=[[],[],[],[]];regionIds.value=[0,0,0,0];regionBusy.value=false;regionError.value='';coupons.value=[];couponBusy.value=false;couponError.value='';couponScope='';}
  async function load(){
    if(!visible.value || !authorized.value || submitting.value)return;
    reset();const epoch=generation;loading.value=true;
    try{
      const saved=journal.read(session.id);draft.checkoutLock=!!saved;
      if(saved){scope.value={adminId:saved.adminId,uid:saved.uid,touristUid:saved.touristUid};pending.value=saved;return;}
      if(resume)throw Error('当前管理员没有本机待确认记录，请从选客页开始');
      if(!freshContext() || !draft.scope || draft.pending || draft.needsReview)throw Error('买家上下文失效或购物车尚未核对，请返回选品页');
      scope.value={...draft.scope};const owner={...scope.value};
      const cart=await apiAssistedCart(owner);if(!current(epoch))return;
      if(!cart.length || cart.some(row=>!row.valid) || new Set(cart.map(row=>row.productType)).size!==1)throw Error('购物车为空、存在失效商品或混合履约类型，请返回选品页处理');
      items.value=cart;shipping.value=cart[0].productType===4?2:1;manualMode.value=owner.uid===0;
      await Promise.all([
        owner.uid && session.permissions.includes('user.view')?apiAssistedAddresses(owner).then(rows=>{
          if(!current(epoch))return;addresses.value=rows;addressId.value=(rows.find(row=>row.isDefault)??rows[0])?.id??0;
        }).catch(e=>{if(current(epoch))addressError.value=message(e);}):Promise.resolve(),
        apiAssistedStores().then(rows=>{if(current(epoch))stores.value=rows;}).catch(e=>{if(current(epoch))storeError.value=message(e);}),
      ]);
      if(current(epoch) && manualMode.value && needsAddress.value)await loadRegions();
    }catch(e){if(visible.value && generation===epoch){draft.checkCheckout();error.value=message(e);}}
    finally{if(visible.value && generation===epoch){loading.value=false;if(!pending.value && !error.value)await refreshQuote();}}
  }
  async function refreshQuote(){
    if(locked.value || !scope.value || !items.value.length || draft.pending || draft.needsReview || !freshContext())return;
    needsRequote.value=false;
    invalidate();const epoch=generation,request=quoteEpoch,owner={...scope.value};
    let input:AssistedOptions;try{input=options();}catch(e){quoteError.value=message(e);return;}
    // Missing logistics address is only a preview, never a submission. Allow
    // the core to expose required-form/type information while the operator edits.
    const fingerprint=JSON.stringify(input);quoteBusy.value=true;
    try{
      const result=await apiAssistedQuote(owner,items.value.map(row=>row.id),input,key.value||undefined);
      if(!current(epoch)||request!==quoteEpoch||safeOptions()!==fingerprint)return;
      if('orderId' in result){error.value=`原确认标识已有订单 ${result.orderId}，请到代客记录核对，勿重新建单`;return;}
      installForm(result);quote.value=result;key.value=result.key;quotedInput=fingerprint;
    }catch(e){if(current(epoch)&&request===quoteEpoch)quoteError.value=message(e);}
    finally{if(current(epoch)&&request===quoteEpoch)quoteBusy.value=false;}
  }
  function installForm(priced:AssistedQuote){
    const signature=JSON.stringify([priced.key,priced.form]);
    if(signature===formSignature)return;
    if(formSignature&&customForm.value.length)notice.value='商品表单已变化，已清空原答案，请重新填写并确认';
    formSignature=signature;formRevision.value++;formName.value=priced.form?.name??'';
    customForm.value=priced.form?JSON.parse(JSON.stringify(priced.form.value)):[];
    // Template defaults cannot authorize a member/other checkout's attachment.
    for(const item of customForm.value)if(item.name==='uploadPicture')item.value=[];
    previews.value={};previewError.value='';consent.value=false;
  }
  function updateForm(value:SystemFormComponent[]){if(!formLocked.value){customForm.value=value;consent.value=false;}}
  function onFormChoosing(value:boolean){formChoosing.value=value;}
  function onFormPending(value:number){
    formPending.value=value>0?1:0;
    if(!formPending.value&&needsRequote.value&&visible.value)void refreshQuote();
  }
  const formCurrent=(epoch:number,originalKey:string,signature:string)=>generation===epoch&&(visible.value||pickerSuspended.value)
    &&authorized.value&&scope.value?.adminId===session.id&&freshContext()&&key.value===originalKey&&formSignature===signature&&!!quote.value;
  async function uploadFormImage(path:string){
    if(formLocked.value||!scope.value)throw Error('代客表单上下文已失效');
    const epoch=generation,originalKey=key.value,signature=formSignature,owner={...scope.value};
    const result=await apiAssistedFormUpload(owner,originalKey,path);
    if(!formCurrent(epoch,originalKey,signature))throw Error('代客表单上下文已变化，请重新选择图片');
    previews.value={...previews.value,[result.url]:result.src};consent.value=false;
    return result;
  }
  async function refreshPreviews(){
    if(formLocked.value||formPending.value||!scope.value)return;
    const references=customForm.value.filter(item=>item.name==='uploadPicture').flatMap(item=>Array.isArray(item.value)?item.value:[]) as string[];
    if(!references.length)return;
    const epoch=generation,request=++previewEpoch,originalKey=key.value,signature=formSignature;
    previewBusy.value=true;previewError.value='';
    try{const result=await apiAssistedFormPreviews({...scope.value},originalKey,references);
      if(formCurrent(epoch,originalKey,signature)&&request===previewEpoch)previews.value={...previews.value,...result};
    }catch(e){if(formCurrent(epoch,originalKey,signature)&&request===previewEpoch)previewError.value=message(e);}
    finally{if(generation===epoch&&request===previewEpoch)previewBusy.value=false;}
  }
  async function loadRegions(){
    if(!visible.value||!authorized.value||pending.value)return;
    const epoch=generation,request=++regionEpoch;regionBusy.value=true;regionError.value='';
    try{const rows=await apiAssistedCities(0);if(current(epoch)&&request===regionEpoch)regions.value=[rows,[],[],[]];}
    catch(e){if(current(epoch)&&request===regionEpoch)regionError.value=message(e);}
    finally{if(current(epoch)&&request===regionEpoch)regionBusy.value=false;}
  }
  async function selectRegion(level:number,index:number){
    if(locked.value || !Number.isInteger(level)||level<0||level>3)return;
    const row=regions.value[level]?.[index];if(!row)return;
    const epoch=generation,request=++regionEpoch;regionBusy.value=false;regionError.value='';
    for(let depth=level;depth<4;depth++){regionIds.value[depth]=0;if(depth>level)regions.value[depth]=[];}
    regionIds.value[level]=row.id;
    const names=['province','city','district','street'] as const;
    for(let depth=level;depth<4;depth++)manual.value[names[depth]]=depth===level?row.name:'';
    manual.value.cityId=level>=2?row.id:0;
    if(row.expandable && level<3){
      regionBusy.value=true;
      try{const rows=await apiAssistedCities(row.id);if(current(epoch)&&request===regionEpoch)regions.value[level+1]=rows;}
      catch(e){if(current(epoch)&&request===regionEpoch)regionError.value=message(e);}
      finally{if(current(epoch)&&request===regionEpoch)regionBusy.value=false;}
    }
  }
  function setShipping(value:number){if(!locked.value && shippingTypes.value.includes(value))shipping.value=value as 1|2;}
  function setManual(value:boolean){if(locked.value)return;manualMode.value=value;if(value && !regions.value[0].length)void loadRegions();}
  const couponSignature=()=>JSON.stringify([items.value.map(row=>row.id),shipping.value,storeId.value]);
  async function loadCoupons(){
    if(locked.value||!scope.value||!scope.value.uid||!items.value.length)return;
    let input:AssistedOptions;try{input=options();}catch(e){couponError.value=message(e);return;}
    couponId.value=0;const epoch=generation,request=++couponEpoch,selection=couponSignature();couponBusy.value=true;couponError.value='';coupons.value=[];
    try{const rows=await apiAssistedCoupons({...scope.value},items.value.map(row=>row.id),input);
      if(current(epoch)&&request===couponEpoch&&selection===couponSignature()){coupons.value=rows;couponScope=selection;}}
    catch(e){if(current(epoch)&&request===couponEpoch)couponError.value=message(e);}
    finally{if(current(epoch)&&request===couponEpoch)couponBusy.value=false;}
  }
  function selectCoupon(id:number){if(!locked.value&&!couponBusy.value&&(id===0 || couponScope===couponSignature()&&coupons.value.some(row=>row.id===id)))couponId.value=id;}
  function confirmSubmit(){
    if(!canSubmit.value)return;const epoch=generation,token=quote.value!.token;confirming.value=true;
    const failed=()=>{if(current(epoch)){confirming.value=false;notice.value='确认窗口打开失败，未发送建单请求';}};
    try{uni.showModal({title:'确认代客建单',content:`应付 ¥${quote.value!.amounts.payable}。提交将预占库存、优惠券和积分，但不会执行收款。收货信息、表单答案和图片引用将未加密地暂存在本机以恢复结果。`,
      success:result=>{if(!current(epoch))return;confirming.value=false;if(result.confirm&&quote.value?.token===token&&canSubmit.value)void submit();},fail:failed});}catch{failed();}
  }
  async function submit(){
    if(pending.value?!canRecover.value:!canSubmit.value)return;
    const epoch=generation,adminVersion=session.version,owner=scope.value?{...scope.value}:null;if(!owner)return;
    submitting.value=true;notice.value='';let intent:AssistedIntent|null=null,fresh=false,sent=false;
    try{
      if(!pending.value){
        const priced=quote.value!;if(quotedInput!==safeOptions())throw Error('结算选择已变化，请重新报价');
        intent=journal.begin(owner,priced.key,priced.cartIds,{...priced.options,addressId:priced.address?.id??0,quoteToken:priced.token,
          ...(priced.form?{customForm:prepareAssistedFormAnswers(priced.form.value,customForm.value,priced.formId)}:{}),
          real_name:shipping.value===2?contact.value.name.trim():'',phone:shipping.value===2?contact.value.phone.trim():'',mark:mark.value.trim()});
        pending.value=intent;draft.checkoutLock=true;fresh=true;
      }else intent=journal.current(pending.value);
      if(!intent.result)intent=journal.attempt(intent);
      pending.value=intent;sent=true;
      const result=await apiAssistedCreate(intent),settled=journal.settle(intent,result);
      if(!current(epoch)||session.version!==adminVersion)return;
      pending.value=settled;verified.value=true;notice.value='订单已由服务器确认。本页没有执行付款。';
    }catch(e){
      if(!current(epoch)||session.version!==adminVersion)return;
      notice.value=message(e);
      const data=e instanceof RequestError&&e.status===400&&e.httpStatus===200?e.data as Record<string,unknown>|null:null;
      if(sent&&fresh&&intent&&['ORDER_QUOTE_RECONFIRM_REQUIRED','ORDER_FORM_REJECTED'].includes(String(data?.errorCode))&&data?.orderKey===intent.key){
        try{journal.clear(intent,true);pending.value=null;draft.checkoutLock=false;invalidate();notice.value='服务器明确拒绝首次建单，请重新报价后确认';}
        catch(storageError){notice.value=message(storageError);}
      }else{
        try{pending.value=journal.read(owner.adminId);draft.checkoutLock=!!pending.value;}catch{draft.checkoutLock=true;}
        if(sent)notice.value+='。结果尚未核实，只能用原标识和原内容查询／重试，勿重新创建。';
      }
    }finally{if(current(epoch)&&session.version===adminVersion)submitting.value=false;}
  }
  function clearResult(){
    if(!canRecover.value||!verified.value||!pending.value?.result)return;
    try{journal.clear(pending.value);pending.value=null;draft.checkoutLock=false;draft.clear();reset();error.value='已清除本机收货信息、表单答案与恢复记录，可到代客记录查看订单或重新选客';}
    catch(e){notice.value=message(e);}
  }
  function goBuyers(){uni.navigateTo({url:'/pages/behalf/user_list/index'});}
  function goRecords(){uni.navigateTo({url:'/pages/behalf/record/index'});}
  function goDetail(){
    const orderNo=pending.value?.result?.orderId;
    if(!visible.value || !verified.value || !authorized.value || scope.value?.adminId!==session.id
      || !orderNo || !validAssistedOrderNo(orderNo))return;
    uni.navigateTo({url:`/pages/behalf/order_detail/index?orderId=${encodeURIComponent(orderNo)}`});
  }
  function goCashier(){
    const orderNo=pending.value?.result?.orderId;
    if(!visible.value || !verified.value || !authorized.value || scope.value?.adminId!==session.id
      || !orderNo || !validAssistedOrderNo(orderNo))return;
    uni.navigateTo({url:`/pages/behalf/cashier/index?orderId=${encodeURIComponent(orderNo)}`});
  }
  function goCart(){if(draft.current&&draft.scope&&!pending.value)uni.navigateTo({url:`/pages/behalf/goods_list/index?uid=${draft.scope.uid}`});}
  watch([shipping,addressId,storeId,manualMode,manual,couponId,useIntegral,payType],invalidate,{deep:true,flush:'sync'});
  watch([customForm,contact,mark],()=>{consent.value=false;},{deep:true,flush:'sync'});
  watch([shipping,storeId],()=>{couponEpoch++;coupons.value=[];couponScope='';couponBusy.value=false;couponId.value=0;},{flush:'sync'});
  watch(()=>session.version,reset,{flush:'sync'});
  watch(()=>draft.version,reset,{flush:'sync'});
  onLoad(query=>{const value=String(query?.uid??'');routeUid=/^(0|[1-9]\d{0,9})$/.test(value)?Number(value):-1;resume=query?.resume==='1';draftVersion=draft.version;});
  onShow(()=>{
    session.ensureFresh();
    visible.value=true;
    if(pickerSuspended.value&&freshContext()&&authorized.value){pickerSuspended.value=false;if(!formPending.value)void refreshQuote();return;}
    void load();
  });
  onHide(()=>{
    if(formChoosing.value&&quote.value&&!pending.value){pickerSuspended.value=true;needsRequote.value=true;visible.value=false;consent.value=false;return;}
    visible.value=false;consent.value=false;
    reset();
  });
  onUnload(()=>{visible.value=false;reset();});
  return {session,draft,scope,authorized,loading,error,notice,items,addresses,stores,addressId,storeId,addressError,storeError,
    shipping,shippingTypes,needsAddress,manualMode,manual,contact,mark,payType,useIntegral,couponId,quote,quoteError,quoteBusy,
    pending,submitting,confirming,verified,consent,locked,canSubmit,canRecover,deliveryError,regions,regionIds,regionBusy,regionError,
    coupons,couponBusy,couponError,load,refreshQuote,loadRegions,selectRegion,setShipping,setManual,loadCoupons,selectCoupon,
    customForm,formName,formRevision,formLocked,formValidation,formPending,previews,previewBusy,previewError,
    updateForm,onFormChoosing,onFormPending,uploadFormImage,refreshPreviews,
    confirmSubmit,submit,clearResult,goBuyers,goRecords,goDetail,goCashier,goCart};
}
function message(error:unknown){return error instanceof Error?error.message:'代客结算失败，请重试';}
