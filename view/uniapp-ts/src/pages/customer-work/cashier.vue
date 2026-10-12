<template>
  <CustomerWorkShell title="次卡现金收银" :manager="manager" :domain-busy="operations.busy.value || images.busy.value || selectionBusy || formPending > 0" active="cashier">
    <template #recovery>
      <view v-if="operations.error.value" class="cw-recovery" role="status">{{ operations.error.value }}</view>
      <view v-if="images.error.value" class="cw-recovery" role="status">{{ images.error.value }}</view>
      <view v-if="images.pending.value.length" class="cw-recovery" data-cashier-image-recovery>
        <text class="cw-subtitle">原图片准备与上传核对</text><text>图片结果不明时，先查询原编号。重选恢复须选择同一原文件；更换文件须在原结果核对后发起新的上传。</text>
        <view v-for="intent in images.pending.value" :key="intent.request_key" class="cw-recovery-row" :data-cashier-image-pending="intent.request_key">
          <text>{{ intent.kind === 'session' ? '原创建前图片准备' : '原图片上传请求' }}</text><text class="cw-request-key">{{ intent.request_key }}</text><text>{{ imagePendingText(intent) }}</text>
          <view class="cw-controls"><button :disabled="locked" @tap="checkImage(intent)">查询原图片编号</button>
            <button v-if="canResumeImage(intent)" :disabled="locked" @tap="resumeImage(intent)">重选原图片恢复上传</button>
          </view>
        </view>
        <button v-if="images.session.value?.state === 'active' && !financialImageIntent" class="cw-full" :disabled="locked" @tap="cancelImages">取消已核对的创建前图片准备</button>
        <text v-if="images.session.value?.state === 'frozen'" class="cw-scope">原下单内容已冻结，请使用上方原收银请求核对与恢复。</text>
      </view>
      <view v-if="operations.pending.value.length" class="cw-recovery" data-cashier-recovery>
        <text class="cw-subtitle">原收银请求核对</text><text>本机保留原选品、购买人和联系资料，用于中断后核对。结果不明时继续使用原编号。</text>
        <view v-for="intent in operations.pending.value" :key="intent.request_key" class="cw-recovery-row" :data-cashier-pending="intent.request_key">
          <text>{{ intent.kind === 'creation' ? '原次卡创建请求' : '原现金付款请求' }}</text><text class="cw-request-key">{{ intent.request_key }}</text>
          <text v-if="intent.kind === 'creation'">原选品 {{ intent.body.quantity }} 份 · {{ intent.body.buyer_uid === 0 ? '游客购买人' : '会员购买人' }}</text>
          <text v-else>{{ intent.body.order_no }} · ¥{{ intent.body.expected_amount }}</text>
          <text>{{ pendingText(intent) }}</text><text v-if="operations.states.value[intent.request_key]?.error" class="cw-error">{{ operations.states.value[intent.request_key].error }}</text>
          <view class="cw-controls"><button :disabled="operations.busy.value" @tap="operations.check(intent)">查询原编号</button>
            <button v-if="operations.canRestore(intent)" :disabled="operations.busy.value" @tap="restore(intent)">{{ intent.kind === 'creation' ? '恢复原选品并重新报价' : '核对并恢复原付款' }}</button>
            <button v-if="operations.canAbandon(intent)" :disabled="locked" @tap="operations.abandon(intent)">{{ operations.abandonRequested(intent) ? '重试原永久放弃请求' : '永久放弃原收银请求' }}</button>
            <button v-if="canClose(intent)" :disabled="locked" @tap="acknowledge(intent)">关闭已核对的本机记录</button>
          </view>
        </view>
      </view>
    </template>
    <text v-if="message" class="cw-error" role="alert">{{ message }}</text>
    <view v-if="manager.context.value?.data.capabilities.cashier_second_card !== true" class="cw-empty">当前经营账号暂不能创建次卡收银订单。原编号仍可在上方核对。</view>
    <template v-else>
      <view class="cw-card"><text class="cw-subtitle">1. 选择次卡与规格</text><text class="cw-scope">选择一项次卡规格。目录为参考价，实际金额以本次服务器报价为准。</text>
        <template v-if="editing"><label class="cw-form-field"><text>次卡关键词</text><input :value="keyword" @input="keyword=inputValue($event)" aria-label="次卡关键词" :maxlength="100" :disabled="contextLocked" placeholder="搜索次卡名称" @confirm="searchProducts" /></label>
          <view class="cw-controls"><button :disabled="contextLocked" @tap="searchProducts">查询次卡</button></view>
          <text v-if="catalogList && !catalogList.list.length" class="cw-scope">没有符合条件的可选次卡</text>
          <button v-for="product in catalogList?.list || []" :key="product.id" class="cw-product-choice" :class="{selected:selection?.product.id === product.id}" :data-cashier-product="product.id" :disabled="contextLocked" @tap="selectProduct(product.id)"><image v-if="product.image" :src="product.image" class="cw-image" mode="aspectFill" /><text>{{ product.store_name }} · {{ product.sku_count }} 个可选规格</text></button>
          <button v-if="catalogList?.has_more" class="cw-full" :disabled="contextLocked" @tap="moreProducts">加载更多次卡</button>
        </template>
        <template v-if="selection"><text class="cw-subtitle">{{ selection.product.store_name }}</text>
          <view class="cw-controls"><button v-for="sku in selection.skus" :key="sku.sku_unique" :class="{selected:skuUnique === sku.sku_unique}" :data-cashier-sku="sku.sku_unique" :disabled="contextLocked || !editing" @tap="chooseSku(sku.sku_unique)">{{ sku.sku || '默认规格' }} · 参考 ¥{{ sku.price }} · 可选 {{ sku.stock }} 份</button></view>
          <text v-if="chosenSku" class="cw-scope">目录参考权益：每份 {{ chosenSku.write_times }} 次 · {{ validityText(chosenSku) }}</text>
          <label class="cw-form-field"><text>购买份数</text><input :value="quantity" @input="setQuantity($event)" type="number" aria-label="购买份数" :disabled="contextLocked || !editing" /></label>
          <text v-if="!selection.readiness.writes" class="cw-error">{{ readinessText(selection.readiness.reason) }}</text>
        </template>
        <text v-if="catalogList && !catalogList.readiness.writes" class="cw-error">{{ readinessText(catalogList.readiness.reason) }}</text>
      </view>
      <view v-if="images.session.value?.state === 'consumed'" class="cw-card" data-cashier-consumed-session><text class="cw-subtitle">原图片已绑定真实订单</text><text>{{ images.session.value.order_no }}</text><text class="cw-scope">请核对上方原收银请求或查看原订单凭据。此处保留的图片不能用于另一笔创建。</text>
        <button v-if="images.session.value.order_id && images.session.value.order_no" class="cw-full" :disabled="locked" @tap="manager.go('cashierRecord',{orderId:images.session.value.order_id,orderNo:images.session.value.order_no})">查看原图片订单凭据</button>
      </view>
      <view v-if="selection" class="cw-card"><text class="cw-subtitle">2. 核对购买人与联系资料</text>
        <view class="cw-controls"><button :class="{selected:buyerMode==='member'}" :disabled="contextLocked || !editing" @tap="selectMemberMode">会员购买</button><button :class="{selected:buyerMode==='guest'}" :disabled="contextLocked || !editing" @tap="selectGuest">游客购买</button></view>
        <template v-if="buyerMode === 'member'"><template v-if="editing"><label class="cw-form-field"><text>查找会员</text><input :value="buyerKeyword" @input="buyerKeyword=inputValue($event)" aria-label="查找会员" :maxlength="100" :disabled="contextLocked" placeholder="会员姓名或手机号" @confirm="searchBuyers" /></label><view class="cw-controls"><button :disabled="contextLocked" @tap="searchBuyers">查询会员</button></view>
            <text v-if="buyers && !buyers.list.length" class="cw-scope">没有符合条件的会员</text>
            <button v-for="user in buyers?.list || []" :key="user.uid" class="cw-buyer-choice" :class="{selected:buyer?.uid===user.uid}" :data-cashier-buyer="user.uid" :disabled="contextLocked || user.deleted || user.status !== 1" @tap="chooseBuyer(user.uid)">{{ user.nickname || '未填写昵称' }} · {{ user.phone || '未填写手机' }}{{ user.deleted || user.status !== 1 ? ' · 当前不可购买' : '' }}</button>
            <button v-if="buyers?.has_more" class="cw-full" :disabled="contextLocked" @tap="moreBuyers">加载更多会员</button>
          </template><text class="cw-scope">{{ buyer ? '已选择会员：' + (buyer.nickname || buyer.real_name) + ' · ' + buyer.phone : '请从会员目录选择购买人' }}</text>
        </template><text v-else class="cw-scope">本次游客购买，订单购买人保持游客身份；由当前经营账号执行收银。</text>
        <label class="cw-form-field"><text>联系人姓名</text><input :value="contact.name" @input="contact.name=inputValue($event)" aria-label="联系人姓名" :maxlength="32" :disabled="locked || !editing" /></label>
        <label class="cw-form-field"><text>联系电话</text><input :value="contact.phone" @input="contact.phone=inputValue($event)" aria-label="联系电话" :maxlength="20" :disabled="locked || !editing" /></label>
        <label class="cw-form-field"><text>订单备注</text><textarea :value="mark" @input="mark=inputValue($event)" aria-label="订单备注" :maxlength="512" :disabled="locked || !editing" /></label>
        <SystemFormFields v-if="customForm.length" :key="formRevision" :model-value="customForm" :title="displayForm?.name" :disabled="selectionBusy || operations.busy.value || !editing" :read-only="!editing" :upload-image="images.upload" :before-choose-images="beforeChooseImages" :preview-urls="formPreviews" :show-image-references="false" :upload-unavailable-reason="imageUploadUnavailable" upload-hint="请先核对购买人，上传完成后保存原图片引用。" @update:model-value="updateForm" @pending="setFormPending" @choosing="setFormChoosing" />
        <text v-if="customForm.some(item=>item.name==='uploadPicture')" class="cw-scope">首次选图前会保留原创建编号和购买人。图片准备开始后选品和购买人保持不变；尚未下单时可核对后取消这份准备。</text>
        <text v-if="images.outstanding.value" class="cw-error">还有原图片结果未确认，请先查询或恢复原上传；当前不能取得报价。</text>
        <button v-if="customForm.some(item=>item.name==='uploadPicture' && Array.isArray(item.value) && item.value.length) && images.session.value" class="cw-full" :disabled="locked" @tap="images.refreshPreviews(currentImageReferences)">刷新原图片预览</button>
        <text v-if="formChanged" class="cw-error">系统表单已更新，下方显示本次实际报价所用的项目及原答案，请重新核对后确认创建。</text>
        <text class="cw-scope">本次不使用优惠券或积分抵扣。会员价格和活动优惠仍由实际报价计算。</text>
      </view>
      <view v-if="selection && editing" class="cw-card"><text class="cw-subtitle">3. 取得实际报价</text>
        <text class="cw-scope">取得报价前会保存真实购物草稿，并在本机保留联系资料、表单答案和原请求编号。确认下单及付款将分别询问。</text>
        <button class="cw-full" :disabled="locked || !imageReady || !selection.readiness.writes || !catalogList?.readiness.writes" @tap="prepare">核对选品并取得报价</button>
      </view>
      <view v-if="operations.quote.value" class="cw-card" data-cashier-quote><text class="cw-subtitle">本次服务器实际报价</text><text class="cw-scope">{{ operations.activeIntent.value?.body.quantity }} 份次卡 · {{ operations.activeIntent.value?.body.buyer_uid === 0 ? '游客购买人' : '会员购买人' }}</text>
        <text v-if="quotedRightsChanged" class="cw-error" data-cashier-card-changed>目录中的次数或有效期已变化，请核对下方本次实际报价权益后再确认创建。</text>
        <view class="cw-stack" data-cashier-quoted-card><text class="cw-subtitle">本次实际报价权益</text><text class="cw-scope">每份 {{ operations.quote.value.card.unit_write_times }} 次 · 本次 {{ operations.quote.value.card.quantity }} 份，共 {{ operations.quote.value.card.total_write_times }} 次</text><text class="cw-scope">{{ validityText(operations.quote.value.card) }}</text></view>
        <view v-for="line in amountLines" :key="line.name" class="cw-row"><text>{{ line.name }}</text><text>{{ line.discount ? '−' : '' }}¥{{ cashierCents(line.cents) }}</text></view>
        <view class="cw-row"><text>实际应付</text><text class="cw-money">¥{{ cashierCents(operations.quote.value.quote.payCents) }}</text></view>
        <text class="cw-scope">创建后将扣减真实库存；现金或零元付款另行确认。</text><button class="cw-full" :disabled="locked || !quoteFormReady" @tap="operations.create()">核对报价并创建订单</button>
      </view>
      <view v-if="operations.detail.value" class="cw-card" data-cashier-created><text class="cw-subtitle">已核对的原次卡订单</text><text>{{ operations.detail.value.record.order_no }}</text><text class="cw-scope">{{ operations.detail.value.record.quantity }} 份 · {{ operations.detail.value.record.buyer_uid === 0 ? '游客购买人' : '会员购买人' }}</text>
        <text class="cw-scope">联系人：{{ operations.detail.value.record.real_name }} · {{ operations.detail.value.record.user_phone }}</text>
        <view v-for="item in operations.detail.value.items" :key="item.product_id + ':' + item.sku_unique" class="cw-stack cw-divider"><text>{{ item.name }}</text><text class="cw-scope">{{ item.sku || '默认规格' }} · 原购买 {{ item.quantity }} 份，共 {{ item.write_times }} 次</text></view>
        <view class="cw-row"><text>当前真实金额</text><text class="cw-money">¥{{ operations.detail.value.record.amount }}</text></view><text class="cw-scope">{{ customerCashierPaymentText(operations.detail.value.record) }}</text>
        <button v-if="operations.detail.value.record.paid===0 && !operations.detail.value.record.root_retired && operations.detail.value.record.status===0 && operations.detail.value.record.refund_status===0" class="cw-full" :disabled="locked" @tap="operations.pay()">{{ operations.detail.value.record.amount === '0.00' ? '核对并确认零元次卡' : '核对现金已收款并记录付款' }}</button>
        <text v-if="operations.detail.value.payment" class="cw-scope">{{ operations.detail.value.payment.payment_kind === 'zero' ? '零金额付款已核对' : '原现金付款已核对' }} · {{ customerWorkDate(operations.detail.value.payment.paid_at) }}</text>
        <SystemFormFields v-if="operations.detail.value.form" :model-value="operations.detail.value.form.components" title="已核对的原购买补充信息" disabled read-only :show-image-references="false" :preview-urls="savedFormPreviews" />
        <button class="cw-full" :disabled="locked" @tap="manager.go('cashierRecord',{orderId:operations.detail.value.record.id,orderNo:operations.detail.value.record.order_no})">查看原创建及付款凭据</button>
      </view>
      <text v-if="operations.pending.value.length" class="cw-scope">开始下一笔前，请先核对并关闭上方本机记录。</text>
      <view class="cw-controls"><button :disabled="locked || !canNew" @tap="manager.load()">开始下一笔收银</button><button :disabled="locked" @tap="manager.go('cashierRecords')">查看本人收银记录</button></view>
    </template>
  </CustomerWorkShell>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import CustomerWorkShell from '@/components/customerWork/CustomerWorkShell.vue';
import SystemFormFields from '@/components/SystemFormFields.vue';
import { useCustomerWork } from '@/composables/useCustomerWork';
import { useCustomerWorkCashier } from '@/composables/useCustomerWorkCashier';
import { useCustomerCashierImages } from '@/composables/useCustomerCashierImages';
import { useCustomerCashierCatalog } from '@/composables/useCustomerCashierCatalog';
import { isCustomerCashierCatalogList, isCustomerCashierCatalogDetail, customerCashierFormDraft, customerCashierFormAnswers } from '@/utils/customerWorkCashierCatalog';
import { customerWorkCanonicalJson, customerWorkRequestKey, cashierCents } from '@/utils/customerWorkCashier';
import { customerCashierPaymentText, customerCashierFormPreviewMap } from '@/utils/customerWorkCashierRead';
import { customerCashierImageFieldId, isCustomerCashierFormContext } from '@/utils/customerWorkCashierImages';
import { customerWorkDate, customerWorkRecord } from '@/utils/customerWork';
import type { CustomerCashierCatalogList, CustomerCashierCatalogDetail, CustomerCashierCatalogSku } from '@/types/customerWorkCashierCatalog';
import type { CustomerCashierIntent } from '@/types/customerWorkCashier';
import type { CustomerCashierFormContext, CustomerCashierImageStageIntent, CustomerCashierImageIntent } from '@/types/customerWorkCashierImages';
import type { CustomerWorkUserList, CustomerWorkUserDetail } from '@/types/customerWorkUsers';
import type { SystemFormComponent, SystemFormInfo } from '@/types/systemForm';
const base = '/mobile/work/cashier/second-card';
const catalogList=ref<CustomerCashierCatalogList|null>(null),selection=ref<CustomerCashierCatalogDetail|null>(null),skuUnique=ref(''),quantity=ref('1'),keyword=ref(''),selectionBusy=ref(false),message=ref('');
const buyers=ref<CustomerWorkUserList|null>(null),buyer=ref<CustomerWorkUserDetail|null>(null),buyerKeyword=ref(''),buyerMode=ref<'member'|'guest'>('member'),touristKey=ref(''),contact=ref({name:'',phone:''}),mark=ref('');
const customForm=ref<SystemFormComponent[]>([]),formRevision=ref(0),formPending=ref(0),formChoosing=ref(false),quotedForm=ref<SystemFormInfo|null>(null),formChanged=ref(false),quoteFormReady=ref(false);
const sessionForm=ref<SystemFormInfo|null>(null);
const removedImageRefs=ref<Record<string,string[]>>({});
let pickerLease: ReturnType<ReturnType<typeof useCustomerWork>['beginSuspendLease']> | null = null;
let epoch=0,productSearch='',buyerSearch='';
const manager=useCustomerWork({page:'cashier',clear(){clearSelection();catalog.clear();operations.clearDomain();images.clear();images.refreshPending();},async load(controller){
  if(controller.context.value?.data.capabilities.cashier_second_card!==true)return;
  const valid=controller.fence(),result=await catalog.read(`${base}/catalog`,isCustomerCashierCatalogList,{page:1,limit:20});if(valid())catalogList.value=result.data;
}});
const images=useCustomerCashierImages(manager),operations=useCustomerWorkCashier(manager,images),catalog=useCustomerCashierCatalog(manager);
const locked=computed(()=>selectionBusy.value||operations.busy.value||images.busy.value||formPending.value>0||formChoosing.value);
const contextLocked=computed(()=>locked.value||images.pending.value.length>0||operations.pending.value.length>0);
const editing=computed(()=>!operations.activeIntent.value&&!operations.detail.value&&!['frozen','consumed'].includes(images.session.value?.state??''));
const chosenSku=computed(()=>selection.value?.skus.find(sku=>sku.sku_unique===skuUnique.value));
const quotedRightsChanged=computed(()=>{const actual=operations.quote.value?.card,reference=chosenSku.value;return !!actual&&(!reference||actual.unit_write_times!==reference.write_times||actual.write_valid!==reference.write_valid||actual.write_days!==reference.write_days||actual.write_start!==reference.write_start||actual.write_end!==reference.write_end);});
const displayForm=computed(()=>operations.quote.value?quotedForm.value:sessionForm.value??selection.value?.system_form??null);
const canNew=computed(()=>operations.pending.value.length===0&&images.pending.value.length===0);
const financialImageIntent=computed(()=>operations.pending.value.some(intent=>intent.kind==='creation'&&intent.request_key===images.parentKey.value));
const imageReady=computed(()=>images.pending.value.length===0||!!images.session.value&&images.session.value.state==='active'&&!images.outstanding.value);
const currentImageReferences=computed(()=>[...new Set(customForm.value.flatMap(item=>item.name==='uploadPicture'&&Array.isArray(item.value)?item.value as string[]:[]))]);
const savedFormPreviews=computed(()=>operations.detail.value?.form?customerCashierFormPreviewMap(operations.detail.value.form):{});
const formPreviews=computed(()=>({...images.previews.value,...savedFormPreviews.value}));
const imageUploadUnavailable=computed(()=> {
  if(!editing.value)return undefined;
  if(selection.value&&!selection.value.readiness.writes)return readinessText(selection.value.readiness.reason);
  const current=manager.context.value;
  return current?.data.capabilities.cashier_form_images===true&&current.data.cashier_form_images_readiness?.writes===true?undefined:'当前经营账号暂不能上传表单图片。可选图片可留空，必填图片请稍后重新核对。';
});
const amountLines=computed(()=>{const q=operations.quote.value?.quote;return q?[{name:'商品金额',cents:q.rawTotalCents,discount:false},{name:'会员优惠',cents:q.memberDiscountCents,discount:true},{name:'活动优惠',cents:q.promotionSavingsCents,discount:true},{name:'首单优惠',cents:q.firstOrderPriceCents,discount:true},{name:'优惠券优惠',cents:q.couponPriceCents,discount:true},{name:'积分抵扣',cents:q.deductionCents,discount:true}].filter(line=>!line.discount||line.cents>0):[];});
function clearSelection(){epoch++;pickerLease=null;sessionForm.value=null;removedImageRefs.value={};catalogList.value=null;selection.value=null;skuUnique.value='';quantity.value='1';keyword.value='';selectionBusy.value=false;message.value='';buyers.value=null;buyer.value=null;buyerKeyword.value='';buyerMode.value='member';touristKey.value='';contact.value={name:'',phone:''};mark.value='';customForm.value=[];formRevision.value++;formPending.value=0;formChoosing.value=false;quotedForm.value=null;formChanged.value=false;quoteFormReady.value=false;productSearch='';buyerSearch='';}
async function selectionAction(work:()=>Promise<void>){if(contextLocked.value||!editing.value)return;const version=epoch,valid=manager.fence();selectionBusy.value=true;message.value='';try{await work();}catch(failure){if(version===epoch&&valid())message.value=failure instanceof Error?failure.message:'选品读取失败';}finally{if(version===epoch&&valid())selectionBusy.value=false;}}
function invalidRead(message:string):never{const failure=Error(message);manager.invalidate(failure);throw failure;}
function inputValue(event:unknown):string{const detail=customerWorkRecord(event)&&customerWorkRecord(event.detail)?event.detail:null;return detail&&typeof detail.value==='string'?detail.value:'';}
function setQuantity(event:unknown){if(!contextLocked.value&&editing.value)quantity.value=inputValue(event);}
function queryText(value:string){const text=value.trim();if(Array.from(text).length>100||/[\u0000-\u001f\u007f]/u.test(text))throw Error('查询文字无效或超过100字');return text;}
async function searchProducts(){await selectionAction(async()=>{const search=queryText(keyword.value),valid=manager.fence(),response=await catalog.read(`${base}/catalog`,isCustomerCashierCatalogList,{page:1,limit:20,...(search?{keyword:search}:{})});if(valid()){catalogList.value=response.data;productSearch=search;}});}
async function moreProducts(){await selectionAction(async()=>{if(!catalogList.value?.has_more)return;const original=catalogList.value,valid=manager.fence(),response=await catalog.read(`${base}/catalog`,isCustomerCashierCatalogList,{page:original.page+1,limit:20,...(productSearch?{keyword:productSearch}:{})});if(!valid())return;if(response.data.page!==original.page+1||response.data.limit!==20||response.data.list.some(row=>original.list.some(prior=>prior.id===row.id)))invalidRead('次卡目录分页已变化，请重新查询');catalogList.value={...response.data,list:[...original.list,...response.data.list]};});}
async function selectProduct(id:number){await selectionAction(async()=>{if(!catalogList.value?.list.some(row=>row.id===id))throw Error('请从当前次卡目录重新选择');const valid=manager.fence(),response=await catalog.read(`${base}/catalog/${id}`,isCustomerCashierCatalogDetail);if(!valid())return;if(response.data.product.id!==id)invalidRead('次卡规格不属于当前选品');selection.value=response.data;skuUnique.value=response.data.skus.length===1?response.data.skus[0]!.sku_unique:'';quantity.value='1';customForm.value=customerCashierFormDraft(response.data.system_form);formRevision.value++;quoteFormReady.value=false;formChanged.value=false;});}
function chooseSku(value:string){if(!contextLocked.value&&editing.value&&selection.value?.skus.some(sku=>sku.sku_unique===value))skuUnique.value=value;}
function selectMemberMode(){if(contextLocked.value||!editing.value)return;buyerMode.value='member';touristKey.value='';buyer.value=null;contact.value={name:'',phone:''};}
async function selectGuest(){await selectionAction(async()=>{const valid=manager.fence(),key=await customerWorkRequestKey();if(!valid())return;buyerMode.value='guest';touristKey.value=key;buyer.value=null;contact.value={name:'',phone:''};buyers.value=null;});}
async function searchBuyers(){await selectionAction(async()=>{const search=queryText(buyerKeyword.value),valid=manager.fence(),response=await catalog.users({page:1,limit:20,...(search?{nickname:search}:{})});if(valid()){buyers.value=response.data;buyerSearch=search;}});}
async function moreBuyers(){await selectionAction(async()=>{if(!buyers.value?.has_more)return;const original=buyers.value,valid=manager.fence(),response=await catalog.users({page:original.page+1,limit:20,...(buyerSearch?{nickname:buyerSearch}:{})});if(!valid())return;if(response.data.page!==original.page+1||response.data.limit!==20||response.data.list.some(row=>original.list.some(prior=>prior.uid===row.uid)))invalidRead('会员目录分页已变化，请重新查询');buyers.value={...response.data,list:[...original.list,...response.data.list]};});}
async function chooseBuyer(uid:number){await selectionAction(async()=>{const available=buyers.value?.list.find(row=>row.uid===uid);if(!available||available.deleted||available.status!==1)throw Error('请从当前有效会员目录选择');const valid=manager.fence(),response=await catalog.user(uid);if(!valid())return;if(response.data.user.uid!==uid||response.data.user.deleted||response.data.user.status!==1)invalidRead('购买会员已变化，请重新查询');buyer.value=response.data.user;buyerMode.value='member';touristKey.value='';const name=buyer.value.real_name||buyer.value.nickname;contact.value={name:name.length<=32?name:'',phone:buyer.value.phone};});}
function updateForm(value:SystemFormComponent[]){if(selectionBusy.value||operations.busy.value||!editing.value||manager.context.value?.data.capabilities.cashier_second_card!==true)return;
  const removed={...removedImageRefs.value};
  for(const [index,component] of value.entries())if(component.name==='uploadPicture'&&Array.isArray(component.value)){
    const references=component.value;
    const previous=customForm.value.find((item,i)=>item.name===component.name&&(component.id===undefined?i===index:item.id===component.id));
    const field=customerCashierImageFieldId(component,index),missing=Array.isArray(previous?.value)?previous.value.filter(reference=>typeof reference==='string'&&!references.includes(reference)) as string[]:[];
    removed[field]=[...new Set([...(removed[field]??[]),...missing])].filter(reference=>!references.includes(reference));
  }
  removedImageRefs.value=removed;customForm.value=value;
}
function setFormPending(value:number){formPending.value=value;if(value===0){pickerLease?.release();pickerLease=null;}}
function setFormChoosing(value:boolean){formChoosing.value=value;if(!value&&manager.current()){pickerLease?.release();pickerLease=null;}}
function selectedImageContext():CustomerCashierFormContext {
  const context=manager.context.value,sku=chosenSku.value;
  if(!context||context.data.capabilities.cashier_second_card!==true||!selection.value||!sku)throw Error('请从目录选择次卡和规格');
  if(!selection.value.readiness.writes||!catalogList.value?.readiness.writes)throw Error(readinessText(selection.value.readiness.reason));
  if(!manager.current()||context.data.capabilities.cashier_form_images!==true||context.data.cashier_form_images_readiness?.writes!==true)throw Error('当前经营账号暂不能上传表单图片，请重新核对');
  if(!/^[1-9]\d{0,4}$/u.test(quantity.value)||Number(quantity.value)>Math.min(32767,sku.stock))throw Error('购买份数需为有效正整数，且不能超过当前库存');
  if(buyerMode.value==='member'&&!buyer.value)throw Error('请从会员目录选择购买人');
  const result:CustomerCashierFormContext={version:'customer-cashier-form-session-v1',scope_key:context.scope_key,buyer_uid:buyerMode.value==='guest'?0:buyer.value!.uid,tourist_key:buyerMode.value==='guest'?touristKey.value:'',product_id:selection.value.product.id,sku_unique:sku.sku_unique,quantity:Number(quantity.value)};
  if(!isCustomerCashierFormContext(result))throw Error('购买人与次卡规格无效，请重新选择');
  return result;
}
function formWithAnswers(info:SystemFormInfo|null,raw:unknown):SystemFormComponent[] {
  const answers=Array.isArray(raw)?raw:[];
  return customerCashierFormDraft(info).map((item,index)=>{const answer=answers.find((row,i)=>customerWorkRecord(row)&&row.name===item.name&&(item.id===undefined?i===index:row.id===item.id));return {...item,value:answer?.value??item.value};});
}
async function beforeChooseImages(index:number) {
  if(selectionBusy.value||operations.busy.value||images.busy.value||!editing.value||images.outstanding.value)throw Error('请先核对原准备与上传结果');
  const context=selectedImageContext(),valid=manager.fence(),version=epoch;
  const original=await images.ensureSession(context);
  if(!original||!valid()||version!==epoch)throw Error(images.error.value||'图片准备尚未确认，请查询原编号');
  if(customerWorkCanonicalJson(original.system_form)!==customerWorkCanonicalJson(displayForm.value)) {
    sessionForm.value=original.system_form;customForm.value=formWithAnswers(original.system_form,customForm.value);formRevision.value++;formChanged.value=true;
    throw Error('系统表单已变化，请核对当前图片准备中的项目后重新选图');
  }
  sessionForm.value=original.system_form;
  if(original.system_form.value[index]?.name!=='uploadPicture')throw Error('当前项目不是原图片字段，请重新核对');
  pickerLease=manager.beginSuspendLease();
}
function applyRecoveredImages() {
  if(!editing.value||!manager.current()||manager.context.value?.data.capabilities.cashier_second_card!==true||!images.session.value)return;
  const original=images.session.value.system_form;
  customForm.value=formWithAnswers(original,customForm.value).map((component,index)=>{if(component.name!=='uploadPicture')return component;const field=customerCashierImageFieldId(component,index);return {...component,value:[...new Set([...(Array.isArray(component.value)?component.value as string[]:[]),...(images.recoveredImages.value[field]??[])])].filter(reference=>!removedImageRefs.value[field]?.includes(reference))};});
  sessionForm.value=original;formRevision.value++;
}
async function restoreImageSelection() {
  const original=images.session.value;
  if(!original||original.state!=='active'||!manager.current()||manager.context.value?.data.capabilities.cashier_second_card!==true||operations.activeIntent.value||operations.detail.value)return;
  const valid=manager.fence(),version=epoch;selectionBusy.value=true;
  try {
    const body=original.intent,retain=selection.value?.product.id===body.product_id&&skuUnique.value===body.sku_unique&&Number(quantity.value)===body.quantity&&(buyerMode.value==='guest'?0:buyer.value?.uid)===body.buyer_uid&&touristKey.value===body.tourist_key;
    if(!retain) {
      const response=await catalog.read(`${base}/catalog/${body.product_id}`,isCustomerCashierCatalogDetail);if(!valid())return;
      if(response.data.product.id!==body.product_id)invalidRead('原图片次卡与当前目录不匹配');
      selection.value=response.data;skuUnique.value=body.sku_unique;quantity.value=String(body.quantity);buyerMode.value=body.buyer_uid===0?'guest':'member';touristKey.value=body.tourist_key;buyer.value=null;contact.value={name:'',phone:''};mark.value='';customForm.value=[];
      if(body.buyer_uid>0){const member=await catalog.user(body.buyer_uid);if(!valid())return;if(member.data.user.uid!==body.buyer_uid)invalidRead('原图片购买会员不匹配');buyer.value=member.data.user;const name=buyer.value.real_name||buyer.value.nickname;contact.value={name:name.length<=32?name:'',phone:buyer.value.phone};}
    }
    formChanged.value=customerWorkCanonicalJson(selection.value?.system_form??null)!==customerWorkCanonicalJson(original.system_form);applyRecoveredImages();
    await images.refreshPreviews(currentImageReferences.value);
  } catch(failure){if(valid()&&version===epoch)message.value=failure instanceof Error?failure.message:'原图片选品暂无法核对';}
  finally{if(valid()&&version===epoch)selectionBusy.value=false;}
}
async function checkImage(intent:CustomerCashierImageStageIntent) {
  if(locked.value)return;const valid=manager.fence(),version=epoch;await images.check(intent);
  if(!valid()||version!==epoch||images.error.value)return;
  if(images.session.value?.state==='cancelled'){resetCancelledImageForm();return;}
  if(images.session.value?.state==='consumed'){const original=operations.pending.value.find(financial=>financial.kind==='creation'&&financial.request_key===images.parentKey.value);if(original)await operations.check(original);return;}
  await restoreImageSelection();
}
function canResumeImage(intent:CustomerCashierImageStageIntent):intent is CustomerCashierImageIntent {
  return intent.kind==='image'&&images.canResumeUpload(intent)&&editing.value&&!financialImageIntent.value;
}
async function resumeImage(intent:CustomerCashierImageStageIntent) {
  if(locked.value||!canResumeImage(intent))return;const version=epoch;formPending.value=1;message.value='';
  try {
    pickerLease=manager.beginSuspendLease();formChoosing.value=true;
    const path=await new Promise<string>((resolve,reject)=>uni.chooseImage({count:1,sizeType:['compressed','original'],success(result){const paths=Array.isArray(result.tempFilePaths)?result.tempFilePaths:[result.tempFilePaths];if(paths.length!==1||typeof paths[0]!=='string')reject(Error('请选择同一张原图片'));else resolve(paths[0]);},fail:reject}));
    if(version!==epoch)throw Error('页面已变化，请重新核对原图片编号');setFormChoosing(false);
    await images.resumeUpload(intent,path);
    if(version===epoch&&manager.current()){applyRecoveredImages();await images.refreshPreviews(currentImageReferences.value);}
  } catch(failure){if(version===epoch&&manager.current())message.value=failure instanceof Error?failure.message:'原图片恢复失败，请保留原编号';}
  finally{if(version===epoch){formChoosing.value=false;setFormPending(0);}}
}
function resetCancelledImageForm(){sessionForm.value=null;removedImageRefs.value={};customForm.value=customerCashierFormDraft(selection.value?.system_form??null);formRevision.value++;formChanged.value=false;}
async function cancelImages(){if(locked.value)return;const valid=manager.fence();await images.cancelSession();if(valid()&&images.session.value?.state==='cancelled'&&!images.pending.value.length)resetCancelledImageForm();}
function imagePendingText(intent:CustomerCashierImageStageIntent){if(intent.kind==='session'){const state=images.parentKey.value===intent.request_key?images.session.value?.state:undefined;return state==='active'?'原创建前准备已核对':state==='frozen'?'完整下单内容已冻结':state==='consumed'?'原图片已绑定真实订单':state==='cancelled'?'原取消已核对':'原准备结果尚未确认';}const image=images.images.value[intent.request_key];return image?.state==='stored'?'原图片保存已核对':image?.state==='reserved'?'原上传已保留，图片尚未确认保存':'原上传结果尚未确认';}
function validityText(sku:Pick<CustomerCashierCatalogSku,'write_valid'|'write_days'|'write_start'|'write_end'>){return sku.write_valid===1?'长期有效':sku.write_valid===2?`付款后 ${sku.write_days} 天`:`${customerWorkDate(sku.write_start)} 至 ${customerWorkDate(sku.write_end)}`;}
function readinessText(reason:string){return reason==='cashier_form_upload_scope_unavailable'?'此商品需要必填图片，当前收银入口暂不支持，请选择其他次卡。':reason==='cashier_form_template_unavailable'?'当前系统表单配置不可用，请重新读取或选择其他次卡。':reason==='cashier_form_capacity_exceeded'?'此商品的系统表单超过当前收银支持范围，请选择其他次卡。':'当前次卡收银暂不可用，请重新读取经营资格。';}
function applyQuotedForm(){const q=operations.quote.value as (typeof operations.quote.value & {system_form?:SystemFormInfo|null});if(!q){quoteFormReady.value=false;return;}
  if(q.system_form===undefined){message.value='实际报价缺少系统表单，请保留原编号重新核对';quoteFormReady.value=false;return;}
  quotedForm.value=q.system_form;formChanged.value=customerWorkCanonicalJson(selection.value?.system_form??null)!==customerWorkCanonicalJson(q.system_form);const raw=operations.activeIntent.value?.body.custom_form;
  customForm.value=formWithAnswers(q.system_form,raw);formRevision.value++;quoteFormReady.value=true;
}
async function prepare(){if(locked.value||!editing.value)return;try{const context=manager.context.value,sku=chosenSku.value;if(!context||!selection.value||!sku)throw Error('请从目录选择次卡和规格');if(!selection.value.readiness.writes||!catalogList.value?.readiness.writes)throw Error(readinessText(selection.value.readiness.reason));
  if(!/^[1-9]\d{0,4}$/u.test(quantity.value)||Number(quantity.value)>Math.min(32767,sku.stock))throw Error('购买份数需为有效正整数，且不能超过当前库存');if(buyerMode.value==='member'&&!buyer.value)throw Error('请从会员目录选择购买人');if(buyerMode.value==='guest'&&!touristKey.value)throw Error('请重新选择游客购买');
  if(!imageReady.value)throw Error('原图片准备或上传结果尚未确认，请先查询原编号');
  message.value='';const result=await operations.prepare({version:'customer-cashier-second-card-v1',scope_key:context.scope_key,buyer_uid:buyerMode.value==='guest'?0:buyer.value!.uid,tourist_key:buyerMode.value==='guest'?touristKey.value:'',product_id:selection.value.product.id,sku_unique:sku.sku_unique,quantity:Number(quantity.value),real_name:contact.value.name.trim(),user_phone:contact.value.phone.trim(),mark:mark.value.trim(),custom_form:customerCashierFormAnswers(displayForm.value,customForm.value),coupon_id:0,use_integral:false},images.pending.value.length?images.parentKey.value:undefined);if(result)applyQuotedForm();
}catch(failure){message.value=failure instanceof Error?failure.message:'本次选品或表单无效';}}
async function restore(intent:CustomerCashierIntent){quoteFormReady.value=false;await operations.restore(intent);if(!operations.quote.value||intent.kind!=='creation')return;const valid=manager.fence(),version=epoch;selectionBusy.value=true;try{
  const response=await catalog.read(`${base}/catalog/${intent.body.product_id}`,isCustomerCashierCatalogDetail);if(!valid())return;if(response.data.product.id!==intent.body.product_id)invalidRead('原次卡选品与当前目录不匹配');selection.value=response.data;skuUnique.value=intent.body.sku_unique;quantity.value=String(intent.body.quantity);buyerMode.value=intent.body.buyer_uid===0?'guest':'member';touristKey.value=intent.body.tourist_key;contact.value={name:intent.body.real_name,phone:intent.body.user_phone};mark.value=intent.body.mark;
  if(intent.body.buyer_uid>0){const member=await catalog.user(intent.body.buyer_uid);if(!valid())return;if(member.data.user.uid!==intent.body.buyer_uid)invalidRead('原购买会员不匹配');buyer.value=member.data.user;}
  applyQuotedForm();const imageSession=images.pending.value.find(stage=>stage.kind==='session'&&stage.request_key===intent.request_key);if(imageSession){await images.check(imageSession);if(valid()&&operations.quote.value)await images.refreshPreviews(currentImageReferences.value);}
}catch(failure){if(version===epoch&&valid()){quoteFormReady.value=false;message.value=failure instanceof Error?failure.message:'原次卡目录暂无法核对';}}finally{if(version===epoch&&valid())selectionBusy.value=false;}}
async function acknowledge(intent:CustomerCashierIntent){if(locked.value)return;const abandoned=intent.kind==='creation'&&!!operations.states.value[intent.request_key]?.receipt?.abandonment;await operations.acknowledge(intent);if(abandoned&&manager.current()&&!operations.pending.value.some(v=>v.request_key===intent.request_key)){clearSelection();}}
function canClose(intent:CustomerCashierIntent){const state=operations.states.value[intent.request_key];return !!state?.receipt?.abandonment||!!state?.receipt?.receipt&&(intent.kind==='payment'||state.detail?.record.paid===1);}
function pendingText(intent:CustomerCashierIntent){const state=operations.states.value[intent.request_key];return state?.receipt?.abandonment?'原编号永久放弃已核对，可以关闭本机记录':state?.receipt?.receipt?(intent.kind==='creation'?'原订单创建已核对':'原现金付款已核对'):operations.abandonRequested(intent)?'已请求永久放弃，请保留原编号；只能查询或重试放弃':!state?.checked?'原结果尚未核对':'没有已提交的原回执，恢复仍使用原编号与原内容';}
</script>
<style scoped>
.cw-product-choice,.cw-buyer-choice{display:flex;align-items:center;gap:18rpx;width:100%;text-align:left;margin:14rpx 0!important}.selected{border-color:#295e43!important;background:#e7f1e9!important;color:#24543a!important}.cw-product-choice text{flex:1;min-width:0}
</style>
