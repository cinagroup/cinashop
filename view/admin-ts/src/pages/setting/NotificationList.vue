<template>
  <div class="notification-page">
    <header class="page-header">
      <div><h2>业务通知中心</h2><p>配置订单与提现通知、检查提供商就绪状态，并处置结果不确定的投递。</p></div>
      <el-button :loading="loading" @click="loadAll">刷新</el-button>
    </header>

    <el-alert title="短信和微信凭据只允许通过 Cloudflare Worker secrets / 受控环境变量配置；后台不会保存、展示或回显密钥。" type="info" :closable="false" show-icon />

    <section v-if="readiness" class="readiness-grid">
      <article v-for="card in readinessCards" :key="card.title" class="readiness-card">
        <div class="readiness-title"><span>{{ card.title }}</span><el-tag :type="card.ready ? 'success' : 'warning'" size="small">{{ card.ready ? "已就绪" : "待配置" }}</el-tag></div>
        <p>{{ card.detail }}</p>
      </article>
    </section>
    <el-alert v-if="configurationWarnings.length" :title="configurationWarnings.join('；')" type="warning" :closable="false" show-icon />

    <el-tabs v-model="activeTab" class="notification-tabs">
      <el-tab-pane label="渠道矩阵" name="channels">
        <div class="section-toolbar">
          <div><strong>微信发货信息上报</strong><p>仅控制物流轨迹上报，不替代公众号或小程序模板消息。</p></div>
          <el-switch v-model="shippingEnabled" :loading="shippingSaving" active-text="启用" inactive-text="关闭" @change="saveShipping" />
        </div>
        <div class="config-grid" v-loading="loading">
          <el-card v-for="item in configs" :key="item.mark" shadow="never" class="config-card">
            <template #header>
              <div class="card-header"><div><strong>{{ item.label }}</strong><code>{{ item.mark }}</code></div><el-button size="small" @click="openConfig(item)">编辑</el-button></div>
            </template>
            <el-alert v-if="item.ambiguous" title="数据库中存在重复配置，保存前需先清理" type="error" :closable="false" />
            <div class="channel-tags">
              <el-tag :type="item.isSystem ? 'success' : 'info'">站内信</el-tag>
              <el-tag :type="item.isSms ? 'success' : 'info'">短信</el-tag>
              <el-tag v-if="item.officialAllowed" :type="item.isWechat ? 'success' : 'info'">公众号</el-tag>
              <el-tag v-if="item.routineAllowed" :type="item.isRoutine ? 'success' : 'info'">小程序</el-tag>
            </div>
            <dl class="config-meta">
              <div><dt>目录状态</dt><dd>{{ item.exists ? "已创建" : "缺失" }}</dd></div>
              <div><dt>启用模板</dt><dd>{{ item.enabledTemplateCount }} / {{ item.templateCount }}</dd></div>
              <div><dt>短信模板</dt><dd>{{ item.smsId || "未配置" }}</dd></div>
            </dl>
          </el-card>
        </div>
      </el-tab-pane>

      <el-tab-pane label="提供商模板" name="templates">
        <div class="section-toolbar"><div><strong>微信模板目录</strong><p>同一通知标识和渠道只能启用一个模板。</p></div><el-button type="primary" @click="openTemplate()">新增模板</el-button></div>
        <el-table :data="templates" v-loading="loading" border class="desktop-table">
          <el-table-column prop="title" label="标题" min-width="180" />
          <el-table-column prop="mark" label="通知标识" min-width="220" />
          <el-table-column label="渠道" width="100"><template #default="{ row }">{{ row.type === "routine" ? "小程序" : "公众号" }}</template></el-table-column>
          <el-table-column prop="tempid" label="提供商模板 ID" min-width="190" />
          <el-table-column label="状态" width="80"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? "启用" : "停用" }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="90"><template #default="{ row }"><el-button size="small" @click="openTemplate(row)">编辑</el-button></template></el-table-column>
        </el-table>
        <div class="mobile-list">
          <el-card v-for="item in templates" :key="item.id" shadow="never">
            <div class="mobile-card-title"><strong>{{ item.title }}</strong><el-tag :type="item.status === 1 ? 'success' : 'info'">{{ item.status === 1 ? "启用" : "停用" }}</el-tag></div>
            <code>{{ item.mark }}</code><p>{{ item.type === "routine" ? "小程序" : "公众号" }} · {{ item.tempid }}</p><el-button size="small" @click="openTemplate(item)">编辑</el-button>
          </el-card>
        </div>
      </el-tab-pane>

      <el-tab-pane label="投递台账" name="deliveries">
        <div class="delivery-summary" v-if="deliveryResult">
          <span>处理中 {{ deliveryResult.summary.pending }}</span><span class="success">成功 {{ deliveryResult.summary.sent }}</span><span class="warning">结果未知 {{ deliveryResult.summary.unknown }}</span><span class="danger">已停止 {{ deliveryResult.summary.dead }}</span><span>跳过 {{ deliveryResult.summary.skipped }}</span>
        </div>
        <el-form :inline="true" class="filters" @submit.prevent="loadDeliveries()">
          <el-form-item label="状态"><el-select v-model="deliveryFilters.status" clearable placeholder="全部" style="width:150px"><el-option v-for="status in deliveryStatuses" :key="status" :label="status" :value="status" /></el-select></el-form-item>
          <el-form-item label="渠道"><el-select v-model="deliveryFilters.channel" clearable placeholder="全部" style="width:170px"><el-option v-for="channel in deliveryChannels" :key="channel" :label="channelLabel(channel)" :value="channel" /></el-select></el-form-item>
          <el-form-item label="事件键"><el-input v-model="deliveryFilters.eventKey" clearable placeholder="精确匹配 event_key" /></el-form-item>
          <el-form-item><el-button type="primary" :loading="deliveriesLoading" @click="loadDeliveries()">查询</el-button></el-form-item>
        </el-form>
        <el-table :data="deliveryResult?.list ?? []" v-loading="deliveriesLoading" border class="desktop-table">
          <el-table-column prop="id" label="ID" width="78" />
          <el-table-column label="业务 / 渠道" min-width="165"><template #default="{ row }"><strong>{{ subjectLabel(row) }}</strong><br><span>{{ channelLabel(row.channel) }}</span></template></el-table-column>
          <el-table-column label="目标" min-width="145"><template #default="{ row }"><code>{{ row.maskedTarget || "—" }}</code></template></el-table-column>
          <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="statusTone(row.status)">{{ row.status }}</el-tag></template></el-table-column>
          <el-table-column label="尝试" width="90"><template #default="{ row }">{{ row.attemptCount }} / {{ row.replayCount }}</template></el-table-column>
          <el-table-column label="最后结果" min-width="220"><template #default="{ row }"><span class="truncate">{{ row.lastError || row.responseCode || row.providerReference || "—" }}</span></template></el-table-column>
          <el-table-column label="操作" width="260" fixed="right"><template #default="{ row }"><delivery-actions :row="row" @operate="openOperation" @history="openHistory" /></template></el-table-column>
        </el-table>
        <div class="mobile-list">
          <el-card v-for="row in deliveryResult?.list ?? []" :key="row.id" shadow="never">
            <div class="mobile-card-title"><strong>{{ subjectLabel(row) }} · {{ channelLabel(row.channel) }}</strong><el-tag :type="statusTone(row.status)">{{ row.status }}</el-tag></div>
            <p><code>{{ row.maskedTarget || "—" }}</code> · 尝试 {{ row.attemptCount }} / 人工重发 {{ row.replayCount }}</p><p class="truncate">{{ row.lastError || row.responseCode || "无错误" }}</p>
            <delivery-actions :row="row" @operate="openOperation" @history="openHistory" />
          </el-card>
        </div>
        <el-button v-if="deliveryResult?.next_cursor" class="load-more" :loading="deliveriesLoading" @click="loadMoreDeliveries">加载更多</el-button>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="configDialog" title="编辑通知渠道" width="min(620px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="通知标识"><el-input v-model="configForm.mark" disabled /></el-form-item><el-form-item label="名称"><el-input v-model="configForm.name" maxlength="255" /></el-form-item><el-form-item label="标题"><el-input v-model="configForm.title" maxlength="255" /></el-form-item>
        <el-form-item label="启用渠道"><el-checkbox v-model="configForm.isSystem">站内信</el-checkbox><el-checkbox v-model="configForm.isSms">短信</el-checkbox><el-checkbox v-if="selectedConfig?.officialAllowed" v-model="configForm.isWechat">公众号</el-checkbox><el-checkbox v-if="selectedConfig?.routineAllowed" v-model="configForm.isRoutine">小程序</el-checkbox></el-form-item>
        <el-form-item label="站内信标题"><el-input v-model="configForm.systemTitle" maxlength="255" /></el-form-item><el-form-item label="站内信内容"><el-input v-model="configForm.systemText" type="textarea" :rows="3" maxlength="4000" show-word-limit /></el-form-item><el-form-item label="短信模板代码"><el-input v-model="configForm.smsId" maxlength="255" placeholder="例如 SMS_ORDER_SENT" /></el-form-item><el-form-item label="短信补充文本"><el-input v-model="configForm.smsText" type="textarea" :rows="2" maxlength="4000" /></el-form-item><el-form-item label="跳转地址"><el-input v-model="configForm.url" maxlength="1000" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="configDialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveConfig">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="templateDialog" title="编辑提供商模板" width="min(620px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="标题"><el-input v-model="templateForm.title" maxlength="255" /></el-form-item><el-form-item label="通知标识"><el-input v-model="templateForm.mark" maxlength="128" /></el-form-item><el-form-item label="渠道"><el-select v-model="templateForm.type" style="width:100%"><el-option value="wechat" label="公众号模板" /><el-option value="routine" label="小程序订阅" /></el-select></el-form-item><el-form-item label="提供商模板 ID"><el-input v-model="templateForm.tempid" maxlength="255" /></el-form-item><el-form-item label="字段映射"><el-input v-model="templateForm.content" type="textarea" :rows="3" maxlength="4000" /></el-form-item><el-form-item label="示例"><el-input v-model="templateForm.example" type="textarea" :rows="2" maxlength="4000" /></el-form-item><el-form-item label="状态"><el-switch v-model="templateForm.status" :active-value="1" :inactive-value="0" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="templateDialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveTemplate">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="operationDialog" :title="operationTitle" width="min(560px, 94vw)">
      <el-alert v-if="operationAction === 'confirm-retry'" title="提供商结果未知时重发可能造成重复短信或微信消息。请先到提供商后台核验。" type="error" :closable="false" show-icon />
      <el-form label-position="top" class="operation-form"><el-form-item label="处置理由（至少 8 个字符）"><el-input v-model="operationForm.reason" type="textarea" :rows="3" maxlength="1000" show-word-limit /></el-form-item><el-form-item v-if="operationAction === 'confirm-sent'" label="提供商引用（可选）"><el-input v-model="operationForm.providerReference" maxlength="255" /></el-form-item></el-form>
      <template #footer><el-button @click="operationDialog=false">取消</el-button><el-button :type="operationAction === 'confirm-retry' ? 'danger' : 'primary'" :loading="saving" @click="submitOperation">确认处置</el-button></template>
    </el-dialog>

    <el-drawer v-model="historyDrawer" title="人工处置记录" size="min(620px, 96vw)">
      <el-empty v-if="!actions.length" description="暂无人工处置记录" />
      <el-timeline v-else><el-timeline-item v-for="item in actions" :key="item.id" :timestamp="formatTime(item.addTime)" placement="top"><el-card shadow="never"><strong>{{ actionLabel(item.action) }}</strong><p>{{ item.previousStatus }} → {{ item.nextStatus }}</p><p>{{ item.reason }}</p><small>管理员 #{{ item.adminId }} · 请求 {{ item.requestKey }}</small></el-card></el-timeline-item></el-timeline>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, reactive, ref } from "vue";
import { ElButton, ElMessage, ElMessageBox } from "element-plus";
import { apiNotificationDeliveries, apiNotificationDeliveryActions, apiNotificationReadiness, apiNotificationTemplates, apiOperateNotificationDelivery, apiOrderNotificationConfigs, apiSaveNotificationShipping, apiSaveNotificationTemplate, apiSaveOrderNotificationConfig, type NotificationDeliveryActionItem, type NotificationDeliveryActionType, type NotificationDeliveryChannel, type NotificationDeliveryItem, type NotificationDeliveryListResult, type NotificationDeliveryStatus, type NotificationMark, type NotificationReadiness, type NotificationTemplateItem, type OrderNotificationConfigItem, type ProviderTemplateType } from "@/api/notifications";

type Operation = "confirm-sent" | "confirm-retry" | "close";
const deliveryStatuses: NotificationDeliveryStatus[] = ["PENDING", "ENQUEUING", "ENQUEUED", "PROCESSING", "RETRYABLE", "SENT", "SKIPPED", "UNKNOWN", "DEAD"];
const deliveryChannels: NotificationDeliveryChannel[] = ["sms", "wechat_official", "wechat_routine", "wechat_shipping"];
const loading = ref(false), saving = ref(false), shippingSaving = ref(false), deliveriesLoading = ref(false);
const activeTab = ref("channels"), configs = ref<OrderNotificationConfigItem[]>([]), templates = ref<NotificationTemplateItem[]>([]), readiness = ref<NotificationReadiness | null>(null), shippingEnabled = ref(false), deliveryResult = ref<NotificationDeliveryListResult | null>(null);
const deliveryFilters = reactive<{ status?: NotificationDeliveryStatus; channel?: NotificationDeliveryChannel; eventKey: string }>({ eventKey: "" });
const configDialog = ref(false), templateDialog = ref(false), operationDialog = ref(false), historyDrawer = ref(false);
const selectedConfig = ref<OrderNotificationConfigItem | null>(null), selectedDelivery = ref<NotificationDeliveryItem | null>(null), operationAction = ref<Operation>("confirm-sent"), actions = ref<NotificationDeliveryActionItem[]>([]);
const configForm = reactive({ mark: "" as NotificationMark | "", name: "", title: "", isSystem: false, isSms: false, isWechat: false, isRoutine: false, systemTitle: "", systemText: "", smsId: "", smsText: "", url: "" });
const templateForm = reactive({ id: undefined as number | undefined, title: "", content: "", type: "wechat" as ProviderTemplateType, mark: "", status: 1, example: "", tempid: "" });
const operationForm = reactive({ reason: "", providerReference: "" });

const DeliveryActions = defineComponent({
  props: { row: { type: Object as () => NotificationDeliveryItem, required: true } }, emits: ["operate", "history"],
  setup(props, { emit }) { return () => h("div", { class: "action-row" }, [
    props.row.status === "UNKNOWN" ? h(ElButton, { size: "small", type: "success", onClick: () => emit("operate", props.row, "confirm-sent") }, () => "确认已发") : null,
    ["UNKNOWN", "DEAD"].includes(props.row.status) ? h(ElButton, { size: "small", type: "danger", plain: true, onClick: () => emit("operate", props.row, "confirm-retry") }, () => "确认重发") : null,
    props.row.status === "UNKNOWN" ? h(ElButton, { size: "small", onClick: () => emit("operate", props.row, "close") }, () => "关闭") : null,
    h(ElButton, { size: "small", link: true, onClick: () => emit("history", props.row) }, () => "记录"),
  ]); },
});
const readinessCards = computed(() => {
  const value = readiness.value; if (!value) return [];
  const smsReady = value.sms.accessKeyIdConfigured && value.sms.accessKeySecretConfigured && value.sms.signNameConfigured && value.sms.regionConfigured;
  const officialReady = value.wechat.officialAppIdConfigured && value.wechat.officialSecretConfigured && value.wechat.identityRows > 0;
  const routineReady = value.wechat.routineAppIdConfigured && value.wechat.routineSecretConfigured && value.wechat.identityRows > 0;
  return [
    { title: "阿里云短信", ready: smsReady, detail: smsReady ? "访问密钥、签名和区域已配置" : "缺少 Worker secret 或运行配置" },
    { title: "微信公众号", ready: officialReady, detail: officialReady ? `凭据就绪，身份映射 ${value.wechat.identityRows} 条` : "缺少凭据或用户身份映射" },
    { title: "微信小程序", ready: routineReady, detail: routineReady ? `凭据就绪，身份映射 ${value.wechat.identityRows} 条` : "缺少凭据或用户身份映射" },
    { title: "微信发货上报", ready: value.shipping.enabled && value.wechat.merchantIdConfigured, detail: value.shipping.enabled ? "功能已启用" : "功能关闭" },
  ];
});
const configurationWarnings = computed(() => { const result: string[] = []; if (readiness.value && readiness.value.site.urlRows > 1) result.push(`site_url 存在 ${readiness.value.site.urlRows} 条重复配置`); for (const item of configs.value) if (item.ambiguous) result.push(`${item.label}存在 ${item.rowCount} 条重复配置`); return result; });
const operationTitle = computed(() => operationAction.value === "confirm-sent" ? "确认提供商已发送" : operationAction.value === "confirm-retry" ? "确认承担重复风险并重发" : "关闭且不再重发");

function errorMessage(error: unknown) { ElMessage.error(error instanceof Error ? error.message : "操作失败"); }
function subjectLabel(row: NotificationDeliveryItem) { return row.withdrawalId ? `提现 #${row.withdrawalId}` : row.orderId ? `订单 #${row.orderId}` : "业务编号缺失"; }
function channelLabel(channel: NotificationDeliveryChannel) { return ({ sms: "短信", wechat_official: "微信公众号", wechat_routine: "微信小程序", wechat_shipping: "微信发货上报" })[channel]; }
function statusTone(status: NotificationDeliveryStatus) { return status === "SENT" ? "success" : status === "UNKNOWN" || status === "RETRYABLE" ? "warning" : status === "DEAD" ? "danger" : status === "SKIPPED" ? "info" : ""; }
function actionLabel(action: NotificationDeliveryActionType) { return action === "CONFIRM_SENT" ? "人工确认已发送" : action === "CONFIRM_RETRY" ? "人工确认重发" : "关闭且不重发"; }
function formatTime(timestamp: number) { return timestamp ? new Date(timestamp * 1000).toLocaleString() : "—"; }
async function loadAll() { loading.value = true; try { const [nextConfigs, nextTemplates, nextReadiness] = await Promise.all([apiOrderNotificationConfigs(), apiNotificationTemplates(), apiNotificationReadiness()]); configs.value = nextConfigs; templates.value = nextTemplates; readiness.value = nextReadiness; shippingEnabled.value = nextReadiness.shipping.enabled; await loadDeliveries(); } catch (error) { errorMessage(error); } finally { loading.value = false; } }
async function loadDeliveries(afterId?: number, append = false) { deliveriesLoading.value = true; try { const result = await apiNotificationDeliveries({ status: deliveryFilters.status, channel: deliveryFilters.channel, event_key: deliveryFilters.eventKey.trim() || undefined, after_id: afterId, limit: 25 }); if (append && deliveryResult.value) result.list = [...deliveryResult.value.list, ...result.list]; deliveryResult.value = result; } catch (error) { errorMessage(error); } finally { deliveriesLoading.value = false; } }
function loadMoreDeliveries() { const cursor = deliveryResult.value?.next_cursor; if (cursor) void loadDeliveries(cursor, true); }
async function saveShipping(value: string | number | boolean) { shippingSaving.value = true; try { await apiSaveNotificationShipping(Boolean(value)); ElMessage.success("发货上报开关已保存"); readiness.value = await apiNotificationReadiness(); } catch (error) { shippingEnabled.value = !Boolean(value); errorMessage(error); } finally { shippingSaving.value = false; } }
function openConfig(item: OrderNotificationConfigItem) { selectedConfig.value = item; Object.assign(configForm, { mark: item.mark, name: item.name, title: item.title, isSystem: item.isSystem, isSms: item.isSms, isWechat: item.isWechat, isRoutine: item.isRoutine, systemTitle: item.systemTitle, systemText: item.systemText, smsId: item.smsId, smsText: item.smsText, url: item.url }); configDialog.value = true; }
async function saveConfig() { const mark = configForm.mark; if (!mark) return ElMessage.error("通知标识无效"); saving.value = true; try { await apiSaveOrderNotificationConfig(mark, { name: configForm.name, title: configForm.title, isSystem: configForm.isSystem, isSms: configForm.isSms, isWechat: configForm.isWechat, isRoutine: configForm.isRoutine, systemTitle: configForm.systemTitle, systemText: configForm.systemText, smsId: configForm.smsId, smsText: configForm.smsText, url: configForm.url }); ElMessage.success("渠道配置已保存"); configDialog.value = false; await loadAll(); } catch (error) { errorMessage(error); } finally { saving.value = false; } }
function openTemplate(item?: NotificationTemplateItem) { Object.assign(templateForm, item ? { id: item.id, title: item.title, content: item.content ?? "", type: item.type === "routine" ? "routine" : "wechat", mark: item.mark, status: item.status, example: item.example, tempid: item.tempid } : { id: undefined, title: "", content: "", type: "wechat", mark: "", status: 1, example: "", tempid: "" }); templateDialog.value = true; }
async function saveTemplate() { if (!templateForm.title.trim() || !templateForm.mark.trim() || !templateForm.tempid.trim()) return ElMessage.error("标题、通知标识和模板 ID 必填"); saving.value = true; try { await apiSaveNotificationTemplate({ ...templateForm }); ElMessage.success("模板已保存"); templateDialog.value = false; await loadAll(); } catch (error) { errorMessage(error); } finally { saving.value = false; } }
function openOperation(row: NotificationDeliveryItem, action: Operation) { selectedDelivery.value = row; operationAction.value = action; operationForm.reason = ""; operationForm.providerReference = row.providerReference; operationDialog.value = true; }
async function submitOperation() { const row = selectedDelivery.value, reason = operationForm.reason.trim(); if (!row || reason.length < 8) return ElMessage.error("请输入至少 8 个字符的处置理由"); if (operationAction.value === "confirm-retry") { try { await ElMessageBox.confirm("这次重发可能导致用户收到重复通知。只有在提供商后台仍无法确认结果时才继续。", "重复发送风险", { type: "warning", confirmButtonText: "我已核验，继续重发", cancelButtonText: "取消" }); } catch { return; } } const confirm = operationAction.value === "confirm-sent" ? "CONFIRM_NOTIFICATION_SENT" : operationAction.value === "confirm-retry" ? "CONFIRM_NOTIFICATION_RETRY_WITH_DUPLICATE_RISK" : "CLOSE_NOTIFICATION_WITHOUT_RETRY"; saving.value = true; try { await apiOperateNotificationDelivery(row.id, operationAction.value, { request_key: crypto.randomUUID(), reason, provider_reference: operationForm.providerReference.trim() || undefined, confirm }); ElMessage.success("投递状态已更新并写入审计记录"); operationDialog.value = false; await Promise.all([loadDeliveries(), refreshReadiness()]); } catch (error) { errorMessage(error); } finally { saving.value = false; } }
async function refreshReadiness() { readiness.value = await apiNotificationReadiness(); }
async function openHistory(row: NotificationDeliveryItem) { selectedDelivery.value = row; actions.value = []; historyDrawer.value = true; try { actions.value = await apiNotificationDeliveryActions(row.id); } catch (error) { errorMessage(error); } }
onMounted(loadAll);
</script>

<style scoped>
.notification-page{grid-template-columns:minmax(0,1fr)}.page-header>div{min-width:0}
.notification-page{display:grid;gap:18px}.page-header,.section-toolbar,.card-header,.mobile-card-title{display:flex;align-items:center;justify-content:space-between;gap:16px}.page-header h2{margin:0 0 6px;font-size:24px}.page-header p,.section-toolbar p,.readiness-card p{margin:0;color:var(--el-text-color-secondary);line-height:1.55}.readiness-grid,.config-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.readiness-card{padding:16px;border:1px solid var(--el-border-color-light);border-radius:10px;background:var(--el-bg-color)}.readiness-title{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px;font-weight:600}.notification-tabs{padding:0 18px 18px;border:1px solid var(--el-border-color-light);border-radius:10px;background:var(--el-bg-color)}.section-toolbar{margin:2px 0 16px;padding:12px 0}.config-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.card-header>div{display:grid;gap:5px}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}.channel-tags{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.config-meta{display:grid;gap:8px;margin:0}.config-meta div{display:flex;justify-content:space-between;gap:14px}.config-meta dt{color:var(--el-text-color-secondary)}.config-meta dd{margin:0;text-align:right;overflow-wrap:anywhere}.delivery-summary{display:flex;flex-wrap:wrap;gap:10px 22px;margin-bottom:14px;padding:12px 14px;border-radius:8px;background:var(--el-fill-color-light)}.delivery-summary .success{color:var(--el-color-success)}.delivery-summary .warning{color:var(--el-color-warning)}.delivery-summary .danger{color:var(--el-color-danger)}.filters{display:flex;flex-wrap:wrap}.filters :deep(.el-form-item){margin-bottom:12px}.action-row{display:flex;flex-wrap:wrap;gap:4px}.action-row :deep(.el-button + .el-button){margin-left:0}.truncate{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mobile-list{display:none;gap:10px}.mobile-list :deep(.el-card__body){display:grid;gap:10px}.mobile-list p{margin:0;color:var(--el-text-color-secondary)}.load-more{display:block;margin:16px auto 0}.operation-form{margin-top:16px}@media(max-width:1100px){.readiness-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.notification-page{gap:12px}.page-header{align-items:flex-start}.page-header h2{font-size:20px}.readiness-grid,.config-grid{grid-template-columns:1fr}.notification-tabs{padding:0 10px 12px}.section-toolbar{align-items:flex-start}.desktop-table{display:none}.mobile-list{display:grid}.filters{display:grid;grid-template-columns:1fr}.filters :deep(.el-form-item),.filters :deep(.el-form-item__content),.filters :deep(.el-select),.filters :deep(.el-input){width:100%!important}}
</style>
