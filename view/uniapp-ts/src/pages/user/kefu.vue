<template>
  <view class="kefu-page">
    <view v-if="kfAdv" class="kf-adv">
      <rich-text :nodes="kfAdv" />
    </view>
    <view v-if="serviceUid" class="service-status">
      <image v-if="serviceAvatar" class="service-avatar" :src="serviceAvatar" mode="aspectFill" />
      <view>
        <view class="service-name">{{ serviceNickname || "在线客服" }}</view>
        <view class="service-presence">{{ serviceOnline ? "在线" : "暂时离线，消息会保留" }}</view>
      </view>
    </view>
    <!-- 消息列表 -->
    <scroll-view scroll-y class="msg-scroll" :scroll-into-view="lastMsgId">
      <view v-if="messages.length" class="msg-list">
        <view
          v-for="m in messages"
          :key="m.id"
          :id="`msg-${m.id}`"
          class="msg-item"
          :class="{ mine: m.mine }"
        >
          <view v-if="m.msnType === 3" class="bubble image-bubble" @tap="previewImage(m.msn)">
            <image class="chat-image" :src="resolveAssetUrl(m.msn)" mode="widthFix" />
          </view>
          <view v-else class="bubble">{{ m.msn }}</view>
          <view class="msg-time">{{ formatTime(m.addTime) }}</view>
        </view>
      </view>
      <view v-else class="empty">联系客服, 我们会尽快回复您</view>
    </scroll-view>

    <!-- 输入栏 -->
    <view class="input-bar">
      <view class="image-btn" :class="{ disabled: uploadingImage }" @tap="chooseAndSendImage">
        {{ uploadingImage ? "上传中" : "图片" }}
      </view>
      <input
        v-model="inputText"
        class="msg-input"
        type="text"
        placeholder="请输入消息..."
        confirm-type="send"
        @confirm="send"
      />
      <view class="send-btn" @tap="send">发送</view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useAuthStore } from "@/stores/auth";
import { API_BASE, getFormType, http } from "@/utils/request";
import { apiKfAdv } from "@/api/legacyContent";

interface ChatMessage {
  id: number | string;
  uid: number;
  to_uid: number;
  msn: string;
  add_time?: number;
  addTime?: number;
  msn_type?: number;
  msnType?: number;
}

interface ServiceRecord {
  serviceList: ChatMessage[];
  uid: number;
  nickname: string;
  avatar: string;
  online: number;
}

interface VisitorBootstrap {
  uid: number;
  nickname: string;
  avatar: string;
  online: number;
  tourist_uid: number;
  visitor_token: string;
  expires_in: number;
}

interface DisplayMessage {
  id: number | string;
  msn: string;
  addTime: number;
  mine: boolean;
  msnType: number;
}

const authStore = useAuthStore();
const messages = ref<DisplayMessage[]>([]);
const inputText = ref("");
const uploadingImage = ref(false);
const kfAdv = ref("");
const serviceUid = ref(0);
const serviceNickname = ref("");
const serviceAvatar = ref("");
const serviceOnline = ref(false);
const visitorUid = ref(0);
const visitorToken = ref("");
const VISITOR_TOKEN_STORAGE_KEY = "cinashop_kefu_visitor_token";
let socket: UniApp.SocketTask | null = null;
let socketReady = false;
let disposed = false;

const lastMsgId = computed(() => {
  const last = messages.value[messages.value.length - 1];
  return last ? `msg-${last.id}` : "";
});

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function appendMessage(message: ChatMessage) {
  if (messages.value.some((item) => String(item.id) === String(message.id))) return;
  messages.value.push({
    id: message.id,
    msn: message.msn,
    addTime: message.add_time ?? message.addTime ?? Math.floor(Date.now() / 1000),
    mine: message.uid === (authStore.uid || visitorUid.value),
    msnType: message.msn_type ?? message.msnType ?? 1,
  });
}

function kefuGet<T>(path: string, token = ""): Promise<T> {
  return new Promise((resolve, reject) => {
    const header: Record<string, string> = { "Form-type": getFormType() };
    if (token) header["X-Visitor-Token"] = token;
    uni.request({
      url: `${API_BASE}/kefuapi/${path.replace(/^\/+/, "")}`,
      method: "GET",
      header,
      success: (response) => {
        const body = response.data as { status?: number; msg?: string; data?: T };
        if (body?.status === 200) resolve(body.data as T);
        else reject(new Error(body?.msg ?? "游客客服请求失败"));
      },
      fail: (error) => reject(new Error(error.errMsg ?? "网络错误")),
    });
  });
}

async function loadVisitorRecord() {
  let stored = String(uni.getStorageSync(VISITOR_TOKEN_STORAGE_KEY) || "");
  let bootstrap: VisitorBootstrap;
  try {
    bootstrap = await kefuGet<VisitorBootstrap>("tourist/user", stored);
  } catch (error) {
    if (!stored) throw error;
    uni.removeStorageSync(VISITOR_TOKEN_STORAGE_KEY);
    stored = "";
    bootstrap = await kefuGet<VisitorBootstrap>("tourist/user");
  }
  visitorToken.value = bootstrap.visitor_token;
  visitorUid.value = bootstrap.tourist_uid;
  uni.setStorageSync(VISITOR_TOKEN_STORAGE_KEY, bootstrap.visitor_token);
  serviceUid.value = bootstrap.uid;
  serviceNickname.value = bootstrap.nickname;
  serviceAvatar.value = bootstrap.avatar;
  serviceOnline.value = bootstrap.online === 1;
  const history = await kefuGet<ChatMessage[]>("tourist/chat?limit=50", bootstrap.visitor_token);
  messages.value = history.map((record) => ({
    id: record.id,
    msn: record.msn,
    addTime: record.add_time ?? record.addTime ?? 0,
    mine: record.uid === bootstrap.tourist_uid,
    msnType: record.msn_type ?? record.msnType ?? 1,
  }));
}

async function loadRecord() {
  try {
    if (!authStore.uid || !authStore.token) {
      await loadVisitorRecord();
      return;
    }
    const result = await http.get<ServiceRecord>("/user/service/record", { limit: 50 });
    serviceUid.value = result.uid;
    serviceNickname.value = result.nickname;
    serviceAvatar.value = result.avatar;
    serviceOnline.value = result.online === 1;
    messages.value = result.serviceList.map((r) => ({
      id: r.id,
      msn: r.msn,
      addTime: r.add_time ?? r.addTime ?? 0,
      mine: r.uid === authStore.uid,
      msnType: r.msn_type ?? r.msnType ?? 1,
    }));
  } catch (error) {
    messages.value = [];
    uni.showToast({
      title: error instanceof Error ? error.message : "客服暂不可用",
      icon: "none",
    });
  }
}

function websocketBase(): string {
  if (API_BASE) return API_BASE.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  if (typeof location !== "undefined" && location.origin) {
    return location.origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  }
  return "";
}

function connect() {
  const registered = Boolean(authStore.uid && authStore.token);
  if ((!registered && !visitorToken.value) || !serviceUid.value || socket) return;
  const base = websocketBase();
  if (!base) return;
  const task = uni.connectSocket({
    url: registered
      ? `${base}/api/ws/kefu?type=1&to_uid=${serviceUid.value}`
      : `${base}/kefuapi/tourist/ws`,
    protocols: registered
      ? ["cinashop", `cinashop-auth.${authStore.token}`]
      : ["cinashop", `cinashop-visitor.${visitorToken.value}`],
    success: () => undefined,
    fail: () => {
      socketReady = false;
      socket = null;
    },
  });
  socket = task;
  task.onOpen(() => {
    socketReady = true;
    task.send({
      data: JSON.stringify({ type: "to_chat", data: { to_uid: serviceUid.value } }),
    });
  });
  task.onMessage((res) => {
    try {
      const msg = JSON.parse(res.data as string) as {
        type?: string;
        data?: Partial<ChatMessage> & {
          msg?: string;
          uid?: number;
          online?: number;
          toUid?: number;
          nickname?: string;
          avatar?: string;
        };
      };
      if ((msg.type === "chat" || msg.type === "reply") && msg.data?.msn) {
        appendMessage(msg.data as ChatMessage);
      } else if (msg.type === "online" && msg.data?.uid === serviceUid.value) {
        serviceOnline.value = msg.data.online === 1;
      } else if (msg.type === "to_transfer" && msg.data?.toUid) {
        serviceUid.value = msg.data.toUid;
        serviceNickname.value = msg.data.nickname || "在线客服";
        serviceAvatar.value = msg.data.avatar || "";
        serviceOnline.value = msg.data.online === 1;
        uni.showToast({ title: `已为您转接至${serviceNickname.value}`, icon: "none" });
      } else if (msg.type === "err_tip") {
        uni.showToast({ title: msg.data?.msg || "消息发送失败", icon: "none" });
      }
    } catch {
      // Ignore protocol frames that are not JSON envelopes.
    }
  });
  task.onClose(() => {
    socketReady = false;
    socket = null;
  });
  task.onError(() => {
    socketReady = false;
  });
}

function sendOverSocket(text: string, messageType = 1): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!socket || !socketReady) {
      reject(new Error("socket unavailable"));
      return;
    }
    socket.send({
      data: JSON.stringify({
        type: "chat",
        data: {
          to_uid: serviceUid.value,
          msn: text,
          msn_type: messageType,
          is_tourist: authStore.uid && authStore.token ? 0 : 1,
        },
      }),
      success: () => resolve(),
      fail: () => reject(new Error("socket send failed")),
    });
  });
}

function resolveAssetUrl(value: string): string {
  if (/^(?:https:\/\/|data:)/i.test(value)) return value;
  return value.startsWith("/") ? `${API_BASE}${value}` : value;
}

function previewImage(current: string) {
  const urls = messages.value
    .filter((message) => message.msnType === 3)
    .map((message) => resolveAssetUrl(message.msn));
  uni.previewImage({ current: resolveAssetUrl(current), urls });
}

function uploadChatImage(filePath: string): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    uni.uploadFile({
      url: authStore.uid && authStore.token
        ? `${API_BASE}/api/upload/image`
        : `${API_BASE}/kefuapi/tourist/upload`,
      filePath,
      name: "file",
      formData: { pid: "0" },
      header: authStore.uid && authStore.token
        ? { "Authori-zation": `Bearer ${authStore.token}`, "Form-type": getFormType() }
        : { "X-Visitor-Token": visitorToken.value, "Form-type": getFormType() },
      success: (response) => {
        let parsed: unknown = null;
        try { parsed = JSON.parse(response.data) as unknown; } catch { parsed = null; }
        const body = parsed && typeof parsed === "object"
          ? parsed as { status?: number; msg?: string; data?: { url: string } }
          : null;
        if (body?.status === 200 && body.data?.url) resolve(body.data);
        else reject(new Error(body?.msg ?? "图片上传失败"));
      },
      fail: (error) => reject(new Error(error.errMsg ?? "图片上传失败")),
    });
  });
}

async function chooseAndSendImage() {
  if (uploadingImage.value || !serviceUid.value) return;
  let selected: { tempFilePaths: string[]; tempFiles?: Array<{ size?: number }> };
  try {
    selected = await new Promise((resolve, reject) => uni.chooseImage({
      count: 1,
      sizeType: ["compressed", "original"],
      sourceType: ["album", "camera"],
      success: (result) => resolve({
        tempFilePaths: Array.isArray(result.tempFilePaths) ? result.tempFilePaths : [result.tempFilePaths],
        tempFiles: result.tempFiles as Array<{ size?: number }> | undefined,
      }),
      fail: reject,
    }));
  } catch {
    return;
  }
  if ((selected.tempFiles?.[0]?.size ?? 0) > 10 * 1024 * 1024) {
    uni.showToast({ title: "图片不能超过10 MiB", icon: "none" });
    return;
  }
  uploadingImage.value = true;
  try {
    const attachment = await uploadChatImage(selected.tempFilePaths[0]);
    if (socketReady) {
      await sendOverSocket(attachment.url, 3);
    } else if (authStore.uid && authStore.token) {
      const persisted = await http.post<ChatMessage>("/service/send", {
        to_uid: serviceUid.value,
        msn: attachment.url,
        msn_type: 3,
      });
      appendMessage(persisted);
    } else {
      throw new Error("游客实时连接尚未就绪，请稍后重试");
    }
  } catch (error) {
    uni.showToast({
      title: error instanceof Error ? error.message : "图片发送失败",
      icon: "none",
    });
  } finally {
    uploadingImage.value = false;
  }
}

async function send() {
  const text = inputText.value.trim();
  if (!text || !serviceUid.value) return;
  inputText.value = "";
  try {
    if (socketReady) {
      await sendOverSocket(text);
      return;
    }
    if (!authStore.uid || !authStore.token) {
      throw new Error("游客实时连接尚未就绪，请稍后重试");
    }
    const persisted = await http.post<ChatMessage>("/service/send", {
      to_uid: serviceUid.value,
      msn: text,
      msn_type: 1,
    });
    appendMessage(persisted);
  } catch (error) {
    inputText.value = text;
    uni.showToast({
      title: error instanceof Error ? error.message : "消息发送失败",
      icon: "none",
    });
  }
}

onMounted(async () => {
  void apiKfAdv().then((result) => {
    kfAdv.value = result.content;
  }).catch(() => {});
  await loadRecord();
  if (!disposed) connect();
});

onUnmounted(() => {
  disposed = true;
  socketReady = false;
  if (socket) socket.close({});
  socket = null;
});
</script>

<style scoped>
.kefu-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.kf-adv {
  flex-shrink: 0;
  max-height: 240rpx;
  overflow-y: auto;
  margin: 20rpx 20rpx 0;
  padding: 20rpx;
  border-radius: 12rpx;
  background: #fff8ed;
  color: #8a5a20;
  font-size: 24rpx;
  line-height: 1.6;
}

.service-status {
  display: flex;
  align-items: center;
  gap: 16rpx;
  margin: 16rpx 20rpx 0;
  padding: 16rpx 20rpx;
  border-radius: 12rpx;
  background: #fff;
}

.service-avatar {
  width: 64rpx;
  height: 64rpx;
  border-radius: 50%;
}

.service-name {
  color: #333;
  font-size: 27rpx;
}

.service-presence {
  margin-top: 4rpx;
  color: #999;
  font-size: 22rpx;
}

.msg-scroll {
  flex: 1;
  padding: 20rpx;
  box-sizing: border-box;
}

.msg-list {
  display: flex;
  flex-direction: column;
}

.msg-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  margin-bottom: 20rpx;
}

.msg-item.mine {
  align-items: flex-end;
}

.bubble {
  max-width: 70%;
  background: #fff;
  border-radius: 12rpx;
  padding: 16rpx 20rpx;
  font-size: 28rpx;
  color: #333;
  word-break: break-all;
}

.msg-item.mine .bubble {
  background: #e93323;
  color: #fff;
}

.image-bubble {
  max-width: 520rpx;
  padding: 8rpx;
  overflow: hidden;
  line-height: 0;
}

.chat-image {
  display: block;
  width: 420rpx;
  max-height: 620rpx;
  border-radius: 9rpx;
}

.msg-time {
  font-size: 20rpx;
  color: #ccc;
  margin-top: 6rpx;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 100rpx 0;
}

.input-bar {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 20rpx 30rpx;
  background: #fff;
  padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
}

.image-btn {
  flex-shrink: 0;
  padding: 14rpx 18rpx;
  border-radius: 30rpx;
  color: #666;
  background: #f0f1f3;
  font-size: 24rpx;
}

.image-btn.disabled {
  opacity: .55;
}

.msg-input {
  flex: 1;
  background: #f7f7f7;
  border-radius: 36rpx;
  padding: 16rpx 28rpx;
  font-size: 28rpx;
}

.send-btn {
  background: #e93323;
  color: #fff;
  font-size: 28rpx;
  padding: 14rpx 36rpx;
  border-radius: 36rpx;
}
</style>
