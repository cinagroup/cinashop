<template>
  <div class="refund-apply container">
    <h2 class="title">申请退款</h2>
    <p v-if="order">订单号：{{ order.order_id }} · 订单金额 ¥{{ order.pay_price }}</p>
    <el-alert v-if="state.loadError || state.submitError" :title="state.loadError || state.submitError" type="warning" :closable="false" class="policy-alert" />
    <el-alert v-if="navigationError" :title="navigationError" type="warning" :closable="false" class="policy-alert" />
    <el-alert v-if="state.refundId" :title="`退款申请 #${state.refundId} 已提交，等待商家处理；不代表退款已到账`" type="success" :closable="false" class="policy-alert" />
    <div class="page-actions">
      <el-button :disabled="loading || submitting || state.uploading || navigating" @click="load">重新加载订单</el-button>
      <el-button v-if="state.refundId || state.uncertain" :disabled="loading || submitting || state.uploading || navigating" @click="goOrder">查看订单</el-button>
      <el-button v-if="state.refundId || state.uncertain" :disabled="loading || submitting || state.uploading || navigating" @click="goRefund">查看退款记录</el-button>
    </div>

    <el-card v-loading="loading" shadow="never" class="refund-card">
      <el-alert
        v-if="refundBlockedReason"
        :title="refundBlockedReason"
        type="warning"
        :closable="false"
        show-icon
        class="policy-alert"
      />
      <el-form v-if="order" :model="form" :disabled="!editable" label-width="100px" style="max-width: 560px">
        <el-form-item label="退款商品" required>
          <el-checkbox-group v-model="selectedIds" class="refund-items">
            <div v-for="item in state.items" :key="item.id" class="refund-line">
              <el-checkbox :value="item.id" :disabled="!editable || !item.refundable">
                {{ item.name }} {{ item.sku }}{{ item.refundable ? '' : ' — 暂不可退' }}
              </el-checkbox>
              <p class="refund-note">订单数量 {{ item.quantity }} · 本次读取剩余 {{ item.remainingQuantity }}</p>
              <div v-if="selectedIds.includes(item.id) && item.refundable" class="quantity-controls">
                <label :for="`refund-quantity-${item.id}`">申请数量</label>
                <button type="button" :aria-label="`减少 ${item.name} ${item.sku} 申请数量`" :disabled="!editable || requestedQuantity(item) === null || (requestedQuantity(item) || 0) <= 1" @click="adjustQuantity(item, -1)">−</button>
                <input :id="`refund-quantity-${item.id}`" class="refund-quantity-input" type="number" inputmode="numeric" min="1" :max="item.remainingQuantity" step="1"
                  :aria-label="`${item.name} ${item.sku} 申请数量`" :aria-invalid="requestedQuantity(item) === null" :value="state.quantities[item.id]" :disabled="!editable" @input="editQuantity(item, $event)" @keydown.enter.prevent />
                <button type="button" :aria-label="`增加 ${item.name} ${item.sku} 申请数量`" :disabled="!editable || requestedQuantity(item) === null || (requestedQuantity(item) || 0) >= item.remainingQuantity" @click="adjustQuantity(item, 1)">+</button>
              </div>
              <p v-if="selectedIds.includes(item.id) && item.refundable && requestedQuantity(item) === null" class="quantity-error" role="alert">请输入 1 至 {{ item.remainingQuantity }} 之间的整数件数</p>
            </div>
          </el-checkbox-group>
        </el-form-item>
        <p class="refund-note">可分别填写所选商品的申请数量。剩余数量为本次读取结果，资格和退款金额由服务端最终核算。</p>
        <el-form-item label="退款类型" required>
          <el-radio-group v-model="form.applyType">
            <el-radio :value="1">仅退款</el-radio>
            <el-radio v-if="!isVirtualOrder" :value="2">退货退款</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="退款原因" required>
          <el-select v-model="form.refundReason" placeholder="请选择退款原因" style="width: 100%">
            <el-option label="商品质量问题" value="商品质量问题" />
            <el-option label="商品与描述不符" value="商品与描述不符" />
            <el-option label="不想要了" value="不想要了" />
            <el-option label="其他原因" value="其他原因" />
          </el-select>
        </el-form-item>
        <el-form-item label="退款说明">
          <el-input
            v-model="form.refundExplain"
            type="textarea"
            :rows="3"
            :maxlength="255"
            placeholder="请描述退款原因"
          />
        </el-form-item>
        <el-form-item label="申请凭证">
          <section class="application-evidence" aria-label="退款申请凭证">
            <p class="refund-note">选填，最多三张。上传与本次退款原因有关的图片，提交后供商家核对。</p>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="上传申请凭证" :disabled="!editable || state.images.length >= 3" @click="beginApplicationImageSelection" @change="uploadApplicationImage" />
            <p v-if="state.uploading" role="status">正在上传申请凭证…</p>
            <div class="application-images">
              <div v-for="(image, index) in state.images" :key="image.url">
                <p v-if="failedImages.includes(image.url)" role="alert">申请凭证 {{ index + 1 }} 预览失败，可移除后重新上传</p>
                <a v-else :href="image.src" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" :aria-label="`查看申请凭证 ${index + 1}`"><img :src="image.src" :alt="`退款申请凭证 ${index + 1}`" @error="imageFailed(image.url)" /></a>
                <el-button :disabled="!editable" @click="removeApplicationImage(index)">移除申请凭证 {{ index + 1 }}</el-button>
              </div>
            </div>
          </section>
        </el-form-item>
        <el-form-item>
          <el-button
            class="refund-submit"
            type="danger"
            :loading="submitting"
            :disabled="!canSubmit || !selectedIds.length || !form.refundReason.trim()"
            @click="submit"
          >提交申请</el-button>
          <el-button @click="$router.back()">取消</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, onBeforeUnmount } from "vue";
import { useRoute, useRouter, isNavigationFailure } from "vue-router";
import { apiOrderDetail } from "@/api/order";
import type { OrderInfo } from "@/types/order";
import request, { getData } from "@/utils/request";
import { ApiResponseError } from "@/utils/apiError";
import { captureAuthSession, isCurrentAuthSession, getUid, onAuthChange } from "@/utils/auth";
import { createRefundApplication, initialRefundApplication, refundBlockReason, type RefundItem } from "../../../../common/refundApplication";
import { orderDetailId } from "../../../../common/orderDetailIdentity";
import { apiReturnImage } from '@/api/refund';

const route = useRoute();
const router = useRouter();
const state=reactive(initialRefundApplication<OrderInfo>());
const order=computed(()=>state.order),loading=computed(()=>state.loading),submitting=computed(()=>state.submitting);
const form=state.form,selectedIds=computed({get:()=>state.selectedIds,set:value=>{state.selectedIds=value;}});
const navigating=ref(false),navigationError=ref('');let disposed=false,navigationVersion=0,id='';
const failedImages=ref<string[]>([]);
let imagePickerOwner: ReturnType<typeof capture> | undefined;
watch(()=>state.images,()=>{failedImages.value=[];},{flush:'sync'});
const isVirtualOrder = computed(() => [1, 3, 4].includes(order.value?.product_type ?? 0));
const refundBlockedReason=computed(()=>order.value?refundBlockReason(order.value):'');
function capture(){
  const session=captureAuthSession(),uid=getUid(),path=route.fullPath,orderId=id,revision=state.revision;
  return{id:orderId,uid,current:()=>!disposed&&!!session.token&&uid===getUid()&&isCurrentAuthSession(session)
    &&path===route.fullPath&&route.path.startsWith('/refund/')&&orderId===id&&revision===state.revision};
}
const controller=createRefundApplication(state,{capture,read:apiOrderDetail,write:(id,body)=>getData(request.post(`/order/refund/apply/${id}`,body)),
  isRejected:error=>error instanceof ApiResponseError&&error.status===400});
const editable=computed(()=>controller.canSubmit()&&!navigating.value);
const canSubmit=computed(()=>editable.value&&!controller.quantityError());
const requestedQuantity=controller.requestedQuantity;
function editQuantity(item:RefundItem,event:Event){if(editable.value)controller.setQuantity(item,(event.target as HTMLInputElement).value);}
function adjustQuantity(item:RefundItem,delta:number){if(editable.value)controller.shiftQuantity(item,delta);}
function clear(){imagePickerOwner=undefined;controller.clear();navigationVersion++;navigating.value=false;navigationError.value='';}
async function load(){if(disposed||navigating.value)return;await controller.load();}
async function submit(){if(!navigating.value)await controller.submit();}
function beginApplicationImageSelection(){imagePickerOwner=editable.value?capture():undefined;}
async function uploadApplicationImage(event: Event) {
  const owner=imagePickerOwner;imagePickerOwner=undefined;
  const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';
  if(file&&!navigating.value&&owner?.current()) await controller.uploadImage(async current=>current()&&owner.current()?apiReturnImage(file):null);
}
function removeApplicationImage(index:number) {
  if(navigating.value)return;const image=state.images[index];controller.removeImage(index);
  if(image&&!state.images.includes(image))failedImages.value=failedImages.value.filter(url=>url!==image.url);
}
function imageFailed(url:string){if(state.images.some(image=>image.url===url)&&!failedImages.value.includes(url))failedImages.value.push(url);}
async function navigateResult(refund = false){
  if(disposed||loading.value||submitting.value||state.uploading||navigating.value||!capture().current())return;
  const owner=capture(),version=++navigationVersion;navigating.value=true;navigationError.value='';
  const target = refund ? (state.refundId ? `/user/refunds/${state.refundId}` : `/user/refunds?q=${encodeURIComponent(owner.id)}`) : `/order/${owner.id}`;
  try{const result=await router.push(target);if(owner.current()&&isNavigationFailure(result))navigationError.value='页面未打开，请重试查看，不会重复提交申请';}
  catch{if(owner.current())navigationError.value='页面未打开，请重试查看，不会重复提交申请';}
  finally{if(owner.current()&&version===navigationVersion)navigating.value=false;}
}
const goOrder = () => navigateResult();
const goRefund = () => { if (state.refundId || state.uncertain) return navigateResult(true); };
const stopAuth=onAuthChange(()=>{clear();state.loadError='登录状态已变化，请重新加载退款订单';});
watch(()=>route.fullPath,()=>{
  clear();id='';if(!route.path.startsWith('/refund/'))return;
  try{id=orderDetailId(route.params.orderId);void load();}catch(error){state.loadError=error instanceof Error?error.message:'订单链接无效';}
},{immediate:true,flush:'sync'});
onBeforeUnmount(()=>{disposed=true;stopAuth();clear();});
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.refund-card {
  max-width: 700px;
}

.policy-alert {
  margin-bottom: 20px;
}
.page-actions { display:flex; flex-wrap:wrap; gap:12px; margin:16px 0; }
.refund-items { display:flex; flex-direction:column; min-width:0; }
.refund-items :deep(.el-checkbox) { height:auto; white-space:normal; margin:8px 0; }
.refund-items :deep(.el-checkbox__label) { white-space:normal; overflow-wrap:anywhere; }
.refund-line { padding:8px 0; border-bottom:1px solid #eee; min-width:0; }
.refund-line p { margin:4px 0 8px; }
.quantity-controls { display:flex; flex-wrap:wrap; align-items:center; gap:8px; font-size:14px; line-height:1.5; }
.quantity-controls button { min-width:44px; min-height:44px; border:1px solid #bbb; border-radius:4px; background:#fff; font:inherit; }
.refund-quantity-input { box-sizing:border-box; width:100px; max-width:100%; min-height:44px; border:1px solid #bbb; border-radius:4px; padding:8px; font:inherit; }
.quantity-error { color:#9b3020; font-size:13px; }
.refund-note { color:#666; font-size:13px; line-height:1.6; }
.application-evidence { width:100%; min-width:0; }
.application-evidence input { max-width:100%; }
.application-images { display:flex; flex-wrap:wrap; gap:12px; margin-top:12px; }
.application-images > div { width:140px; max-width:100%; min-width:0; }
.application-images img { display:block; width:100%; height:140px; object-fit:contain; }
.application-images :deep(button) { max-width:100%; margin:8px 0; }
</style>
