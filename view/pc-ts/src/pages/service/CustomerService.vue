<template>
  <div class="service-page">
    <section class="service-shell">
      <header class="service-header">
        <div class="agent-identity">
          <div class="agent-avatar">
            <img v-if="serviceAvatar" :src="serviceAvatar" alt="客服头像" />
            <span v-else>{{ serviceNickname.slice(0, 1) || "客" }}</span>
            <i :class="{ online: serviceOnline }" />
          </div>
          <div>
            <p class="eyebrow">CUSTOMER SERVICE</p>
            <h1>{{ serviceNickname || "在线客服" }}</h1>
            <p>{{ serviceOnline ? "客服在线" : "客服暂时离线" }} · {{ identityLabel }}</p>
          </div>
        </div>
        <div class="connection" :class="socketState">
          {{ socketState === "open" ? "实时连接" : socketState === "connecting" ? "连接中" : "已断开" }}
        </div>
      </header>

      <div ref="messagePanel" class="message-panel" aria-live="polite">
        <div v-if="loading" class="empty-state">正在建立安全客服会话…</div>
        <div v-else-if="loadError" class="empty-state error-state">
          <strong>暂时无法连接客服</strong>
          <span>{{ loadError }}</span>
          <el-button type="primary" @click="initialize">重新连接</el-button>
        </div>
        <div v-else-if="!messages.length" class="empty-state">
          <strong>开始咨询</strong>
          <span>消息会通过独立身份和加密连接发送给当前客服。</span>
        </div>
        <template v-else>
          <article
            v-for="message in messages"
            :key="message.id"
            class="message-row"
            :class="{ mine: isMine(message) }"
          >
            <div class="bubble" :class="{ image: message.msn_type === 3 }">
              <img
                v-if="message.msn_type === 3"
                :src="message.msn"
                alt="聊天图片"
                loading="lazy"
                @click="previewImage = message.msn"
              />
              <span v-else>{{ message.msn }}</span>
            </div>
            <time>{{ formatTime(message.add_time) }}</time>
          </article>
        </template>
      </div>

      <footer class="composer-panel">
        <div v-if="notice" class="notice">{{ notice }}</div>
        <div class="composer-tools">
          <label class="upload-button" :class="{ disabled: loading || uploading }">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              :disabled="loading || uploading"
              @change="uploadImage"
            />
            {{ uploading ? "上传中…" : "发送图片" }}
          </label>
          <span>Shift + Enter 换行</span>
        </div>
        <div class="composer-row">
          <el-input
            v-model="draft"
            type="textarea"
            :rows="3"
            maxlength="2000"
            show-word-limit
            resize="none"
            placeholder="请输入咨询内容"
            :disabled="loading || !serviceUid"
            @keydown.enter.exact.prevent="sendText"
          />
          <el-button
            type="primary"
            class="send-button"
            :loading="sending"
            :disabled="!draft.trim() || loading || !serviceUid"
            @click="sendText"
          >
            发送
          </el-button>
        </div>
        <p class="privacy-note">
          游客会话只保存签名令牌摘要，不使用旧版随机 UID；订单信息仅在登录后通过订单页面查询。
        </p>
      </footer>
    </section>

    <el-dialog v-model="previewOpen" width="min(92vw, 760px)" title="图片预览">
      <img v-if="previewImage" class="preview-image" :src="previewImage" alt="聊天图片预览" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import {
  apiRegisteredServiceRecord,
  apiRegisteredServiceSend,
  apiRegisteredServiceUpload,
  apiVisitorBootstrap,
  apiVisitorServiceHistory,
  apiVisitorServiceUpload,
  storedVisitorToken,
  type CustomerServiceMessage,
} from "@/api/customerService";
import { CustomerServiceSocket, type CustomerServiceSocketEvent } from "@/services/customerServiceSocket";
import { useAuthStore } from "@/stores/auth";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const authStore = useAuthStore();
const loading = ref(true);
const loadError = ref("");
const messages = ref<CustomerServiceMessage[]>([]);
const serviceUid = ref(0);
const serviceNickname = ref("");
const serviceAvatar = ref("");
const serviceOnline = ref(false);
const visitorUid = ref(0);
const visitorToken = ref("");
const draft = ref("");
const notice = ref("");
const sending = ref(false);
const uploading = ref(false);
const socketState = ref<"connecting" | "open" | "closed">("closed");
const messagePanel = ref<HTMLElement | null>(null);
const previewImage = ref("");
const previewOpen = computed({
  get: () => Boolean(previewImage.value),
  set: (value) => { if (!value) previewImage.value = ""; },
});
let socket: CustomerServiceSocket | null = null;
let mounted = false;

type MessageInput = Partial<CustomerServiceMessage> & {
  toUid?: unknown;
  msnType?: unknown;
  addTime?: unknown;
};

const registered = computed(() => authStore.isLoggedIn && Boolean(authStore.token));
const identityLabel = computed(() => registered.value ? "已登录用户" : "签名游客会话");

function normalizeMessage(value: MessageInput): CustomerServiceMessage {
  return {
    id: Number(value.id ?? Date.now()),
    uid: Number(value.uid ?? 0),
    to_uid: Number(value.to_uid ?? value.toUid ?? 0),
    msn: String(value.msn ?? ""),
    msn_type: Number(value.msn_type ?? value.msnType ?? 1),
    add_time: Number(value.add_time ?? value.addTime ?? Math.floor(Date.now() / 1_000)),
    is_tourist: Number(value.is_tourist ?? (registered.value ? 0 : 1)) === 1 ? 1 : 0,
    type: Number(value.type ?? 0),
  };
}

function appendMessage(value: MessageInput): void {
  const message = normalizeMessage(value);
  if (!message.id || !message.uid || !message.to_uid || !message.msn) return;
  const index = messages.value.findIndex((item) => item.id === message.id);
  if (index >= 0) messages.value[index] = message;
  else messages.value.push(message);
  void scrollToLatest();
}

function isMine(message: CustomerServiceMessage): boolean {
  const ownUid = registered.value ? authStore.uid : visitorUid.value;
  return ownUid > 0 ? message.uid === ownUid : message.uid !== serviceUid.value;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1_000));
}

async function scrollToLatest(): Promise<void> {
  await nextTick();
  if (messagePanel.value) messagePanel.value.scrollTop = messagePanel.value.scrollHeight;
}

function handleSocketEvent(event: CustomerServiceSocketEvent): void {
  if ((event.type === "chat" || event.type === "reply") && event.data) {
    appendMessage(event.data as MessageInput);
    return;
  }
  if (event.type === "online" && event.data && Number(event.data.uid) === serviceUid.value) {
    serviceOnline.value = Number(event.data.online) === 1;
    return;
  }
  if (event.type === "to_transfer" && event.data) {
    serviceUid.value = Number(event.data.toUid ?? serviceUid.value);
    serviceNickname.value = String(event.data.nickname ?? serviceNickname.value);
    serviceAvatar.value = String(event.data.avatar ?? serviceAvatar.value);
    serviceOnline.value = Number(event.data.online) === 1;
    notice.value = `会话已转接给 ${serviceNickname.value}`;
    return;
  }
  if (event.type === "err_tip") {
    notice.value = String(event.data?.msg ?? "消息发送失败");
  }
}

function connectSocket(): void {
  socket?.close();
  const token = registered.value ? authStore.token : visitorToken.value;
  if (!token || !serviceUid.value) return;
  socket = new CustomerServiceSocket(
    { kind: registered.value ? "registered" : "visitor", token },
    () => serviceUid.value,
    {
      onState: (state) => { socketState.value = state; },
      onEvent: handleSocketEvent,
    },
  );
  socket.connect();
}

async function initialize(): Promise<void> {
  socket?.close();
  socket = null;
  loading.value = true;
  loadError.value = "";
  notice.value = "";
  messages.value = [];
  serviceUid.value = 0;
  visitorUid.value = 0;
  visitorToken.value = "";
  try {
    if (registered.value) {
      const record = await apiRegisteredServiceRecord();
      serviceUid.value = record.uid;
      serviceNickname.value = record.nickname;
      serviceAvatar.value = record.avatar;
      serviceOnline.value = record.online === 1;
      messages.value = record.serviceList.map((item) => normalizeMessage(item));
    } else {
      const record = await apiVisitorBootstrap();
      visitorToken.value = record.visitor_token || storedVisitorToken();
      visitorUid.value = record.tourist_uid;
      serviceUid.value = record.uid;
      serviceNickname.value = record.nickname;
      serviceAvatar.value = record.avatar;
      serviceOnline.value = record.online === 1;
      messages.value = (await apiVisitorServiceHistory(visitorToken.value)).map((item) => normalizeMessage(item));
    }
    connectSocket();
    await scrollToLatest();
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "客服连接失败";
  } finally {
    loading.value = false;
  }
}

async function sendMessage(message: string, messageType: 1 | 3): Promise<void> {
  if (!serviceUid.value) return;
  const payload = message.trim();
  if (!payload) return;
  try {
    if (socket?.isOpen) {
      socket.send("chat", {
        to_uid: serviceUid.value,
        msn: payload,
        msn_type: messageType,
        is_tourist: registered.value ? 0 : 1,
      });
      return;
    }
    if (!registered.value) throw new Error("游客实时连接尚未就绪，请稍后重试");
    appendMessage(await apiRegisteredServiceSend(serviceUid.value, payload, messageType));
  } catch (error) {
    throw error instanceof Error ? error : new Error("消息发送失败");
  }
}

async function sendText(): Promise<void> {
  const text = draft.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  notice.value = "";
  try {
    await sendMessage(text, 1);
    draft.value = "";
  } catch (error) {
    notice.value = error instanceof Error ? error.message : "消息发送失败";
  } finally {
    sending.value = false;
  }
}

async function uploadImage(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || uploading.value) return;
  if (file.size > MAX_IMAGE_BYTES) {
    ElMessage.error("图片不能超过 10 MiB");
    return;
  }
  uploading.value = true;
  notice.value = "";
  try {
    const attachment = registered.value
      ? await apiRegisteredServiceUpload(file)
      : await apiVisitorServiceUpload(visitorToken.value, file);
    await sendMessage(attachment.url, 3);
  } catch (error) {
    notice.value = error instanceof Error ? error.message : "图片发送失败";
  } finally {
    uploading.value = false;
  }
}

watch(() => authStore.token, () => {
  if (mounted) void initialize();
});

onMounted(() => {
  mounted = true;
  void initialize();
});

onBeforeUnmount(() => {
  mounted = false;
  socket?.close();
});
</script>

<style scoped>
.service-page {
  min-height: calc(100vh - 150px);
  padding: 32px 20px;
  background:
    radial-gradient(circle at 12% 12%, rgba(230, 67, 64, 0.10), transparent 32%),
    linear-gradient(160deg, #f7f3ee 0%, #f5f7fa 65%, #eef2f6 100%);
}

.service-shell {
  width: min(100%, 980px);
  height: min(760px, calc(100vh - 190px));
  min-height: 620px;
  margin: 0 auto;
  display: grid;
  grid-template-rows: auto 1fr auto;
  overflow: hidden;
  border: 1px solid rgba(26, 32, 44, 0.08);
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 28px 80px rgba(37, 42, 52, 0.14);
}

.service-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 22px 28px;
  color: #fff;
  background: linear-gradient(120deg, #202733, #343d4b);
}

.agent-identity {
  display: flex;
  align-items: center;
  gap: 14px;
}

.agent-avatar {
  position: relative;
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  overflow: visible;
  border-radius: 18px;
  background: #e64340;
  font-size: 22px;
  font-weight: 700;
}

.agent-avatar img {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}

.agent-avatar i {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 13px;
  height: 13px;
  border: 3px solid #202733;
  border-radius: 50%;
  background: #8a94a3;
}

.agent-avatar i.online {
  background: #24c875;
}

.eyebrow {
  margin: 0 0 3px;
  color: #e2a6a4;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.18em;
}

.agent-identity h1 {
  margin: 0;
  font-size: 19px;
}

.agent-identity p:last-child {
  margin: 4px 0 0;
  color: #bdc5d0;
  font-size: 12px;
}

.connection {
  padding: 7px 12px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  color: #c7cfda;
  font-size: 12px;
}

.connection.open { color: #62e6a3; }
.connection.connecting { color: #ffd27a; }

.message-panel {
  min-height: 0;
  overflow-y: auto;
  padding: 30px clamp(18px, 5vw, 56px);
  background: #f7f8fa;
}

.message-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  margin-bottom: 18px;
}

.message-row.mine { align-items: flex-end; }

.bubble {
  max-width: min(72%, 620px);
  padding: 11px 15px;
  border: 1px solid #e8ebef;
  border-radius: 7px 18px 18px 18px;
  background: #fff;
  color: #29313d;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  box-shadow: 0 5px 18px rgba(38, 45, 56, 0.05);
}

.message-row.mine .bubble {
  border-color: #e64340;
  border-radius: 18px 7px 18px 18px;
  background: #e64340;
  color: #fff;
}

.bubble.image {
  padding: 5px;
  overflow: hidden;
  background: #fff;
  border-color: #e8ebef;
}

.bubble.image img {
  display: block;
  max-width: min(360px, 60vw);
  max-height: 340px;
  border-radius: 13px;
  object-fit: contain;
  cursor: zoom-in;
}

.message-row time {
  margin-top: 5px;
  color: #9ca4af;
  font-size: 11px;
}

.empty-state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #8b94a1;
  text-align: center;
}

.empty-state strong {
  color: #384150;
  font-size: 18px;
}

.error-state span { max-width: 520px; }

.composer-panel {
  padding: 14px 22px 18px;
  border-top: 1px solid #e9ecf0;
  background: #fff;
}

.notice {
  margin-bottom: 10px;
  padding: 8px 11px;
  border-radius: 8px;
  background: #fff2f1;
  color: #b63734;
  font-size: 12px;
}

.composer-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  color: #98a0aa;
  font-size: 11px;
}

.upload-button {
  color: #4a5564;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.upload-button input { display: none; }
.upload-button.disabled { opacity: 0.45; pointer-events: none; }

.composer-row {
  display: grid;
  grid-template-columns: 1fr 92px;
  gap: 12px;
  align-items: stretch;
}

.send-button { height: auto; }

.privacy-note {
  margin: 9px 0 0;
  color: #a0a7b0;
  font-size: 11px;
}

.preview-image {
  display: block;
  max-width: 100%;
  max-height: 72vh;
  margin: 0 auto;
  object-fit: contain;
}

@media (max-width: 720px) {
  .service-page {
    padding: 0;
  }

  .service-shell {
    width: 100%;
    height: calc(100vh - 56px);
    min-height: 560px;
    border: 0;
    border-radius: 0;
  }

  .service-header {
    padding: 16px;
  }

  .connection {
    padding: 6px 9px;
  }

  .message-panel {
    padding: 20px 14px;
  }

  .bubble {
    max-width: 88%;
  }

  .composer-panel {
    padding: 11px 12px 13px;
  }

  .composer-row {
    grid-template-columns: 1fr 72px;
  }
}
</style>
