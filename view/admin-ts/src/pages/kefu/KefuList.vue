<template>
  <div class="kefu-page">
    <div class="page-head">
      <h2>客服会话</h2>
    </div>

    <el-row :gutter="16">
      <!-- 会话列表 -->
      <el-col :span="8">
        <div class="session-panel" v-loading="loading">
          <div
            v-for="s in sessions"
            :key="s.peerUid"
            class="session-item"
            :class="{ active: activeUid === s.peerUid }"
            @click="openChat(s)"
          >
            <div class="session-avatar">{{ (s.nickname || "客")[0] }}</div>
            <div class="session-info">
              <div class="session-name">
                {{ s.nickname }}
                <span v-if="s.phone" class="session-phone">{{ s.phone }}</span>
                <el-badge v-if="s.unread > 0" :value="s.unread" class="unread" />
              </div>
              <div class="session-msg">{{ s.msn }}</div>
              <div class="session-time">{{ formatTime(s.addTime) }}</div>
            </div>
          </div>
          <el-empty v-if="!sessions.length && !loading" description="暂无会话" />
        </div>
      </el-col>

      <!-- 聊天记录 -->
      <el-col :span="16">
        <div class="chat-panel">
          <div v-if="activeUid" class="chat-head">
            <div class="chat-head-main">
              与「{{ activeName }}」的对话
            </div>
            <div v-if="activeSession" class="user-panel">
              <span class="user-item">UID: {{ activeSession.peerUid }}</span>
              <span v-if="activeSession.phone" class="user-item">手机: {{ activeSession.phone }}</span>
              <span class="user-item">未读: {{ activeSession.unread }}</span>
            </div>
          </div>
          <div v-else class="chat-empty">选择左侧会话查看聊天记录</div>

          <div v-if="messages.length" class="chat-list">
            <div
              v-for="m in messages"
              :key="m.id"
              class="chat-item"
              :class="{ mine: m.uid === adminUid }"
            >
              <div class="chat-bubble">{{ m.msn }}</div>
              <div class="chat-time">{{ formatTime(m.addTime) }}</div>
            </div>
          </div>
          <el-empty v-else-if="activeUid" description="暂无聊天记录" />

          <!-- 回复输入 -->
          <div v-if="activeUid" class="reply-bar">
            <el-input
              v-model="replyText"
              placeholder="输入回复内容..."
              @keyup.enter="sendReply"
            />
            <el-button type="primary" @click="sendReply">发送</el-button>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { apiAdminChatSessions, apiAdminChatHistory, apiAdminServiceSend, type ChatSession, type ChatMessage } from "@/api/kefu";

const sessions = ref<ChatSession[]>([]);
const messages = ref<ChatMessage[]>([]);
const activeUid = ref(0);
const activeName = ref("");
const adminUid = ref(0);
const loading = ref(true);
const replyText = ref("");

const activeSession = computed(() =>
  sessions.value.find((s) => s.peerUid === activeUid.value) ?? null,
);

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadSessions() {
  loading.value = true;
  try {
    sessions.value = await apiAdminChatSessions();
    // admin uid 从会话推断 (取第一个消息中非 peer 的一方)
    if (sessions.value.length && !adminUid.value) {
      const first = await apiAdminChatHistory(sessions.value[0].peerUid);
      if (first.length) {
        adminUid.value = first[0].uid === sessions.value[0].peerUid ? first[0].toUid : first[0].uid;
      }
    }
  } catch (e) {
    ElMessage.error((e as Error).message || "加载失败");
  } finally {
    loading.value = false;
  }
}

async function openChat(s: ChatSession) {
  activeUid.value = s.peerUid;
  activeName.value = s.nickname;
  try {
    messages.value = await apiAdminChatHistory(s.peerUid);
  } catch (e) {
    ElMessage.error((e as Error).message || "加载失败");
  }
}

async function sendReply() {
  const text = replyText.value.trim();
  if (!text || !activeUid.value) return;
  try {
    await apiAdminServiceSend(activeUid.value, text);
    replyText.value = "";
    messages.value = await apiAdminChatHistory(activeUid.value);
  } catch (e) {
    ElMessage.error((e as Error).message || "发送失败");
  }
}

onMounted(loadSessions);
</script>

<style scoped>
.page-head h2 {
  font-size: 18px;
  margin: 0 0 16px;
}

.session-panel {
  background: #fff;
  border-radius: 8px;
  height: 70vh;
  overflow-y: auto;
}

.session-item {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid #f5f5f5;
  cursor: pointer;
  gap: 12px;
}

.session-item.active {
  background: #ecf5ff;
}

.session-avatar {
  width: 40px;
  height: 40px;
  background: #409eff;
  color: #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.session-info {
  flex: 1;
  min-width: 0;
}

.session-name {
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.session-phone {
  font-size: 11px;
  color: #999;
  font-weight: 400;
}

.session-msg {
  font-size: 12px;
  color: #999;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 4px;
}

.session-time {
  font-size: 11px;
  color: #ccc;
  margin-top: 2px;
}

.chat-panel {
  background: #fff;
  border-radius: 8px;
  height: 70vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-head {
  padding: 14px 20px;
  border-bottom: 1px solid #f0f0f0;
  font-weight: 600;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.user-panel {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #666;
  font-weight: 400;
}

.user-item {
  background: #f5f7fa;
  padding: 4px 10px;
  border-radius: 4px;
}

.chat-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #999;
}

.chat-list {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.chat-item {
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
}

.chat-item.mine {
  align-items: flex-end;
}

.chat-bubble {
  max-width: 70%;
  padding: 10px 14px;
  border-radius: 8px;
  background: #f0f2f5;
  font-size: 14px;
  word-break: break-all;
}

.chat-item.mine .chat-bubble {
  background: #409eff;
  color: #fff;
}

.chat-time {
  font-size: 11px;
  color: #ccc;
  margin-top: 4px;
}

.reply-bar {
  display: flex;
  gap: 12px;
  padding: 14px 20px;
  border-top: 1px solid #f0f0f0;
}
</style>
