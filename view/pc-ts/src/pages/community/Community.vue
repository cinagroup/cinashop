<template>
  <div class="community container">
    <h2 class="title">社区</h2>

    <!-- 发布框 -->
    <el-card shadow="never" class="post-box" v-if="isLoggedIn()">
      <el-input
        v-model="postForm.title"
        placeholder="标题"
        class="post-title"
      />
      <el-input
        v-model="postForm.content"
        type="textarea"
        :rows="3"
        placeholder="分享你的生活..."
      />
      <div class="post-actions">
        <el-button type="primary" :loading="posting" @click="submitPost">发布</el-button>
      </div>
    </el-card>

    <!-- 帖子列表 -->
    <div v-if="posts.length" class="post-list">
      <el-card v-for="post in posts" :key="post.id" shadow="never" class="post-card">
        <div class="post-header">
          <span class="post-title">{{ post.title || "分享" }}</span>
          <span class="post-time">{{ formatTime(post.addTime) }}</span>
        </div>
        <div class="post-content">{{ post.content }}</div>
        <div class="post-stats">
          <span class="stat" @click="like(post)">👍 {{ post.likeNum }}</span>
          <span class="stat">💬 {{ post.commentNum }}</span>
          <span class="stat">👁 {{ post.playNum }}</span>
        </div>
      </el-card>
    </div>
    <el-empty v-else-if="!loading" description="暂无内容" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import {
  apiCommunityList,
  apiCommunitySave,
  apiCommunityLike,
  type CommunityPost,
} from "@/api/community";
import { isLoggedIn } from "@/utils/auth";
import dayjs from "dayjs";

const posts = ref<CommunityPost[]>([]);
const loading = ref(true);
const posting = ref(false);
const postForm = ref({ title: "", content: "" });

function formatTime(ts: number): string {
  return ts ? dayjs(ts * 1000).format("MM-DD HH:mm") : "-";
}

async function load() {
  loading.value = true;
  try {
    posts.value = await apiCommunityList(1, 10);
  } finally {
    loading.value = false;
  }
}

async function submitPost() {
  if (!postForm.value.content) return ElMessage.error("请输入内容");
  posting.value = true;
  try {
    await apiCommunitySave({
      title: postForm.value.title,
      content: postForm.value.content,
      content_type: 1,
    });
    ElMessage.success("发布成功");
    postForm.value = { title: "", content: "" };
    load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "发布失败");
  } finally {
    posting.value = false;
  }
}

async function like(post: CommunityPost) {
  if (!isLoggedIn()) return ElMessage.warning("请先登录");
  try {
    await apiCommunityLike(post.id);
    post.likeNum += 1;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "操作失败");
  }
}

onMounted(load);
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.post-box {
  margin-bottom: 20px;
}

.post-title {
  margin-bottom: 10px;
}

.post-actions {
  text-align: right;
  margin-top: 10px;
}

.post-card {
  margin-bottom: 16px;
}

.post-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.post-title {
  font-size: 16px;
  font-weight: 600;
}

.post-time {
  color: #999;
  font-size: 12px;
}

.post-content {
  color: #555;
  line-height: 1.6;
  margin-bottom: 10px;
}

.post-stats {
  display: flex;
  gap: 20px;
  color: #666;
  font-size: 13px;
}

.stat {
  cursor: pointer;
}

.stat:hover {
  color: #e64340;
}
</style>
