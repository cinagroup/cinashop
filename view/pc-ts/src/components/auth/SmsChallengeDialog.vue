<template>
  <el-dialog
    :model-value="smsChallengeDialog.visible.value"
    title="安全验证"
    width="min(440px, 94vw)"
    destroy-on-close
    :close-on-click-modal="false"
    @close="cancelSmsChallenge()"
  >
    <iframe
      v-if="smsChallengeDialog.challenge.value"
      class="challenge-frame"
      :src="smsChallengeDialog.challenge.value.challenge_url"
      title="Cloudflare Turnstile 人机验证"
      sandbox="allow-scripts allow-forms allow-same-origin"
      referrerpolicy="no-referrer"
    />
  </el-dialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import {
  cancelSmsChallenge,
  confirmSmsChallenge,
  smsChallengeDialog,
} from "@/composables/smsChallenge";

interface ChallengeMessage {
  type?: unknown;
  key?: unknown;
}

function receiveMessage(event: MessageEvent<unknown>): void {
  const current = smsChallengeDialog.challenge.value;
  if (!current) return;
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(current.challenge_url, window.location.href).origin;
  } catch {
    return;
  }
  if (event.origin !== expectedOrigin || !event.data || typeof event.data !== "object") return;
  const message = event.data as ChallengeMessage;
  if (message.type !== "cinashop:turnstile:complete" || message.key !== current.key) return;
  void confirmSmsChallenge(current.key).catch((error) => {
    cancelSmsChallenge(error instanceof Error ? error.message : "人机验证失败，请重试");
  });
}

onMounted(() => window.addEventListener("message", receiveMessage));
onBeforeUnmount(() => window.removeEventListener("message", receiveMessage));
</script>

<style scoped>
.challenge-frame {
  display: block;
  width: 100%;
  height: 390px;
  border: 0;
  border-radius: 12px;
  background: #f7f8fa;
}

@media (max-width: 520px) {
  .challenge-frame {
    height: 430px;
  }
}
</style>
