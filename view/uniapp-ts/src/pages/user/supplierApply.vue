<template>
  <view class="page">
    <view class="intro-card">
      <text class="eyebrow">SUPPLIER PROGRAM</text>
      <text class="title">成为 CinaShop 供应商</text>
      <text class="desc">提交企业资料后由平台审核。审核通过不会发送默认密码，您需使用申请手机号验证并设置自己的登录密码。</text>
    </view>

    <view v-if="loading" class="empty">正在加载申请记录...</view>
    <template v-else>
      <view v-for="item in applications" :key="item.id" class="application-card">
        <view class="card-head">
          <view><text class="company">{{ item.system_name }}</text><text class="meta">申请号 #{{ item.id }}</text></view>
          <text class="status" :class="`status-${item.status}`">{{ item.status_label }}</text>
        </view>
        <view class="detail-row"><text>联系人</text><text>{{ item.name }} · {{ item.phone }}</text></view>
        <view class="detail-row"><text>提交时间</text><text>{{ formatTime(item.add_time) }}</text></view>
        <view v-if="item.mark" class="notice neutral">平台备注：{{ item.mark }}</view>
        <view v-if="item.fail_msg" class="notice danger">未通过原因：{{ item.fail_msg }}</view>
        <view v-if="item.activation_required" class="activation">
          <text class="activation-title">审核通过，完成账号激活</text>
          <text class="activation-note">登录账号：{{ item.account }}。验证码只发送到 {{ item.phone }}。</text>
          <view class="code-row">
            <input v-model="activation.code" maxlength="6" type="number" placeholder="6 位验证码" />
            <button class="code-btn" :disabled="countdown > 0" @tap="sendCode('activate', item)">{{ countdown > 0 ? `${countdown}s` : "获取验证码" }}</button>
          </view>
          <input v-model="activation.password" class="field" password maxlength="72" placeholder="设置至少 12 位密码" />
          <input v-model="activation.confirm" class="field" password maxlength="72" placeholder="再次输入密码" />
          <button class="primary-btn" :loading="submitting" @tap="activate(item)">激活供应商账号</button>
        </view>
        <view v-else-if="item.activated" class="notice success">供应商账号 {{ item.account }} 已激活，可前往供应商后台登录。</view>
        <button v-if="item.status === 2" class="outline-btn" @tap="edit(item)">修改资料并重新提交</button>
      </view>

      <view v-if="canApply || editingId" class="form-card">
        <text class="section-title">{{ editingId ? "修改入驻资料" : "提交入驻申请" }}</text>
        <text class="label">供应商名称</text>
        <input v-model="form.system_name" class="field" maxlength="30" placeholder="4–30 个字符" />
        <text class="label">联系人</text>
        <input v-model="form.name" class="field" maxlength="30" placeholder="联系人姓名" />
        <text class="label">申请手机号</text>
        <input v-model="form.phone" class="field" maxlength="11" type="number" placeholder="用于验证与账号激活" />
        <text class="label">资质图片</text>
        <view class="qualification-grid">
          <view v-for="(image, index) in form.imagePreviews" :key="`${form.imageRefs[index]}-${index}`" class="qualification-item">
            <image :src="image" mode="aspectFill" />
            <button class="remove-image" @tap="removeImage(index)">×</button>
          </view>
          <button v-if="form.imageRefs.length < 9" class="add-image" :loading="uploading" :disabled="uploading" @tap="chooseImages">
            <text class="add-symbol">+</text><text>{{ uploading ? "上传中" : "上传资质" }}</text>
          </button>
        </view>
        <text class="hint">支持 JPEG、PNG、WebP、GIF，单张最大 10 MiB，最多 9 张；图片存入私有 R2 并通过临时签名访问。</text>
        <text class="label">短信验证码</text>
        <view class="code-row">
          <input v-model="form.code" maxlength="6" type="number" placeholder="6 位验证码" />
          <button class="code-btn" :disabled="countdown > 0" @tap="sendCode('apply')">{{ countdown > 0 ? `${countdown}s` : "获取验证码" }}</button>
        </view>
        <button class="primary-btn" :loading="submitting" @tap="submit">{{ editingId ? "重新提交审核" : "提交申请" }}</button>
        <button v-if="editingId" class="text-btn" @tap="cancelEdit">取消修改</button>
      </view>

      <view v-if="!applications.length && !canApply" class="empty">暂无申请记录</view>
    </template>
  </view>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onShow, onUnload } from "@dcloudio/uni-app";
import {
  apiSupplierActivate,
  apiSupplierApplications,
  apiSupplierApply,
  apiSupplierCode,
  apiSupplierImageUpload,
  resolveSupplierAssetUrl,
  type SupplierApplication,
} from "@/api/supplierApplication";

const applications = ref<SupplierApplication[]>([]);
const loading = ref(true);
const submitting = ref(false);
const uploading = ref(false);
const editingId = ref(0);
const countdown = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
const form = reactive({ system_name: "", name: "", phone: "", imageRefs: [] as string[], imagePreviews: [] as string[], code: "" });
const activation = reactive({ code: "", password: "", confirm: "" });
const canApply = computed(() => !applications.value.some((item) => item.status === 0 || item.status === 1));

function message(error: unknown, fallback: string) {
  uni.showToast({ title: error instanceof Error ? error.message : fallback, icon: "none", duration: 2600 });
}
function formatTime(value: number) {
  return value ? new Date(value * 1000).toLocaleString() : "-";
}
async function load() {
  loading.value = true;
  try { applications.value = (await apiSupplierApplications()).list; }
  catch (error) { message(error, "申请记录加载失败"); }
  finally { loading.value = false; }
}
function beginCountdown() {
  countdown.value = 60;
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0 && timer) { clearInterval(timer); timer = null; }
  }, 1000);
}
async function sendCode(purpose: "apply" | "activate", item?: SupplierApplication) {
  const phone = purpose === "activate" ? item?.phone ?? "" : form.phone.trim();
  if (!/^1\d{10}$/.test(phone)) { message(null, "请填写正确的 11 位手机号"); return; }
  try {
    await apiSupplierCode({ phone, purpose, application_id: item?.id });
    beginCountdown();
    uni.showToast({ title: "验证码任务已提交", icon: "success" });
  } catch (error) { message(error, "验证码发送失败"); }
}
function urls(): string[] { return [...form.imageRefs]; }
async function chooseImages() {
  const remaining = 9 - form.imageRefs.length;
  if (remaining <= 0 || uploading.value) return;
  let selected: { tempFilePaths: string[] };
  try {
    selected = await new Promise((resolve, reject) => uni.chooseImage({
      count: remaining,
      sizeType: ["compressed", "original"],
      success: (result) => resolve({
        tempFilePaths: Array.isArray(result.tempFilePaths)
          ? result.tempFilePaths
          : [result.tempFilePaths],
      }),
      fail: reject,
    }));
  } catch (error) {
    const text = error && typeof error === "object" && "errMsg" in error ? String(error.errMsg) : "";
    if (!/cancel/i.test(text)) message(error, "选择图片失败");
    return;
  }
  uploading.value = true;
  try {
    for (const filePath of selected.tempFilePaths) {
      const uploaded = await apiSupplierImageUpload(filePath);
      form.imageRefs.push(uploaded.url);
      form.imagePreviews.push(uploaded.src);
    }
    uni.showToast({ title: "资质图片已上传", icon: "success" });
  } catch (error) { message(error, "图片上传失败"); }
  finally { uploading.value = false; }
}
function removeImage(index: number) {
  form.imageRefs.splice(index, 1);
  form.imagePreviews.splice(index, 1);
}
async function submit() {
  if (form.system_name.trim().length < 4 || form.name.trim().length < 2 || !/^1\d{10}$/.test(form.phone) || urls().length < 1 || !/^\d{6}$/.test(form.code)) {
    message(null, "请完整填写名称、联系人、手机号、资质图片和验证码"); return;
  }
  submitting.value = true;
  try {
    await apiSupplierApply(editingId.value, {
      phone: form.phone.trim(), system_name: form.system_name.trim(), name: form.name.trim(),
      images: urls(), code: form.code,
    });
    uni.showToast({ title: "申请已提交", icon: "success" });
    cancelEdit(); await load();
  } catch (error) { message(error, "申请提交失败"); }
  finally { submitting.value = false; }
}
function edit(item: SupplierApplication) {
  editingId.value = item.id;
  form.system_name = item.system_name; form.name = item.name; form.phone = item.phone;
  form.imageRefs = [...(item.image_refs?.length ? item.image_refs : item.images)];
  form.imagePreviews = item.images.map(resolveSupplierAssetUrl); form.code = "";
  uni.pageScrollTo({ scrollTop: 100000, duration: 250 });
}
function cancelEdit() {
  editingId.value = 0;
  Object.assign(form, { system_name: "", name: "", phone: "", imageRefs: [], imagePreviews: [], code: "" });
}
async function activate(item: SupplierApplication) {
  if (!/^\d{6}$/.test(activation.code) || activation.password.length < 12 || activation.password !== activation.confirm) {
    message(null, "请填写验证码，并确保两次输入的密码一致且至少 12 位"); return;
  }
  submitting.value = true;
  try {
    const result = await apiSupplierActivate(item.id, {
      code: activation.code, password: activation.password, password_confirmation: activation.confirm,
    });
    uni.showModal({ title: "账号已激活", content: `供应商登录账号：${result.account}`, showCancel: false });
    Object.assign(activation, { code: "", password: "", confirm: "" });
    await load();
  } catch (error) { message(error, "账号激活失败"); }
  finally { submitting.value = false; }
}
onShow(load);
onUnload(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.page { min-height: 100vh; padding: 24rpx; background: #f4f6f5; box-sizing: border-box; }
.intro-card { display: flex; flex-direction: column; padding: 38rpx 32rpx; border-radius: 24rpx; color: #fff; background: linear-gradient(135deg, #0f3c37, #18776b 68%, #d1a24b); box-shadow: 0 18rpx 45rpx rgba(15,60,55,.18); }
.eyebrow { color: #f4dcae; font-size: 20rpx; font-weight: 700; letter-spacing: 4rpx; }.title { margin-top: 12rpx; font-size: 42rpx; font-weight: 700; }.desc { margin-top: 14rpx; color: rgba(255,255,255,.78); font-size: 25rpx; line-height: 1.7; }
.application-card,.form-card { margin-top: 24rpx; padding: 28rpx; border-radius: 20rpx; background: #fff; box-shadow: 0 8rpx 24rpx rgba(22,48,45,.05); }.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20rpx; }.company { display: block; color: #17332f; font-size: 30rpx; font-weight: 650; }.meta { display: block; margin-top: 8rpx; color: #98a19f; font-size: 22rpx; }.status { padding: 7rpx 16rpx; border-radius: 999rpx; font-size: 22rpx; }.status-0 { color: #93671d; background: #fff4d6; }.status-1 { color: #14705d; background: #e5f6f0; }.status-2 { color: #c7473b; background: #fff0ee; }
.detail-row { display: flex; justify-content: space-between; gap: 20rpx; margin-top: 22rpx; color: #52615e; font-size: 25rpx; }.detail-row text:first-child { color: #99a3a1; }.notice { margin-top: 22rpx; padding: 18rpx 20rpx; border-radius: 12rpx; font-size: 24rpx; line-height: 1.55; }.notice.neutral { color: #5f674c; background: #f6f7ec; }.notice.danger { color: #a23f37; background: #fff0ee; }.notice.success { color: #176956; background: #eaf7f2; }
.activation { margin-top: 24rpx; padding-top: 24rpx; border-top: 1rpx solid #eef1f0; }.activation-title,.section-title { display: block; color: #163d37; font-size: 30rpx; font-weight: 650; }.activation-note,.hint { display: block; margin-top: 10rpx; color: #8d9795; font-size: 22rpx; line-height: 1.55; }.label { display: block; margin: 26rpx 0 10rpx; color: #41514e; font-size: 25rpx; font-weight: 600; }.field,.code-row input,.textarea { width: 100%; padding: 22rpx 24rpx; border: 1rpx solid #dfe6e3; border-radius: 13rpx; color: #243b37; background: #fafcfb; box-sizing: border-box; font-size: 27rpx; }.textarea { height: 180rpx; line-height: 1.55; }.code-row { display: flex; gap: 16rpx; margin-top: 16rpx; }.code-row input { flex: 1; }.code-btn { width: 210rpx; margin: 0; border: 0; border-radius: 13rpx; color: #176a60; background: #e8f4f1; font-size: 24rpx; }.code-btn::after { border: 0; }
.qualification-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14rpx; }.qualification-item,.add-image { position: relative; height: 190rpx; overflow: hidden; border-radius: 14rpx; }.qualification-item image { width: 100%; height: 100%; }.remove-image { position: absolute; top: 8rpx; right: 8rpx; width: 44rpx; height: 44rpx; margin: 0; padding: 0; border: 0; border-radius: 50%; color: #fff; background: rgba(25,35,33,.72); font-size: 32rpx; line-height: 40rpx; }.remove-image::after,.add-image::after { border: 0; }.add-image { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 4rpx; margin: 0; border: 1rpx dashed #a9c2bc; color: #33766b; background: #f1f8f6; font-size: 22rpx; }.add-symbol { font-size: 44rpx; line-height: 1; }
.primary-btn { margin-top: 24rpx; border: 0; border-radius: 13rpx; color: #fff; background: #176f64; font-size: 27rpx; }.primary-btn::after,.outline-btn::after,.text-btn::after { border: 0; }.outline-btn { margin-top: 22rpx; border: 1rpx solid #176f64; border-radius: 13rpx; color: #176f64; background: #fff; font-size: 25rpx; }.text-btn { margin-top: 8rpx; color: #7f8987; background: transparent; font-size: 24rpx; }.empty { padding: 80rpx 20rpx; color: #929b99; text-align: center; font-size: 25rpx; }
</style>
