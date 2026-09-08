<template>
  <div class="bargain container">
    <div class="head"><h2>砍价专区</h2><el-button @click="openMy">我的砍价</el-button></div>
    <el-button :disabled="loading" @click="load(page)">刷新商品列表</el-button>
    <p v-if="loading" role="status">正在加载砍价活动…</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-button v-if="error" :disabled="loading" @click="load(page)">重试商品列表</el-button>
    <div class="goods-grid">
      <router-link v-for="item in goods" :key="item.id" :to="`/bargain/${item.id}`" class="goods-card">
        <ProductImage :src="item.image" :alt="item.title" loading="lazy" />
        <div class="goods-info"><h3>{{ item.title }}</h3><p>起价 ¥{{ item.price }} · 可砍至 ¥{{ item.minimum }}</p><span>查看活动与参与</span></div>
      </router-link>
    </div>
    <el-empty v-if="!loading && !error && !goods.length" description="当前页暂无砍价商品" />
    <nav class="pagination" aria-label="砍价活动分页">
      <el-button :disabled="loading || page <= 1" @click="load(page - 1)">上一页</el-button><span>第 {{ page }} 页</span>
      <el-button :disabled="loading || !!error || goods.length < 20 || page >= 10000" @click="load(page + 1)">下一页</el-button>
    </nav>
    <el-dialog v-model="myVisible" title="我的砍价" width="min(620px, 94vw)" @closed="closeMy">
      <p v-if="myLoading" role="status">正在读取本人砍价记录…</p>
      <el-alert v-if="myError" :title="myError" type="error" :closable="false" />
      <el-button :disabled="myLoading || mutating !== 0" @click="loadMy(myPage)">刷新本人记录</el-button>
      <p>当前价按参与起价减去已砍金额展示；结算价以详情及服务端最终报价为准。</p>
      <article v-for="item in myList" :key="item.id" class="my-item">
        <h3>{{ item.title }} · 参与 #{{ item.id }}</h3>
        <p>{{ statusLabel(item) }} · 当前价 ¥{{ item.current }} / 底价 ¥{{ item.minimum }} · 已砍 ¥{{ item.cut }}</p>
        <el-progress v-if="item.amountsValid" :percentage="item.progress" :stroke-width="8" />
        <p v-else role="status">参与金额异常，暂不可购买，请联系商家核查。</p>
        <div class="actions">
          <router-link v-if="!mutating && !myLoading" :to="{ path: `/bargain/${item.activityId}`, query: { bargainUserId: String(item.id) } }">{{ item.ready ? '选择此参与并选规购买' : '查看此参与资格' }}</router-link>
          <el-button v-if="item.status === 1 && !item.ready && item.amountsValid" :disabled="!!mutating || myLoading" @click="mutate(item, 'help')">帮砍一次</el-button>
          <el-button v-if="[1, 3].includes(item.status)" :disabled="!!mutating || myLoading" @click="mutate(item, 'cancel')">取消此参与</el-button>
        </div>
      </article>
      <el-empty v-if="!myLoading && !myError && !myList.length" description="本页没有砍价记录" />
      <nav class="pagination" aria-label="本人砍价分页">
        <el-button :disabled="myLoading || !!mutating || myPage <= 1" @click="loadMy(myPage - 1)">上一页记录</el-button><span>第 {{ myPage }} 页</span>
        <el-button :disabled="myLoading || !!mutating || !!myError || myList.length < 20 || myPage >= 10000" @click="loadMy(myPage + 1)">下一页记录</el-button>
      </nav>
    </el-dialog>
  </div>
</template>
<script setup lang="ts">
import ProductImage from "@/components/ProductImage.vue";
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { apiBargainList, apiMyBargains, apiBargainHelp, apiBargainCancel } from '@/api/activity';
import { captureAuthSession, isCurrentAuthSession, onAuthChange } from '@/utils/auth';
import type { BargainItem, MyBargain } from '../../../../common/bargainPurchase';
const route = useRoute(), router = useRouter();
const goods = ref<BargainItem[]>([]), loading = ref(false), error = ref(''), page = ref(1);
const myList = ref<MyBargain[]>([]), myVisible = ref(false), myLoading = ref(false), myError = ref(''), myPage = ref(1), mutating = ref(0);
let revision = 0, myRevision = 0, disposed = false, opening = false;
const statusLabel = (row: MyBargain) => row.status === 4 ? '已用于订单' : row.status === 2 ? '已关闭/到期' : row.ready ? '已完成砍价，可查看购买资格' : '砍价中或活动不可购买';
async function load(next = 1) {
  if (disposed) return;
  const current = ++revision; goods.value = []; page.value = next; error.value = ''; loading.value = true;
  try { const rows = await apiBargainList(next); if (!disposed && current === revision) goods.value = rows; }
  catch (e) { if (!disposed && current === revision) error.value = e instanceof Error ? e.message : '商品列表加载失败'; }
  finally { if (!disposed && current === revision) loading.value = false; }
}
function closeMy() { myRevision++; myList.value = []; myError.value = ''; myLoading.value = false; }
async function loadMy(next = 1) {
  if (disposed || !myVisible.value || mutating.value) return;
  const current = ++myRevision, session = captureAuthSession();
  myList.value = []; myPage.value = next; myError.value = ''; myLoading.value = true;
  try { const rows = await apiMyBargains(next); if (!disposed && current === myRevision && myVisible.value && isCurrentAuthSession(session)) myList.value = rows; }
  catch (e) { if (!disposed && current === myRevision && myVisible.value && isCurrentAuthSession(session)) myError.value = e instanceof Error ? e.message : '本人记录读取失败'; }
  finally { if (!disposed && current === myRevision) myLoading.value = false; }
}
async function openMy() {
  if (disposed || opening || mutating.value) return;
  if (!captureAuthSession().token) {
    opening = true;
    try { if (await router.push({ path: '/login', query: { redirect: '/bargain?my=1' } })) error.value = '登录页面打开失败，请重试'; }
    catch { if (!disposed) error.value = '登录页面打开失败，请重试'; }
    finally { opening = false; }
    return;
  }
  myVisible.value = true; await loadMy();
}
async function mutate(item: MyBargain, action: 'help' | 'cancel') {
  if (disposed || !myVisible.value || myLoading.value || mutating.value || !myList.value.some(row => row.id === item.id)) return;
  const current = myRevision, session = captureAuthSession();
  const valid = () => !disposed && current === myRevision && myVisible.value && isCurrentAuthSession(session);
  mutating.value = item.id; myError.value = '';
  try {
    if (action === 'cancel') {
      try { await ElMessageBox.confirm(`取消参与 #${item.id}？本操作不会取消订单或删除其他参与。`, '确认取消', { type: 'warning' }); }
      catch { return; }
    }
    if (!valid()) return;
    if (action === 'help') await apiBargainHelp(item.id); else await apiBargainCancel(item.id);
    if (!valid()) return;
    mutating.value = 0; await loadMy(myPage.value);
  } catch (e) { if (valid()) { myList.value = []; myError.value = `${e instanceof Error ? e.message : '操作失败'}；请刷新记录确认结果，不会自动重试`; } }
  finally { mutating.value = 0; }
}
watch(() => route.query.my, value => { if (value === '1') void openMy(); });
const unbind = onAuthChange(() => { closeMy(); myVisible.value = false; });
onMounted(() => { void load(); if (route.query.my === '1') void openMy(); });
onUnmounted(() => { disposed = true; revision++; myRevision++; unbind(); });
</script>
<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin: 20px 0; }
.goods-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; margin-top: 16px; }
.goods-card { display: block; background: white; color: inherit; text-decoration: none; overflow: hidden; border-radius: 8px; }
.goods-card > .product-media { width: 100%; aspect-ratio: 1; object-fit: cover; }
.goods-info { padding: 12px; overflow-wrap: anywhere; } .goods-info p, .goods-info span { color: #b32421; margin: 12px 0; }
.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; margin: 20px 0; flex-wrap: wrap; }
.my-item { border: 1px solid #ddd; padding: 12px; margin: 12px 0; border-radius: 8px; overflow-wrap: anywhere; }
.my-item p { margin: 8px 0; } .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
@media (max-width: 500px) { .goods-grid { grid-template-columns: 1fr; } .head h2 { font-size: 20px; } }
</style>
