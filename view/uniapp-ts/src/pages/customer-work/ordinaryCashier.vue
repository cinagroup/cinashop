<template>
  <CustomerWorkShell title="普通商品现金收银" :manager="manager" :domain-busy="locked" active="ordinaryCashier">
    <template #recovery>
      <view v-if="operations.error.value" class="cw-recovery" role="status">{{ operations.error.value }}</view>
      <view v-if="operations.pending.value.length" class="cw-recovery" data-ordinary-recovery>
        <text class="cw-subtitle">原收银请求核对</text>
        <text>本机保存原购物行、购买人与联系资料。结果未确认时，继续查询原编号。</text>
        <view v-for="original in operations.pending.value" :key="original.request_key" class="cw-recovery-row">
          <text>{{ kindText(original.kind) }}</text><text class="cw-request-key">{{ original.request_key }}</text>
          <text>{{ recoveryText(original) }}</text>
          <view class="cw-controls">
            <button :disabled="locked" @tap="run(()=>operations.check(original))">查询原编号</button>
            <button v-if="!operations.states.value[original.request_key]?.receipt" :disabled="locked" @tap="run(()=>operations.abandon(original))">核对并永久放弃原请求</button>
            <button v-if="draftReceipt(original)" :disabled="locked || !manager.context.value" @tap="restoreDraft(original)">读取已核对的购物车</button>
            <button v-if="operations.states.value[original.request_key]?.receipt" :disabled="locked" @tap="run(()=>operations.acknowledge(original))">关闭已核对的本机记录</button>
          </view>
        </view>
      </view>
    </template>
    <text v-if="message" class="cw-error" role="alert">{{ message }}</text>
    <view v-if="operations.gate.value?.writes !== true" class="cw-card" data-ordinary-closed>
      <text class="cw-subtitle">普通收银暂未开放提交</text><text class="cw-scope">{{ gateText }}</text>
    </view>
    <view v-if="!createdOrder" class="cw-card">
      <text class="cw-subtitle">1. 核对购买人</text>
      <view class="cw-controls"><button :disabled="identityLocked" :class="{selected:buyerMode==='member'}" @tap="chooseMember">会员购买</button><button :disabled="identityLocked" :class="{selected:buyerMode==='guest'}" @tap="chooseGuest">游客购买</button></view>
      <template v-if="buyerMode==='member'">
        <label v-if="!operations.draft.value" class="cw-form-field"><text>会员姓名或手机号</text><input v-model="buyerKeyword" :disabled="identityLocked" :maxlength="100" aria-label="查找会员" @confirm="searchBuyers(false)" /></label>
        <button v-if="!operations.draft.value" class="cw-full" :disabled="identityLocked" @tap="searchBuyers(false)">查询会员</button>
        <button v-for="row in buyers?.list || []" :key="row.uid" class="cw-full" :disabled="identityLocked" :class="{selected:buyer?.uid===row.uid}" @tap="selectBuyer(row)">{{ row.nickname || '未填写昵称' }} · {{ row.phone || '未填写手机' }}</button>
        <button v-if="buyers?.has_more && !operations.draft.value" class="cw-full" :disabled="identityLocked" @tap="searchBuyers(true)">加载更多会员</button>
        <text class="cw-scope">{{ buyer ? '已选择会员：'+buyer.nickname+' · '+buyer.phone : operations.draft.value ? '原购物车会员编号：'+operations.draft.value.buyer_uid : '请从目录选择购买人' }}</text>
      </template><text v-else class="cw-scope">订单购买人保留游客身份，由当前经营账号操作收银。游客不使用账户优惠券或积分。</text>
      <text v-if="operations.draft.value" class="cw-scope">购物车建立后购买人保持不变。</text>
    </view>
    <view v-if="!createdOrder" class="cw-card">
      <text class="cw-subtitle">2. 选择商品与多个规格</text>
      <label class="cw-form-field"><text>商品关键词</text><input v-model="keyword" :disabled="editingLocked" :maxlength="100" aria-label="商品关键词" @confirm="searchProducts(false)" /></label>
      <button class="cw-full" :disabled="editingLocked" @tap="searchProducts(false)">查询普通商品</button>
      <text v-if="catalog && !catalog.list.length" class="cw-scope">没有符合条件的商品</text>
      <button v-for="product in catalog?.list || []" :key="product.id" class="cw-product" :disabled="editingLocked" @tap="selectProduct(product.id)"><image v-if="product.image" :src="product.image" mode="aspectFill" class="cw-image" /><text>{{ product.store_name }} · {{ product.sku_count }} 个可选规格</text></button>
      <button v-if="catalog?.has_more" class="cw-full" :disabled="editingLocked" @tap="searchProducts(true)">加载更多商品</button>
      <template v-if="selection"><text class="cw-subtitle">{{ selection.product.store_name }}</text>
        <view class="cw-controls"><button v-for="sku in selection.skus" :key="sku.sku_unique" :class="{selected:skuUnique===sku.sku_unique}" :disabled="editingLocked" @tap="skuUnique=sku.sku_unique">{{ sku.sku || '默认规格' }} · 参考 ¥{{ sku.price }} · 库存 {{ sku.stock }}</button></view>
        <label class="cw-form-field"><text>本次添加数量</text><input v-model="addQuantity" :disabled="editingLocked" type="number" aria-label="本次添加数量" /></label>
        <button class="cw-full" :disabled="editingLocked || !skuUnique || (operations.draft.value!==null && !operations.canWrite.value)" @tap="addSelected">添加此规格</button>
      </template>
      <view v-for="row in cartRows" :key="row.key" class="cw-cart"><view class="cw-grow"><text>{{ row.name }}</text><text class="cw-scope">{{ row.sku }} · {{ row.quantity }} 件</text><view class="cw-controls"><button :disabled="editingLocked || (row.cart_id>0 && !operations.canWrite.value) || row.quantity<=1" @tap="changeQuantity(row,-1)">减少</button><button :disabled="editingLocked || (row.cart_id>0 && !operations.canWrite.value) || row.quantity>=32767" @tap="changeQuantity(row,1)">增加</button><button :disabled="editingLocked || (row.cart_id>0 && !operations.canWrite.value)" @tap="removeRow(row)">移除</button></view></view></view>
      <button v-if="!operations.draft.value" class="cw-full" :disabled="locked || !operations.canWrite.value || !localRows.length || (buyerMode==='member' && !buyer) || (buyerMode==='guest' && !touristKey)" @tap="saveDraft">核对购买人与全部购物行并保存草稿</button>
    </view>
    <view v-if="operations.draft.value && !createdOrder" class="cw-card">
      <text class="cw-subtitle">3. 配送、优惠与补充信息</text>
      <view class="cw-controls"><button :disabled="editingLocked" :class="{selected:shippingType===2}" @tap="shippingType=2">门店自提</button><button :disabled="editingLocked" :class="{selected:shippingType===1}" @tap="shippingType=1">快递配送</button></view>
      <template v-if="shippingType===2"><picker :disabled="editingLocked" :range="stores" range-key="name" :value="storeIndex" @change="selectStore"><view>{{ stores[storeIndex]?.name || '请选择自提门店' }}</view></picker><text class="cw-scope">{{ stores[storeIndex]?.address }}</text></template>
      <template v-else>
        <view v-if="operations.draft.value.buyer_uid>0" class="cw-controls"><button :disabled="editingLocked" @tap="addressId=0">手工填写配送地址</button><button v-for="address in addresses?.list || []" :key="address.id" :disabled="editingLocked" :class="{selected:addressId===address.id}" @tap="addressId=address.id">{{ address.real_name }} · {{ address.phone }} · {{ address.province }}{{ address.city }}{{ address.district }}{{ address.detail }}</button></view>
        <template v-if="addressId===0"><label class="cw-form-field"><text>收件人</text><input v-model="manual.realName" :disabled="editingLocked" :maxlength="32" aria-label="收件人" /></label><label class="cw-form-field"><text>收件电话</text><input v-model="manual.phone" :disabled="editingLocked" :maxlength="20" aria-label="收件电话" /></label>
          <view class="cw-controls"><picker v-for="(rows,level) in regions" :key="level" :disabled="editingLocked || !rows.length" :range="rows" range-key="name" :value="regionIndex(level)" @change="selectRegion(level,$event)"><view>{{ regionNames[level] }}：{{ chosenRegion(level)?.name || '请选择' }}</view></picker></view>
          <label class="cw-form-field"><text>详细地址</text><input v-model="manual.detail" :disabled="editingLocked" :maxlength="256" aria-label="详细地址" /></label>
        </template>
      </template>
      <label class="cw-form-field"><text>联系人姓名{{ shippingType===2 && operations.draft.value.buyer_uid>0 ? '（必填）' : '' }}</text><input v-model="contact.name" :disabled="editingLocked" :maxlength="32" aria-label="联系人姓名" /></label>
      <label class="cw-form-field"><text>联系电话</text><input v-model="contact.phone" :disabled="editingLocked" :maxlength="20" aria-label="联系电话" /></label>
      <label class="cw-form-field"><text>订单备注</text><textarea v-model="mark" :disabled="editingLocked" :maxlength="512" aria-label="订单备注" /></label>
      <SystemFormFields v-if="form.length" :key="formRevision" :model-value="form" :title="formInfo?.name" :disabled="editingLocked" :upload-image="uploadImage" :before-choose-images="beforeChooseImages" :preview-urls="previews" :show-image-references="false" upload-hint="图片归当前经营账号所有，核对上传回执后加入订单。" @update:model-value="updateForm" @pending="setFormPending" @choosing="setFormChoosing" />
      <template v-if="operations.draft.value.buyer_uid>0"><view class="cw-controls"><button :disabled="editingLocked" :class="{selected:useIntegral}" @tap="useIntegral=!useIntegral">{{ useIntegral ? '取消积分抵扣' : '使用会员积分抵扣' }}</button><button :disabled="editingLocked" @tap="couponId=0">不使用优惠券</button></view><text class="cw-scope">先取得实际报价，查看该会员本次订单可用的优惠券；变更优惠后重新报价。</text></template>
      <button class="cw-full" :disabled="locked || !operations.canWrite.value || !cartRows.length" @tap="prepare">核对全部资料并取得实际报价</button>
    </view>
    <view v-if="quote" class="cw-card" data-ordinary-quote>
      <text class="cw-subtitle">本次服务器实际报价</text>
      <view v-for="line in amountLines" :key="line.name" class="cw-row"><text>{{ line.name }}</text><text>{{ line.discount ? '−' : '' }}¥{{ line.value }}</text></view>
      <view class="cw-row"><text>实际应付</text><text class="cw-money">¥{{ quote.pricing.amount }}</text></view>
      <text class="cw-scope">{{ quote.pricing.quantity }} 件（包含活动赠品） · 抵扣 {{ quote.pricing.used_integral }} 积分 · 付款后待处理赠送积分 {{ quote.pricing.gives_integral }}</text>
      <text v-for="promotion in quote.promotion_gifts.promotions" :key="promotion.id+':'+promotion.tier_id" class="cw-scope">活动：{{ promotion.name }} · 门槛 {{ promotion.threshold_type===1 ? '¥'+promotion.threshold : promotion.threshold+' 件' }} · 本次 {{ promotion.repetitions }} 次</text>
      <view v-for="gift in quote.promotion_gifts.products" :key="gift.cart_id" class="cw-stack"><text>活动赠品：商品 {{ gift.product_id }} · {{ gift.sku_unique }} · {{ gift.quantity }} 件</text></view>
      <text v-for="gift in quote.promotion_gifts.coupons" :key="gift.issue_id+'-'+gift.title" class="cw-scope">付款后待处理赠券：{{ gift.title }} · ¥{{ gift.price }}</text>
      <template v-if="operations.draft.value?.buyer_uid"><text class="cw-subtitle">本次可用优惠券</text><text v-if="!coupons.length" class="cw-scope">当前页没有可用优惠券</text><button v-for="coupon in coupons" :key="coupon.id" class="cw-full" :disabled="locked || coupon.availability!=='available'" @tap="chooseCoupon(coupon.id)">{{ coupon.title }} · 预计优惠 ¥{{ coupon.estimated_discount }} · {{ coupon.availability_message }}</button><button v-if="couponCursor!==null" class="cw-full" :disabled="locked" @tap="moreCoupons">继续查询优惠券</button></template>
      <text class="cw-scope">创建订单将扣减真实库存。创建与现金付款分别确认。</text><view class="cw-controls"><button :disabled="locked" @tap="operations.clearQuotation()">返回修改资料</button><button :disabled="locked || !operations.canWrite.value" @tap="run(()=>operations.create())">核对报价并创建订单</button></view>
    </view>
    <view v-if="createdOrder" class="cw-card" data-ordinary-created>
      <text class="cw-subtitle">已核对的普通商品订单</text><text>{{ createdOrder.order_no }}</text><view class="cw-row"><text>原创建金额</text><text class="cw-money">¥{{ createdOrder.pay_price }}</text></view>
      <text class="cw-scope">购买人：{{ createdOrder.buyer_uid===0 ? '游客' : '会员 '+createdOrder.buyer_uid }} · 创建人：{{ createdOrder.creator_uid }}</text>
      <text v-if="paid" class="cw-scope">原付款已核对。实际付款已记录，后续通知与赠送仍由系统处理。</text><button v-else class="cw-full" :disabled="locked || !operations.canWrite.value" @tap="payCreated">{{ createdOrder.pay_price==='0.00' ? '核对并确认零元付款' : '核对现金已收款并记录付款' }}</button>
      <button class="cw-full" :disabled="locked || !manager.context.value" @tap="manager.go('orderDetail',{orderId:createdOrder.order_no})">查看实际订单</button>
      <text v-if="operations.pending.value.length>0" class="cw-scope">开始下一笔前，请先核对并关闭上方本机记录。</text><button class="cw-full" :disabled="locked || operations.pending.value.length>0" @tap="manager.load()">开始下一笔普通商品收银</button>
    </view>
  </CustomerWorkShell>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import CustomerWorkShell from '@/components/customerWork/CustomerWorkShell.vue';
import SystemFormFields from '@/components/SystemFormFields.vue';
import { useCustomerWork, type CustomerWorkSuspendLease } from '@/composables/useCustomerWork';
import { useCustomerOrdinaryCashier } from '@/composables/useCustomerOrdinaryCashier';
import { customerWorkRequestKey } from '@/utils/customerWorkFulfillment';
import { customerWorkCanonicalJson } from '../../../../common/customerWorkIntent';
import { parseOrderSystemFormTemplate, prepareOrderSystemFormSubmission } from '../../../../common/order-system-form';
import { customerWorkRecord } from '@/utils/customerWork';
import { customerCashierFormDraft } from '@/utils/customerWorkCashierCatalog';
import { isOrdinaryCatalogList, isOrdinaryCatalogSelection, isOrdinaryBuyerList, isOrdinaryAddressList, isOrdinaryQuoteData, isOrdinaryCouponRead } from '@/utils/customerWorkOrdinaryCashierRead';
import { ordinaryPickupStores, ordinaryCities, ordinaryCreatorImage, type OrdinaryStore, type OrdinaryCity } from '@/api/customerWorkOrdinaryCashierAssets';
import type { OrdinaryCashierRow, OrdinaryCashierIntent, OrdinaryCashierManualAddress } from '@/api/customerWorkOrdinaryCashier';
import type { OrdinaryCashierPending, OrdinaryPaymentSource } from '@/utils/customerWorkOrdinaryCashier';
import type { OrdinaryCatalogList, OrdinaryCatalogSelection, OrdinaryBuyerList, OrdinaryBuyer, OrdinaryAddressList, OrdinaryQuoteData, OrdinaryCoupon } from '@/types/customerWorkOrdinaryCashierRead';
import type { SystemFormComponent, SystemFormInfo } from '@/types/systemForm';
interface Choice extends OrdinaryCashierRow { name:string; sku:string; form:SystemFormInfo|null }
interface CartDisplay extends OrdinaryCashierRow { key:string; cart_id:number; name:string; sku:string }
interface CreatedOrder { order_id:number; order_no:string; buyer_uid:number; creator_uid:number; pay_price:string }
const catalog=ref<OrdinaryCatalogList|null>(null),selection=ref<OrdinaryCatalogSelection|null>(null),keyword=ref(''),skuUnique=ref(''),addQuantity=ref('1');
const buyers=ref<OrdinaryBuyerList|null>(null),buyer=ref<OrdinaryBuyer|null>(null),buyerKeyword=ref(''),buyerMode=ref<'member'|'guest'>('member'),touristKey=ref('');
const localRows=ref<Choice[]>([]),choices=ref<Record<string,Choice>>({}),io=ref(false),message=ref('');
const stores=ref<OrdinaryStore[]>([]),storeIndex=ref(-1),shippingType=ref<1|2>(2),addresses=ref<OrdinaryAddressList|null>(null),addressId=ref(0);
const emptyManual=():OrdinaryCashierManualAddress=>({realName:'',phone:'',province:'',city:'',district:'',street:'',detail:'',cityId:0});
const manual=ref(emptyManual()),regions=ref<OrdinaryCity[][]>([[],[],[],[]]),regionIds=ref([0,0,0,0]),regionNames=['省','市','区县','街道'];
const contact=ref({name:'',phone:''}),mark=ref(''),couponId=ref(0),useIntegral=ref(false),coupons=ref<OrdinaryCoupon[]>([]),couponCursor=ref<number|null>(null);
const formInfo=ref<SystemFormInfo|null>(null),form=ref<SystemFormComponent[]>([]),formRevision=ref(0),formPending=ref(0),previews=ref<Record<string,string>>({});
let epoch=0,pickerLease:CustomerWorkSuspendLease|null=null,catalogKeyword='',buyerQuery='';
const manager=useCustomerWork({page:'ordinaryCashier',clear(){epoch++;pickerLease?.release();pickerLease=null;operations.clearDomain();catalog.value=null;selection.value=null;keyword.value='';catalogKeyword='';buyerQuery='';skuUnique.value='';addQuantity.value='1';buyers.value=null;buyerKeyword.value='';buyer.value=null;buyerMode.value='member';touristKey.value='';localRows.value=[];choices.value={};io.value=false;message.value='';stores.value=[];storeIndex.value=-1;shippingType.value=2;addresses.value=null;addressId.value=0;manual.value=emptyManual();regions.value=[[],[],[],[]];regionIds.value=[0,0,0,0];contact.value={name:'',phone:''};mark.value='';couponId.value=0;useIntegral.value=false;coupons.value=[];couponCursor.value=null;formInfo.value=null;form.value=[];formRevision.value++;formPending.value=0;previews.value={};},async load(){await operations.load();await searchProducts(false);}});
const operations=useCustomerOrdinaryCashier(manager);
const locked=computed(()=>io.value||operations.busy.value||formPending.value>0);
const editingLocked=computed(()=>io.value||operations.busy.value||operations.unresolved.value||!!operations.quotation.value);
const identityLocked=computed(()=>editingLocked.value||!!operations.draft.value||formPending.value>0);
const gateText=computed(()=>operations.gate.value?.reason==='ordinary_source_not_commissioned' ? '普通商品收银来源尚未启用。原编号仍可核对。' : '请核对当前经营资格与服务状态。原编号仍可核对。');
const quote=computed<OrdinaryQuoteData|null>(()=>{const data=operations.quotation.value?.quote?.read.data;return isOrdinaryQuoteData(data)?data:null;});
const createdOrder=computed<CreatedOrder|null>(()=>{const value=operations.created.value?.evidence.order;return customerWorkRecord(value)?value as unknown as CreatedOrder:null;});
const paid=computed(()=>{const order=createdOrder.value,payment=operations.payment.value?.evidence.payment;return !!order&&customerWorkRecord(payment)&&payment.order_id===order.order_id;});
const cartRows=computed<CartDisplay[]>(()=>operations.draft.value ? operations.draft.value.rows.filter(row=>!row.removed&&!row.consumed).map(row=>{const choice=choices.value[`${row.product_id}:${row.sku_unique}`];return {...row,key:String(row.cart_id),name:choice?.name||`商品 ${row.product_id}`,sku:choice?.sku||row.sku_unique};}) : localRows.value.map(row=>({...row,key:`${row.product_id}:${row.sku_unique}`,cart_id:0})));
const amountLines=computed(()=>quote.value?[{name:'商品原金额',value:quote.value.pricing.raw_total,discount:false},{name:'会员优惠',value:quote.value.pricing.membership_discount,discount:true},{name:'活动优惠',value:quote.value.pricing.promotion_discount,discount:true},{name:'首单优惠',value:quote.value.pricing.first_order_discount,discount:true},{name:'优惠券抵扣',value:quote.value.pricing.coupon_discount,discount:true},{name:'积分抵扣',value:quote.value.pricing.integral_discount,discount:true},{name:'运费',value:quote.value.pricing.postage,discount:false}]:[]);
async function run(action:()=>unknown|Promise<unknown>){const version=epoch;try{return await action();}catch(error){if(version===epoch&&manager.current())message.value=error instanceof Error?error.message:'操作未完成，请核对原编号';return null;}}
async function readAction(action:(valid:()=>boolean)=>Promise<void>){if(locked.value)return;const version=epoch,validScope=manager.fence();io.value=true;message.value='';const valid=()=>version===epoch&&validScope()&&manager.current();try{await action(valid);}catch(error){if(valid())message.value=error instanceof Error?error.message:'读取未完成';}finally{if(valid())io.value=false;}}
const kindText=(kind:OrdinaryCashierPending['kind'])=>({draft:'原购物草稿',append:'原添加规格',quantity:'原数量修改',remove:'原购物行移除',creation:'原订单创建',payment:'原现金或零元付款'}[kind]);
function recoveryText(original:OrdinaryCashierPending){const state=operations.states.value[original.request_key];return state?.receipt ? state.receipt.kind==='abandon'?'已核对：原请求永久终止':'已核对原实际结果' : state?.error||'请查询原编号核对结果';}
function draftReceipt(original:OrdinaryCashierPending){const receipt=operations.states.value[original.request_key]?.receipt;return receipt&&['draft','append','quantity','remove'].includes(receipt.kind)&&customerWorkRecord(receipt.evidence.draft)?receipt.evidence.draft:null;}
async function restoreDraft(original:OrdinaryCashierPending) {
  const value=draftReceipt(original);if(!value||typeof value.draft_key!=='string')return;
  await run(async()=>{
    await operations.readDraft(value.draft_key as string);const d=operations.draft.value!;
    buyerMode.value=d.buyer_uid===0?'guest':'member';touristKey.value=d.tourist_key;
    await readAction(async valid=>{
      for(const row of d.rows.filter(row=>!row.removed&&!row.consumed)){
        const response=await operations.read(`/catalog/${row.product_id}`,isOrdinaryCatalogSelection);
        if(!valid())return;
        if(response.data.product.id!==row.product_id)throw Error('原购物行商品不匹配');
        const sku=response.data.skus.find(sku=>sku.sku_unique===row.sku_unique);
        if(!sku)throw Error('原购物行规格当前不可购买，请核对后移除');
        choices.value[`${row.product_id}:${row.sku_unique}`]={product_id:row.product_id,sku_unique:row.sku_unique,quantity:row.quantity,name:response.data.product.store_name,sku:sku.sku,form:response.data.system_form};
      }
      if(valid())syncForm();
    });
    await loadCheckoutReads();
  });
}
async function searchProducts(more:boolean) {
  await readAction(async valid=>{
    const term=keyword.value.trim(),append=more&&!!catalog.value?.has_more&&term===catalogKeyword;
    const response=await operations.read('/catalog',isOrdinaryCatalogList,{page:append?catalog.value!.page+1:1,limit:20,keyword:term});
    if(valid()){catalog.value={...response.data,list:append?[...catalog.value!.list,...response.data.list]:response.data.list};catalogKeyword=term;}
  });
}
async function selectProduct(id:number){await readAction(async valid=>{const response=await operations.read(`/catalog/${id}`,isOrdinaryCatalogSelection);if(response.data.product.id!==id)throw Error('商品目录归属不匹配');if(valid()){selection.value=response.data;skuUnique.value=response.data.skus.length===1?response.data.skus[0]!.sku_unique:'';addQuantity.value='1';}});}
async function searchBuyers(more:boolean) {
  await readAction(async valid=>{
    const term=buyerKeyword.value.trim(),append=more&&!!buyers.value?.has_more&&term===buyerQuery;
    const response=await operations.read('/users',isOrdinaryBuyerList,{page:append?buyers.value!.page+1:1,limit:20,keyword:term});
    if(valid()){buyers.value={...response.data,list:append?[...buyers.value!.list,...response.data.list]:response.data.list};buyerQuery=term;}
  });
}
function chooseMember(){if(identityLocked.value)return;buyerMode.value='member';buyer.value=null;touristKey.value='';contact.value={name:'',phone:''};}
async function chooseGuest(){if(identityLocked.value)return;await readAction(async valid=>{const key=await customerWorkRequestKey();if(valid()){buyerMode.value='guest';touristKey.value=key;buyer.value=null;buyers.value=null;contact.value={name:'',phone:''};}});}
function selectBuyer(row:OrdinaryBuyer){if(identityLocked.value)return;buyer.value=row;contact.value={name:row.nickname.slice(0,32),phone:row.phone};}
function syncForm(){const active=new Set(cartRows.value.map(row=>`${row.product_id}:${row.sku_unique}`)),infos=Object.entries(choices.value).filter(([key])=>active.has(key)).map(([,row])=>row.form).filter((value):value is SystemFormInfo=>value!==null);const info=infos[0]??null;if(infos.some(row=>row.id!==info!.id))throw Error('同一订单不能包含不同的自定义表单');if(customerWorkCanonicalJson(info)!==customerWorkCanonicalJson(formInfo.value)){formInfo.value=info;form.value=customerCashierFormDraft(info);previews.value={};formRevision.value++;}}
async function addSelected(){if(editingLocked.value)return;await run(async()=>{const selected=selection.value,sku=selected?.skus.find(row=>row.sku_unique===skuUnique.value),quantity=Number(addQuantity.value);if(!selected||!sku||!Number.isInteger(quantity)||quantity<1||quantity>32767||quantity>sku.stock)throw Error('请选择实际规格并填写有效数量');const choice:Choice={product_id:selected.product.id,sku_unique:sku.sku_unique,quantity,name:selected.product.store_name,sku:sku.sku,form:selected.system_form};const activeForms=cartRows.value.map(row=>choices.value[`${row.product_id}:${row.sku_unique}`]?.form?.id??0).filter(Boolean);if(choice.form&&activeForms.some(id=>id!==choice.form!.id))throw Error('同一订单不能包含不同的自定义表单');const key=`${choice.product_id}:${choice.sku_unique}`;choices.value[key]=choice;if(operations.draft.value){await operations.append([{product_id:choice.product_id,sku_unique:choice.sku_unique,quantity}]);}else{const old=localRows.value.find(row=>row.product_id===choice.product_id&&row.sku_unique===choice.sku_unique);if(old){if(old.quantity+quantity>32767)throw Error('该规格累计数量超出上限');old.quantity+=quantity;}else{if(localRows.value.length>=200)throw Error('购物行超出上限');localRows.value.push(choice);}}syncForm();});}
async function changeQuantity(row:CartDisplay,delta:number){if(editingLocked.value)return;await run(async()=>{const next=row.quantity+delta;if(next<1||next>32767)throw Error('数量无效');if(row.cart_id)await operations.quantity(row.cart_id,next);else{const choice=localRows.value.find(value=>`${value.product_id}:${value.sku_unique}`===row.key);if(choice)choice.quantity=next;}});}
async function removeRow(row:CartDisplay){if(editingLocked.value)return;await run(async()=>{if(row.cart_id)await operations.remove([row.cart_id]);else localRows.value=localRows.value.filter(value=>`${value.product_id}:${value.sku_unique}`!==row.key);syncForm();});}
async function saveDraft(){await run(async()=>{const context=manager.context.value;if(!context)throw Error('请重新读取经营身份');const body={version:'customer-cashier-ordinary-v1' as const,scope_key:context.scope_key,buyer_uid:buyerMode.value==='guest'?0:buyer.value?.uid??0,tourist_key:buyerMode.value==='guest'?touristKey.value:'',rows:localRows.value.map(({product_id,sku_unique,quantity})=>({product_id,sku_unique,quantity}))};const receipt=await operations.beginDraft(body);if(receipt&&receipt.kind==='draft'){localRows.value=[];await loadCheckoutReads();}});}
async function loadCheckoutReads(){await readAction(async valid=>{const d=operations.draft.value;if(!d)return;const [storeRows,provinceRows]=await Promise.all([ordinaryPickupStores(),ordinaryCities(0)]);if(!valid())return;stores.value=storeRows;regions.value=[provinceRows,[],[],[]];if(d.buyer_uid>0){const response=await operations.read(`/users/${d.buyer_uid}/addresses`,isOrdinaryAddressList);if(response.data.buyer_uid!==d.buyer_uid)throw Error('配送地址不属于原购买人');if(valid())addresses.value=response.data;}});}
const chosenRegion=(level:number)=>regions.value[level]?.find(row=>row.id===regionIds.value[level]);
const regionIndex=(level:number)=>Math.max(0,regions.value[level]?.findIndex(row=>row.id===regionIds.value[level])??0);
const eventIndex=(event:unknown)=>customerWorkRecord(event)&&customerWorkRecord(event.detail)?Number(event.detail.value):-1;
function selectStore(event:unknown){if(editingLocked.value)return;const index=eventIndex(event);if(Number.isInteger(index)&&stores.value[index])storeIndex.value=index;}
async function selectRegion(level:number,event:unknown){if(editingLocked.value)return;await readAction(async valid=>{const row=regions.value[level]?.[eventIndex(event)];if(!row)return;const names=['province','city','district','street'] as const;for(let depth=level;depth<4;depth++){regionIds.value[depth]=depth===level?row.id:0;manual.value[names[depth]!]=depth===level?row.name:'';if(depth>level)regions.value[depth]=[];}manual.value.cityId=level>=2?row.id:0;if(row.expandable&&level<3){const rows=await ordinaryCities(row.id);if(valid())regions.value[level+1]=rows;}});}
function submission(){if(!formInfo.value){if(form.value.length)throw Error('补充表单已变化');return null;}if(form.value.some(item=>item.name==='uploadPicture'&&(!Array.isArray(item.value)||item.value.some(ref=>typeof ref!=='string'||!/^\/api\/assets\/[1-9]\d{0,9}$/u.test(ref)))))throw Error('图片只能使用已核对的上传引用');const prepared=prepareOrderSystemFormSubmission(parseOrderSystemFormTemplate(formInfo.value.value),form.value,formInfo.value.id);return JSON.parse(prepared.snapshotJson).map((item:SystemFormComponent)=>({...(item.id===undefined?{}:{id:item.id}),name:item.name,value:item.value}));}
async function prepare(){await run(async()=>{const d=operations.draft.value;if(!d)throw Error('请先核对完整购物草稿');const input:OrdinaryCashierIntent={version:d.version,scope_key:d.scope_key,draft_key:d.draft_key,draft_hash:d.draft_hash,buyer_uid:d.buyer_uid,tourist_key:d.tourist_key,coupon_id:d.buyer_uid?couponId.value:0,use_integral:d.buyer_uid?useIntegral.value:false,shipping_type:shippingType.value,store_id:shippingType.value===2?stores.value[storeIndex.value]?.id??0:0,address_id:shippingType.value===1?addressId.value:0,manual_address:shippingType.value===1&&addressId.value===0?{...manual.value}:null,real_name:contact.value.name.trim(),user_phone:contact.value.phone.trim(),mark:mark.value.trim(),custom_form:submission()};const pending=await operations.prepareQuote(input);if(!pending)return;const data=pending.quote!.read.data;if(!isOrdinaryQuoteData(data))throw Error('实际报价无效');if(customerWorkCanonicalJson(data.system_form)!==customerWorkCanonicalJson(formInfo.value)){operations.clearQuotation();formInfo.value=data.system_form;form.value=customerCashierFormDraft(data.system_form);formRevision.value++;throw Error('服务器补充表单已变化，请重新填写并核对报价');}coupons.value=data.coupons.list;couponCursor.value=data.coupons.next_cursor;});}
async function chooseCoupon(id:number){if(locked.value)return;operations.clearQuotation();couponId.value=id;await prepare();}
async function moreCoupons(){if(couponCursor.value===null||!quote.value)return;await readAction(async valid=>{const original=quote.value!,response=await operations.read(`/quotes/${original.quote_token}/coupons`,isOrdinaryCouponRead,{request_key:original.request_key,limit:20,before:couponCursor.value!});if(response.data.request_key!==original.request_key||response.data.quote_token!==original.quote_token)throw Error('优惠券页不属于原报价');if(valid()){const rows=new Map(coupons.value.map(row=>[row.id,row]));for(const row of response.data.coupons.list)rows.set(row.id,row);coupons.value=[...rows.values()];couponCursor.value=response.data.coupons.next_cursor;}});}
function updateForm(value:SystemFormComponent[]){if(!editingLocked.value)form.value=value;}
async function beforeChooseImages(index:number){if(editingLocked.value||form.value[index]?.name!=='uploadPicture')throw Error('原表单图片项目不可用');pickerLease=manager.beginSuspendLease();}
function setFormPending(value:number){formPending.value=value;if(value===0){pickerLease?.release();pickerLease=null;}}
function setFormChoosing(value:boolean){if(!value&&manager.current()){pickerLease?.release();pickerLease=null;}}
async function uploadImage(path:string,index:number){const version=epoch,validScope=manager.fence(),snapshot=customerWorkCanonicalJson(formInfo.value);const current=()=>version===epoch&&validScope()&&manager.current()&&form.value[index]?.name==='uploadPicture'&&customerWorkCanonicalJson(formInfo.value)===snapshot;const result=await ordinaryCreatorImage(path,current);if(!current())throw Error('原经营账号或表单已变化');previews.value[result.url]=result.src;return result;}
async function payCreated(){await run(async()=>{const order=createdOrder.value,receipt=operations.created.value;if(!order||!receipt||typeof receipt.evidence.origin_hash!=='string')throw Error('请先核对原实际订单');const source:OrdinaryPaymentSource={order_id:order.order_id,order_no:order.order_no,buyer_uid:order.buyer_uid,creator_uid:order.creator_uid,amount:order.pay_price,origin_hash:receipt.evidence.origin_hash,creation_key:receipt.request_key};await operations.pay(source);});}
</script>
<style scoped>
.cw-product{display:flex;align-items:center;gap:18rpx;width:100%;margin:16rpx 0;text-align:left}.selected{background:#e7f0e8!important;border-color:#4c7e5e!important}.cw-grow{display:flex;flex-direction:column;gap:12rpx}.cw-card>text{line-height:1.6}
</style>
