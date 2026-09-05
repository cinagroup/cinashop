<template>
  <el-container class="admin-layout">
    <!-- 侧边栏 -->
    <el-aside width="200px" class="aside">
      <div class="logo">
        <img src="/logo.png" alt="CinaShop" class="logo-img" />
      </div>
      <el-menu
        :default-active="activeMenu"
        router
        background-color="#001529"
        text-color="rgba(255,255,255,0.65)"
        active-text-color="#fff"
      >
        <el-menu-item v-if="canMenu('/dashboard')" index="/dashboard">
          <el-icon><Odometer /></el-icon>
          <span>控制台</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/product')" index="/product">
          <el-icon><Goods /></el-icon>
          <span>商品管理</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/order')" index="/order">
          <el-icon><Tickets /></el-icon>
          <span>订单管理</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/user')" index="/user">
          <el-icon><User /></el-icon>
          <span>用户管理</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/community')" index="/community">
          <el-icon><ChatLineRound /></el-icon>
          <span>社区运营</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/member')" index="/member">
          <el-icon><Key /></el-icon>
          <span>付费会员</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/refund')" index="/refund">
          <el-icon><RefreshLeft /></el-icon>
          <span>退款审核</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/supplier/applications')" index="/supplier/applications">
          <el-icon><Shop /></el-icon>
          <span>供应商入驻</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/operations/outbox')" index="/operations/outbox">
          <el-icon><Operation /></el-icon>
          <span>任务运维</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/operations/legacy-runtime')" index="/operations/legacy-runtime">
          <el-icon><Clock /></el-icon>
          <span>迁移运行历史</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/operations/work')" index="/operations/work">
          <el-icon><Connection /></el-icon>
          <span>企业微信</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/operations/store')" index="/operations/store">
          <el-icon><Shop /></el-icon>
          <span>门店与配送</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/config')" index="/config/newcomer">
          <el-icon><Present /></el-icon>
          <span>新人运营</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/config')" index="/config/runtime-content">
          <el-icon><Monitor /></el-icon>
          <span>客户端内容</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/config')" index="/config">
          <el-icon><Setting /></el-icon>
          <span>系统配置</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/category')" index="/category">
          <el-icon><Folder /></el-icon>
          <span>商品分类</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/coupon')" index="/coupon">
          <el-icon><Ticket /></el-icon>
          <span>优惠券管理</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/activity')" index="/activity">
          <el-icon><Present /></el-icon>
          <span>营销活动</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/lottery')" index="/marketing/lottery">
          <el-icon><Trophy /></el-icon>
          <span>抽奖活动</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/live')" index="/marketing/live">
          <el-icon><VideoCamera /></el-icon>
          <span>小程序直播</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/system/out')" index="/system/out">
          <el-icon><Key /></el-icon>
          <span>对外接口</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/kefu')" index="/kefu">
          <el-icon><ChatDotRound /></el-icon>
          <span>客服会话</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/reply')" index="/reply">
          <el-icon><Star /></el-icon>
          <span>商品评价</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/brand')" index="/brand">
          <el-icon><Collection /></el-icon>
          <span>品牌管理</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/system')" index="/system">
          <el-icon><UserFilled /></el-icon>
          <span>系统管理</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/finance/extract')" index="/finance/extract">
          <el-icon><Wallet /></el-icon>
          <span>提现审核</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/assets')" index="/assets">
          <el-icon><Picture /></el-icon>
          <span>素材中心</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/finance/supplier-extract')" index="/finance/supplier-extract">
          <el-icon><WalletFilled /></el-icon>
          <span>供应商提现</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/finance/bill')" index="/finance/bill">
          <el-icon><Tickets /></el-icon>
          <span>财务流水</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/level')" index="/level">
          <el-icon><Medal /></el-icon>
          <span>会员等级</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/shipping')" index="/shipping">
          <el-icon><Van /></el-icon>
          <span>运费模板</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/express')" index="/express">
          <el-icon><Box /></el-icon>
          <span>快递公司</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/statistic')" index="/statistic">
          <el-icon><TrendCharts /></el-icon>
          <span>统计报表</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/label')" index="/label">
          <el-icon><PriceTag /></el-icon>
          <span>标签管理</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/content/article')" index="/content/article">
          <el-icon><Document /></el-icon>
          <span>CMS 文章</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/content/wechat-card')" index="/content/wechat-card">
          <el-icon><CreditCard /></el-icon>
          <span>公众号会员卡</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/content/wechat')" index="/content/wechat">
          <el-icon><ChatLineRound /></el-icon>
          <span>公众号内容</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/content/wechat-qrcode')" index="/content/wechat-qrcode">
          <el-icon><Connection /></el-icon>
          <span>渠道二维码</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/content/dise')" index="/content/dise">
          <el-icon><Brush /></el-icon>
          <span>DIY 装修</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/system/log')" index="/system/log">
          <el-icon><Tickets /></el-icon>
          <span>操作日志</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/agent')" index="/agent">
          <el-icon><Share /></el-icon>
          <span>分销管理</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/division')" index="/division">
          <el-icon><Connection /></el-icon>
          <span>事业部管理</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/notification')" index="/setting/notification">
          <el-icon><Bell /></el-icon>
          <span>通知配置</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/print')" index="/setting/print">
          <el-icon><Printer /></el-icon>
          <span>小票打印</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/waybill')" index="/setting/waybill">
          <el-icon><Tickets /></el-icon>
          <span>电子面单</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <!-- 顶栏 -->
      <el-header class="header">
        <div class="header-left">{{ currentTitle }}</div>
        <div class="header-right">
          <AdminTodoBell :key="authStore.token" />
          <el-dropdown @command="handleCommand">
            <span class="user-name">
              {{ authStore.userInfo?.account ?? "管理员" }}
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <!-- 主体 -->
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import AdminTodoBell from "./AdminTodoBell.vue";

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
const allowedMenuPaths = computed(() => new Set(authStore.menus.map((menu) => menu.path)));

function canMenu(path: string): boolean {
  if (previewMode || !authStore.userInfo || authStore.userInfo.level === 0) return true;
  return allowedMenuPaths.value.has(path);
}

const activeMenu = computed(() => {
  const path = route.path;
  if (path.startsWith("/product")) return "/product";
  if (path.startsWith("/order")) return "/order";
  if (path.startsWith("/user")) return "/user";
  if (path.startsWith("/community")) return "/community";
  if (path.startsWith("/member")) return "/member";
  if (path.startsWith("/supplier/applications")) return "/supplier/applications";
  if (path.startsWith("/refund")) return "/refund";
  if (path.startsWith("/operations/outbox")) return "/operations/outbox";
  if (path.startsWith("/operations/legacy-runtime")) return "/operations/legacy-runtime";
  if (path.startsWith("/operations/work")) return "/operations/work";
  if (path.startsWith("/operations/store")) return "/operations/store";
  if (path.startsWith("/config/newcomer")) return "/config/newcomer";
  if (path.startsWith("/config/runtime-content")) return "/config/runtime-content";
  if (path.startsWith("/config")) return "/config";
  if (path.startsWith("/assets")) return "/assets";
  if (path.startsWith("/category")) return "/category";
  if (path.startsWith("/coupon")) return "/coupon";
  if (path.startsWith("/activity")) return "/activity";
  if (path.startsWith("/marketing/lottery")) return "/marketing/lottery";
  if (path.startsWith("/marketing/live")) return "/marketing/live";
  if (path.startsWith("/system/out")) return "/system/out";
  if (path.startsWith("/kefu")) return "/kefu";
  if (path.startsWith("/reply")) return "/reply";
  if (path.startsWith("/brand")) return "/brand";
  if (path.startsWith("/system/log")) return "/system/log";
  if (path.startsWith("/system")) return "/system";
  if (path.startsWith("/finance/supplier-extract")) return "/finance/supplier-extract";
  if (path.startsWith("/finance/bill")) return "/finance/bill";
  if (path.startsWith("/finance")) return "/finance/extract";
  if (path.startsWith("/level")) return "/level";
  if (path.startsWith("/shipping")) return "/shipping";
  if (path.startsWith("/express")) return "/express";
  if (path.startsWith("/statistic")) return "/statistic";
  if (path.startsWith("/label")) return "/label";
  if (path.startsWith("/content/article")) return "/content/article";
  if (path.startsWith("/content/wechat-card")) return "/content/wechat-card";
  if (path.startsWith("/content/wechat-qrcode")) return "/content/wechat-qrcode";
  if (path.startsWith("/content/wechat")) return "/content/wechat";
  if (path.startsWith("/content/dise")) return "/content/dise";
  if (path.startsWith("/agent")) return "/agent";
  if (path.startsWith("/division")) return "/division";
  if (path.startsWith("/setting/print")) return "/setting/print";
  if (path.startsWith("/setting/waybill")) return "/setting/waybill";
  if (path.startsWith("/setting")) return "/setting/notification";
  return "/dashboard";
});

const currentTitle = computed(() => (route.meta.title as string) ?? "控制台");

function handleCommand(cmd: string) {
  if (cmd === "logout") {
    authStore.logout();
    ElMessage.success("已退出登录");
    router.push("/login");
  }
}

</script>

<style scoped>
.admin-layout {
  height: 100vh;
  width: 100%;
  overflow: hidden;
}

.admin-layout > .el-container {
  min-width: 0;
  overflow: hidden;
}

.aside {
  background: #001529;
  overflow-y: auto;
}

.logo {
  color: #fff;
  font-size: 16px;
  font-weight: 600;
  padding: 16px;
  text-align: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.logo-img {
  height: 40px;
  width: auto;
  object-fit: contain;
}

.aside :deep(.el-menu) {
  border-right: none;
}

.header {
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.header-left {
  font-size: 16px;
  font-weight: 600;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 20px;
}

.user-name {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
}

.main {
  background: #f0f2f5;
  min-width: 0;
  overflow-x: hidden;
  padding: 20px;
}

@media (max-width: 768px) {
  .aside {
    width: 64px !important;
  }

  .admin-layout > .el-container {
    flex: 0 0 calc(100vw - 64px);
    width: calc(100vw - 64px);
    max-width: calc(100vw - 64px);
  }

  .logo {
    padding: 12px 4px;
  }

  .logo-img {
    height: 32px;
    max-width: 52px;
  }

  .aside :deep(.el-menu-item) {
    justify-content: center;
    padding: 0 !important;
  }

  .aside :deep(.el-menu-item span) {
    display: none;
  }

  .header {
    padding: 0 12px;
  }

  .header-left {
    max-width: 132px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .header-right {
    gap: 10px;
  }

  .main {
    width: 100%;
    max-width: 100%;
    padding: 10px;
  }
}
</style>
