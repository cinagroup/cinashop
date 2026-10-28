<template>
  <div class="withdrawal-page" data-extract-directory>
    <div class="page-heading"><div><h1>提现申请</h1><p>查看提现明细与审核结果</p></div>
      <el-button :disabled="!canView || loading" @click="retry">刷新</el-button>
    </div>
    <el-alert v-if="!canView" title="暂无查看提现申请的权限" type="info" :closable="false" show-icon />
    <template v-else>
      <el-card shadow="never" class="filter-card">
        <el-form inline label-width="88px" @submit.prevent="search">
          <el-form-item label="时间选择：" class="date-field">
            <el-date-picker :model-value="draft.dates" type="datetimerange" value-format="YYYY/MM/DD HH:mm"
              format="YYYY/MM/DD HH:mm" range-separator="至" start-placeholder="开始时间" end-placeholder="结束时间"
              :editable="false" :show-now="false" clearable aria-label="时间选择（上海时间）" @update:model-value="updateDates" />
          </el-form-item>
          <el-form-item label="提现状态："><el-select :model-value="draft.status" clearable placeholder="全部状态" aria-label="提现状态" @update:model-value="updateStatus">
            <el-option label="申请中" value="0" /><el-option label="已通过" value="1" /><el-option label="未通过" value="-1" />
          </el-select></el-form-item>
          <el-form-item label="提现方式："><el-select :model-value="draft.extract_type" clearable placeholder="全部方式" aria-label="提现方式" @update:model-value="updateChannel">
            <el-option label="支付宝" value="alipay" /><el-option label="银行卡" value="bank" /><el-option label="微信" value="weixin" /><el-option label="提现到余额" value="balance" />
          </el-select></el-form-item>
          <el-form-item label="搜索：" class="keyword-field"><el-input v-model="draft.keyword" clearable maxlength="128"
            placeholder="微信昵称 / 姓名 / 支付宝账号 / 银行卡号" aria-label="提现搜索关键词" /></el-form-item>
          <el-form-item class="filter-actions"><el-button type="primary" native-type="submit" :loading="loading">查询</el-button><el-button :disabled="loading" @click="resetFilters">重置</el-button></el-form-item>
        </el-form>
        <div class="time-shortcuts"><span>快捷时间</span><button v-for="item in shortcuts" :key="item.value" type="button" :disabled="loading" @click="setShortcut(item.value)">{{ item.label }}</button><span class="time-zone">上海时间</span></div>
      </el-card>

      <div class="statistics" aria-label="提现统计">
        <div v-for="item in cards" :key="item.key" class="stat-card"><span class="stat-symbol" :class="item.key" aria-hidden="true">¥</span>
          <div><div class="stat-name">{{ item.label }}</div><strong :title="report ? report.statistics[item.key] : ''">{{ report ? '¥'+report.statistics[item.key] : '—' }}</strong></div>
        </div>
      </div>

      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="read-error"><template #default><el-button link type="primary" :disabled="loading" @click="retry">重新读取</el-button></template></el-alert>
      <el-card shadow="never" class="table-card">
        <div class="table-heading"><div><h2>申请记录</h2><p v-if="accepted">{{ acceptedCaption }}</p><p v-else>选择条件后查询提现申请</p></div><span v-if="dirty" class="draft-notice">筛选条件尚未应用</span></div>
        <div class="table-scroll"><el-table :data="list" v-loading="loading" row-key="id" :empty-text="loading ? '正在读取…' : '暂无提现记录'" data-extract-table>
          <el-table-column prop="id" label="ID" width="88" />
          <el-table-column label="用户信息" min-width="178"><template #default="{ row }"><div class="user-name">{{ row.nickname || row.account || '未命名用户' }}</div><div class="secondary">用户 ID：{{ row.uid }}</div></template></el-table-column>
          <el-table-column label="提现到账金额" min-width="150"><template #default="{ row }"><strong class="amount">¥{{ row.net_amount }}</strong><div class="secondary">申请金额 ¥{{ row.gross_amount }}</div></template></el-table-column>
          <el-table-column label="手续费" min-width="106"><template #default="{ row }">¥{{ row.fee_amount }}</template></el-table-column>
          <el-table-column label="提现方式" min-width="242"><template #default="{ row }"><div class="channel-title">{{ channel(row.extract_type) }}</div>
            <div v-if="row.real_name" class="recipient-line">姓名：{{ row.real_name }}</div>
            <template v-if="row.extract_type === 'bank'"><div v-if="row.bank_name" class="recipient-line">银行：{{ row.bank_name }}</div><div class="recipient-line">银行卡号：{{ row.bank_code || row.extract_number || '—' }}</div><div v-if="row.bank_address" class="recipient-line">开户地址：{{ row.bank_address }}</div></template>
            <div v-else-if="row.extract_type === 'weixin'" class="recipient-line">微信号：{{ row.wechat || row.extract_number || '—' }}</div>
            <div v-else-if="row.extract_type === 'alipay'" class="recipient-line">支付宝号：{{ row.alipay_code || row.extract_number || '—' }}</div>
            <div v-else-if="row.extract_type === 'balance'" class="recipient-line">佣金转入余额</div>
            <div v-else-if="row.extract_number" class="recipient-line">账号：{{ row.extract_number }}</div>
          </template></el-table-column>
          <el-table-column label="收款码" min-width="124"><template #default="{ row }"><el-button v-if="row.media_available" link type="primary" :disabled="loading" @click="openMedia(row)">查看收款码</el-button><span v-else class="secondary">暂无收款码</span></template></el-table-column>
          <el-table-column label="添加时间" min-width="166"><template #default="{ row }">{{ row.time || '—' }}</template></el-table-column>
          <el-table-column prop="mark" label="备注" min-width="164" show-overflow-tooltip />
          <el-table-column label="审核状态" min-width="208"><template #default="{ row }"><el-tag :type="statusTag(row.status)" effect="light">{{ statusLabel(row.status) }}</el-tag><div v-if="row.fail_msg" class="failure">{{ row.status === -1 ? '未通过原因：' : '历史说明：' }}{{ row.fail_msg }}</div><div v-if="row.fail_time" class="secondary">{{ extractDirectoryShanghaiTime(row.fail_time) }}</div></template></el-table-column>
        </el-table></div>
        <div class="pagination"><span>共 {{ count }} 条</span><el-pagination :current-page="page" :page-size="20" :total="Math.min(count,20000)" layout="prev, pager, next, jumper" :disabled="loading" @current-change="changePage" /></div>
      </el-card>
    </template>

    <el-dialog :model-value="!!media" title="收款码" width="min(460px, calc(100vw - 32px))" append-to-body @close="closeMedia">
      <div v-if="media" class="media-content"><div class="media-owner">{{ media.nickname || '用户' }} · 申请 #{{ media.id }}</div>
        <div v-if="media.state === 'loading'" v-loading="true" class="media-loading">正在读取收款码…</div>
        <img v-else-if="mediaImage" :key="mediaImage.key" :src="mediaImage.src" :data-media-key="mediaImage.key" class="collection-code" alt="该提现申请的收款码" referrerpolicy="no-referrer" @error="imageError" />
        <div v-else class="media-empty" role="status">{{ media.message }}</div>
      </div>
      <template #footer><el-button @click="closeMedia">关闭</el-button><el-button v-if="media && media.state !== 'loading'" type="primary" @click="retryMedia">重新读取</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import { extractDirectoryPeriod, type ExtractDirectoryQuery } from '@/api/extractDirectory';
import { useExtractDirectory, type ExtractDirectoryShortcut } from '@/composables/useExtractDirectory';
const route = useRoute();
function routeStatus(): ExtractDirectoryQuery['status'] { return typeof route.query.status === 'string' && ['-1','0','1'].includes(route.query.status) ? Number(route.query.status) as -1|0|1 : null; }
const {canView,draft,accepted,report,loading,error,dirty,media,mediaImage,list,count,page,search,resetFilters,setShortcut,
  changePage,retry,openMedia,closeMedia,retryMedia,imageFailed,applyStatus,extractDirectoryShanghaiTime} = useExtractDirectory(routeStatus());
const cards = [{key:'price',label:'待提现金额'},{key:'brokerage_count',label:'佣金总金额'},{key:'priced',label:'已提现金额'},{key:'brokerage_not',label:'未提现金额'}] as const;
const shortcuts: {value:ExtractDirectoryShortcut;label:string}[] = [{value:'today',label:'今天'},{value:'yesterday',label:'昨天'},
  {value:'recent7',label:'最近7天'},{value:'recent30',label:'最近30天'},{value:'last-month',label:'上月'},{value:'month',label:'本月'},{value:'year',label:'本年'}];
function channel(value:string) { return ({bank:'银行卡',balance:'提现到余额',weixin:'微信',alipay:'支付宝'} as Record<string,string>)[value] ?? (value || '未记录方式'); }
function statusLabel(value:number) { return value === 0 ? '申请中' : value === 1 ? '已通过' : value === -1 ? '未通过' : `未知状态（${value}）`; }
function statusTag(value:number): 'warning'|'success'|'danger'|'info' { return value === 0 ? 'warning' : value === 1 ? 'success' : value === -1 ? 'danger' : 'info'; }
function updateDates(value:unknown) { draft.dates = Array.isArray(value) && value.every(item => typeof item === 'string') ? [...value] : []; }
function updateStatus(value:unknown) { draft.status = ['-1','0','1'].includes(String(value)) ? String(value) as '-1'|'0'|'1' : ''; }
function updateChannel(value:unknown) { draft.extract_type = ['bank','balance','weixin','alipay'].includes(String(value)) ? String(value) as ExtractDirectoryQuery['extract_type'] : ''; }
function imageError(event: Event) { const image = event.currentTarget as HTMLImageElement | null; if (image) imageFailed(image.getAttribute('src') ?? '',image.dataset.mediaKey ?? ''); }
const acceptedCaption = computed(() => {
  const query = accepted.value; if (!query) return '';
  const state = query.status === null ? '全部状态' : statusLabel(query.status), type = query.extract_type ? channel(query.extract_type) : '全部方式';
  const time = query.start ? `${extractDirectoryShanghaiTime(query.start)} 至 ${extractDirectoryShanghaiTime(extractDirectoryPeriod(query.start,query.stop).effective_stop)}（含结束时刻）` : '全部时间';
  return [state,type,query.keyword ? `关键词：${query.keyword}` : '全部关键词',time].join(' · ');
});
watch(() => route.query.status,() => applyStatus(routeStatus()));
</script>

<style scoped>
.withdrawal-page{color:#303133;font-size:14px}.page-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.page-heading h1{margin:0;font-size:21px;line-height:1.5;font-weight:600}.page-heading p{margin:5px 0 0;color:#909399;font-size:13px}.filter-card,.table-card{border:0;border-radius:6px}.filter-card{margin-bottom:20px}.filter-card :deep(.el-card__body){padding:24px 20px 16px}.filter-card :deep(.el-form){display:flex;flex-wrap:wrap;gap:0 20px}.filter-card :deep(.el-form-item){margin:0 0 18px}.filter-card :deep(.el-select){width:152px}.filter-card :deep(.el-range-editor){width:360px;max-width:100%}.keyword-field :deep(.el-input){width:300px}.filter-actions{margin-left:0!important}.time-shortcuts{display:flex;align-items:center;gap:15px;flex-wrap:wrap;padding-left:88px;font-size:12px;color:#909399}.time-shortcuts button{padding:0;border:0;background:none;color:#606266;font:inherit;cursor:pointer}.time-shortcuts button:hover{color:#1890ff}.time-shortcuts button:disabled{cursor:default;color:#c0c4cc}.time-zone{margin-left:auto}.statistics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;margin-bottom:20px}.stat-card{display:flex;align-items:center;gap:18px;padding:25px 22px;background:#fff;border-radius:6px;min-width:0}.stat-card>div{min-width:0}.stat-symbol{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;flex-shrink:0;background:#eef5ff;color:#1890ff;font-size:25px;font-weight:500}.stat-symbol.brokerage_count{color:#19be6b;background:#eaf9f0}.stat-symbol.priced{color:#ff9900;background:#fff7e8}.stat-symbol.brokerage_not{color:#7d64d9;background:#f3efff}.stat-name{color:#909399;font-size:13px;margin-bottom:9px}.stat-card strong{display:block;font-size:25px;font-weight:500;line-height:1.3;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.table-card :deep(.el-card__body){padding:0}.table-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:22px 24px 18px}.table-heading h2{font-size:15px;font-weight:600;margin:0 0 7px}.table-heading p{margin:0;color:#909399;font-size:12px;line-height:1.7}.draft-notice{font-size:12px;color:#b88230;flex-shrink:0}.table-scroll{overflow-x:auto}.table-card :deep(.el-table){--el-table-header-bg-color:#f7f8fa;--el-table-header-text-color:#606266;--el-table-border-color:#f0f0f0;font-size:13px}.table-card :deep(.el-table th.el-table__cell){height:48px;font-weight:500}.table-card :deep(.el-table .cell){line-height:1.8}.table-card :deep(.el-table td.el-table__cell){padding:17px 0;vertical-align:top}.user-name{font-weight:500}.secondary{color:#909399;font-size:12px}.amount{font-weight:600;font-variant-numeric:tabular-nums}.channel-title{margin-bottom:3px;font-weight:500}.recipient-line{color:#606266;overflow-wrap:anywhere}.failure{color:#909399;font-size:12px;max-width:240px;margin-top:5px;overflow-wrap:anywhere}.pagination{display:flex;align-items:center;justify-content:flex-end;gap:18px;padding:22px 24px;color:#909399;font-size:12px}.read-error{margin-bottom:20px}.media-content{text-align:center;min-height:200px}.media-owner{margin-bottom:24px;font-size:13px;color:#909399}.collection-code{display:block;max-width:100%;width:280px;max-height:360px;object-fit:contain;margin:0 auto}.media-loading,.media-empty{display:grid;place-items:center;min-height:200px;color:#909399;line-height:1.8}.media-empty{padding:0 20px}@media(max-width:1200px){.statistics{gap:12px}.stat-card{padding:22px 16px;gap:12px}.stat-card strong{font-size:21px}}@media(max-width:760px){.statistics{grid-template-columns:repeat(2,minmax(0,1fr))}.stat-card{padding:20px 15px}.stat-symbol{display:none}.filter-card :deep(.el-form-item){width:100%;margin-right:0}.filter-card :deep(.el-form-item__content){min-width:0}.filter-card :deep(.el-select),.keyword-field :deep(.el-input),.filter-card :deep(.el-range-editor){width:100%}.time-shortcuts{padding-left:0;gap:12px}.time-zone{margin-left:0}.table-heading{flex-direction:column;gap:10px;padding:20px 16px}.pagination{padding:20px 12px;gap:8px;flex-wrap:wrap}.page-heading{margin-bottom:16px}.page-heading h1{font-size:19px}}
</style>
