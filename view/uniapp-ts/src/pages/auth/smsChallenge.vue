<template>
  <web-view
    v-if="challengeUrl"
    :src="challengeUrl"
    @message="handleWebViewMessage"
    @error="handleLoadError"
  />
  <view v-else class="error-page">人机验证链接无效，请返回重试。</view>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { confirmPendingSmsChallenge } from "@/utils/smsChallenge";

interface ChallengeMessage {
  type?: unknown;
  key?: unknown;
}

const challengeKey = ref("");
const challengeUrl = ref("");
let returning = false;

function isChallengeMessage(value: unknown): value is ChallengeMessage {
  return Boolean(value && typeof value === "object");
}

async function acceptMessage(value: unknown): Promise<void> {
  if (returning || !isChallengeMessage(value)) return;
  if (value.type !== "cinashop:turnstile:complete" || value.key !== challengeKey.value) return;
  try {
    if (!(await confirmPendingSmsChallenge(challengeKey.value))) return;
    returning = true;
    uni.navigateBack();
  } catch (error) {
    uni.showToast({
      title: error instanceof Error ? error.message : "人机验证状态确认失败",
      icon: "none",
    });
  }
}

function handleWebViewMessage(event: { detail?: { data?: unknown } }): void {
  const data = event.detail?.data;
  const messages = Array.isArray(data) ? data : [data];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (isChallengeMessage(candidate) && candidate.type === "cinashop:turnstile:complete") {
      void acceptMessage(candidate);
      break;
    }
  }
}

function handleWindowMessage(event: MessageEvent<unknown>): void {
  if (!challengeUrl.value) return;
  try {
    if (event.origin !== new URL(challengeUrl.value).origin) return;
  } catch {
    return;
  }
  void acceptMessage(event.data);
}

function handleLoadError(): void {
  uni.showToast({ title: "人机验证页面加载失败，请检查网络", icon: "none" });
}

onLoad((options) => {
  challengeKey.value = decodeURIComponent(String(options?.key ?? ""));
  challengeUrl.value = decodeURIComponent(String(options?.url ?? ""));
});

onMounted(() => {
  // #ifdef H5
  window.addEventListener("message", handleWindowMessage);
  // #endif
});

onBeforeUnmount(() => {
  // #ifdef H5
  window.removeEventListener("message", handleWindowMessage);
  // #endif
});
</script>

<style scoped>
.error-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48rpx;
  color: #666;
  background: #f7f8fa;
  text-align: center;
}
</style>
