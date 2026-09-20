<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { getAdminSession } from '@/utils/auth';
import { createAdminSessionScope } from '@/utils/adminSessionScope';
import { previewMode } from '@/api/refund';
import { apiCreationAction, apiCreationFinancialReceipt, apiCreationQuote } from '@/api/refundCreation';
import { creationIntentKey, creationMessage, creationSelection, makeCreationIntent, parseCreationBody, parseCreationQuote,
  readCreationIntent, withCreationLock, writeCreationIntent, type CreationIntent, type CreationMode, type CreationQuote } from '@/utils/refundCreation';

const route=useRoute(),routeKey=route.fullPath,identity=getAdminSession(),actorId=identity?.userInfo.id??0;
const orderInput=ref(typeof route.query.creationOrderId==='string'?route.query.creationOrderId:''),orderId=ref(0);
const busy=ref(false),invalid=ref(false),readable=ref(false),error=ref(''),message=ref('');
const quote=ref<CreationQuote|null>(null),intent=ref<CreationIntent|null>(null);
const choices=ref<Array<{cartId:number;maximum:number;quantity:number}>>([]),amount=ref(''),reason=ref('');
let generation=0,observedRaw:string|null=null,confirmation=false;
function clear() { quote.value=null;choices.value=[];amount.value='';reason.value='';intent.value=null;observedRaw=null;readable.value=false;message.value=''; }
function invalidate() {
  invalid.value=true;generation++;busy.value=false;clear();orderId.value=0;orderInput.value='';error.value='';
  if(confirmation){ElMessageBox.close();confirmation=false;}
}
const scope=createAdminSessionScope(invalidate,previewMode);
const active=()=>scope.isCurrent() && !invalid.value && route.fullPath===routeKey;
const canManage=computed(()=>!previewMode && !invalid.value && (identity?.userInfo.level===0 || identity?.uniqueAuth.includes('refund.manage')));
const canStart=computed(()=>canManage.value && readable.value && !!orderId.value && !busy.value && intent.value?.phase!=='pending');
const canRecover=computed(()=>canManage.value && readable.value && !busy.value && intent.value?.phase==='pending');
const failure=(e:unknown)=>e instanceof Error?e.message:'操作失败，请保留原请求并核对';
function storage(event:StorageEvent) {
  if(!active() || !orderId.value || event.storageArea!==localStorage)return;
  if(event.key===null || event.key===creationIntentKey(actorId,orderId.value)) {
    generation++;busy.value=false;clear();error.value='其他标签页已更新主动退款，请重新打开订单核对';
    if(confirmation){ElMessageBox.close();confirmation=false;}
  }
}
window.addEventListener('storage',storage);
watch(()=>route.fullPath,value=>{if(value!==routeKey){invalidate();scope.dispose();}},{flush:'sync'});
onBeforeUnmount(()=>{window.removeEventListener('storage',storage);invalidate();scope.dispose();});
function accept(state:Awaited<ReturnType<typeof readCreationIntent>>) {
  observedRaw=state.raw;intent.value=state.intent;readable.value=true;
  message.value=state.intent?creationMessage(state.intent):'';
}
async function open() {
  if(!active() || !canManage.value || busy.value)return;
  if(!/^[1-9]\d{0,9}$/.test(orderInput.value) || Number(orderInput.value)>2147483647){error.value='请输入订单数字 ID，不是显示订单号';return;}
  const id=Number(orderInput.value),ticket=++generation;clear();orderId.value=id;error.value='';busy.value=true;
  try {const stored=await readCreationIntent(actorId,id);if(active() && ticket===generation)accept(stored);}
  catch(e){if(active() && ticket===generation)error.value=failure(e);}
  finally{if(active() && ticket===generation)busy.value=false;}
}
async function readQuote(mode:'remaining'|'items') {
  if(!active() || !canStart.value)return;
  const id=orderId.value,ticket=++generation,raw=observedRaw;
  const selected=mode==='items'?choices.value.filter(row=>row.quantity>0).map(row=>({cartId:row.cartId,cartNum:row.quantity})):[];
  quote.value=null;error.value='';busy.value=true;
  try {
    const request=creationSelection(id,mode,selected);
    const result=await apiCreationQuote(actorId,request,scope.signal);
    if(!active() || ticket!==generation)return;
    const stored=await readCreationIntent(actorId,id);
    if(!active() || ticket!==generation)return;
    if(stored.raw!==raw)throw Error('原请求已变化，请重新打开订单');
    if(mode==='remaining')choices.value=result.items.map(row=>({cartId:row.cartId,maximum:row.cartNum,quantity:row.cartNum}));
    quote.value=result;amount.value=result.quotedPrice;
  }catch(e){if(active() && ticket===generation)error.value=failure(e);}
  finally{if(active() && ticket===generation)busy.value=false;}
}
function changedSelection() {quote.value=null;amount.value='';}
async function confirm(text:string,title:string) {
  confirmation=true;
  try {await ElMessageBox.confirm(text,title,{type:'warning',confirmButtonText:'确认',cancelButtonText:'取消',closeOnClickModal:false});}
  finally{confirmation=false;}
}
async function saveResult(next:CreationIntent,expectedRaw:string,owns:()=>boolean) {
  const stored=await readCreationIntent(actorId,next.orderId);
  if(!owns())return;
  if(stored.raw!==expectedRaw)throw Error('原请求已被更新，请重新打开订单');
  let raw:string;
  try{raw=writeCreationIntent(next,expectedRaw);}catch(e){readable.value=false;throw e;}
  accept({raw,intent:next});
}
async function submit(mode:'create'|'execute') {
  if(!active() || !canStart.value || !quote.value)return;
  const q=parseCreationQuote(quote.value,creationSelection(orderId.value,quote.value.mode,quote.value.mode==='items'?quote.value.items:[]));
  const raw=observedRaw,ticket=++generation,owns=()=>active() && ticket===generation && orderId.value===q.review.id;
  let dispatched=false;busy.value=true;error.value='';
  try {
    const body=parseCreationBody({version:'admin-refund-creation-v1',review:q.review,mode:q.mode,items:q.mode==='items'?q.items:[],
      quotedPrice:q.quotedPrice,refundPrice:amount.value,reason:reason.value,quoteFingerprint:q.quoteFingerprint});
    await confirm(`订单 ${q.review.orderId}（ID ${q.review.id}），用户 UID ${q.review.uid}。商品项 ${q.items.map(row=>row.cartId+' × '+row.cartNum).join('、')}。本次退款 ¥${body.refundPrice}，报价上限 ¥${q.quotedPrice}。原因：${body.reason}。`+
      (mode==='execute'?'确认创建并执行资金退款？':'仅创建申请，本次不执行资金退款。'),mode==='execute'?'确认主动退款':'仅创建退款申请');
    if(!owns())return;
    await withCreationLock(q.review.id,async()=>{
      if(!owns())return;
      const stored=await readCreationIntent(actorId,q.review.id);
      if(!owns())return;
      if(stored.raw!==raw || stored.intent?.phase==='pending')throw Error('仍有待核对的原请求，不能创建新请求');
      const next=await makeCreationIntent(actorId,q,body.refundPrice,body.reason);
      if(!owns())return;
      let saved:string;
      try{saved=writeCreationIntent(next,raw);}catch(e){readable.value=false;throw e;}
      accept({raw:saved,intent:next});quote.value=null;choices.value=[];amount.value='';reason.value='';
      dispatched=true;
      const result=await apiCreationAction(next,mode,scope.signal);
      if(owns())await saveResult(result,saved,owns);
    });
  }catch(e){if(owns() && e!=='cancel' && e!=='close')error.value=dispatched?'结果待核对，原请求已保留。请查询回执；不会自动重试或生成新键。':failure(e);}
  finally{if(owns())busy.value=false;}
}
async function recover(mode:CreationMode|'financial') {
  if(!active() || !canRecover.value || !intent.value || observedRaw===null)return;
  const original=intent.value,raw=observedRaw,ticket=++generation,owns=()=>active() && ticket===generation && orderId.value===original.orderId;
  busy.value=true;error.value='';
  try {
    if(mode==='execute' || mode==='abandon') {
      await confirm(mode==='execute'?`使用原请求向 UID ${original.body.review.uid} 退款 ¥${original.body.refundPrice}。可能创建申请、执行资金退款或继续查询渠道；不会重新报价或换键。`
        :'仅阻止尚未创建的原请求。若退款申请已经创建，不会取消申请或资金退款。是否继续？',mode==='execute'?'恢复原主动退款':'放弃未创建的原请求');
      if(!owns())return;
    }
    await withCreationLock(original.orderId,async()=>{
      if(!owns())return;
      const stored=await readCreationIntent(actorId,original.orderId);
      if(!owns())return;
      if(stored.raw!==raw)throw Error('原请求记录已变化，请重新打开订单核对');
      const result=mode==='financial'?await apiCreationFinancialReceipt(original,scope.signal):await apiCreationAction(original,mode,scope.signal);
      if(owns())await saveResult(result,raw,owns);
    });
  }catch(e){if(owns() && e!=='cancel' && e!=='close')error.value=failure(e)+'；原请求保留待核对。';}
  finally{if(owns())busy.value=false;}
}
</script>

<template>
  <el-card class="creation" shadow="never">
    <template #header><h3>主动退款与恢复</h3></template>
    <p>报价不创建申请、不扣款，也不预留商品。每次提交前请核对订单、商品项、用户及退款金额。</p>
    <p v-if="!canManage">{{ invalid ? '登录状态已变化，请重新打开页面。' : '当前账号或预览模式不可发起主动退款。' }}</p>
    <form class="creation-actions" @submit.prevent="open">
      <el-input v-model="orderInput" aria-label="主动退款订单 ID" placeholder="订单数字 ID，可从订单详情进入" maxlength="10" :disabled="!canManage || busy" />
      <el-button native-type="submit" :disabled="!canManage || busy">打开主动退款</el-button>
    </form>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template v-if="readable && orderId">
      <p>当前订单 ID {{ orderId }} <span v-if="intent">· 已保存原请求 {{ intent.nonce }}</span></p>
      <el-alert v-if="message" :title="message" type="info" :closable="false" />
      <div v-if="intent" class="original">
        <p>原订单 {{ intent.body.review.orderId }} · UID {{ intent.body.review.uid }} · ¥{{ intent.body.refundPrice }}</p>
        <p>原原因：{{ intent.body.reason }}</p>
        <p v-if="intent.receipt?.refundId">退款单 ID {{ intent.receipt.refundId }}（创建回执不代表资金已到账）</p>
        <div v-if="intent.phase === 'pending'" class="creation-actions">
          <el-button :disabled="!canRecover" @click="recover('receipt')">查询创建回执</el-button>
          <el-button :disabled="!canRecover || intent.receipt?.outcome !== 'created'" @click="recover('financial')">查询资金回执</el-button>
          <el-button type="danger" :disabled="!canRecover" @click="recover('execute')">恢复原主动退款</el-button>
          <el-button :disabled="!canRecover" @click="recover('abandon')">放弃未创建的原请求</el-button>
        </div>
      </div>
      <div class="creation-actions"><el-button :disabled="!canStart" @click="readQuote('remaining')">读取全部剩余商品报价</el-button></div>
      <template v-if="choices.length">
        <p>商品项编号来自订单快照；数量设为 0 可排除该项。修改后须重新报价。</p>
        <div v-for="row in choices" :key="row.cartId" class="creation-actions">
          <label :for="'creation-item-'+row.cartId">商品项 {{ row.cartId }}（最多 {{ row.maximum }} 件）</label>
          <el-input-number :id="'creation-item-'+row.cartId" v-model="row.quantity" :aria-label="'商品项 '+row.cartId+' 数量'" :min="0" :max="row.maximum" :step="1" step-strictly :disabled="!canStart" @change="changedSelection" />
        </div>
        <el-button :disabled="!canStart" @click="readQuote('items')">重新报价所选商品</el-button>
      </template>
      <div v-if="quote" class="quote-review">
        <h4>本次报价核对</h4>
        <p>订单 {{ quote.review.orderId }} · UID {{ quote.review.uid }} · 门店 {{ quote.review.storeId }} · 供应商 {{ quote.review.supplierId }}</p>
        <p>实付 ¥{{ quote.review.payPrice }} · 已退 ¥{{ quote.review.refundPrice }} · 支付方式 {{ quote.review.payType }}</p>
        <p>本次 {{ quote.refundNum }} 件，上限 ¥{{ quote.quotedPrice }}。{{ quote.mode === 'remaining' ? '全部剩余商品' : '指定商品及件数' }}</p>
        <el-form label-position="top" @submit.prevent>
          <el-form-item label="本次退款金额（两位小数）"><el-input v-model="amount" aria-label="本次退款金额" maxlength="13" :disabled="!canStart" /></el-form-item>
          <el-form-item label="主动退款原因"><el-input v-model="reason" aria-label="主动退款原因" maxlength="255" :disabled="!canStart" /></el-form-item>
        </el-form>
        <div class="creation-actions">
          <el-button :disabled="!canStart" @click="submit('create')">仅创建申请</el-button>
          <el-button type="danger" :disabled="!canStart" @click="submit('execute')">创建并执行退款</el-button>
        </div>
      </div>
    </template>
    <p v-if="busy" role="status">正在核对，请勿重复操作……</p>
  </el-card>
</template>

<style scoped>
.creation{margin-bottom:16px}.creation h3{margin:0}.creation p{overflow-wrap:anywhere;line-height:1.6}
.creation-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0}.creation-actions>.el-input{max-width:360px}
.creation-actions .el-button{margin-left:0}.quote-review,.original{margin-top:16px;padding-top:12px;border-top:1px solid var(--el-border-color)}
@media(max-width:600px){.creation-actions{align-items:stretch;flex-direction:column}.creation-actions>.el-input{max-width:none}}
</style>
