<template>
  <div class="community container">
    <div class="page-heading">
      <div>
        <h2 class="title">社区</h2>
        <p>发现内容，也维护你的好友、关注与粉丝关系。</p>
      </div>
    </div>

    <div class="community-layout">
      <main class="feed-column">
        <div v-if="highlights.length" class="highlight-strip" aria-label="关注动态">
          <button
            v-for="item in highlights"
            :key="item.relation_id"
            class="highlight-person"
            type="button"
            @click="socialTab = 'follow'"
          >
            <span class="avatar-shell">
              <el-avatar :size="44" :src="item.author_image">{{ item.author.slice(0, 1) }}</el-avatar>
              <i v-if="item.is_new" class="unread-dot" />
            </span>
            <span>{{ item.author }}</span>
          </button>
        </div>

        <el-card v-if="hasSocialAccess" shadow="never" class="post-box">
          <el-input v-model="postForm.title" placeholder="标题" class="post-title-input" />
          <el-input
            v-model="postForm.content"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            placeholder="分享你的生活..."
          />
          <div class="post-actions">
            <el-button type="primary" :loading="posting" @click="submitPost">发布</el-button>
          </div>
        </el-card>

        <div v-if="posts.length" class="post-list">
          <el-card v-for="post in posts" :key="post.id" shadow="never" class="post-card">
            <div class="post-header">
              <span class="post-title">{{ post.title || "分享" }}</span>
              <span class="post-time">{{ formatTime(post.addTime) }}</span>
            </div>
            <div class="post-content">{{ post.content }}</div>
            <div class="post-stats">
              <button class="stat" type="button" @click="like(post)">👍 {{ post.likeNum }}</button>
              <span class="stat-label">💬 {{ post.commentNum }}</span>
              <span class="stat-label">👁 {{ post.playNum }}</span>
            </div>
          </el-card>
        </div>
        <el-empty v-else-if="!loading" description="暂无内容" />
        <div v-if="loading" class="feed-loading"><el-skeleton :rows="4" animated /></div>
      </main>

      <aside class="social-panel">
        <template v-if="hasSocialAccess">
          <div class="social-heading">
            <div>
              <strong>社交关系</strong>
              <span>好友来自推广关系，互关状态单独显示</span>
            </div>
          </div>
          <el-tabs v-model="socialTab" stretch class="social-tabs">
            <el-tab-pane
              v-for="tab in socialTabs"
              :key="tab.key"
              :name="tab.key"
              :label="tab.label"
            />
          </el-tabs>
          <div v-loading="socialLoading" class="social-list">
            <div v-for="item in socialUsers" :key="`${socialTab}-${item.relation_id}`" class="social-person">
              <el-avatar :size="44" :src="item.author_image">{{ item.author.slice(0, 1) }}</el-avatar>
              <div class="social-copy">
                <strong>{{ item.author || "社区用户" }}</strong>
                <span>内容 {{ item.community_num }} · 粉丝 {{ item.fans_num }}</span>
              </div>
              <el-button
                :type="item.is_follow ? 'default' : 'primary'"
                size="small"
                round
                :loading="busyUid === item.relation_id"
                @click="toggleFollow(item)"
              >
                {{ followLabel(item) }}
              </el-button>
            </div>
            <el-empty v-if="!socialLoading && !socialUsers.length" :description="socialEmptyText" :image-size="72" />
          </div>
        </template>
        <template v-else>
          <el-empty description="登录后查看好友与关注" :image-size="96">
            <el-button type="primary" @click="router.push('/login')">去登录</el-button>
          </el-empty>
        </template>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useRouter } from "vue-router";
import dayjs from "dayjs";
import {
  apiCommunityFollowHighlights,
  apiCommunityFollowList,
  apiCommunityFriendList,
  apiCommunityLike,
  apiCommunityList,
  apiCommunityRecommendations,
  apiCommunitySave,
  apiCommunitySetInterest,
  communityPreviewMode,
  type CommunityPost,
  type CommunitySocialUser,
} from "@/api/community";
import { isLoggedIn } from "@/utils/auth";

type SocialTab = "friend" | "follow" | "fans" | "recommend";

const router = useRouter();
const hasSocialAccess = computed(() => isLoggedIn() || communityPreviewMode);
const posts = ref<CommunityPost[]>([]);
const loading = ref(true);
const posting = ref(false);
const postForm = ref({ title: "", content: "" });
const highlights = ref<Awaited<ReturnType<typeof apiCommunityFollowHighlights>>>([]);
const socialTab = ref<SocialTab>("friend");
const socialUsers = ref<CommunitySocialUser[]>([]);
const socialLoading = ref(false);
const busyUid = ref(0);
const socialTabs: Array<{ key: SocialTab; label: string }> = [
  { key: "friend", label: "好友" },
  { key: "follow", label: "关注" },
  { key: "fans", label: "粉丝" },
  { key: "recommend", label: "推荐" },
];

const socialEmptyText = computed(() => ({
  friend: "还没有好友",
  follow: "还没有关注任何人",
  fans: "还没有粉丝",
  recommend: "暂时没有推荐作者",
})[socialTab.value]);

function formatTime(ts: number): string {
  return ts ? dayjs(ts * 1000).format("MM-DD HH:mm") : "-";
}

function followLabel(item: CommunitySocialUser): string {
  if (item.is_follow === 1 && item.is_fans === 1) return "互相关注";
  if (item.is_follow === 1) return "已关注";
  if (item.is_fans === 1) return "回关";
  return "关注";
}

async function load() {
  loading.value = true;
  try {
    posts.value = await apiCommunityList(1, 10);
  } catch (error) {
    posts.value = [];
    ElMessage.error(error instanceof Error ? error.message : "社区内容加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadHighlights() {
  if (!hasSocialAccess.value) return;
  try {
    highlights.value = await apiCommunityFollowHighlights();
  } catch {
    highlights.value = [];
  }
}

async function loadSocial() {
  if (!hasSocialAccess.value) return;
  socialLoading.value = true;
  try {
    if (socialTab.value === "friend") socialUsers.value = await apiCommunityFriendList(1, 20);
    else if (socialTab.value === "recommend") socialUsers.value = await apiCommunityRecommendations(1, 20);
    else socialUsers.value = await apiCommunityFollowList(socialTab.value, 1, 20);
  } catch (error) {
    socialUsers.value = [];
    ElMessage.error(error instanceof Error ? error.message : "社交关系加载失败");
  } finally {
    socialLoading.value = false;
  }
}

async function submitPost() {
  if (!postForm.value.content.trim()) return ElMessage.error("请输入内容");
  posting.value = true;
  try {
    await apiCommunitySave({
      title: postForm.value.title.trim(),
      content: postForm.value.content.trim(),
      content_type: 1,
    });
    ElMessage.success("发布成功");
    postForm.value = { title: "", content: "" };
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "发布失败");
  } finally {
    posting.value = false;
  }
}

async function like(post: CommunityPost) {
  if (!hasSocialAccess.value) return ElMessage.warning("请先登录");
  try {
    const result = await apiCommunityLike(post.id, 1);
    post.likeNum = result.likeNum;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "操作失败");
  }
}

async function toggleFollow(item: CommunitySocialUser) {
  if (busyUid.value) return;
  const next: 0 | 1 = item.is_follow === 1 ? 0 : 1;
  if (next === 0) {
    try {
      await ElMessageBox.confirm(`确认不再关注 ${item.author || "该用户"}？`, "取消关注", {
        confirmButtonText: "确认取消",
        cancelButtonText: "保留关注",
        type: "warning",
      });
    } catch {
      return;
    }
  }
  busyUid.value = item.relation_id;
  try {
    const result = await apiCommunitySetInterest(item.relation_id, next);
    item.is_follow = result.is_follow;
    item.is_fans = result.is_fans;
    if (socialTab.value === "follow" && next === 0) {
      socialUsers.value = socialUsers.value.filter((row) => row.relation_id !== item.relation_id);
    }
    ElMessage.success(next === 1 ? "关注成功" : "已取消关注");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "操作失败");
  } finally {
    busyUid.value = 0;
  }
}

watch(socialTab, () => void loadSocial());
onMounted(() => {
  void load();
  void loadHighlights();
  void loadSocial();
});
</script>

<style scoped>
.community { padding-bottom: 40px; }
.page-heading { display: flex; justify-content: space-between; align-items: flex-end; margin: 28px 0 20px; }
.title { margin: 0; font-size: 26px; color: #202124; }
.page-heading p { margin: 7px 0 0; color: #8a8f98; font-size: 14px; }
.community-layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 22px; align-items: start; }
.feed-column { min-width: 0; }
.highlight-strip { display: flex; gap: 14px; overflow-x: auto; margin-bottom: 16px; padding: 16px 18px; border: 1px solid #ebeef5; border-radius: 12px; background: #fff; }
.highlight-person { display: grid; flex: 0 0 62px; gap: 6px; justify-items: center; border: 0; background: transparent; color: #606266; font: inherit; font-size: 12px; cursor: pointer; }
.avatar-shell { position: relative; }
.unread-dot { position: absolute; top: 0; right: 0; width: 9px; height: 9px; border: 2px solid #fff; border-radius: 50%; background: #ef3f36; }
.post-box { margin-bottom: 18px; border-radius: 12px; }
.post-title-input { margin-bottom: 10px; }
.post-actions { margin-top: 12px; text-align: right; }
.post-card { margin-bottom: 14px; border-radius: 12px; }
.post-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 9px; }
.post-title { min-width: 0; overflow: hidden; color: #303133; font-size: 17px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.post-time { flex: 0 0 auto; color: #a0a5ae; font-size: 12px; }
.post-content { margin-bottom: 14px; color: #555b65; line-height: 1.75; }
.post-stats { display: flex; align-items: center; gap: 20px; color: #737982; font-size: 13px; }
.stat { padding: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.stat:hover { color: #e64340; }
.stat-label { cursor: default; }
.feed-loading { padding: 22px; border: 1px solid #ebeef5; border-radius: 12px; background: #fff; }
.social-panel { position: sticky; top: 86px; min-height: 260px; padding: 20px; border: 1px solid #ebeef5; border-radius: 14px; background: #fff; box-sizing: border-box; }
.social-heading strong { display: block; color: #303133; font-size: 18px; }
.social-heading span { display: block; margin-top: 6px; color: #9aa0a9; font-size: 12px; line-height: 1.5; }
.social-tabs { margin-top: 10px; }
.social-list { min-height: 170px; }
.social-person { display: flex; align-items: center; gap: 11px; padding: 12px 0; border-bottom: 1px solid #f1f2f5; }
.social-person:last-child { border-bottom: 0; }
.social-copy { flex: 1; min-width: 0; }
.social-copy strong, .social-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.social-copy strong { color: #303133; font-size: 14px; }
.social-copy span { margin-top: 5px; color: #9aa0a9; font-size: 12px; }
@media (max-width: 900px) {
  .community-layout { grid-template-columns: 1fr; }
  .social-panel { position: static; grid-row: 1; }
}
@media (max-width: 560px) {
  .community { padding-inline: 14px; }
  .page-heading { margin-top: 20px; }
  .page-heading p { font-size: 12px; }
  .social-panel { padding: 16px 14px; }
  .social-person { gap: 9px; }
  .social-person :deep(.el-button) { padding-inline: 12px; }
  .highlight-strip { margin-inline: -2px; }
}
</style>
