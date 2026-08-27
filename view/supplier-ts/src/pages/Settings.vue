<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { getStoreConfig, saveStoreConfig } from "@/api/supplier";
import type { SupplierConfigGroup, SupplierConfigView } from "@/types";

const loading = ref(true);
const saving = ref<string | null>(null);
const config = ref<SupplierConfigView | null>(null);

async function load() {
  loading.value = true;
  try {
    config.value = await getStoreConfig("store_electronic_sheet");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "履约配置加载失败");
  } finally {
    loading.value = false;
  }
}

async function save(group: SupplierConfigGroup) {
  saving.value = group.key;
  try {
    const values = Object.fromEntries(group.fields.map((field) => [field.key, field.value]));
    await saveStoreConfig(group.key, values);
    ElMessage.success(`${group.label}配置已保存`);
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "配置保存失败");
  } finally {
    saving.value = null;
  }
}

onMounted(load);
</script>

<template>
  <section class="page-section fulfillment-settings-page">
    <header class="page-heading settings-heading">
      <div>
        <h1>履约配置</h1>
        <p>管理默认快递公司、模板、云打印机与发件信息；一号通凭据仅由 Worker Secret 注入</p>
      </div>
    </header>

    <el-alert
      class="settings-security-note"
      title="敏感密钥不会从服务端回显；已配置的密钥留空即可保持不变。"
      type="info"
      :closable="false"
      show-icon
    />

    <div v-loading="loading" class="settings-grid">
      <article v-for="group in config?.groups ?? []" :key="group.key" class="surface settings-card">
        <header class="settings-card__header">
          <div>
            <span>{{ group.key === "store_printing_deploy" ? "PRINT" : "SHIPPING" }}</span>
            <h2>{{ group.label }}</h2>
          </div>
          <p>{{ group.key === "store_printing_deploy" ? "订单支付完成后的打印终端参数" : "快递公司、模板、云打印机与默认发件信息" }}</p>
        </header>

        <el-form label-position="top" class="settings-form">
          <el-form-item v-for="field in group.fields" :key="field.key" :label="field.label">
            <div v-if="field.input_type === 'password'" class="secret-field">
              <el-input
                v-model="field.value"
                type="password"
                show-password
                autocomplete="new-password"
                :placeholder="field.configured ? '已配置，留空保持不变' : '请输入密钥'"
              />
              <el-tag v-if="field.configured" type="success" effect="plain" size="small">已配置</el-tag>
            </div>
            <el-switch
              v-else-if="field.input_type === 'switch'"
              v-model="field.value"
              :active-value="1"
              :inactive-value="0"
              active-text="开启"
              inactive-text="关闭"
            />
            <el-input v-else v-model="field.value" clearable />
          </el-form-item>
        </el-form>

        <footer class="settings-card__footer">
          <span>{{ group.fields.filter((field) => field.configured).length }} 项已有配置</span>
          <el-button type="primary" :loading="saving === group.key" @click="save(group)">
            保存{{ group.label }}
          </el-button>
        </footer>
      </article>
    </div>
  </section>
</template>
