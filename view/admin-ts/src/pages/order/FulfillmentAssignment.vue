<template>
  <div class="assignment-page">
    <div class="page-head">
      <div><h2>门店履约分配</h2><p>分配门店负责发货，订单的财务归属仍为平台。</p></div>
      <div class="head-actions">
        <el-button :disabled="!sessionValid || loading || busy" @click="load">重新读取</el-button>
        <el-button @click="$router.push('/order')">返回订单</el-button>
      </div>
    </div>
    <el-alert v-if="!sessionValid" title="登录状态已变化，请重新打开页面。原请求仍保留在原账号下。" type="warning" :closable="false" />
    <template v-else>
      <el-card v-if="!orderId" shadow="never" class="section">
        <p>请从订单详情打开本页，核对订单后选择履约门店。</p>
        <p v-if="pendingOrders.length">本机还有以下分配请求需要核对：</p>
        <div class="recovery-links">
          <el-button v-for="id in pendingOrders" :key="id" @click="openOrder(id)">恢复订单 {{ id }} 的原请求</el-button>
        </div>
      </el-card>
      <el-alert v-if="journalError" :title="journalError" type="error" :closable="false" class="section" />
      <el-card v-if="intent" shadow="never" class="section" aria-label="原分配请求">
        <template #header>原分配请求{{ intent.phase === 'recorded' ? '已记录' : '待确认' }}</template>
        <p>{{ intent.input.kind === 'grant' ? '批准履约门店' : '撤销履约批准' }}：{{ storeLabel(intent.input.target_store_id) }}</p>
        <p class="request-id">原操作编号：{{ intent.input.operation_id }}</p>
        <template v-if="intent.phase === 'pending'">
          <el-alert title="尚未确认结果。请查询原回执，或使用原编号和原内容恢复；不要另建请求。" type="warning" :closable="false" />
          <div class="panel-actions">
            <el-button :loading="busy" :disabled="loading || !!journalError" @click="recover(false)">查询原回执</el-button>
            <el-button v-if="canManage" :loading="busy" :disabled="loading || !!journalError" @click="recover(true)">同键恢复原请求</el-button>
          </div>
        </template>
        <p v-else>服务器已保存原回执。{{ intent.receipt?.kind === 'grant' ? '批准已记录。' : '撤销已记录；已完成的发货不会倒退。' }}</p>
      </el-card>
      <el-alert v-if="message" :title="message" :type="intent?.phase === 'recorded' ? 'success' : 'warning'" :closable="false" class="section" />
      <el-skeleton v-if="loading" :rows="5" animated />
      <el-alert v-if="readError" :title="readError" type="warning" :closable="false" class="section" />
      <el-card v-if="review" shadow="never" class="section">
        <template #header>{{ review.grant?.order_no ? `订单 ${review.grant.order_no}` : '当前分配' }}</template>
        <dl class="facts">
          <div><dt>财务归属</dt><dd>平台</dd></div>
          <div><dt>当前履约门店</dt><dd>{{ review.current_head?.kind === 'grant' ? storeLabel(review.current_head.target_store_id) : '尚无有效门店批准' }}</dd></div>
          <div v-if="review.grant"><dt>本次核对商品</dt><dd>{{ review.grant.source.cart_rows.reduce((n, row) => n + row.quantity, 0) }} 件</dd></div>
        </dl>
        <el-alert v-if="!review.can_append" title="分配历史已达到核对容量，请保留原回执并联系维护人员。" type="warning" :closable="false" />
        <el-alert v-else-if="!review.grant" :title="review.grant_reason || '此订单当前不能新增履约批准。'" type="info" :closable="false" />
        <template v-if="canManage">
          <div v-if="review.grant && review.can_append" class="selection">
            <label for="fulfillment-store">履约门店</label>
            <el-select id="fulfillment-store" v-model="target" placeholder="请选择有效门店" :disabled="busy || unresolved || !!journalError" filterable>
              <el-option v-for="store in stores" :key="store.id" :label="store.name" :value="store.id" />
            </el-select>
            <el-button v-if="nextAfter !== null" :loading="storesLoading" :disabled="busy || unresolved" @click="moreStores">加载更多门店</el-button>
          </div>
          <el-alert v-if="storeError" :title="storeError" type="warning" :closable="false" />
          <div class="panel-actions">
            <el-button v-if="review.grant && review.can_append" type="primary" :loading="busy"
              :disabled="!target || unresolved || !!journalError || sameTarget" @click="decide('grant')">
              {{ review.current_head?.kind === 'grant' ? '确认改派门店' : '确认批准门店' }}
            </el-button>
            <el-button v-if="review.revoke && review.can_append" type="danger" plain :loading="busy"
              :disabled="unresolved || !!journalError" @click="decide('revoke')">撤销当前批准</el-button>
          </div>
          <p class="hint">读取结果供本次核对，提交时仍会重新检查订单、门店和当前批准。</p>
        </template>
        <p v-else>当前账号只能核对分配，不能批准、改派或撤销。原请求可在上方查询。</p>
      </el-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { getAdminSession } from '@/utils/auth';
import { createAdminSessionScope } from '@/utils/adminSessionScope';
import { assignmentReview, assignmentStores, assignmentCommit, assignmentReceipt } from '@/api/fulfillmentAssignment';
import { assignmentIntentKey, assignmentIntentOrders, makeAssignmentIntent, readAssignmentIntent, writeAssignmentIntent,
  withAssignmentIntentLock, type AssignmentIntent } from '@/utils/fulfillmentAssignmentIntent';
import { makeAdminAssignment, type AdminAssignmentReceipt, type AdminAssignmentReview } from '../../../../common/fulfillmentAssignment';

const route = useRoute(), router = useRouter(), session = getAdminSession();
const actor = session?.userInfo.id ?? 0, sessionValid = ref(true);
const permitted = (permission: string) => sessionValid.value && Boolean(session && (session.userInfo.level === 0 || session.uniqueAuth.includes(permission)));
const canManage = computed(() => permitted('order.manage'));
const orderId = computed(() => typeof route.query.order_id === 'string' && /^[1-9][0-9]{0,9}$/u.test(route.query.order_id)
  && Number(route.query.order_id) <= 2147483647 ? Number(route.query.order_id) : 0);
const review = ref<AdminAssignmentReview | null>(null), intent = ref<AssignmentIntent | null>(null), raw = ref<string | null>(null);
const stores = ref<Array<{ id: number; name: string }>>([]), target = ref<number | null>(null), nextAfter = ref<number | null>(null);
const loading = ref(false), busy = ref(false), storesLoading = ref(false), readError = ref(''), journalError = ref(''), storeError = ref(''), message = ref('');
const pendingOrders = ref<number[]>([]), unresolved = computed(() => intent.value?.phase === 'pending');
const sameTarget = computed(() => review.value?.current_head?.kind === 'grant' && review.value.current_head.target_store_id === target.value);
let epoch = 0, controller: AbortController | undefined;
const scope = createAdminSessionScope(() => { sessionValid.value = false; reset(); });
const current = (generation: number, order: number) => scope.isCurrent() && epoch === generation && orderId.value === order;
const errorText = (error: unknown) => error instanceof Error ? error.message : '暂时无法完成核对，请保留原请求';
function reset() {
  epoch++; controller?.abort(); controller = undefined; review.value = null; stores.value = []; target.value = null; nextAfter.value = null;
  intent.value = null; raw.value = null; pendingOrders.value = []; loading.value = busy.value = storesLoading.value = false;
  readError.value = journalError.value = storeError.value = message.value = '';
}
function storeLabel(id: number) { return stores.value.find(s => s.id === id)?.name || '门店 ' + id; }
function openOrder(id: number) { void router.push({ path: '/order/fulfillment-assignment', query: { order_id: String(id) } }); }
async function load() {
  if (!scope.isCurrent()) return; reset(); const id = orderId.value, generation = epoch;
  controller = new AbortController(); const signal = controller.signal; loading.value = true;
  try {
    if (!Number.isSafeInteger(actor) || actor < 1) throw Error('当前管理员身份不完整，请重新登录');
    if (!id) {
      const list = await assignmentIntentOrders(actor); if (current(generation, id)) pendingOrders.value = list;
      return;
    }
    try {
      const saved = await readAssignmentIntent(actor, id); if (!current(generation, id)) return;
      raw.value = saved.raw; intent.value = saved.intent;
    } catch (error) { if (current(generation, id)) journalError.value = errorText(error); }
    if (!current(generation, id)) return;
    if (!permitted('order.view')) { readError.value = '当前账号无订单读取权限。已保存的原请求仍可查询回执。'; return; }
    try {
      const result = await assignmentReview(id, signal); if (!current(generation, id)) return; review.value = result;
    } catch (error) { if (current(generation, id)) readError.value = errorText(error); }
    if (current(generation, id) && canManage.value && review.value) {
      try { const page = await assignmentStores(0, signal); if (current(generation, id)) { stores.value = page.list; nextAfter.value = page.next_after; } }
      catch (error) { if (current(generation, id)) storeError.value = errorText(error); }
    }
  } catch (error) { if (current(generation, id)) journalError.value = errorText(error); }
  finally { if (current(generation, id)) loading.value = false; }
}
async function moreStores() {
  const after = nextAfter.value, id = orderId.value, generation = epoch;
  if (after === null || !current(generation, id) || storesLoading.value || busy.value) return;
  storesLoading.value = true; storeError.value = '';
  try {
    const page = await assignmentStores(after, controller?.signal); if (!current(generation, id)) return;
    if (stores.value.some(s => page.list.some(t => t.id === s.id)) || stores.value.at(-1)?.id !== after) throw Error('门店分页已变化，请重新读取');
    stores.value = [...stores.value, ...page.list]; nextAfter.value = page.next_after;
  } catch (error) { if (current(generation, id)) storeError.value = errorText(error); }
  finally { if (current(generation, id)) storesLoading.value = false; }
}
async function completed(saved: AssignmentIntent, expectedRaw: string, receipt: AdminAssignmentReceipt, generation: number, id: number) {
  if (!current(generation, id)) return;
  const next: AssignmentIntent = { ...saved, phase: 'recorded', receipt }, written = await writeAssignmentIntent(next, expectedRaw, () => current(generation, id));
  if (!current(generation, id)) return;
  intent.value = next; raw.value = written; review.value = null; target.value = null;
  message.value = '原请求已取得服务器回执。请重新读取当前分配后继续。';
}
async function decide(kind: 'grant' | 'revoke') {
  const reviewed = review.value, id = orderId.value, generation = epoch;
  if (!reviewed || !id || !current(generation, id) || !canManage.value || unresolved.value || journalError.value || busy.value) return;
  const store = kind === 'revoke' ? reviewed.revoke?.target_store_id : target.value;
  if (!store || !reviewed.can_append || kind === 'grant' && (sameTarget.value || !stores.value.some(row => row.id === store))
    || kind === 'revoke' && !reviewed.revoke) return;
  busy.value = true; message.value = '';
  try {
    const input = makeAdminAssignment(reviewed, kind, store);
    await withAssignmentIntentLock(id, async () => {
      const before = await readAssignmentIntent(actor, id); if (!current(generation, id)) return;
      if (before.raw !== raw.value || before.intent?.phase === 'pending') throw Error('本订单已有待核对原请求，请重新读取');
      const confirmed = await ElMessageBox.confirm(kind === 'revoke'
        ? '撤销当前门店的履约批准。已完成的发货不会倒退。确认撤销？'
        : `确认由“${storeLabel(store)}”负责本订单整单快递？订单财务归属仍为平台。`, kind === 'revoke' ? '确认撤销' : '确认履约门店',
      { confirmButtonText: kind === 'revoke' ? '确认撤销' : '确认批准', cancelButtonText: '返回核对', type: 'warning' }).then(() => true, () => false);
      if (!confirmed || !current(generation, id)) return;
      const saved = await makeAssignmentIntent(actor, input); if (!current(generation, id)) return;
      const written = await writeAssignmentIntent(saved, before.raw, () => current(generation, id)); if (!current(generation, id)) return;
      intent.value = saved; raw.value = written;
      if (localStorage.getItem(assignmentIntentKey(actor, id)) !== written) throw Error('原请求记录已变化，尚未确认结果');
      const result = await assignmentCommit(saved.input, actor, controller?.signal);
      await completed(saved, written, result.receipt, generation, id);
    });
  } catch (error) { if (current(generation, id)) { review.value = null; message.value = intent.value?.phase === 'pending'
    ? '原请求结果尚未确认。请查询原回执或同键恢复，不要新建请求。' : errorText(error); } }
  finally { if (current(generation, id)) busy.value = false; }
}
async function recover(restore: boolean) {
  const id = orderId.value, generation = epoch, displayed = intent.value;
  if (!displayed || displayed.phase !== 'pending' || !id || !current(generation, id) || busy.value || journalError.value || restore && !canManage.value) return;
  busy.value = true; message.value = '';
  try {
    await withAssignmentIntentLock(id, async () => {
      const saved = await readAssignmentIntent(actor, id); if (!current(generation, id)) return;
      if (!saved.intent || !saved.raw || saved.raw !== raw.value || saved.intent.phase !== 'pending') throw Error('原请求记录已变化，请重新读取');
      if (restore) {
        const confirmed = await ElMessageBox.confirm('使用原编号和原内容恢复。若已执行，只返回原回执，不新建分配。', '恢复原分配请求',
          { confirmButtonText: '同键恢复', cancelButtonText: '仅返回' }).then(() => true, () => false);
        if (!confirmed || !current(generation, id)) return;
      }
      if (localStorage.getItem(assignmentIntentKey(actor, id)) !== saved.raw) throw Error('原请求记录已变化，请重新读取');
      const receipt = restore ? (await assignmentCommit(saved.intent.input, actor, controller?.signal)).receipt
        : await assignmentReceipt(saved.intent.input, actor, controller?.signal);
      if (!current(generation, id)) return;
      if (!receipt) { message.value = '暂未取得原请求回执，请继续保留原编号和原内容核对；不能据此认定未执行。'; return; }
      await completed(saved.intent, saved.raw, receipt, generation, id);
    });
  } catch (error) { if (current(generation, id)) message.value = errorText(error); }
  finally { if (current(generation, id)) busy.value = false; }
}
function storage(event: StorageEvent) {
  if (event.storageArea === localStorage && (event.key === null || orderId.value && event.key === assignmentIntentKey(actor, orderId.value))) void load();
}
window.addEventListener('storage', storage);
watch(() => route.fullPath, () => { void load(); }, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { reset(); scope.dispose(); window.removeEventListener('storage', storage); });
</script>

<style scoped>
.assignment-page{max-width:960px;margin:0 auto;padding:20px}.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}.page-head h2{margin:0 0 8px}.page-head p,.hint{color:var(--el-text-color-secondary);line-height:1.6;margin:0}.head-actions,.panel-actions,.recovery-links{display:flex;gap:10px;flex-wrap:wrap}.section{margin-bottom:16px}.panel-actions{margin-top:18px}.facts{margin:0 0 20px}.facts>div{display:flex;gap:24px;padding:9px 0}.facts dt{color:var(--el-text-color-secondary);min-width:100px}.facts dd{margin:0}.selection{display:flex;align-items:center;gap:12px;margin:20px 0}.selection .el-select{width:300px;max-width:100%}.hint{margin-top:16px;font-size:13px}.request-id{overflow-wrap:anywhere;font-size:13px;color:var(--el-text-color-secondary)}.recovery-links{margin-top:16px}
@media(max-width:640px){.assignment-page{padding:12px}.page-head{flex-direction:column}.selection{align-items:stretch;flex-direction:column}.selection .el-select{width:100%}.facts>div{gap:12px}.head-actions{width:100%}.panel-actions>.el-button{margin-left:0;min-height:40px}.recovery-links>.el-button{margin-left:0;white-space:normal;height:auto;min-height:40px}}
</style>
