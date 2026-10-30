<template>
  <main class="browser-log">
    <header><div><h2>本浏览器日志</h2><p>仅记录当前标签页的运行摘要；刷新页面、退出或切换会话后清空。</p></div></header>
    <el-alert title="日志保留最近500条，不上传、不保存到浏览器存储。完整错误请在开发者控制台核对。" type="info" :closable="false" />
    <el-alert v-if="!model?.state.enabled" title="当前会话不可用，请重新登录后查看本浏览器日志。" type="warning" :closable="false" />
    <template v-else>
      <div v-for="screen in screens" :key="screen.key" class="screen">
        <el-alert v-if="model.state.notice" :title="model.state.notice" type="success" :closable="false" />
        <p class="counts">共 {{ model.state.rows.length }} 条，错误 {{ counts.error }} 条。信息 {{ counts.info }} · 成功 {{ counts.success }} · 警告 {{ counts.warning }}<span v-if="model.state.dropped">；已舍弃 {{ model.state.dropped }} 条较早记录</span></p>
        <div class="toolbar"><label>日志等级<el-select :model-value="model.state.filter" aria-label="日志等级" @update:model-value="screen.filter"><el-option label="全部等级" value="all" /><el-option v-for="level in levels" :key="level" :label="levelLabel(level)" :value="level" /></el-select></label><el-button :disabled="!model.state.rows.length" @click="screen.clear">清空日志</el-button></div>
        <p v-if="!rows.length" class="empty">{{ model.state.rows.length ? '没有此等级的日志' : '暂无本浏览器日志' }}</p>
        <div v-else class="records" aria-label="本浏览器日志列表">
          <article v-for="item in rows" :key="item.key" class="record">
            <div class="entry"><div class="summary"><el-tag :type="tagType(item.row.type)">{{ levelLabel(item.row.type) }}</el-tag><strong>{{ item.row.message }}</strong></div><time>{{ localTime(item.row.at) }}</time><p>触发页面：{{ item.row.page }}</p><code>{{ item.row.path }}</code></div>
            <el-button @click="item.view">查看</el-button>
          </article>
        </div>
        <nav v-if="filteredCount" class="pagination" aria-label="日志分页"><span>第 {{ model.state.page }} / {{ model.pageCount() }} 页，每页20条</span><el-button :disabled="model.state.page <= 1" @click="screen.move(-1)">上一页</el-button><el-button :disabled="model.state.page >= model.pageCount()" @click="screen.move(1)">下一页</el-button></nav>
      </div>
      <el-dialog v-for="detail in details" :key="detail.key" :model-value="true" title="日志详情" width="min(580px, calc(100vw - 24px))" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false">
        <dl><dt>时间</dt><dd>{{ localTime(detail.row.at) }}（浏览器本地时间）</dd><dt>等级</dt><dd>{{ levelLabel(detail.row.type) }}</dd><dt>信息</dt><dd>{{ detail.row.message }}</dd><dt>触发页面</dt><dd>{{ detail.row.page }} · {{ detail.row.path }}</dd><template v-if="detail.row.method"><dt>请求方式</dt><dd>{{ detail.row.method }}</dd></template><template v-if="detail.row.httpStatus"><dt>HTTP状态</dt><dd>{{ detail.row.httpStatus }}</dd></template></dl><p class="detail-copy">{{ detailCopy(detail.row) }}</p>
        <template #footer><el-button @click="detail.close">关闭详情</el-button></template>
      </el-dialog>
      <el-dialog v-for="confirmation in confirmations" :key="confirmation.key" :model-value="true" title="清空本浏览器日志" width="min(440px, calc(100vw - 24px))" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false">
        <p>确认清除这 {{ confirmation.count }} 条本浏览器日志？之后新增的记录会保留。</p><template #footer><div class="actions"><el-button @click="confirmation.cancel">取消清空</el-button><el-button type="danger" @click="confirmation.confirm">确认清空</el-button></div></template>
      </el-dialog>
    </template>
  </main>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';
import { browserLog } from '@/stores/browserLog';
import { BROWSER_LOG_LEVELS, browserLogLevelLabel, browserLogLocalTime, browserLogDetail, type BrowserLogLevel, type BrowserLogModel, type BrowserLogView } from '@/utils/browserLogState';
const model = browserLog;
let attached: BrowserLogModel | null = null, lease: BrowserLogView | null = null;
const stop = watch(model, next => { attached?.closeView(lease); attached = next; lease = next?.openView() ?? null; }, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { stop(); attached?.closeView(lease); });
const levels = BROWSER_LOG_LEVELS, levelLabel = browserLogLevelLabel, localTime = browserLogLocalTime, detailCopy = browserLogDetail;
const screens = computed(() => model.value?.pageControls() ?? []);
const rows = computed(() => model.value?.rows().map(row => model.value!.rowControls(row)) ?? []);
const counts = computed(() => model.value?.counts() ?? { info: 0, success: 0, warning: 0, error: 0 });
const filteredCount = computed(() => model.value?.filtered().length ?? 0);
const details = computed(() => model.value?.detailControls() ?? []);
const confirmations = computed(() => model.value?.confirmationControls() ?? []);
const tagType = (type: BrowserLogLevel): 'info' | 'success' | 'warning' | 'danger' => type === 'error' ? 'danger' : type;
</script>
<style scoped>
.browser-log,.screen{display:grid;gap:16px;min-width:0}.browser-log h2{margin:0;font-size:20px}.browser-log header p,.counts,.entry p,.entry time,.detail-copy{color:var(--el-text-color-secondary);font-size:13px;line-height:1.7}.toolbar,.summary,.pagination,.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.toolbar{justify-content:space-between}.toolbar label{display:grid;gap:8px;font-size:14px;width:220px}.records{border:1px solid var(--el-border-color);border-radius:6px;overflow:hidden}.record{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:16px;background:var(--el-bg-color)}.record+.record{border-top:1px solid var(--el-border-color-lighter)}.entry{min-width:0;overflow-wrap:anywhere}.entry time{display:block;margin-top:8px}.entry p{margin:4px 0}.entry code{font-size:12px;color:var(--el-text-color-secondary)}.pagination{justify-content:flex-end;font-size:13px}.empty{padding:32px;text-align:center;color:var(--el-text-color-secondary)}dl{display:grid;grid-template-columns:90px minmax(0,1fr);gap:12px;font-size:14px}dt{color:var(--el-text-color-secondary)}dd{margin:0;overflow-wrap:anywhere}.toolbar :deep(.el-select){width:100%}.browser-log :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}@media(max-width:600px){.record{align-items:flex-start}.toolbar label{width:100%}.pagination{justify-content:flex-start}dl{grid-template-columns:1fr;gap:6px}.actions{justify-content:flex-end}}
</style>
