<template>
  <section class="purchased-label-tasks" aria-label="购买标签任务">
    <el-alert title="购买标签在付款后独立处理" description="任务执行时读取商品及套餐的当前标签配置，按标签自身归属追加缺失关系。修复归属或配置后，可维护重放原任务。" type="info" :closable="false" show-icon />
    <el-alert v-if="!canRead" title="当前账号没有任务查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" show-icon />
      <el-alert v-if="state.notice" :title="state.notice" type="success" :closable="false" show-icon />
      <el-card v-if="recovery && !state.modal" shadow="never"><div class="label-task-header"><span>本账号有一项维护操作待核对</span><el-button @click="restore">继续原任务核对</el-button></div></el-card>
      <el-card shadow="never">
        <template #header><div class="label-task-header"><div><strong>购买标签任务</strong><p>本页 {{ state.items.length }} 项 · 已停止 {{ stopped }} · 已有回执 {{ completed }}</p><p v-if="state.observedAt">读取于 {{ time(state.observedAt) }}</p></div>
          <el-button :loading="state.loading" @click="load">刷新任务</el-button></div></template>
        <form class="label-task-filters" @submit.prevent="query">
          <label>任务状态<select v-model="state.status" aria-label="购买标签任务状态" :disabled="state.loading" @change="query"><option value="">全部状态</option><option v-for="s in statuses" :key="s" :value="s">{{ statusLabel(s) }}</option></select></label>
          <label class="task-id-filter">任务编号<input v-model="state.taskId" aria-label="购买标签任务编号" placeholder="输入完整任务 UUID" autocomplete="off" spellcheck="false" :disabled="state.loading" /></label>
          <el-button native-type="submit" :disabled="state.loading">查询任务</el-button>
        </form>
        <div v-if="!state.loading && !state.error && !state.items.length" class="label-task-empty" role="status">当前条件下没有购买标签任务</div>
        <div v-loading="state.loading" class="label-task-rows">
          <article v-for="row in state.items" :key="row.taskId" class="label-task-row" :aria-label="'购买标签任务 '+row.taskId">
            <div class="label-task-identity"><strong>订单 #{{ row.orderId }} · 用户 #{{ row.userId }}</strong><code>{{ row.taskId }}</code><span>{{ time(row.createdAt) }}</span></div>
            <div class="label-task-state"><el-tag :type="row.recovery==='receipt'?'success':row.status==='DEAD'?'danger':row.status==='FAILED'?'warning':'info'">{{ statusLabel(row.status) }}</el-tag>
              <span>{{ recoveryLabel(row.recovery) }}</span><span v-if="row.receiptCompletedAt">回执 {{ time(row.receiptCompletedAt) }}</span></div>
            <div class="label-task-counts"><span>处理 {{ row.attemptCount }} · 派发 {{ row.dispatchCount }}</span><span>维护重放 {{ row.replayCount }} / 20</span><p v-if="row.lastError" class="label-task-error">{{ row.lastError }}</p></div>
            <div class="label-task-action"><el-button v-if="canManage && row.recovery==='eligible'" type="primary" plain :disabled="state.loading || !!state.modal" @click="open(row)">维护重放</el-button>
              <span v-else>{{ !canManage && row.recovery==='eligible' ? '仅查看' : recoveryLabel(row.recovery) }}</span></div>
          </article>
        </div>
        <div class="label-task-pager"><span>第 {{ state.history.length+1 }} 页</span><el-button :disabled="state.loading || !state.history.length" @click="previous">上一页</el-button><el-button :disabled="state.loading || state.next===null" @click="next">下一页</el-button></div>
      </el-card>
    </template>
    <el-dialog v-if="state.modal" :model-value="true" title="维护重放购买标签任务" width="min(640px, calc(100vw - 24px))" :close-on-click-modal="false" :close-on-press-escape="!state.modal.busy" :show-close="!state.modal.busy" @close="close">
      <div class="label-task-dialog">
        <p>订单 #{{ state.modal.row.orderId }} · 用户 #{{ state.modal.row.userId }}</p><code>{{ state.modal.row.taskId }}</code>
        <p>原任务按当前配置追加缺失标签，已有关系保留；已完成任务保留原回执。</p>
        <label>维护原因<textarea v-model="state.modal.reason" aria-label="购买标签维护原因" rows="3" :disabled="state.modal.phase!=='review' || state.modal.busy" placeholder="说明已完成的归属或配置维护" /></label>
        <span class="label-task-counter">{{ Array.from(state.modal.reason.trim()).length }} / 100 字符</span>
        <el-alert v-if="state.modal.error" :title="state.modal.error" type="error" :closable="false" show-icon />
        <el-alert v-if="state.modal.notice" :title="state.modal.notice" :type="state.modal.phase==='uncertain'?'warning':'info'" :closable="false" show-icon />
        <p v-if="state.modal.phase!=='review'">当前任务：{{ statusLabel(state.modal.row.status) }} · 维护重放 {{ state.modal.row.replayCount }} 次</p>
      </div>
      <template #footer><el-button :disabled="state.modal.busy" @click="close">{{ state.modal.phase==='review'?'取消':'关闭' }}</el-button>
        <el-button v-if="state.modal.phase==='review'" type="primary" :disabled="!canManage || state.modal.busy" @click="submit">确认维护重放</el-button>
        <el-button v-else :loading="state.modal.busy" :disabled="state.modal.phase==='sending'" @click="lookup">读取原任务状态</el-button></template>
    </el-dialog>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { usePurchasedLabelTasks } from '@/composables/usePurchasedLabelTasks';
import { purchasedLabelTaskStatuses as statuses, type PurchasedLabelTaskStatus, type PurchasedLabelRecovery } from '../../../../common/purchasedProductLabelTasks';
const {state,canRead,canManage,recovery,restore,load,query,next,previous,open,close,submit,lookup}=usePurchasedLabelTasks();
const stopped=computed(()=>state.items.filter(r=>r.status==='DEAD').length),completed=computed(()=>state.items.filter(r=>r.receiptCompletedAt!==null).length);
const statusLabel=(s:PurchasedLabelTaskStatus)=>({PENDING:'待处理',ENQUEUING:'派发中',ENQUEUED:'已入队',PROCESSING:'处理中',FAILED:'等待重试',DEAD:'已停止',COMPLETED:'已完成'})[s];
const recoveryLabel=(s:PurchasedLabelRecovery)=>({eligible:'可维护重放',receipt:'保留原回执',automatic:'等待自动处理',active:'正在处理，请稍后刷新',limit:'达到维护重放上限',maintenance:'完成状态缺少回执，请维护核对'})[s];
const time=(n:number)=>n?new Date(n*1000).toLocaleString('zh-CN',{hour12:false}):'—';
</script>
<style scoped>
.purchased-label-tasks{display:grid;gap:16px}.label-task-header{display:flex;justify-content:space-between;align-items:center;gap:16px}.label-task-header p{margin:6px 0 0;color:#64748b;font-size:13px}.label-task-filters{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin-bottom:18px}.label-task-filters label,.label-task-dialog label{display:grid;gap:7px;color:#475569;font-size:13px}.label-task-filters select,.label-task-filters input,.label-task-dialog textarea{box-sizing:border-box;font:inherit;padding:8px 10px;border:1px solid #cbd5e1;border-radius:4px;color:#172b4d;background:white}.label-task-filters select{min-width:140px}.task-id-filter{flex:1;min-width:220px}.label-task-rows{display:grid}.label-task-row{display:grid;grid-template-columns:minmax(230px,1.3fr) minmax(170px,1fr) minmax(200px,1fr) 130px;gap:18px;padding:20px 0;border-top:1px solid #e2e8f0}.label-task-identity,.label-task-state,.label-task-counts{display:flex;flex-direction:column;align-items:flex-start;gap:7px;min-width:0}.label-task-identity code,.label-task-dialog code{font-family:ui-monospace,monospace;font-size:12px;overflow-wrap:anywhere;color:#475569}.label-task-identity span,.label-task-state span:not(.el-tag),.label-task-counts,.label-task-action{color:#64748b;font-size:12px}.label-task-error{margin:0;color:#b91c1c;overflow-wrap:anywhere;line-height:1.6}.label-task-pager{display:flex;justify-content:flex-end;gap:10px;align-items:center;margin-top:16px;font-size:13px;color:#64748b}.label-task-empty{padding:30px;text-align:center;color:#64748b}.label-task-dialog{display:grid;gap:12px}.label-task-dialog p{margin:0;line-height:1.6}.label-task-dialog textarea{width:100%;resize:vertical}.label-task-counter{font-size:12px;color:#64748b;text-align:right}
@media(max-width:1100px){.label-task-row{grid-template-columns:1.2fr 1fr}.label-task-action{align-self:end}}@media(max-width:767px){.label-task-header{align-items:flex-start}.label-task-filters{align-items:stretch}.label-task-filters label{width:100%}.task-id-filter{flex:none;min-width:0}.label-task-filters input,.label-task-filters select{width:100%;min-width:0}.label-task-filters .el-button{width:100%;margin-left:0}.label-task-row{grid-template-columns:minmax(0,1fr);gap:12px}.label-task-identity strong{overflow-wrap:anywhere}.label-task-pager{justify-content:space-between}.label-task-action .el-button{width:100%}}
</style>
