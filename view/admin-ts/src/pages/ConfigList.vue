<template>
  <div class="config-page">
    <div class="page-head">
      <h2>系统配置</h2>
      <el-button type="primary" :loading="saving" @click="saveAll">保存全部</el-button>
    </div>

    <el-alert
      title="配置为键值对形式, 修改后即时生效 (Web 端通过 site_config 读取)"
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom: 16px"
    />

    <!-- 分组筛选 -->
    <el-radio-group v-model="activeGroup" class="group-bar">
      <el-radio-button value="all">全部</el-radio-button>
      <el-radio-button value="site">站点</el-radio-button>
      <el-radio-button value="sign">签到</el-radio-button>
      <el-radio-button value="order">订单</el-radio-button>
      <el-radio-button value="other">其他</el-radio-button>
    </el-radio-group>

    <el-table :data="filteredList" v-loading="loading" border>
      <el-table-column prop="menu_name" label="配置键" width="260" />
      <el-table-column prop="info" label="说明" width="200" />
      <el-table-column label="值" min-width="260">
        <template #default="{ row }">
          <!-- image 类型 -->
          <div v-if="row.inputType === 'image'" class="image-cell">
            <el-image
              v-if="edits[row.menuName]"
              :src="edits[row.menuName]"
              class="preview-img"
              fit="cover"
              :preview-src-list="[edits[row.menuName]]"
            />
            <el-input v-model="edits[row.menuName]" placeholder="图片 URL" clearable />
          </div>
          <!-- switch 类型 -->
          <el-switch
            v-else-if="row.inputType === 'switch'"
            v-model="edits[row.menuName]"
            :active-value="'1'"
            :inactive-value="'0'"
          />
          <!-- number 类型 -->
          <el-input-number
            v-else-if="row.inputType === 'number'"
            v-model="edits[row.menuName]"
            :min="0"
            :precision="0"
          />
          <!-- textarea 类型 -->
          <el-input
            v-else-if="row.inputType === 'textarea'"
            v-model="edits[row.menuName]"
            type="textarea"
            :rows="2"
            placeholder="请输入配置值"
          />
          <!-- 默认 input -->
          <el-input v-else v-model="edits[row.menuName]" placeholder="请输入配置值" clearable />
        </template>
      </el-table-column>
      <el-table-column label="当前值" width="200">
        <template #default="{ row }">
          <el-tag type="info">{{ row.value || "—" }}</el-tag>
        </template>
      </el-table-column>
    </el-table>

    <el-empty v-if="!filteredList.length && !loading" description="暂无配置项" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive } from "vue";
import { ElMessage } from "element-plus";
import { apiAdminConfigList, apiAdminConfigSave, type SystemConfigItem } from "@/api/config";

const list = ref<SystemConfigItem[]>([]);
const loading = ref(true);
const saving = ref(false);
const edits = reactive<Record<string, string>>({});
const activeGroup = ref("all");

/** 分组: 按 menuName 前缀归类 */
const filteredList = computed(() => {
  if (activeGroup.value === "all") return list.value;
  return list.value.filter((item) => {
    const name = item.menuName;
    if (activeGroup.value === "site") return /site_|share_|record_/.test(name);
    if (activeGroup.value === "sign") return /sign_/.test(name);
    if (activeGroup.value === "order") return /auto_|delivery_|comment_/.test(name);
    return true;
  });
});

async function load() {
  loading.value = true;
  try {
    list.value = await apiAdminConfigList();
    for (const item of list.value) {
      edits[item.menuName] = item.value ?? "";
    }
  } finally {
    loading.value = false;
  }
}

async function saveAll() {
  saving.value = true;
  try {
    // 仅提交有变更的配置
    const payload: Record<string, string> = {};
    for (const item of list.value) {
      const newVal = edits[item.menuName] ?? "";
      if (newVal !== (item.value ?? "")) {
        payload[item.menuName] = newVal;
      }
    }
    if (!Object.keys(payload).length) {
      ElMessage.info("没有需要保存的变更");
      return;
    }
    await apiAdminConfigSave(payload);
    ElMessage.success(`已保存 ${Object.keys(payload).length} 项配置`);
    load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.page-head h2 {
  font-size: 18px;
  margin: 0;
}

.group-bar {
  margin-bottom: 16px;
}

.image-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.preview-img {
  width: 48px;
  height: 48px;
  border-radius: 6px;
  flex-shrink: 0;
}
</style>
