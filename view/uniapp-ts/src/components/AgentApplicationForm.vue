<template>
  <view class="page">
    <view class="intro">
      <text class="eyebrow">{{ kind === "promoter" ? "分销员申请" : "代理商申请" }}</text>
      <text class="intro-copy">{{ kind === "promoter" ? "申请参与分销推广" : "申请加入指定事业部" }}</text>
    </view>
    <view v-if="!auth.isLoggedIn" class="card">
      <text>请先登录，再查看或提交申请。</text>
      <button @tap="openLogin">去登录</button>
    </view>
    <view v-else-if="loading" class="card">正在读取申请…</view>
    <view v-else-if="loadError" class="card">
      <text>{{ loadError }}</text><button @tap="load">重新读取</button>
    </view>
    <template v-else>
      <view v-if="application && application.status !== -1" class="card">
        <text class="section">当前申请</text>
        <text>{{ statusLabel(application.status) }} · {{ application.name || "待填写" }}</text>
        <text v-if="application.status === 2" class="reason">{{ application.refusalReason || "审核未通过，请核对资料" }}</text>
        <button class="secondary" @tap="openState">查看审核状态</button>
      </view>
      <view v-if="application?.status === 0 || application?.status === 1" class="card hint">
        {{ application.status === 0 ? "申请正在审核，结果以服务器状态为准。" : "申请已通过。" }}
      </view>
      <view v-else class="card">
        <text class="section">{{ application?.status === 2 ? "修改后重新提交" : "填写申请资料" }}</text>
        <template v-if="kind === 'promoter'">
          <text class="label">用户昵称 / UID</text><text>{{ application?.nickname || "-" }} / {{ application?.uid || "-" }}</text>
          <text class="label">真实姓名</text><input v-model="form.name" maxlength="255" placeholder="请输入真实姓名" />
        </template>
        <template v-else>
          <text class="label">代理商名称</text><input v-model="form.divisionName" maxlength="255" placeholder="请输入代理商名称" />
          <text class="label">联系人</text><input v-model="form.name" maxlength="255" placeholder="请输入联系人" />
          <text class="label">事业部邀请码</text><input v-model="form.divisionInvite" type="number" placeholder="请输入邀请码" />
          <text class="label">资质图片（至少一张）</text>
          <view class="images">
            <view v-for="(image, index) in imagePreviews" :key="`${index}-${image}`" class="image-tile">
              <image :src="image" mode="aspectFill" /><button @tap="removeImage(index)">×</button>
            </view>
            <button v-if="form.images.length < 8" :disabled="uploading" @tap="chooseImages">{{ uploading ? "上传中" : "+ 上传图片" }}</button>
          </view>
        </template>
        <text class="label">手机号</text><input v-model="form.phone" type="number" maxlength="11" placeholder="请输入手机号" />
        <text v-if="kind === 'agent'" class="hint">必须与当前账号已绑定的手机号一致。</text>
        <text class="label">短信验证码</text>
        <view class="code-row">
          <input v-model="form.code" type="number" maxlength="6" placeholder="6 位验证码" />
          <button :disabled="sendingCode || countdown > 0" @tap="sendCode">{{ countdown > 0 ? `${countdown}s` : sendingCode ? "发送中" : "获取验证码" }}</button>
        </view>
        <view class="agreement-row" @tap="agreed = !agreed">
          <text>{{ agreed ? "☑" : "□" }}</text><text>已阅读并同意 {{ kind === "promoter" ? "分销说明" : "代理商协议" }}</text>
        </view>
        <view v-if="agreementContent" class="agreement"><rich-text :nodes="agreementContent" /></view>
        <text v-else class="reason">申请协议尚未配置，当前不能提交。</text>
        <text v-if="error" class="reason">{{ error }}</text>
        <view v-if="submissionUnknown" class="unknown">
          申请结果尚未确认。请先读取服务器状态，不要重复提交。
          <button @tap="load">读取申请状态</button>
        </view>
        <button class="primary" :disabled="submitting || uploading || submissionUnknown || !agreementContent" @tap="submit">
          {{ submitting ? "提交中" : "提交申请" }}
        </button>
      </view>
      <button class="record-link" @tap="openRecord">查看申请记录</button>
    </template>
  </view>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useAuthStore } from "@/stores/auth";
import { apiRequestCode } from "@/api/auth";
import {
  apiAgentAgreement, apiAgentApplication, apiAgentImageUpload, apiSubmitAgentApplication, resolveAgentImage,
  type AgentApplication, type AgentApplicationKind, type AgentApplicationStatus,
} from "@/api/agentSelfService";
import { RequestError } from "@/utils/request";
import { requestSmsChallenge } from "@/utils/smsChallenge";
import { sanitizeArticleRichText } from "@/utils/articleRichText";

const props = defineProps<{ kind: AgentApplicationKind; requestedId?: string }>();
const auth = useAuthStore();
const application = ref<AgentApplication | null>(null);
const loading = ref(true);
const loadError = ref("");
const error = ref("");
const agreed = ref(false);
const submitting = ref(false);
const submissionUnknown = ref(false);
const uploading = ref(false);
const sendingCode = ref(false);
const countdown = ref(0);
const agreementRaw = ref("");
const imagePreviews = ref<string[]>([]);
const form = reactive({ name: "", divisionName: "", phone: "", code: "", divisionInvite: "", images: [] as string[] });
let requestEpoch = 0;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
const agreementContent = computed(() => sanitizeArticleRichText(agreementRaw.value));

function statusLabel(value: AgentApplicationStatus): string {
  return ({ [-1]: "未申请", 0: "待审核", 1: "审核通过", 2: "审核未通过" } as Record<number, string>)[value] || "状态未知";
}
function message(value: unknown, fallback: string): string { return value instanceof Error ? value.message : fallback; }
function resetForm(): void {
  Object.assign(form, { name: "", divisionName: "", phone: "", code: "", divisionInvite: "", images: [] });
  imagePreviews.value = [];
  agreed.value = false;
}
function fillForm(item: AgentApplication): void {
  form.name = item.kind === "promoter" ? item.name : item.nickname;
  form.divisionName = item.kind === "agent" ? item.name : "";
  form.phone = item.phone;
  form.divisionInvite = item.divisionInvite ? String(item.divisionInvite) : "";
  form.images = [...item.images];
  imagePreviews.value = item.images.map(resolveAgentImage);
}
async function load(): Promise<void> {
  const epoch = ++requestEpoch;
  loading.value = true;
  submitting.value = false;
  loadError.value = "";
  error.value = "";
  submissionUnknown.value = false;
  resetForm();
  if (!auth.isLoggedIn) { application.value = null; loading.value = false; return; }
  try {
    const item = await apiAgentApplication(props.kind);
    if (epoch !== requestEpoch) return;
    const requested = props.requestedId?.trim();
    if (requested && (!/^[1-9]\d{0,9}$/.test(requested) || Number(requested) !== item.id)) {
      throw new Error("申请编号与当前账号不匹配");
    }
    let agreement = item.agreement;
    if (props.kind === "agent") {
      agreement = await apiAgentAgreement();
    }
    if (epoch !== requestEpoch) return;
    application.value = item;
    agreementRaw.value = agreement;
    fillForm(item);
  } catch (cause) {
    if (epoch !== requestEpoch) return;
    application.value = null;
    agreementRaw.value = "";
    loadError.value = message(cause, "申请读取失败");
  } finally { if (epoch === requestEpoch) loading.value = false; }
}
function openState(): void {
  if (!application.value || application.value.status === -1) return;
  uni.navigateTo({ url: `/pages/users/agent/state?type=${props.kind}&id=${application.value.id}` });
}
function openLogin(): void { uni.navigateTo({ url: "/pages/auth/login" }); }
function openRecord(): void { uni.navigateTo({ url: "/pages/users/agent/record" }); }
function stopCountdown(): void { if (countdownTimer) clearInterval(countdownTimer); countdownTimer = undefined; countdown.value = 0; }
async function sendCode(): Promise<void> {
  if (sendingCode.value || countdown.value > 0) return;
  const phone = form.phone.trim();
  if (!/^1\d{10}$/.test(phone)) { error.value = "请输入正确的 11 位手机号"; return; }
  const owner = { uid: auth.uid, token: auth.token, version: auth.sessionVersion };
  sendingCode.value = true; error.value = "";
  try {
    const purpose = props.kind === "promoter" ? "promoter_application" : "division_application";
    const key = await requestSmsChallenge(phone, purpose);
    if (auth.uid !== owner.uid || auth.token !== owner.token || auth.sessionVersion !== owner.version) {
      throw new Error("登录状态已变化，请重新操作");
    }
    await apiRequestCode(phone, purpose, key);
    if (auth.uid !== owner.uid || auth.token !== owner.token || auth.sessionVersion !== owner.version) return;
    countdown.value = 60;
    countdownTimer = setInterval(() => { countdown.value -= 1; if (countdown.value <= 0) stopCountdown(); }, 1000);
    uni.showToast({ title: "验证码任务已提交", icon: "success" });
  } catch (cause) { error.value = message(cause, "验证码发送失败"); }
  finally { sendingCode.value = false; }
}
async function chooseImages(): Promise<void> {
  if (uploading.value || form.images.length >= 8) return;
  let files: string[];
  try {
    const selected = await new Promise<{ tempFilePaths: string | string[] }>((resolve, reject) => uni.chooseImage({
      count: 8 - form.images.length, success: (result) => resolve(result), fail: reject,
    }));
    files = Array.isArray(selected.tempFilePaths) ? selected.tempFilePaths : [selected.tempFilePaths];
  } catch { return; }
  uploading.value = true; error.value = "";
  try {
    for (const file of files) {
      const uploaded = await apiAgentImageUpload(file);
      form.images.push(uploaded.url);
      imagePreviews.value.push(uploaded.src);
    }
  } catch (cause) { error.value = message(cause, "图片上传失败"); }
  finally { uploading.value = false; }
}
function removeImage(index: number): void { form.images.splice(index, 1); imagePreviews.value.splice(index, 1); }
async function submit(): Promise<void> {
  if (submitting.value || submissionUnknown.value || !application.value) return;
  const phone = form.phone.trim();
  if (!/^1\d{10}$/.test(phone) || !/^\d{6}$/.test(form.code)) { error.value = "请填写正确的手机号和 6 位验证码"; return; }
  if (!form.name.trim() || (props.kind === "agent" && (!form.divisionName.trim() || !/^[1-9]\d{0,9}$/.test(form.divisionInvite) || form.images.length === 0))) {
    error.value = "请完整填写申请资料"; return;
  }
  if (!agreed.value || !agreementContent.value) { error.value = "请先阅读并同意申请协议"; return; }
  const epoch = requestEpoch;
  submitting.value = true; error.value = "";
  try {
    const result = await apiSubmitAgentApplication(props.kind, application.value.id, props.kind === "promoter"
      ? { nickname: application.value.nickname, real_name: form.name.trim(), phone, code: form.code }
      : { division_name: form.divisionName.trim(), name: form.name.trim(), phone, code: form.code,
          division_invite: Number(form.divisionInvite), images: [...form.images] });
    if (epoch !== requestEpoch) return;
    form.code = "";
    uni.redirectTo({ url: `/pages/users/agent/state?type=${props.kind}&id=${result.id}` });
  } catch (cause) {
    if (epoch !== requestEpoch) return;
    form.code = "";
    submissionUnknown.value = !(cause instanceof RequestError && cause.status !== undefined);
    error.value = submissionUnknown.value ? "提交结果未知，请先读取申请状态" : message(cause, "提交失败，请重新获取验证码");
  } finally { if (epoch === requestEpoch) submitting.value = false; }
}

watch(() => [auth.uid, auth.token, auth.sessionVersion], () => { ++requestEpoch; stopCountdown(); void load(); });
watch(() => props.requestedId, () => { void load(); });
onMounted(() => { void load(); });
onBeforeUnmount(() => { ++requestEpoch; stopCountdown(); });
defineExpose({ load });
</script>

<style scoped>
.page { min-height: 100vh; box-sizing: border-box; padding: 24rpx; background: #f5f6f8; color: #283437; }
.intro { display: flex; flex-direction: column; gap: 10rpx; padding: 38rpx 32rpx; border-radius: 22rpx; background: #185a50; color: #fff; }
.eyebrow { font-size: 38rpx; font-weight: 700; }.intro-copy { font-size: 25rpx; opacity: .8; }
.card { display: flex; flex-direction: column; gap: 14rpx; margin-top: 22rpx; padding: 28rpx; border-radius: 18rpx; background: #fff; }
.section { font-size: 30rpx; font-weight: 700; }.label { margin-top: 18rpx; font-size: 25rpx; color: #566; }
input { padding: 18rpx; border: 1rpx solid #dce2e0; border-radius: 10rpx; font-size: 27rpx; }
.code-row { display: flex; gap: 10rpx; }.code-row input { flex: 1; min-width: 0; }.code-row button { flex: 0 0 205rpx; margin: 0; font-size: 23rpx; }
.images { display: flex; flex-wrap: wrap; gap: 12rpx; }.image-tile { position: relative; width: 142rpx; height: 142rpx; }.image-tile image { width: 100%; height: 100%; }.image-tile button { position: absolute; top: 0; right: 0; width: 48rpx; height: 48rpx; padding: 0; line-height: 48rpx; }
.agreement-row { display: flex; gap: 12rpx; margin-top: 16rpx; font-size: 25rpx; }.agreement { max-height: 220rpx; overflow: auto; padding: 16rpx; background: #f7faf9; font-size: 23rpx; }
.hint { color: #70807c; font-size: 23rpx; }.reason { color: #af3f35; font-size: 24rpx; }.unknown { color: #9a641b; background: #fff7e7; padding: 16rpx; }
.primary { margin: 20rpx 0 0; color: #fff; background: #176e61; }.secondary,.record-link { color: #176e61; background: #fff; border: 1rpx solid #176e61; }
.record-link { margin-top: 24rpx; width: 100%; }
</style>
