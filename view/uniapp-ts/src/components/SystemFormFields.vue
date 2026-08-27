<template>
  <view v-if="modelValue.length" class="system-form section">
    <view class="form-title">{{ title || "补充信息" }}</view>
    <view v-for="(item, index) in modelValue" :key="String(item.id ?? index)" class="form-item">
      <view class="label">
        <text v-if="item.titleShow?.val" class="required">*</text>
        {{ item.titleConfig?.value || `表单项 ${index + 1}` }}
      </view>

      <input
        v-if="item.name === 'texts' || item.name === 'citys'"
        class="field"
        :value="stringValue(item.value)"
        :type="item.name === 'texts' && Number(item.valConfig?.tabVal) === 4 ? 'number' : 'text'"
        :placeholder="item.tipConfig?.value || '请输入'"
        @input="setValue(index, eventValue($event))"
      />

      <radio-group v-else-if="item.name === 'radios'" class="choice-list" @change="setValue(index, eventValue($event))">
        <label v-for="choice in choices(item)" :key="choice" class="choice">
          <radio :value="choice" :checked="stringValue(item.value) === choice" />
          <text>{{ choice }}</text>
        </label>
      </radio-group>

      <checkbox-group v-else-if="item.name === 'checkboxs'" class="choice-list" @change="setCheckboxes(index, eventValue($event))">
        <label v-for="choice in choices(item)" :key="choice" class="choice">
          <checkbox :value="choice" :checked="checkboxValues(item.value).includes(choice)" />
          <text>{{ choice }}</text>
        </label>
      </checkbox-group>

      <picker
        v-else-if="item.name === 'selects'"
        :range="choices(item)"
        @change="setValue(index, choices(item)[eventIndex($event)] || '')"
      >
        <view class="picker-field">{{ stringValue(item.value) || "请选择" }}</view>
      </picker>

      <picker v-else-if="item.name === 'dates'" mode="date" @change="setValue(index, eventValue($event))">
        <view class="picker-field">{{ stringValue(item.value) || "请选择日期" }}</view>
      </picker>

      <picker v-else-if="item.name === 'times'" mode="time" @change="setValue(index, eventValue($event))">
        <view class="picker-field">{{ stringValue(item.value) || "请选择时间" }}</view>
      </picker>

      <view v-else-if="item.name === 'dateranges'" class="range-field">
        <picker mode="date" @change="setRangePart(index, 0, eventValue($event))">
          <view class="picker-field">{{ arrayValue(item.value)[0] || "开始日期" }}</view>
        </picker>
        <text>至</text>
        <picker mode="date" @change="setRangePart(index, 1, eventValue($event))">
          <view class="picker-field">{{ arrayValue(item.value)[1] || "结束日期" }}</view>
        </picker>
      </view>

      <view v-else-if="item.name === 'timeranges'" class="range-field">
        <picker mode="time" @change="setTimePart(index, 0, eventValue($event))">
          <view class="picker-field">{{ timeParts(item.value)[0] || "开始时间" }}</view>
        </picker>
        <text>至</text>
        <picker mode="time" @change="setTimePart(index, 1, eventValue($event))">
          <view class="picker-field">{{ timeParts(item.value)[1] || "结束时间" }}</view>
        </picker>
      </view>

      <view v-else-if="item.name === 'uploadPicture'" class="upload-field">
        <view class="image-list">
          <view v-for="(image, imageIndex) in arrayValue(item.value)" :key="image" class="image-item">
            <text class="image-ref">{{ image }}</text>
            <text class="remove" @tap="removeImage(index, imageIndex)">移除</text>
          </view>
        </view>
        <button size="mini" :loading="uploadingIndex === index" @tap="chooseImages(index)">上传图片</button>
        <text class="hint">最多 {{ uploadLimit(item) }} 张，图片存入私有 R2。</text>
      </view>

      <input
        v-else
        class="field"
        :value="stringValue(item.value)"
        :placeholder="item.tipConfig?.value || '请输入'"
        @input="setValue(index, eventValue($event))"
      />
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { apiSupplierImageUpload } from "@/api/supplierApplication";
import type { SystemFormComponent } from "@/types/systemForm";

const props = defineProps<{ modelValue: SystemFormComponent[]; title?: string }>();
const emit = defineEmits<{ (event: "update:modelValue", value: SystemFormComponent[]): void }>();
const uploadingIndex = ref(-1);

type UniValueEvent = { detail?: { value?: unknown } };

function update(index: number, value: unknown) {
  emit("update:modelValue", props.modelValue.map((item, itemIndex) => (
    itemIndex === index ? { ...item, value } : item
  )));
}
function setValue(index: number, value: unknown) { update(index, value); }
function eventValue(event: Event | UniValueEvent) { return (event as UniValueEvent).detail?.value ?? ""; }
function eventIndex(event: Event | UniValueEvent) { return Number((event as UniValueEvent).detail?.value ?? 0); }
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
function setRangePart(index: number, part: number, value: unknown) {
  const range = arrayValue(props.modelValue[index]?.value);
  range[part] = String(value);
  update(index, range.length === 2 ? range : [range[0] ?? "", range[1] ?? ""]);
}
function timeParts(value: unknown) {
  if (Array.isArray(value)) return value.map(String);
  const range = stringValue(value).split(" - ");
  return range.length === 2 ? range : [];
}
function setTimePart(index: number, part: number, value: unknown) {
  const range = timeParts(props.modelValue[index]?.value);
  range[part] = String(value);
  update(index, range.length === 2 && range.every(Boolean) ? range.join(" - ") : "");
}
async function chooseImages(index: number) {
  const current = arrayValue(props.modelValue[index]?.value);
  const remaining = uploadLimit(props.modelValue[index]) - current.length;
  if (remaining <= 0 || uploadingIndex.value >= 0) return;
  let paths: string[];
  try {
    const selected = await new Promise<{ tempFilePaths: string[] }>((resolve, reject) => uni.chooseImage({
      count: remaining,
      sizeType: ["compressed", "original"],
      success: (result) => resolve({ tempFilePaths: Array.isArray(result.tempFilePaths) ? result.tempFilePaths : [result.tempFilePaths] }),
      fail: reject,
    }));
    paths = selected.tempFilePaths;
  } catch {
    return;
  }
  uploadingIndex.value = index;
  try {
    const uploaded = [...current];
    for (const path of paths) uploaded.push((await apiSupplierImageUpload(path)).url);
    update(index, uploaded);
    uni.showToast({ title: "图片已上传", icon: "success" });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "图片上传失败", icon: "none" });
  } finally {
    uploadingIndex.value = -1;
  }
}
function removeImage(index: number, imageIndex: number) {
  update(index, arrayValue(props.modelValue[index]?.value).filter((_, current) => current !== imageIndex));
}
</script>

<style scoped>
.system-form { padding: 24rpx; }
.form-title { font-size: 30rpx; font-weight: 600; margin-bottom: 16rpx; }
.form-item { padding: 18rpx 0; border-top: 1rpx solid #f2f2f2; }
.label { color: #333; font-size: 28rpx; margin-bottom: 12rpx; }
.required { color: #e64340; margin-right: 6rpx; }
.field, .picker-field { box-sizing: border-box; min-height: 76rpx; width: 100%; padding: 18rpx 20rpx; border: 1rpx solid #e5e5e5; border-radius: 10rpx; background: #fafafa; }
.choice-list { display: flex; flex-wrap: wrap; gap: 18rpx 28rpx; }
.choice { display: flex; align-items: center; gap: 8rpx; }
.range-field { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12rpx; }
.upload-field { display: grid; gap: 12rpx; }
.image-item { display: flex; justify-content: space-between; gap: 12rpx; padding: 12rpx; background: #f7f8fa; border-radius: 8rpx; }
.image-ref { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.remove { color: #e64340; flex: none; }
.hint { color: #999; font-size: 22rpx; }
</style>
