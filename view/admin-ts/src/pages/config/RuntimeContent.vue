<template>
  <div class="runtime-content">
    <div class="page-heading">
      <div>
        <h2>客户端内容</h2>
        <p>管理 PHP 旧版数据库缓存承载的客服提示和首页开屏广告。</p>
      </div>
      <el-button type="primary" :loading="saving" :disabled="!canSave" @click="save">
        保存配置
      </el-button>
    </div>

    <el-alert
      v-if="!canSave"
      type="warning"
      :closable="false"
      title="当前账号只有查看权限，需要 config.manage 才能保存。"
      class="notice"
    />

    <el-card shadow="never" class="section-card" v-loading="loading">
      <template #header>客服页面内容</template>
      <el-form label-position="top">
        <el-form-item label="HTML 内容">
          <el-input
            v-model="form.kf_adv"
            type="textarea"
            :rows="8"
            maxlength="200000"
            show-word-limit
            placeholder="例如客服工作时间、售后说明或公告"
          />
        </el-form-item>
      </el-form>
      <el-text type="info">内容按旧客户端契约保存为 HTML；本页不执行或预览 HTML。</el-text>
    </el-card>

    <el-card shadow="never" class="section-card" v-loading="loading">
      <template #header>政策与入驻协议</template>
      <el-tabs v-model="agreementTab">
        <el-tab-pane v-for="item in agreementTabs" :key="item.key" :name="item.key" :label="item.label">
          <el-input
            v-model="form.agreements[item.key]"
            type="textarea"
            :rows="10"
            maxlength="200000"
            show-word-limit
            :placeholder="`请输入${item.label} HTML`"
          />
        </el-tab-pane>
      </el-tabs>
      <el-text type="info">兼容旧 user_agreement/:type 读取；新人协议继续在“新人运营”中单独管理。</el-text>
    </el-card>

    <el-card shadow="never" class="section-card" v-loading="loading">
      <template #header>首页开屏广告</template>
      <el-form :model="form.open_adv" label-position="top">
        <div class="form-grid">
          <el-form-item label="启用">
            <el-switch v-model="form.open_adv.status" :active-value="1" :inactive-value="0" />
          </el-form-item>
          <el-form-item label="素材类型">
            <el-radio-group v-model="form.open_adv.type">
              <el-radio-button value="pic">图片</el-radio-button>
              <el-radio-button value="video">视频</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="展示时长（秒）">
            <el-input-number v-model="form.open_adv.time" :min="1" :max="60" />
          </el-form-item>
          <el-form-item label="再次展示间隔（小时）">
            <el-input-number v-model="form.open_adv.interval_time" :min="0" :max="720" />
          </el-form-item>
        </div>

        <el-form-item v-if="form.open_adv.type === 'video'" label="HTTPS 视频地址">
          <el-input v-model="form.open_adv.video_link" maxlength="2048" placeholder="https://..." />
        </el-form-item>

        <template v-else>
          <div class="subheading">
            <span>图片广告（最多 5 条）</span>
            <el-button :disabled="form.open_adv.value.length >= 5" @click="addPicture">添加图片</el-button>
          </div>
          <div v-for="(item, index) in form.open_adv.value" :key="index" class="picture-row">
            <el-form-item :label="`第 ${index + 1} 条图片`">
              <el-input v-model="item.img" maxlength="2048" placeholder="HTTPS 或 / 开头的站内地址" />
            </el-form-item>
            <el-form-item label="跳转地址">
              <el-input v-model="item.link" maxlength="2048" placeholder="/pages/... 或 https://..." />
            </el-form-item>
            <el-form-item label="说明">
              <el-input v-model="item.comment" maxlength="500" />
            </el-form-item>
            <div class="picture-actions">
              <el-switch v-model="item.status" :active-value="1" :inactive-value="0" />
              <el-button type="danger" link @click="removePicture(index)">删除</el-button>
            </div>
          </div>
        </template>
      </el-form>
    </el-card>

    <el-card shadow="never" class="section-card" v-loading="loading">
      <template #header>UniApp 页面路径</template>
      <el-alert
        type="info"
        :closable="false"
        title="优先读取 system_group_data 的 uni_app_link；只有目录为空时才回退旧 uni_app_url 缓存。"
        class="notice"
      />
      <el-table :data="form.uni_app_url" empty-text="尚无页面路径数据">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="名称" min-width="160" />
        <el-table-column prop="url" label="路径" min-width="260" show-overflow-tooltip />
        <el-table-column prop="parameter" label="参数" min-width="180" show-overflow-tooltip />
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import {
  apiLegacyRuntimeContent,
  apiSaveLegacyRuntimeContent,
  type LegacyRuntimeContent,
  type OpenAdvItem,
} from "@/api/legacyContent";

type AgreementKey = keyof LegacyRuntimeContent["agreements"];

const authStore = useAuthStore();
const loading = ref(false);
const saving = ref(false);
const agreementTab = ref<AgreementKey>("privacy");
const agreementTabs: Array<{ key: AgreementKey; label: string }> = [
  { key: "privacy", label: "隐私协议" },
  { key: "user", label: "用户协议" },
  { key: "cancel", label: "注销协议" },
  { key: "supplier", label: "供应商入驻协议" },
  { key: "agent", label: "代理商入驻协议" },
];
const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
const canSave = computed(
  () => previewMode || authStore.userInfo?.level === 0 || authStore.uniqueAuth.includes("config.manage"),
);

const form = reactive<LegacyRuntimeContent>({
  kf_adv: "",
  open_adv: {
    status: 0,
    time: 3,
    interval_time: 24,
    type: "pic",
    value: [],
    video_link: "",
  },
  uni_app_url: [],
  agreements: { privacy: "", user: "", cancel: "", supplier: "", agent: "" },
});

function replace(value: LegacyRuntimeContent) {
  form.kf_adv = value.kf_adv;
  form.open_adv = value.open_adv;
  form.uni_app_url = value.uni_app_url;
  form.agreements = value.agreements;
}

function emptyPicture(): OpenAdvItem {
  return { id: 0, gid: 0, img: "", link: "", sort: 0, status: 1, comment: "", add_time: "" };
}

function addPicture() {
  if (form.open_adv.value.length < 5) form.open_adv.value.push(emptyPicture());
}

function removePicture(index: number) {
  form.open_adv.value.splice(index, 1);
}

async function load() {
  loading.value = true;
  try {
    replace(await apiLegacyRuntimeContent());
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    replace(await apiSaveLegacyRuntimeContent({
      kf_adv: form.kf_adv,
      open_adv: form.open_adv,
      agreements: form.agreements,
    }));
    ElMessage.success("客户端内容已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.runtime-content {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.page-heading,
.subheading,
.picture-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.page-heading h2 {
  margin: 0 0 6px;
}
.page-heading p {
  margin: 0;
  color: #909399;
}
.section-card,
.notice {
  min-width: 0;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}
.picture-row {
  display: grid;
  grid-template-columns: 1.3fr 1.3fr 1fr auto;
  gap: 12px;
  align-items: end;
  padding: 14px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.picture-row :deep(.el-form-item) {
  margin-bottom: 0;
}
@media (max-width: 900px) {
  .form-grid,
  .picture-row {
    grid-template-columns: 1fr;
  }
  .page-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .picture-actions {
    justify-content: flex-start;
  }
}
</style>
