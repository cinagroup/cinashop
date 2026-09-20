<template>
  <div class="refund-apply container">
    <h2 class="title">申请退款</h2>
    <p v-if="order">订单号：{{ order.order_id }} · 订单金额 ¥{{ order.pay_price }}</p>
    <el-alert v-if="state.loadError || state.submitError" :title="state.loadError || state.submitError" type="warning" :closable="false" class="policy-alert" />
    <el-alert v-if="navigationError" :title="navigationError" type="warning" :closable="false" class="policy-alert" />
    <el-alert v-if="state.refundId" :title="`退款申请 #${state.refundId} 已提交，等待商家处理；不代表退款已到账`" type="success" :closable="false" class="policy-alert" />
    <div class="page-actions">
      <el-button :disabled="loading || submitting || navigating" @click="load">重新加载订单</el-button>
      <el-button v-if="state.refundId || state.uncertain" :disabled="loading || submitting || navigating" @click="goOrder">查看订单</el-button>
      <el-button v-if="state.refundId || state.uncertain" :disabled="loading || submitting || navigating" @click="goRefund">查看退款记录</el-button>
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
            <el-checkbox v-for="item in state.items" :key="item.id" :value="item.id" :disabled="!editable || !item.refundable">
              {{ item.name }} {{ item.sku }}（订单数量 {{ item.quantity }}）{{ item.refundable ? '' : ' — 暂不可退' }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <p class="refund-note">申请所选商品的剩余可退数量，资格和退款金额由服务端最终核算。</p>
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
        <el-form-item>
          <el-button
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
import { createRefundApplication, initialRefundApplication, refundBlockReason } from "../../../../common/refundApplication";
import { orderDetailId } from "../../../../common/orderDetailIdentity";

const route = useRoute();
const router = useRouter();
const state=reactive(initialRefundApplication<OrderInfo>());
const order=computed(()=>state.order),loading=computed(()=>state.loading),submitting=computed(()=>state.submitting);
const form=state.form,selectedIds=computed({get:()=>state.selectedIds,set:value=>{state.selectedIds=value;}});
const navigating=ref(false),navigationError=ref('');let disposed=false,navigationVersion=0,id='';
const isVirtualOrder = computed(() => [1, 3, 4].includes(order.value?.product_type ?? 0));
const refundBlockedReason=computed(()=>order.value?refundBlockReason(order.value):'');
function capture(){
  const session=captureAuthSession(),uid=getUid(),path=route.fullPath,orderId=id,revision=state.revision;
  return{id:orderId,uid,current:()=>!disposed&&!!session.token&&uid===getUid()&&isCurrentAuthSession(session)
    &&path===route.fullPath&&route.path.startsWith('/refund/')&&orderId===id&&revision===state.revision};
}
const controller=createRefundApplication(state,{capture,read:apiOrderDetail,write:(id,body)=>getData(request.post(`/order/refund/apply/${id}`,body)),
  isRejected:error=>error instanceof ApiResponseError&&error.status===400});
const canSubmit=computed(()=>controller.canSubmit()&&!navigating.value),editable=computed(()=>canSubmit.value);
function clear(){controller.clear();navigationVersion++;navigating.value=false;navigationError.value='';}
async function load(){if(disposed||navigating.value)return;await controller.load();}
async function submit(){if(!navigating.value)await controller.submit();}
async function navigateResult(refund = false){
  if(disposed||loading.value||submitting.value||navigating.value||!capture().current())return;
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
.refund-note { color:#666; font-size:13px; line-height:1.6; }
</style>
