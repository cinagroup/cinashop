<template>
  <view class="kefu-page">
    <!-- 消息列表 -->
    <scroll-view scroll-y class="msg-scroll" :scroll-into-view="lastMsgId">
      <view v-if="messages.length" class="msg-list">
        <view
          v-for="m in messages"
          :key="(m as any).id || (m as any).time"
          :id="`msg-${(m as any).id || (m as any).time}`"
          class="msg-item"
          :class="{ mine: (m as any).mine }"
        >
          <view class="bubble">{{ (m as any).msn || (m as any).content }}</view>
          <view class="msg-time">{{ formatTime((m as any).addTime) }}</view>
        </view>
      </view>
      <view v-else class="empty">联系客服, 我们会尽快回复您</view>
    </scroll-view>

    <!-- 输入栏 -->
    <view class="input-bar">
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
import { http } from "@/utils/request";

const authStore = useAuthStore();
const messages = ref<any[]>([]);
const inputText = ref("");
let socket: UniApp.SocketTask | null = null;

const lastMsgId = computed(() => {
  const last = messages.value[messages.value.length - 1];
  return last ? `msg-${last.id || last.time}` : "";
});

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadHistory() {
  try {
    const rows = await http.get<any[]>("/service/chat_history", { to_uid: 0 });
    messages.value = rows.map((r: any) => ({
      id: r.id,
      msn: r.msn,
      addTime: r.addTime,
      mine: r.uid === authStore.uid,
    }));
  } catch {
    messages.value = [];
  }
}

function connect() {
  if (!authStore.uid || socket) return;
  // v1Routes 挂载在 /api 前缀 → WS 端点为 /api/ws/kefu
  let wsUrl = `wss://cinashop-api.cinagroup.workers.dev/api/ws/kefu?uid=${authStore.uid}&type=1&to_uid=0`;
  // #ifdef H5
  wsUrl = `wss://cinashop-api.cinagroup.workers.dev/api/ws/kefu?uid=${authStore.uid}&type=1&to_uid=0`;
  // #endif
  socket = uni.connectSocket({
    url: wsUrl,
    success: () => {
      // 发送登录
      if (socket) {
        socket.send({
          data: JSON.stringify({ type: "login", data: { uid: authStore.uid, type: 1 } }),
        });
      }
    },
  });
  socket.onMessage((res) => {
    try {
      const msg = JSON.parse(res.data as string);
      if (msg.type === "chat") {
        const d = msg.data;
        messages.value.push({
          id: `ws-${Date.now()}`,
          msn: d.msn,
          addTime: Math.floor(Date.now() / 1000),
          mine: false,
        });
      }
    } catch {
      // ignore
    }
  });
}

function send() {
  const text = inputText.value.trim();
  if (!text) return;
  // REST 持久化 (chat_save 链路, 保证落库)
  http.post<{ id: number }>("/service/send", { to_uid: 0, msn: text, msn_type: 1 }).catch(() => {});
  // WS 实时推送
  if (socket) {
    socket.send({
      data: JSON.stringify({
        type: "chat",
        data: { to_uid: 0, msn: text, msn_type: 1 },
      }),
    });
  }
  messages.value.push({
    id: `local-${Date.now()}`,
    msn: text,
    addTime: Math.floor(Date.now() / 1000),
    mine: true,
  });
  inputText.value = "";
}

onMounted(() => {
  loadHistory();
  connect();
});

onUnmounted(() => {
  if (socket) socket.close({});
});
</script>

<style scoped>
.kefu-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
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
