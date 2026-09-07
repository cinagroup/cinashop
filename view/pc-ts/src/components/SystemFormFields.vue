<template>
  <section v-if="modelValue.length" class="system-form">
    <h3 class="system-form__title">{{ title || "补充信息" }}</h3>
    <el-form label-position="top" :disabled="disabled">
      <el-form-item
        v-for="(item, index) in modelValue"
        :key="String(item.id ?? index)"
        :required="isRequired(item)"
        :label="item.titleConfig?.value || `表单项 ${index + 1}`"
      >
        <el-input
          v-if="item.name === 'texts' || item.name === 'citys'"
          :model-value="stringValue(item.value)"
          :type="item.name === 'texts' ? 'text' : 'textarea'"
          :placeholder="item.tipConfig?.value || '请输入'"
          maxlength="10000"
          @update:model-value="setValue(index, $event)"
        />

        <el-radio-group
          v-else-if="item.name === 'radios'"
          :model-value="stringValue(item.value)"
          @update:model-value="setValue(index, $event)"
        >
          <el-radio v-for="choice in choices(item)" :key="choice" :value="choice">{{ choice }}</el-radio>
        </el-radio-group>

        <el-checkbox-group
          v-else-if="item.name === 'checkboxs'"
          :model-value="checkboxValues(item.value)"
          @update:model-value="setCheckboxes(index, $event)"
        >
          <el-checkbox v-for="choice in choices(item)" :key="choice" :value="choice">{{ choice }}</el-checkbox>
        </el-checkbox-group>

        <el-select
          v-else-if="item.name === 'selects'"
          :model-value="stringValue(item.value)"
          placeholder="请选择"
          @update:model-value="setValue(index, $event)"
        >
          <el-option v-for="choice in choices(item)" :key="choice" :label="choice" :value="choice" />
        </el-select>

        <el-date-picker
          v-else-if="item.name === 'dates'"
          :model-value="stringValue(item.value)"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="请选择日期"
          @update:model-value="setValue(index, $event || '')"
        />

        <el-date-picker
          v-else-if="item.name === 'dateranges'"
          :model-value="arrayValue(item.value)"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          @update:model-value="setValue(index, $event || [])"
        />

        <el-time-picker
          v-else-if="item.name === 'times'"
          :model-value="stringValue(item.value)"
          value-format="HH:mm"
          placeholder="请选择时间"
          @update:model-value="setValue(index, $event || '')"
        />

        <el-time-picker
          v-else-if="item.name === 'timeranges'"
          :model-value="timeRangeValue(item.value)"
          is-range
          value-format="HH:mm"
          start-placeholder="开始时间"
          end-placeholder="结束时间"
          @update:model-value="setTimeRange(index, $event)"
        />

        <div v-else-if="item.name === 'uploadPicture'" class="upload-field">
          <div v-for="(image, imageIndex) in arrayValue(item.value)" :key="image" class="upload-image">
            <span>{{ image }}</span>
            <el-button link type="danger" :disabled="disabled || uploadingFields.includes(index)" @click="removeImage(index, imageIndex)">移除</el-button>
          </div>
          <el-upload
            :show-file-list="false"
            :http-request="uploadRequestFor(index)"
            :disabled="disabled || uploadingFields.includes(index)"
            accept="image/jpeg,image/png,image/webp,image/gif"
          >
            <el-button :disabled="disabled" :loading="uploadingFields.includes(index)">上传图片</el-button>
          </el-upload>
          <small>最多 {{ uploadLimit(item) }} 张，图片存入私有 R2。</small>
        </div>

        <el-input
          v-else
          :model-value="stringValue(item.value)"
          :placeholder="item.tipConfig?.value || '请输入'"
          @update:model-value="setValue(index, $event)"
        />
      </el-form-item>
    </el-form>
  </section>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { ElMessage, type UploadRequestOptions } from "element-plus";
import { apiOrderFormImageUpload } from "@/api/order";
import type { SystemFormComponent } from "@/types/systemForm";
import { SystemFormUploads } from "@/utils/systemFormUploads";

const props = defineProps<{ modelValue: SystemFormComponent[]; title?: string; disabled?: boolean }>();
const emit = defineEmits<{
  (event: "update:modelValue", value: SystemFormComponent[]): void;
  (event: "pending-change", count: number): void;
}>();
const uploadingFields = ref<number[]>([]);
const uploads = new SystemFormUploads((indices) => {
  uploadingFields.value = indices;
  emit("pending-change", indices.length);
});
onUnmounted(() => uploads.reset());

function isRequired(item: SystemFormComponent) {
  const value: unknown = item.titleShow?.val;
  return value === true || value === 1 || value === "1";
}

function update(index: number, value: unknown) {
  if (props.disabled) return;
  emit("update:modelValue", props.modelValue.map((item, itemIndex) => (
    itemIndex === index ? { ...item, value } : item
  )));
}

function setValue(index: number, value: unknown) { update(index, value); }
function stringValue(value: unknown) { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function arrayValue(value: unknown) { return Array.isArray(value) ? value.map(String) : []; }
function checkboxValues(value: unknown) {
  return Array.isArray(value) ? value.map(String) : stringValue(value).split(",").map((item) => item.trim()).filter(Boolean);
}
function setCheckboxes(index: number, value: unknown) {
  update(index, Array.isArray(value) ? value.map(String).join(",") : "");
}
function choiceText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const candidate = record.val ?? record.value ?? record.label;
  return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : "";
}
function choices(item: SystemFormComponent) { return (item.wordsConfig?.list ?? []).map(choiceText).filter(Boolean); }
function uploadLimit(item: SystemFormComponent) {
  const configured = Number(item.numConfig?.val ?? 9);
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 9) : 9;
}
function timeRangeValue(value: unknown) {
  if (Array.isArray(value)) return value.map(String);
  const values = stringValue(value).split(" - ");
  return values.length === 2 ? values : [];
}
function setTimeRange(index: number, value: unknown) {
  update(index, Array.isArray(value) && value.length === 2 ? value.map(String).join(" - ") : "");
}
async function upload(index: number, file: File) {
  if (props.disabled || uploadingFields.value.includes(index)) throw new Error("请等待当前操作完成");
  const component = props.modelValue[index];
  if (!component || component.name !== "uploadPicture") throw new Error("图片表单已失效");
  const current = arrayValue(props.modelValue[index]?.value);
  const limit = uploadLimit(component);
  if (current.length >= limit) { ElMessage.error(`最多上传 ${limit} 张图片`); throw new Error("图片数量已达上限"); }
  const ticket = uploads.begin(index);
  if (!ticket) throw new Error("图片正在上传");
  try {
    const uploaded = await apiOrderFormImageUpload(file);
    if (!uploads.current(ticket) || props.disabled || props.modelValue[index]?.id !== component.id
      || props.modelValue[index]?.name !== component.name) return;
    const latest = arrayValue(props.modelValue[index].value);
    if (latest.length >= uploadLimit(props.modelValue[index])) throw new Error("图片数量已达上限");
    update(index, [...latest, uploaded.url]);
    ElMessage.success("图片已上传");
  } catch (error) {
    if (uploads.current(ticket)) ElMessage.error(error instanceof Error ? error.message : "图片上传失败");
    throw error;
  } finally {
    uploads.finish(ticket);
  }
}
function uploadRequestFor(index: number) {
  return (options: UploadRequestOptions) => upload(index, options.file);
}
function removeImage(index: number, imageIndex: number) {
  if (props.disabled || uploadingFields.value.includes(index)) return;
  update(index, arrayValue(props.modelValue[index]?.value).filter((_, current) => current !== imageIndex));
}
</script>

<style scoped>
.system-form { background: #fff; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
.system-form__title { font-size: 16px; margin: 0 0 16px; }
.upload-field { display: grid; gap: 8px; width: 100%; }
.upload-image { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; background: #f7f8fa; border-radius: 6px; }
.upload-image span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.upload-field small { color: #909399; }
</style>
