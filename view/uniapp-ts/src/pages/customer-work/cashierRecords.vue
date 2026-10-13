<template>
  <CustomerWorkShell title="本人次卡收银记录" :manager="manager" :domain-busy="paging" active="cashierRecords">
    <view class="cw-card">
      <text class="cw-scope">仅查询由当前经营账号实际创建的次卡订单，包含未付款订单。游客购买人和经营创建人分别显示。</text>
      <text class="cw-form-field">完整订单编号<input v-model="keyword" aria-label="完整次卡收银订单编号" :maxlength="32" placeholder="输入完整订单号精确查询" @confirm="search" /></text>
      <view class="cw-controls"><button :disabled="manager.loading.value || paging" @tap="search">查询订单</button><button :disabled="manager.loading.value || paging" @tap="recent">返回最近记录</button></view>
      <text v-if="applied" class="cw-scope">精确查询：{{ applied }}</text>
      <text v-if="searchError" class="cw-error" role="alert">{{ searchError }}</text>
    </view>
    <view v-if="!rows.length" class="cw-empty">当前查询没有本人次卡收银记录</view>
    <view v-for="row in rows" :key="row.id" class="cw-card" :data-cashier-record="row.id">
      <view class="cw-row"><text class="cw-subtitle">{{ row.order_no }}</text><text class="cw-status">{{ customerCashierPaymentText(row) }}</text></view>
      <text class="cw-scope">{{ customerWorkDate(row.created_at) }} · {{ row.quantity }} 件 · 当前订单金额 ¥{{ row.amount }}</text>
      <text class="cw-scope">{{ row.buyer_uid === 0 ? '游客购买人' : '购买人 UID ' + row.buyer_uid }} · 创建人 UID {{ row.creator_uid }}</text>
      <text class="cw-scope">{{ row.real_name || '未填写姓名' }} · {{ row.user_phone || '未填写电话' }}</text>
      <text v-if="row.root_retired" class="cw-scope">原购买订单已进入后续退款或拆单代次；凭据保留原购买事实。</text>
      <button class="cw-full" :disabled="paging" @tap="open(row)">核对创建及付款凭据</button>
    </view>
    <button v-if="hasMore" class="cw-full" :disabled="paging" @tap="more">{{ paging ? '读取中…' : '加载更多记录' }}</button>
  </CustomerWorkShell>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import { onReachBottom } from '@dcloudio/uni-app';
import CustomerWorkShell from '@/components/customerWork/CustomerWorkShell.vue';
import { useCustomerWork } from '@/composables/useCustomerWork';
import { useCustomerCashierRead } from '@/composables/useCustomerCashierRead';
import { customerCashierOrderNo, isCustomerCashierRecordList, customerCashierPaymentText } from '@/utils/customerWorkCashierRead';
import { customerWorkDate } from '@/utils/customerWork';
import type { CustomerCashierRecord } from '@/types/customerWorkCashierRead';
const keyword = ref(''), applied = ref(''), searchError = ref(''), rows = ref<CustomerCashierRecord[]>([]), hasMore = ref(false), paging = ref(false);
let cursor: string | null = null, queuedSearch: string | null = null, ownerStamp = '';
const seenCursors = new Set<string>();
const manager = useCustomerWork({ page: 'cashierRecords', clear() {
  reader.clear(); rows.value = []; applied.value = ''; keyword.value = ''; searchError.value = ''; hasMore.value = false; paging.value = false;
  cursor = null; seenCursors.clear();
  const stamp = `${manager.auth.uid}:${manager.auth.sessionVersion}:${manager.auth.token}`;
  if (!manager.current() || stamp !== ownerStamp) queuedSearch = null;
  ownerStamp = stamp;
}, async load(controller) {
  const search = queuedSearch ?? ''; queuedSearch = null;
  const valid = controller.fence();
  const response = await reader.read('records', isCustomerCashierRecordList, { limit: 20, ...(search ? { order_no: search } : {}) });
  if (!valid()) return;
  if (response.data.limit !== 20 || search && response.data.list.some(row => row.order_no !== search)) throw Error('收银记录查询依据不匹配');
  rows.value = response.data.list; applied.value = search;
  cursor = response.data.next_cursor; hasMore.value = response.data.has_more;
} });
const reader = useCustomerCashierRead(manager);
function search() {
  if (manager.loading.value || paging.value || !manager.context.value) return;
  const value = keyword.value.trim();
  if (!customerCashierOrderNo(value)) { searchError.value = '请输入有效的完整次卡收银订单编号'; return; }
  queuedSearch = value; void manager.load();
}
function recent() { if (!manager.loading.value && !paging.value) { queuedSearch = ''; void manager.load(); } }
function open(row: CustomerCashierRecord) {
  if (paging.value || !rows.value.some(current => current.id === row.id && current.order_no === row.order_no)) return;
  manager.go('cashierRecord', { orderId: row.id, orderNo: row.order_no });
}
async function more() {
  if (!manager.current() || !manager.context.value || manager.loading.value || paging.value || !hasMore.value || !cursor) return;
  const valid = manager.fence(), requested = cursor; paging.value = true;
  try {
    const response = await reader.read('records', isCustomerCashierRecordList, { limit: 20, cursor: requested, ...(applied.value ? { order_no: applied.value } : {}) });
    if (!valid()) return;
    if (response.data.limit !== 20 || response.data.list.some(row => rows.value.some(old => old.id === row.id || old.order_no === row.order_no))
      || applied.value && response.data.list.some(row => row.order_no !== applied.value)
      || response.data.next_cursor !== null && (response.data.next_cursor === requested || seenCursors.has(response.data.next_cursor))) throw Error('收银记录分页已变化，请重新读取');
    seenCursors.add(requested); rows.value.push(...response.data.list); cursor = response.data.next_cursor; hasMore.value = response.data.has_more;
  } catch (failure) { if (valid()) manager.invalidate(failure); }
  finally { if (valid()) paging.value = false; }
}
onReachBottom(() => { void more(); });
</script>
