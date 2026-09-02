<template>
  <div class="community-ops">
    <section class="hero-card">
      <div>
        <p class="eyebrow">COMMUNITY OPERATIONS</p>
        <h1>社区运营</h1>
        <p class="hero-copy">统一管理内容审核、话题目录和评论秩序，所有计数随操作原子校正。</p>
      </div>
      <div class="hero-actions">
        <el-button v-if="canManage" type="primary" @click="openPost()">发布平台内容</el-button>
        <el-button v-if="canManage" @click="openVirtualComment">添加虚拟评论</el-button>
      </div>
    </section>

    <el-tabs v-model="activeTab" class="ops-tabs" @tab-change="handleTabChange">
      <el-tab-pane label="内容审核" name="posts">
        <div class="metric-grid">
          <button
            v-for="item in postHeader"
            :key="item.is_verify"
            class="metric-card"
            :class="{ active: postFilters.is_verify === item.is_verify }"
            type="button"
            @click="selectVerify(item.is_verify)"
          >
            <span>{{ item.name }}</span>
            <strong>{{ item.count }}</strong>
          </button>
        </div>

        <el-card shadow="never" class="panel-card">
          <el-form class="filter-row" inline @submit.prevent="loadPosts">
            <el-form-item label="搜索">
              <el-input v-model="postFilters.keyword" clearable placeholder="标题或内容 ID" @keyup.enter="loadPosts" />
            </el-form-item>
            <el-form-item label="内容类型">
              <el-select v-model="postFilters.content_type" clearable placeholder="全部" style="width: 130px">
                <el-option label="图文" :value="1" />
                <el-option label="视频" :value="2" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="loadPosts">筛选</el-button>
              <el-button @click="resetPostFilters">重置</el-button>
            </el-form-item>
          </el-form>

          <el-table v-loading="postLoading" :data="posts" row-key="id">
            <el-table-column label="内容" min-width="290">
              <template #default="{ row }">
                <div class="content-cell">
                  <img :src="row.image || '/logo.png'" alt="" />
                  <div>
                    <strong>{{ row.title }}</strong>
                    <p>#{{ row.id }} · {{ row.author }} · {{ row.content_type === 2 ? "视频" : "图文" }}</p>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="数据" min-width="170">
              <template #default="{ row }">
                <div class="data-pills">
                  <span>赞 {{ row.like_num }}</span><span>评 {{ row.comment_num }}</span><span>看 {{ row.play_num }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="审核" width="128">
              <template #default="{ row }">
                <el-tag :type="verifyTag(row.is_verify)">{{ verifyText(row.is_verify) }}</el-tag>
                <p v-if="row.refusal" class="refusal" :title="row.refusal">{{ row.refusal }}</p>
              </template>
            </el-table-column>
            <el-table-column label="推荐" width="110">
              <template #default="{ row }">
                <el-rate :model-value="row.star" disabled size="small" />
                <el-tag v-if="row.is_recommend" size="small" type="warning">推荐</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="显示" width="88">
              <template #default="{ row }">
                <el-switch :model-value="row.status === 1" :disabled="!canManage" @change="togglePostStatus(row)" />
              </template>
            </el-table-column>
            <el-table-column label="发布时间" width="150">
              <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="248" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openPost(row)">编辑</el-button>
                <el-button v-if="canManage" link type="success" @click="openModeration(row, 1)">通过</el-button>
                <el-button v-if="canManage" link type="warning" @click="openModeration(row, -1)">拒绝</el-button>
                <el-dropdown v-if="canManage" @command="(cmd: string) => handlePostCommand(row, cmd)">
                  <el-button link type="primary">更多</el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="recommend">{{ row.is_recommend ? "取消推荐" : "设为推荐" }}</el-dropdown-item>
                      <el-dropdown-item command="star">设置星级</el-dropdown-item>
                      <el-dropdown-item command="take-down">强制下架</el-dropdown-item>
                      <el-dropdown-item command="delete" divided>删除内容</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            class="pagination"
            layout="total, prev, pager, next"
            :total="postTotal"
            :page-size="postFilters.limit"
            :current-page="postFilters.page"
            @current-change="(page: number) => { postFilters.page = page; loadPosts(); }"
          />
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="话题目录" name="topics">
        <el-card shadow="never" class="panel-card">
          <div class="panel-toolbar">
            <el-input v-model="topicFilters.name" clearable placeholder="搜索话题" style="max-width: 280px" @keyup.enter="loadTopics" />
            <div>
              <el-button @click="loadTopics">查询</el-button>
              <el-button v-if="canManage" type="primary" @click="openTopic()">新建话题</el-button>
            </div>
          </div>
          <el-table v-loading="topicLoading" :data="topics" row-key="id">
            <el-table-column prop="id" label="ID" width="80" />
            <el-table-column prop="name" label="话题" min-width="200">
              <template #default="{ row }"><strong># {{ row.name }}</strong></template>
            </el-table-column>
            <el-table-column prop="community_num" label="关联内容" width="110" />
            <el-table-column prop="sort" label="排序" width="90" />
            <el-table-column label="推荐" width="90">
              <template #default="{ row }"><el-switch :model-value="row.is_recommend === 1" :disabled="!canManage" @change="toggleTopicRecommend(row)" /></template>
            </el-table-column>
            <el-table-column label="显示" width="90">
              <template #default="{ row }"><el-switch :model-value="row.status === 1" :disabled="!canManage" @change="toggleTopicStatus(row)" /></template>
            </el-table-column>
            <el-table-column label="创建时间" width="170">
              <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button link type="primary" @click="openTopic(row)">编辑</el-button>
                <el-button v-if="canManage" link type="danger" @click="deleteTopic(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            class="pagination"
            layout="total, prev, pager, next"
            :total="topicTotal"
            :page-size="topicFilters.limit"
            :current-page="topicFilters.page"
            @current-change="(page: number) => { topicFilters.page = page; loadTopics(); }"
          />
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="评论治理" name="comments">
        <el-card shadow="never" class="panel-card">
          <el-form class="filter-row" inline @submit.prevent="loadComments">
            <el-form-item label="搜索">
              <el-input v-model="commentFilters.keyword" clearable placeholder="评论内容" @keyup.enter="loadComments" />
            </el-form-item>
            <el-form-item label="审核">
              <el-select v-model="commentFilters.is_verify" clearable placeholder="全部" style="width: 140px">
                <el-option label="已通过" :value="1" /><el-option label="待审核" :value="0" />
                <el-option label="已拒绝" :value="-1" /><el-option label="已下架" :value="-2" />
              </el-select>
            </el-form-item>
            <el-form-item><el-button type="primary" @click="loadComments">筛选</el-button></el-form-item>
          </el-form>
          <el-table v-loading="commentLoading" :data="comments" row-key="id">
            <el-table-column label="评论" min-width="310">
              <template #default="{ row }">
                <div class="comment-cell">
                  <div class="avatar">{{ row.author.slice(0, 1) }}</div>
                  <div><strong>{{ row.author }}</strong><p>{{ row.content }}</p><small>#{{ row.id }} · {{ formatTime(row.add_time) }}</small></div>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="community_title" label="所属内容" min-width="190" show-overflow-tooltip />
            <el-table-column label="互动" width="110">
              <template #default="{ row }">{{ row.like_num }} 赞 · {{ row.comment_num }} 回复</template>
            </el-table-column>
            <el-table-column label="审核" width="110">
              <template #default="{ row }"><el-tag :type="verifyTag(row.is_verify)">{{ verifyText(row.is_verify) }}</el-tag></template>
            </el-table-column>
            <el-table-column label="显示" width="88">
              <template #default="{ row }"><el-switch :model-value="row.is_show === 1" :disabled="!canManage" @change="toggleCommentStatus(row)" /></template>
            </el-table-column>
            <el-table-column label="操作" width="238" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.comment_num || row.verify_count" link type="primary" @click="showReplies(row)">回复列表</el-button>
                <el-button v-if="canManage" link type="primary" @click="replyTo(row)">回复</el-button>
                <el-button v-if="canManage" link type="success" @click="verifyComment(row, 1)">通过</el-button>
                <el-button v-if="canManage" link type="warning" @click="verifyComment(row, -1)">拒绝</el-button>
                <el-button v-if="canManage" link type="danger" @click="deleteComment(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            class="pagination"
            layout="total, prev, pager, next"
            :total="commentTotal"
            :page-size="commentFilters.limit"
            :current-page="commentFilters.page"
            @current-change="(page: number) => { commentFilters.page = page; loadComments(); }"
          />
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="社区设置" name="settings">
        <el-card v-loading="settingsLoading" shadow="never" class="panel-card settings-panel">
          <div class="settings-heading">
            <div>
              <h2>社区开关与审核策略</h2>
              <p>保存后会核验数据库写入并清除用户端配置缓存。</p>
            </div>
            <el-button
              v-if="canManage"
              type="primary"
              :loading="settingsSaving"
              :disabled="settingsDuplicateKeys.length > 0"
              @click="saveSettings"
            >保存设置</el-button>
          </div>
          <el-alert
            v-if="settingsDuplicateKeys.length"
            type="error"
            :closable="false"
            show-icon
            :title="`检测到重复历史配置：${settingsDuplicateKeys.join('、')}。为防止改错记录，保存已停用。`"
          />
          <el-alert
            v-else-if="settingsMissingKeys.length"
            type="warning"
            :closable="false"
            show-icon
            :title="`缺少 ${settingsMissingKeys.length} 项历史配置；首次保存时会安全创建。`"
          />
          <div class="settings-grid">
            <article v-for="item in settingDefinitions" :key="item.key" class="setting-card">
              <div>
                <strong>{{ item.label }}</strong>
                <p>{{ item.description }}</p>
              </div>
              <el-switch
                v-model="settings[item.key]"
                :active-value="1"
                :inactive-value="0"
                :disabled="!canManage || settingsDuplicateKeys.length > 0"
              />
            </article>
          </div>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="postDialog" :title="postForm.id ? '编辑社区内容' : '发布平台内容'" width="min(760px, 94vw)">
      <el-form label-position="top" class="dialog-form">
        <el-form-item label="标题" required><el-input v-model="postForm.title" maxlength="255" show-word-limit /></el-form-item>
        <div class="form-grid">
          <el-form-item label="内容类型"><el-radio-group v-model="postForm.content_type"><el-radio-button :value="1">图文</el-radio-button><el-radio-button :value="2">视频</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="关联话题" required><el-select v-model="postForm.topic_id" multiple filterable style="width: 100%"><el-option v-for="topic in topicOptions" :key="topic.id" :label="topic.name" :value="topic.id" /></el-select></el-form-item>
        </div>
        <el-form-item label="正文"><el-input v-model="postForm.content" type="textarea" :rows="5" maxlength="200000" /></el-form-item>
        <div class="form-grid">
          <el-form-item label="封面地址"><el-input v-model="postForm.image" /></el-form-item>
          <el-form-item v-if="postForm.content_type === 2" label="视频地址" required><el-input v-model="postForm.video_url" /></el-form-item>
        </div>
        <el-form-item label="图集地址（每行一个）"><el-input v-model="postForm.slider_text" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="商品 ID（逗号分隔）"><el-input v-model="postForm.product_text" placeholder="301,302" /></el-form-item>
        <div class="form-grid form-grid-4">
          <el-form-item label="推荐"><el-switch v-model="postForm.is_recommend" :active-value="1" :inactive-value="0" /></el-form-item>
          <el-form-item label="显示"><el-switch v-model="postForm.status" :active-value="1" :inactive-value="0" /></el-form-item>
          <el-form-item label="星级"><el-rate v-model="postForm.star" /></el-form-item>
          <el-form-item label="排序"><el-input-number v-model="postForm.sort" controls-position="right" /></el-form-item>
        </div>
      </el-form>
      <template #footer><el-button @click="postDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="savePost">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="topicDialog" :title="topicForm.id ? '编辑话题' : '新建话题'" width="min(500px, 92vw)">
      <el-form label-position="top">
        <el-form-item label="话题名称" required><el-input v-model="topicForm.name" maxlength="20" show-word-limit /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="topicForm.sort" /></el-form-item>
        <div class="switch-row"><span>推荐 <el-switch v-model="topicForm.is_recommend" :active-value="1" :inactive-value="0" /></span><span>显示 <el-switch v-model="topicForm.status" :active-value="1" :inactive-value="0" /></span></div>
      </el-form>
      <template #footer><el-button @click="topicDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveTopic">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="moderationDialog" :title="moderationForm.status === 1 ? '审核通过' : moderationForm.status === -2 ? '强制下架' : '拒绝内容'" width="min(500px, 92vw)">
      <p class="dialog-hint">{{ moderationForm.title }}</p>
      <el-input v-if="moderationForm.status < 0" v-model="moderationForm.refusal" type="textarea" :rows="4" maxlength="255" show-word-limit placeholder="请填写原因" />
      <template #footer><el-button @click="moderationDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="submitModeration">确认</el-button></template>
    </el-dialog>

    <el-dialog v-model="replyDialog" title="回复评论" width="min(520px, 92vw)">
      <p class="dialog-hint">回复 {{ replyForm.author }}：{{ replyForm.quote }}</p>
      <el-input v-model="replyForm.content" type="textarea" :rows="4" maxlength="1000" show-word-limit />
      <template #footer><el-button @click="replyDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="submitReply">回复</el-button></template>
    </el-dialog>

    <el-dialog v-model="virtualDialog" title="添加虚拟评论" width="min(560px, 92vw)">
      <el-form label-position="top">
        <el-form-item label="社区内容 ID" required><el-input-number v-model="virtualForm.community_id" :min="1" /></el-form-item>
        <el-form-item label="评论身份"><el-radio-group v-model="virtualForm.type"><el-radio :value="0">平台</el-radio><el-radio :value="3">虚拟用户</el-radio></el-radio-group></el-form-item>
        <el-form-item v-if="virtualForm.type === 3" label="虚拟昵称" required><el-input v-model="virtualForm.nickname" maxlength="64" /></el-form-item>
        <el-form-item v-if="virtualForm.type === 3" label="头像地址"><el-input v-model="virtualForm.avatar" /></el-form-item>
        <el-form-item label="评论内容" required><el-input v-model="virtualForm.content" type="textarea" :rows="4" maxlength="1000" show-word-limit /></el-form-item>
      </el-form>
      <template #footer><el-button @click="virtualDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveVirtualComment">添加</el-button></template>
    </el-dialog>

    <el-dialog v-model="repliesDialog" title="评论回复" width="min(720px, 94vw)">
      <el-table :data="replies" empty-text="暂无回复">
        <el-table-column prop="author" label="作者" width="120" /><el-table-column prop="content" label="内容" min-width="260" />
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="verifyTag(row.is_verify)">{{ verifyText(row.is_verify) }}</el-tag></template></el-table-column>
        <el-table-column label="时间" width="150"><template #default="{ row }">{{ formatTime(row.add_time) }}</template></el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import {
  apiCommunityAllTopics,
  apiCommunityCommentDelete,
  apiCommunityCommentReplies,
  apiCommunityCommentReply,
  apiCommunityComments,
  apiCommunityCommentStatus,
  apiCommunityCommentVerify,
  apiCommunityFictitiousComment,
  apiCommunityPostDelete,
  apiCommunityPostHeader,
  apiCommunityPostInfo,
  apiCommunityPostRecommend,
  apiCommunityPosts,
  apiCommunityPostSave,
  apiCommunityPostStar,
  apiCommunityPostStatus,
  apiCommunityPostVerify,
  apiCommunitySettings,
  apiCommunitySettingsSave,
  apiCommunityTopicDelete,
  apiCommunityTopicRecommend,
  apiCommunityTopics,
  apiCommunityTopicSave,
  apiCommunityTopicStatus,
  type CommunityComment,
  type CommunityPost,
  type CommunitySettings,
  type CommunityTopic,
} from "@/api/community";

const authStore = useAuthStore();
const previewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
const canManage = computed(() => previewMode || authStore.userInfo?.level === 0 || authStore.uniqueAuth.includes("community.manage"));
const activeTab = ref("posts");
const saving = ref(false);

const postLoading = ref(false);
const posts = ref<CommunityPost[]>([]);
const postTotal = ref(0);
const postHeader = ref<Array<{ is_verify: number; name: string; count: number }>>([]);
const postFilters = reactive({ page: 1, limit: 20, keyword: "", is_verify: undefined as number | undefined, content_type: undefined as number | undefined });

const topicLoading = ref(false);
const topics = ref<CommunityTopic[]>([]);
const topicTotal = ref(0);
const topicOptions = ref<Array<{ id: number; name: string }>>([]);
const topicFilters = reactive({ page: 1, limit: 20, name: "" });

const commentLoading = ref(false);
const comments = ref<CommunityComment[]>([]);
const commentTotal = ref(0);
const commentFilters = reactive({ page: 1, limit: 20, keyword: "", field_key: "comment", is_verify: undefined as number | undefined, is_reply: 1 });

const postDialog = ref(false);
const topicDialog = ref(false);
const moderationDialog = ref(false);
const replyDialog = ref(false);
const virtualDialog = ref(false);
const repliesDialog = ref(false);
const replies = ref<CommunityComment[]>([]);

const postForm = reactive({ id: 0, title: "", content: "", content_type: 1, image: "", video_url: "", slider_text: "", topic_id: [] as number[], product_text: "", status: 1, is_recommend: 1, star: 3, sort: 0 });
const topicForm = reactive({ id: 0, name: "", sort: 0, is_recommend: 0, status: 1 });
const moderationForm = reactive({ id: 0, title: "", status: 1, refusal: "" });
const replyForm = reactive({ id: 0, author: "", quote: "", content: "" });
const virtualForm = reactive({ community_id: 0, type: 3, nickname: "", avatar: "", content: "" });
const settingsLoading = ref(false);
const settingsSaving = ref(false);
const settingsLoaded = ref(false);
const settingsMissingKeys = ref<Array<keyof CommunitySettings>>([]);
const settingsDuplicateKeys = ref<Array<keyof CommunitySettings>>([]);
const settings = reactive<CommunitySettings>({
  community_status: 1,
  community_verify: 1,
  community_video_verify: 1,
  community_comment_status: 1,
  community_comment_add: 1,
  community_comment_verify: 0,
});
const settingDefinitions: Array<{ key: keyof CommunitySettings; label: string; description: string }> = [
  { key: "community_status", label: "启用社区", description: "控制用户端社区入口与社区内容访问。" },
  { key: "community_verify", label: "图文内容审核", description: "用户发布的图文内容先进入后台审核。" },
  { key: "community_video_verify", label: "视频内容审核", description: "用户发布的视频内容先进入后台审核。" },
  { key: "community_comment_status", label: "启用评论", description: "允许用户查看社区内容下的评论。" },
  { key: "community_comment_add", label: "允许发表评论", description: "允许用户提交新的社区评论。" },
  { key: "community_comment_verify", label: "评论审核", description: "新评论审核通过后才对外显示。" },
];

function verifyText(value: number) { return value === 1 ? "已通过" : value === 0 ? "待审核" : value === -1 ? "已拒绝" : "已下架"; }
function verifyTag(value: number): "success" | "info" | "warning" | "danger" { return value === 1 ? "success" : value === 0 ? "info" : value === -1 ? "warning" : "danger"; }
function formatTime(value: number) { return value ? new Date(value * 1000).toLocaleString("zh-CN", { hour12: false }) : "-"; }

async function loadPosts() {
  postLoading.value = true;
  try {
    const [page, header] = await Promise.all([apiCommunityPosts(postFilters), apiCommunityPostHeader(postFilters)]);
    posts.value = page.list;
    postTotal.value = page.count;
    postHeader.value = header;
  } finally { postLoading.value = false; }
}

async function loadTopics() {
  topicLoading.value = true;
  try { const result = await apiCommunityTopics(topicFilters); topics.value = result.list; topicTotal.value = result.count; }
  finally { topicLoading.value = false; }
}

async function loadComments() {
  commentLoading.value = true;
  try { const result = await apiCommunityComments(commentFilters); comments.value = result.list; commentTotal.value = result.count; }
  finally { commentLoading.value = false; }
}

async function loadSettings() {
  settingsLoading.value = true;
  try {
    const result = await apiCommunitySettings();
    Object.assign(settings, result.settings);
    settingsMissingKeys.value = result.missing_keys;
    settingsDuplicateKeys.value = result.duplicate_keys;
    settingsLoaded.value = true;
  } finally { settingsLoading.value = false; }
}

async function saveSettings() {
  if (!canManage.value || settingsDuplicateKeys.value.length) return;
  settingsSaving.value = true;
  try {
    const result = await apiCommunitySettingsSave({ ...settings });
    if (!result.verified) {
      ElMessage.error("保存结果未通过回读核验，请重试");
      return;
    }
    Object.assign(settings, result.settings);
    settingsMissingKeys.value = result.missing_keys;
    settingsDuplicateKeys.value = result.duplicate_keys;
    ElMessage.success("社区设置已保存并生效");
  } finally { settingsSaving.value = false; }
}

function handleTabChange(name: string | number) {
  if (name === "topics" && !topics.value.length) void loadTopics();
  if (name === "comments" && !comments.value.length) void loadComments();
  if (name === "settings" && !settingsLoaded.value) void loadSettings();
}

function selectVerify(value: number) { postFilters.is_verify = postFilters.is_verify === value ? undefined : value; postFilters.page = 1; void loadPosts(); }
function resetPostFilters() { postFilters.keyword = ""; postFilters.is_verify = undefined; postFilters.content_type = undefined; postFilters.page = 1; void loadPosts(); }

async function ensureTopicOptions() {
  if (!topicOptions.value.length) topicOptions.value = await apiCommunityAllTopics();
}

async function openPost(row?: CommunityPost) {
  await ensureTopicOptions();
  const item = row ? await apiCommunityPostInfo(row.id) : null;
  Object.assign(postForm, item ? {
    id: item.id, title: item.title, content: item.content, content_type: item.content_type,
    image: item.image, video_url: item.video_url, slider_text: item.slider_image.join("\n"),
    topic_id: [...item.topic_id], product_text: item.product_id.join(","), status: item.status,
    is_recommend: item.is_recommend, star: item.star, sort: item.sort,
  } : { id: 0, title: "", content: "", content_type: 1, image: "", video_url: "", slider_text: "", topic_id: [], product_text: "", status: 1, is_recommend: 1, star: 3, sort: 0 });
  postDialog.value = true;
}

async function savePost() {
  if (!postForm.title.trim()) return ElMessage.warning("请填写标题");
  if (!postForm.topic_id.length) return ElMessage.warning("请至少选择一个话题");
  if (postForm.content_type === 2 && !postForm.video_url.trim()) return ElMessage.warning("请填写视频地址");
  saving.value = true;
  try {
    await apiCommunityPostSave(postForm.id, {
      title: postForm.title, content: postForm.content, content_type: postForm.content_type,
      image: postForm.image, video_url: postForm.video_url,
      slider_image: postForm.slider_text.split("\n").map((value) => value.trim()).filter(Boolean),
      topic_id: postForm.topic_id,
      product_id: postForm.product_text.split(",").map(Number).filter((value) => Number.isSafeInteger(value) && value > 0),
      status: postForm.status, is_recommend: postForm.is_recommend, star: postForm.star, sort: postForm.sort,
    });
    postDialog.value = false;
    ElMessage.success("社区内容已保存");
    await loadPosts();
  } finally { saving.value = false; }
}

async function togglePostStatus(row: CommunityPost) { await apiCommunityPostStatus(row.id, row.status ? 0 : 1); await loadPosts(); }
function openModeration(row: CommunityPost, status: number) { Object.assign(moderationForm, { id: row.id, title: row.title, status, refusal: "" }); moderationDialog.value = true; }
async function submitModeration() {
  if (moderationForm.status < 0 && !moderationForm.refusal.trim()) return ElMessage.warning("请填写原因");
  saving.value = true;
  try { await apiCommunityPostVerify(moderationForm.id, moderationForm.status, moderationForm.refusal); moderationDialog.value = false; ElMessage.success("审核状态已更新"); await loadPosts(); }
  finally { saving.value = false; }
}

async function handlePostCommand(row: CommunityPost, command: string) {
  if (command === "recommend") { await apiCommunityPostRecommend(row.id, row.is_recommend ? 0 : 1); await loadPosts(); return; }
  if (command === "star") {
    const result = await ElMessageBox.prompt("输入 1–5 的推荐指数", "设置星级", { inputValue: String(row.star), inputPattern: /^[1-5]$/, inputErrorMessage: "请输入 1–5" });
    await apiCommunityPostStar(row.id, Number(result.value)); await loadPosts(); return;
  }
  if (command === "take-down") { openModeration(row, -2); return; }
  if (command === "delete") {
    await ElMessageBox.confirm("删除后帖子、评论和互动关系会一并退出运行时，确认继续？", "删除社区内容", { type: "warning" });
    await apiCommunityPostDelete(row.id); ElMessage.success("已删除"); await loadPosts();
  }
}

function openTopic(row?: CommunityTopic) { Object.assign(topicForm, row ? { id: row.id, name: row.name, sort: row.sort, is_recommend: row.is_recommend, status: row.status } : { id: 0, name: "", sort: 0, is_recommend: 0, status: 1 }); topicDialog.value = true; }
async function saveTopic() { if (!topicForm.name.trim()) return ElMessage.warning("请填写话题名称"); saving.value = true; try { await apiCommunityTopicSave(topicForm.id, topicForm); topicDialog.value = false; topicOptions.value = []; ElMessage.success("话题已保存"); await loadTopics(); } finally { saving.value = false; } }
async function toggleTopicStatus(row: CommunityTopic) { await apiCommunityTopicStatus(row.id, row.status ? 0 : 1); await loadTopics(); }
async function toggleTopicRecommend(row: CommunityTopic) { await apiCommunityTopicRecommend(row.id, row.is_recommend ? 0 : 1); await loadTopics(); }
async function deleteTopic(row: CommunityTopic) { await ElMessageBox.confirm(`确认删除话题「${row.name}」？历史帖子不会删除。`, "删除话题", { type: "warning" }); await apiCommunityTopicDelete(row.id); topicOptions.value = []; await loadTopics(); }

function replyTo(row: CommunityComment) { Object.assign(replyForm, { id: row.id, author: row.author, quote: row.content, content: "" }); replyDialog.value = true; }
async function submitReply() { if (!replyForm.content.trim()) return ElMessage.warning("请输入回复内容"); saving.value = true; try { await apiCommunityCommentReply(replyForm.id, replyForm.content); replyDialog.value = false; ElMessage.success("回复成功"); await loadComments(); } finally { saving.value = false; } }
async function showReplies(row: CommunityComment) { replies.value = (await apiCommunityCommentReplies(row.id)).list; repliesDialog.value = true; }
async function toggleCommentStatus(row: CommunityComment) { await apiCommunityCommentStatus(row.id, row.is_show ? 0 : 1); await loadComments(); }
async function verifyComment(row: CommunityComment, status: number) { await apiCommunityCommentVerify(row.id, status); ElMessage.success("评论状态已更新"); await loadComments(); }
async function deleteComment(row: CommunityComment) { await ElMessageBox.confirm("删除一级评论时，其全部回复也会删除，确认继续？", "删除评论", { type: "warning" }); await apiCommunityCommentDelete(row.id); await loadComments(); }
function openVirtualComment() { Object.assign(virtualForm, { community_id: posts.value[0]?.id ?? 0, type: 3, nickname: "", avatar: "", content: "" }); virtualDialog.value = true; }
async function saveVirtualComment() { if (!virtualForm.community_id || !virtualForm.content.trim()) return ElMessage.warning("请填写内容 ID 和评论内容"); if (virtualForm.type === 3 && !virtualForm.nickname.trim()) return ElMessage.warning("请填写虚拟昵称"); saving.value = true; try { await apiCommunityFictitiousComment(virtualForm); virtualDialog.value = false; ElMessage.success("虚拟评论已添加"); if (activeTab.value === "comments") await loadComments(); } finally { saving.value = false; } }

onMounted(() => { void loadPosts(); });
</script>

<style scoped>
.community-ops { display: grid; min-width: 0; gap: 18px; color: #1d2939; }
.hero-card { position: relative; overflow: hidden; display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 150px; padding: 28px 32px; color: #fff; border-radius: 18px; background: radial-gradient(circle at 80% 0%, rgba(255,255,255,.24), transparent 30%), linear-gradient(135deg, #102a43, #0e7490 58%, #14b8a6); box-shadow: 0 18px 44px rgba(15,118,110,.18); }
.hero-card::after { content: "#"; position: absolute; right: 34px; bottom: -72px; font-size: 210px; font-weight: 800; color: rgba(255,255,255,.07); pointer-events: none; }
.eyebrow { margin: 0 0 7px; font-size: 11px; letter-spacing: .18em; opacity: .76; }
.hero-card h1 { margin: 0; font-size: 30px; letter-spacing: -.02em; }
.hero-copy { max-width: 620px; margin: 10px 0 0; color: rgba(255,255,255,.78); }
.hero-actions { z-index: 1; display: flex; gap: 10px; flex-wrap: wrap; }
.hero-actions :deep(.el-button:not(.el-button--primary)) { color: #0f766e; border-color: rgba(255,255,255,.8); background: rgba(255,255,255,.92); }
.ops-tabs { padding: 0 2px; }
.metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
.metric-card { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px; border: 1px solid #e4e7ec; border-radius: 14px; color: #475467; background: #fff; cursor: pointer; transition: .2s ease; }
.metric-card strong { font-size: 26px; color: #101828; }
.metric-card:hover, .metric-card.active { border-color: #0d9488; transform: translateY(-1px); box-shadow: 0 10px 26px rgba(15,118,110,.1); }
.metric-card.active { background: #f0fdfa; }
.panel-card { border: 0; border-radius: 16px; }
.panel-card :deep(.el-card__body) { min-width: 0; }
.panel-card :deep(.el-table) { max-width: 100%; }
.filter-row, .panel-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.filter-row :deep(.el-form-item) { margin-bottom: 12px; }
.panel-toolbar { margin-bottom: 18px; }
.content-cell, .comment-cell { display: flex; align-items: center; gap: 12px; min-width: 0; }
.content-cell img { width: 52px; height: 52px; border-radius: 12px; object-fit: cover; background: #f2f4f7; }
.content-cell strong, .comment-cell strong { display: block; color: #101828; }
.content-cell p, .comment-cell p { margin: 5px 0 0; color: #667085; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.avatar { display: grid; flex: 0 0 38px; height: 38px; place-items: center; border-radius: 50%; color: #0f766e; font-weight: 700; background: #ccfbf1; }
.comment-cell > div:last-child { min-width: 0; }
.comment-cell small { color: #98a2b3; }
.data-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.data-pills span { padding: 3px 7px; border-radius: 999px; color: #475467; background: #f2f4f7; font-size: 12px; }
.refusal { max-width: 110px; margin: 5px 0 0; color: #b42318; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pagination { justify-content: flex-end; margin-top: 18px; }
.dialog-form { max-height: 64vh; overflow: auto; padding-right: 6px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.form-grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.switch-row { display: flex; gap: 32px; padding: 8px 0; }
.switch-row span { display: flex; align-items: center; gap: 12px; }
.dialog-hint { margin: 0 0 16px; padding: 12px 14px; border-radius: 10px; color: #475467; background: #f2f4f7; }
.settings-panel :deep(.el-alert) { margin: 0 0 16px; }
.settings-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 18px; }
.settings-heading h2 { margin: 0; color: #101828; font-size: 20px; }
.settings-heading p { margin: 7px 0 0; color: #667085; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.setting-card { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-width: 0; padding: 18px; border: 1px solid #e4e7ec; border-radius: 13px; background: #fdfefe; }
.setting-card strong { color: #101828; }
.setting-card p { margin: 6px 0 0; color: #667085; font-size: 13px; line-height: 1.55; }

@media (max-width: 900px) {
  .hero-card { align-items: flex-start; flex-direction: column; padding: 24px; }
  .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .settings-grid { grid-template-columns: 1fr; }
  .form-grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 560px) {
  .community-ops {
    width: calc(100vw - 84px);
    max-width: calc(100vw - 84px);
    gap: 12px;
    overflow: hidden;
  }
  .hero-card {
    display: grid;
    width: 100%;
    max-width: 100%;
    min-height: 0;
    grid-template-columns: minmax(0, 1fr);
    border-radius: 14px;
    box-sizing: border-box;
    padding: 20px;
  }
  .hero-card > div { width: 100%; max-width: 100%; min-width: 0; }
  .hero-card h1 { font-size: 25px; }
  .hero-copy { width: 100%; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
  .hero-actions { display: grid; width: 100%; grid-template-columns: 1fr; }
  .hero-actions :deep(.el-button) { width: 100%; min-width: 0; margin-left: 0; }
  .ops-tabs, .metric-grid, .panel-card { width: 100%; max-width: 100%; min-width: 0; }
  .ops-tabs :deep(.el-tabs__content), .panel-card :deep(.el-card__body) { max-width: 100%; overflow: hidden; }
  .metric-grid { grid-template-columns: 1fr; gap: 8px; }
  .metric-card { padding: 13px; }
  .metric-card strong { font-size: 21px; }
  .form-grid, .form-grid-4 { grid-template-columns: 1fr; gap: 0; }
  .panel-toolbar > div { display: flex; width: 100%; }
  .panel-toolbar > div :deep(.el-button) { flex: 1; }
  .pagination { justify-content: center; }
  .settings-heading { align-items: stretch; flex-direction: column; }
  .settings-heading :deep(.el-button) { width: 100%; margin-left: 0; }
  .setting-card { padding: 14px; }
}
</style>
