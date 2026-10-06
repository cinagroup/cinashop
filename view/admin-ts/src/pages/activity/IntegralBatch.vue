<template>
  <div class="integral-batch">
    <div class="heading"><div><h2>批量添加积分商品</h2><p>选择基础商品及规格，设置兑换积分、现金价格和兑换次数。商品展示与配送信息沿用基础商品。</p></div><el-button @click="router.push('/activity?tab=integral')">返回积分商城</el-button></div>
    <el-alert v-if="!canView" title="当前账号没有积分商品批量查看权限" type="warning" :closable="false" />
    <template v-else>
      <el-alert v-if="!canManage" title="当前账号只能查看，不能添加积分商品" type="info" :closable="false" />
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-alert v-if="pending" title="正在核对未完成的批量请求" type="warning" :closable="false" show-icon>
        <template #default><p>本批共 {{ pending.input.products.length }} 个商品。先读取结果，避免重复创建。</p><div class="buttons"><el-button :loading="readingReceipt" :disabled="saving || !pending.input.request_id" @click="readReceipt">读取提交结果</el-button><el-button v-if="retryReady && canManage" type="primary" :loading="saving" :disabled="readingReceipt" @click="submitFrozen">重新提交原批次</el-button></div></template>
      </el-alert>
      <el-alert v-if="receipt" :title="`已添加 ${receipt.count} 个积分商品`" type="success" :closable="false" show-icon><template #default><p>积分商品 ID：{{ receipt.products.map(row => row.integral_id).join('、') }}。{{ receipt.is_show ? '商品已上架。' : '商品保持下架，可在积分商城检查后开启。' }}</p></template></el-alert>
      <div class="toolbar"><el-button type="primary" :disabled="locked" @click="openPicker">{{ canManage ? '选择商品' : '查看基础商品' }}</el-button><span>已选 {{ picked.length }} 个商品，勾选 {{ selectedCount }} 个规格</span><el-radio-group v-model="isShow" :disabled="locked || !canManage" aria-label="上架状态"><el-radio :value="0">下架</el-radio><el-radio :value="1">上架</el-radio></el-radio-group></div>
      <fieldset v-if="canManage" :disabled="locked" class="batch-settings"><legend>给勾选规格批量设置</legend><label>兑换积分<el-input-number v-model="bulk.integral" :min="0" :max="MAX" :precision="0" aria-label="批量兑换积分" /></label><label>现金价格<el-input v-model="bulk.price" inputmode="decimal" aria-label="批量现金价格" /></label><label>兑换次数<el-input-number v-model="bulk.quota" :min="1" :max="MAX" :precision="0" aria-label="批量兑换次数" /></label><el-button :disabled="locked || !selectedCount" @click="applyBulk">应用到勾选规格</el-button></fieldset>
      <p class="hint">兑换次数不能超过基础库存。创建时不扣基础库存，兑换时按实际规格扣减；已有积分商品不被覆盖。</p>
      <el-empty v-if="!picked.length && !pending" description="请先选择商品，再勾选要添加的规格" />
      <section v-for="entry in picked" :key="entry.product.id" class="product-card">
        <div class="product-heading"><div><h3>{{ entry.product.store_name }}</h3><span class="hint">基础商品 {{ entry.product.id }} · 库存 {{ entry.product.stock }} · {{ entry.product.category_name || '未分类' }}</span></div><div class="buttons"><el-button :disabled="locked || !canManage" @click="selectAll(entry)">选中全部有库存规格</el-button><el-button :disabled="locked || !canManage" type="danger" plain @click="remove(entry.product.id)">移除商品</el-button></div></div>
        <div class="table-scroll"><el-table :data="entry.skus" row-key="base_unique" border>
          <el-table-column label="选择" width="64"><template #default="{row}"><el-checkbox v-model="row.selected" :aria-label="`选择规格 ${row.suk || row.base_unique}`" :disabled="locked || !canManage || row.stock <= 0 || !row.valid || !entry.product.valid" /></template></el-table-column>
          <el-table-column label="规格" min-width="130"><template #default="{row}">{{ row.suk || '默认规格' }}<p class="hint">{{ row.base_unique }}</p><p v-if="!row.valid" class="hint">{{ row.issues.join('；') }}</p></template></el-table-column>
          <el-table-column label="规格图片" min-width="220"><template #default="{row}"><el-image v-if="image(row.image,row.image_preview)" :src="image(row.image,row.image_preview)" fit="contain" class="sku-image" /><el-input v-model="row.image" :aria-label="`${row.suk} 规格图片`" :disabled="locked || !canManage" maxlength="128" placeholder="HTTPS或站内图片地址" @input="row.image_preview = ''" /><ImagePicker :disabled="locked || !canManage" :editor-key="`${epoch}:${entry.product.id}:${row.base_unique}`" title="选择积分商品规格图片" @choose="(reference,preview) => chooseImage(row,reference,preview)" /></template></el-table-column>
          <el-table-column label="兑换积分" min-width="160"><template #default="{row}"><el-input-number v-model="row.integral" :aria-label="`${row.suk} 兑换积分`" :min="0" :max="MAX" :precision="0" :disabled="locked || !canManage" /></template></el-table-column>
          <el-table-column label="现金价格" min-width="145"><template #default="{row}"><el-input v-model="row.price" :aria-label="`${row.suk} 现金价格`" inputmode="decimal" :disabled="locked || !canManage" /></template></el-table-column>
          <el-table-column label="兑换次数" min-width="160"><template #default="{row}"><el-input-number v-model="row.quota" :aria-label="`${row.suk} 兑换次数`" :min="0" :max="row.stock" :precision="0" :disabled="locked || !canManage" /></template></el-table-column>
          <el-table-column prop="stock" label="基础库存" width="100" /><el-table-column prop="cost" label="成本价" width="100" /><el-table-column prop="weight" label="重量" width="90" /><el-table-column prop="volume" label="体积" width="90" /><el-table-column prop="bar_code" label="条码" min-width="120" /><el-table-column prop="code" label="编号" min-width="120" />
        </el-table></div>
      </section>
      <el-button v-if="canManage" type="primary" :loading="saving" :disabled="locked || !selectedCount" @click="confirmSubmit">提交所选商品</el-button>
      <el-dialog v-model="pickerVisible" title="选择基础商品" width="min(1000px, calc(100vw - 24px))" top="5vh" :close-on-click-modal="false" :close-on-press-escape="!applying" :show-close="!applying" @closed="closePicker">
        <div class="filters"><el-input v-model="keyword" aria-label="商品名称或ID" maxlength="100" clearable placeholder="商品名称或ID" @keyup.enter="loadProducts(1)" /><el-select v-model="category" aria-label="商品分类" clearable placeholder="全部分类"><el-option v-for="row in categories" :key="row.id" :value="row.id" :label="row.cate_name" /></el-select><el-select v-model="label" aria-label="商品标签" clearable placeholder="全部标签"><el-option v-for="row in labels" :key="row.id" :value="row.id" :label="row.label_name" /></el-select><el-button :disabled="applying" @click="loadProducts(1)">查询商品</el-button></div>
        <el-alert v-if="pickerError" :title="pickerError" type="error" :closable="false"><template #default><el-button link @click="loadProducts(page)">重读商品列表</el-button></template></el-alert>
        <div class="table-scroll"><el-table :data="options" v-loading="loading" border row-key="id"><el-table-column label="选择" width="66"><template #default="{row}"><el-checkbox :model-value="choices.has(row.id)" :aria-label="`选择商品 ${row.store_name}`" :disabled="applying || !canManage || !row.valid" @change="toggleChoice(row)" /></template></el-table-column><el-table-column prop="id" label="ID" width="75" /><el-table-column label="商品" min-width="180"><template #default="{row}">{{ row.store_name }}<p v-if="!row.valid" class="hint">{{ row.issues.join('；') }}</p></template></el-table-column><el-table-column prop="owner_name" label="所属方" min-width="120" /><el-table-column prop="category_name" label="分类" min-width="120" /><el-table-column prop="stock" label="基础库存" width="100" /><el-table-column prop="price" label="基础价格" width="100" /></el-table></div>
        <el-pagination :current-page="page" :page-size="15" :total="count" :pager-count="5" layout="total, prev, pager, next" :disabled="loading || applying" @current-change="loadProducts" /><p class="hint">已选择 {{ choices.size }} 个商品。翻页后保留选择，取消不会更改草稿。</p>
        <template #footer><el-button :disabled="applying" @click="closePicker">{{ canManage ? '取消选品' : '关闭' }}</el-button><el-button v-if="canManage" type="primary" :loading="applying" :disabled="loading || !!pickerError || !choices.size" @click="applyChoices">应用选品</el-button></template>
      </el-dialog>
    </template>
  </div>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {useRouter} from 'vue-router';
import {ElMessageBox} from 'element-plus';
import axios from 'axios';
import {useAuthStore} from '@/stores/auth';
import {getToken, getAdminSession} from '@/utils/auth';
import {AdminResponseError} from '@/utils/request';
import ImagePicker from './SeckillActivityImagePicker.vue';
import {apiIntegralBatchProducts, apiIntegralBatchProduct, apiIntegralBatchCreate, apiIntegralBatchReceipt, normalizeIntegralBatch, integralBatchMoney, integralBatchImage,
  type IntegralBatchDetail, type IntegralBatchProduct, type IntegralBatchSku, type IntegralBatchInput, type IntegralBatchReceipt, type IntegralBatchPage} from '@/api/integralBatch';
const MAX = 2_147_483_647, router = useRouter(), auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('integral_batch.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('integral_batch.manage')));
const session = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`);
type DraftSku = IntegralBatchSku & {selected: boolean};
type Draft = Omit<IntegralBatchDetail,'skus'> & {skus: DraftSku[]};
type Pending = {input: IntegralBatchInput & {request_id: string}; fingerprint: string};
const picked = ref<Draft[]>([]), isShow = ref<0|1>(0), error = ref(''), saving = ref(false), confirming = ref(false), readingReceipt = ref(false), pending = ref<Pending|null>(null), retryReady = ref(false), receipt = ref<IntegralBatchReceipt|null>(null);
const locked = computed(() => saving.value || confirming.value || !!pending.value);
const selectedCount = computed(() => picked.value.reduce((sum,row) => sum + row.skus.filter(sku => sku.selected).length,0));
const bulk = ref({integral:0,price:'0.00',quota:1});
const pickerVisible = ref(false), applying = ref(false), loading = ref(false), pickerError = ref(''), keyword = ref(''), category = ref<number|''>(''), label = ref<number|''>(''), page = ref(1), count = ref(0), options = ref<IntegralBatchProduct[]>([]), choices = ref(new Map<number,IntegralBatchProduct>());
const categories = ref<IntegralBatchPage['categories']>([]), labels = ref<IntegralBatchPage['labels']>([]);
let alive = false, epoch = 0, listSerial = 0, pickerSerial = 0, syncing = false;
let listAbort:AbortController|null=null, detailAbort:AbortController|null=null, mutationAbort:AbortController|null=null, receiptAbort:AbortController|null=null;
type Stamp = {epoch:number; session:string; stored:string|null};
const stamp = ():Stamp => ({epoch,session:session.value,stored:localStorage.getItem('admin_session')});
const current = (value:Stamp) => alive && canView.value && value.epoch === epoch && value.session === session.value && value.stored === localStorage.getItem('admin_session') && auth.token === getToken();
const image = integralBatchImage;
const message = (reason:unknown) => reason instanceof Error ? reason.message : '操作失败';
const pendingKey = () => `admin_integral_batch_pending:${auth.userInfo?.id}`;
function closePicker() { pickerSerial++; listSerial++; listAbort?.abort(); detailAbort?.abort(); listAbort=detailAbort=null; pickerVisible.value=applying.value=loading.value=false; options.value=[]; choices.value=new Map(); pickerError.value=''; }
function remove(id:number) { if (!locked.value && canManage.value) picked.value=picked.value.filter(row=>row.product.id!==id); }
function selectAll(entry:Draft) { if (!locked.value && canManage.value && entry.product.valid) entry.skus.forEach(sku=>{sku.selected=sku.stock>0&&sku.valid;}); }
function chooseImage(row:DraftSku,reference:string,preview:string) { if (!locked.value && canManage.value) {row.image=reference;row.image_preview=preview;} }
function applyBulk() {
  if (locked.value || !canManage.value) return;
  try { const price=integralBatchMoney(bulk.value.price), rows=picked.value.flatMap(row=>row.skus.filter(sku=>sku.selected));
    if (price==='0.00' && bulk.value.integral===0) throw Error('兑换积分和现金价格不能同时为0');
    if (!rows.length || !Number.isSafeInteger(bulk.value.integral) || bulk.value.integral<0 || bulk.value.integral>MAX || !Number.isSafeInteger(bulk.value.quota) || bulk.value.quota<1 || rows.some(sku=>bulk.value.quota>sku.stock)) throw Error('请勾选规格；积分须为非负整数，兑换次数须大于0且不超过每个规格库存');
    rows.forEach(row=>{row.price=price;row.integral=bulk.value.integral;row.quota=bulk.value.quota;}); error.value='';
  } catch(reason) {error.value=message(reason);}
}
function openPicker() { if (!canView.value || locked.value) return; closePicker(); choices.value=new Map(picked.value.map(row=>[row.product.id,row.product])); keyword.value='';category.value=label.value='';pickerVisible.value=true; void loadProducts(1); }
function toggleChoice(row:IntegralBatchProduct) { if (!canManage.value || applying.value || !pickerVisible.value || !row.valid) return; const next=new Map(choices.value); if (next.has(row.id)) next.delete(row.id); else if (next.size<100) next.set(row.id,row); else {pickerError.value='一批最多100个商品';return;} choices.value=next; }
async function loadProducts(target=page.value) {
  if (!canView.value || !pickerVisible.value || applying.value || !Number.isSafeInteger(target) || target<1 || target>667) return;
  listAbort?.abort(); const controller=new AbortController(), value=stamp(), serial=++listSerial; listAbort=controller;loading.value=true;pickerError.value='';options.value=[];page.value=target;
  try {const result=await apiIntegralBatchProducts({page:target,limit:15,keyword:keyword.value.trim(),category_id:category.value,label_id:label.value},controller.signal);
    if (!current(value) || serial!==listSerial || !pickerVisible.value) return; options.value=result.list;count.value=result.count;categories.value=result.categories;labels.value=result.labels;
  } catch(reason) {if(current(value)&&serial===listSerial&&pickerVisible.value) pickerError.value=message(reason);}
  finally {if(listAbort===controller)listAbort=null;if(current(value)&&serial===listSerial)loading.value=false;}
}
async function applyChoices() {
  if (!canManage.value || locked.value || applying.value || loading.value || !pickerVisible.value) return;
  const value=stamp(), serial=++pickerSerial, controller=new AbortController(); detailAbort=controller;applying.value=true;pickerError.value='';
  try {const next:Draft[]=[];
    for(const product of choices.value.values()) {const existing=picked.value.find(row=>row.product.id===product.id);if(existing)next.push(existing);else {const detail=await apiIntegralBatchProduct(product.id,controller.signal);if(!current(value)||serial!==pickerSerial)return;next.push({...detail,skus:detail.skus.map(sku=>({...sku,selected:false}))});}}
    if(next.reduce((sum,row)=>sum+row.skus.length,0)>1000)throw Error('一批最多1000个规格，请减少商品');
    if(!current(value)||serial!==pickerSerial||!canManage.value)return;picked.value=next;receipt.value=null;closePicker();
  }catch(reason){if(current(value)&&serial===pickerSerial)pickerError.value=message(reason);}
  finally{if(detailAbort===controller)detailAbort=null;if(current(value)&&serial===pickerSerial)applying.value=false;}
}
function input():IntegralBatchInput {
  const products=picked.value.map(row=>({product_id:row.product.id,revision:row.revision,skus:row.skus.filter(sku=>sku.selected).map(sku=>({base_unique:sku.base_unique,price:sku.price,integral:sku.integral,quota:sku.quota,image:sku.image}))})).filter(row=>row.skus.length);
  for(const entry of picked.value){const selected=entry.skus.filter(sku=>sku.selected);if(selected.some(sku=>sku.quota>sku.stock)||selected.reduce((sum,sku)=>sum+sku.quota,0)>entry.product.stock)throw Error(`${entry.product.store_name} 的兑换次数超过基础库存`);}
  return normalizeIntegralBatch({is_show:isShow.value,products});
}
async function fingerprint(input:IntegralBatchInput) {const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(normalizeIntegralBatch(input))));return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
function assertReceipt(value:IntegralBatchReceipt,frozen:Pending) {const expected=frozen.input.products.map(row=>row.product_id).sort((a,b)=>a-b), actual=value.products.map(row=>row.product_id).sort((a,b)=>a-b);if(value.payload_hash!==frozen.fingerprint||value.is_show!==frozen.input.is_show||JSON.stringify(expected)!==JSON.stringify(actual))throw Error('回执与原批次不一致，请继续核对结果');}
function accept(value:IntegralBatchReceipt,frozen:Pending) {assertReceipt(value,frozen);sessionStorage.removeItem(pendingKey());pending.value=null;retryReady.value=false;receipt.value=value;picked.value=[];error.value='';}
function notFound(reason:unknown) {return reason instanceof AdminResponseError&&reason.status===404||axios.isAxiosError(reason)&&reason.response?.status===404;}
function rejected(reason:unknown) {return reason instanceof AdminResponseError&&[400,404,409,422].includes(Number(reason.status))||axios.isAxiosError(reason)&&[400,404,409,422].includes(reason.response?.status??0);}
async function confirmSubmit() {
  if(!canManage.value||locked.value)return;const value=stamp();confirming.value=true;error.value='';
  try {const body=input(), hash=await fingerprint(body);await ElMessageBox.confirm(`将新建 ${body.products.length} 个积分商品，共 ${body.products.reduce((sum,row)=>sum+row.skus.length,0)} 个规格，${body.is_show?'立即上架':'保持下架'}。确认提交？`,'确认批量添加',{type:'warning',confirmButtonText:'确认添加',cancelButtonText:'取消'});
    if(!current(value)||!canManage.value)return;const frozen:Pending={input:{...body,request_id:crypto.randomUUID()},fingerprint:hash};sessionStorage.setItem(pendingKey(),JSON.stringify(frozen));pending.value=frozen;retryReady.value=true;
  }catch(reason){if(current(value)&&reason!=='cancel'&&reason!=='close')error.value=message(reason);}
  finally{if(current(value))confirming.value=false;}
  if(current(value)&&pending.value&&retryReady.value)await submitFrozen();
}
async function submitFrozen() {
  if(!canManage.value||saving.value||readingReceipt.value||!pending.value||!retryReady.value)return;const frozen=pending.value,value=stamp(),controller=new AbortController();mutationAbort=controller;saving.value=true;retryReady.value=false;error.value='';
  try {const result=await apiIntegralBatchCreate(frozen.input,controller.signal);if(current(value)&&canManage.value)accept(result,frozen);}
  catch(reason){if(current(value)){if(rejected(reason)){sessionStorage.removeItem(pendingKey());pending.value=null;error.value=message(reason);}else error.value='提交结果尚未确认，请读取提交结果后继续；此时不能发起新的批次。';}}
  finally{if(mutationAbort===controller)mutationAbort=null;if(current(value))saving.value=false;}
}
async function readReceipt() {
  if(!canView.value||saving.value||readingReceipt.value||!pending.value||!pending.value.input.request_id)return;const frozen=pending.value,value=stamp(),controller=new AbortController();receiptAbort=controller;readingReceipt.value=true;error.value='';retryReady.value=false;
  try{const result=await apiIntegralBatchReceipt(frozen.input.request_id,controller.signal);if(current(value))accept(result,frozen);}
  catch(reason){if(current(value)){if(notFound(reason)){retryReady.value=true;error.value='尚未发现提交记录，可重新提交原批次；请求内容与标识保持原样。';}else error.value=message(reason);}}
  finally{if(receiptAbort===controller)receiptAbort=null;if(current(value))readingReceipt.value=false;}
}
async function restore() {const raw=sessionStorage.getItem(pendingKey());if(!raw||!canView.value)return;const value=stamp();try{if(raw.length>1_048_576)throw Error();const saved=JSON.parse(raw) as Pending,body=normalizeIntegralBatch(saved.input);if(!/^[a-f0-9-]{36}$/iu.test(saved.input.request_id)||await fingerprint(body)!==saved.fingerprint)throw Error();if(current(value))pending.value={input:{...body,request_id:saved.input.request_id},fingerprint:saved.fingerprint};}catch{if(current(value)){error.value='未完成请求记录损坏，请先核对操作结果。';pending.value={input:{request_id:'',is_show:0,products:[]},fingerprint:''};}}}
function invalidate(){epoch++;closePicker();mutationAbort?.abort();receiptAbort?.abort();mutationAbort=receiptAbort=null;picked.value=[];pending.value=receipt.value=null;saving.value=confirming.value=readingReceipt.value=retryReady.value=false;error.value='';isShow.value=0;void restore();}
function syncStored(event?:Event){if(syncing||event instanceof StorageEvent&&event.key!==null&&!['admin_token','admin_session'].includes(event.key))return;syncing=true;const stored=getAdminSession(),token=getToken()??'';auth.$patch({token,userInfo:stored?.userInfo??null,uniqueAuth:stored?.uniqueAuth??[],menus:(stored?.menus as typeof auth.menus)??[]});syncing=false;invalidate();}
watch(session,()=>{if(alive&&!syncing)invalidate();},{flush:'sync'});
onMounted(()=>{alive=true;window.addEventListener('storage',syncStored);window.addEventListener('admin-session-changed',syncStored);window.addEventListener('admin-auth-expired',syncStored);void restore();});
onBeforeUnmount(()=>{alive=false;epoch++;closePicker();mutationAbort?.abort();receiptAbort?.abort();window.removeEventListener('storage',syncStored);window.removeEventListener('admin-session-changed',syncStored);window.removeEventListener('admin-auth-expired',syncStored);});
</script>

<style scoped>
.integral-batch{display:grid;gap:18px;min-width:0}.heading,.product-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.heading h2,.product-heading h3{margin:0 0 8px}.heading p,.hint{font-size:13px;color:var(--el-text-color-secondary);line-height:1.6;margin:6px 0}.toolbar,.buttons,.batch-settings,.filters{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.toolbar>span{flex:1}.batch-settings{border:1px solid var(--el-border-color);border-radius:6px;padding:16px;margin:0;min-width:0}.batch-settings label{display:grid;gap:8px;width:170px}.batch-settings .el-input-number{width:100%}.product-card{border:1px solid var(--el-border-color);border-radius:6px;padding:16px;min-width:0}.product-heading{margin-bottom:14px}.table-scroll{overflow-x:auto;max-width:100%}.table-scroll>.el-table{min-width:920px}.sku-image{width:48px;height:48px;margin-bottom:8px}.filters{margin-bottom:16px}.filters>.el-input{flex:1;min-width:160px}.filters>.el-select{width:180px}.el-pagination{margin-top:16px;max-width:100%;flex-wrap:wrap}.el-alert p{margin:6px 0}.el-table .hint{overflow-wrap:anywhere}
@media(max-width:600px){.heading,.product-heading{align-items:flex-start;flex-direction:column}.toolbar{align-items:flex-start}.toolbar>span{flex-basis:100%}.batch-settings label{width:100%}.filters>.el-select{width:100%}.filters>.el-input{flex-basis:100%}.product-card{padding:12px}.buttons{gap:8px}.buttons .el-button+.el-button{margin-left:0}}
</style>
