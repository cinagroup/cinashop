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
        <el-menu-item v-if="canMenu('/order')" index="/order/offline" aria-label="线下消费">
          <el-icon><CreditCard /></el-icon>
          <span>线下消费</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/order/invoice')" index="/order/invoice" aria-label="发票管理">
          <el-icon><Tickets /></el-icon>
          <span>发票管理</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/user')" index="/user">
          <el-icon><User /></el-icon>
          <span>用户管理</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/user')" index="/user/groups">
          <el-icon><User /></el-icon>
          <span>商城用户分组</span>
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
        <el-menu-item v-if="canMenu('/supplier/directory')" index="/supplier/directory">
          <el-icon><Shop /></el-icon>
          <span>供应商目录</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/supplier/menu-rules')" index="/supplier/menu-rules">
          <el-icon><Key /></el-icon>
          <span>供应商菜单规则</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/supplier/bills')" index="/supplier/bills">
          <el-icon><Tickets /></el-icon>
          <span>供应商账单</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/supplier/capital-flow')" index="/supplier/capital-flow">
          <el-icon><CreditCard /></el-icon>
          <span>供应商资金流水</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/supplier/order-statistics')" index="/supplier/order-statistics">
          <el-icon><TrendCharts /></el-icon>
          <span>供应商订单统计</span>
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
        <el-menu-item v-if="canMenu('/operations/writeoff-orders')" index="/operations/writeoff-orders">
          <el-icon><Shop /></el-icon>
          <span>核销订单</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/config')" index="/config/newcomer">
          <el-icon><Present /></el-icon>
          <span>新人运营</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/config')" index="/config/level-activation" aria-label="普通等级卡激活">
          <el-icon><Present /></el-icon>
          <span>普通等级卡激活</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/config')" index="/config/paid-membership" aria-label="付费会员功能设置">
          <el-icon><Setting /></el-icon>
          <span>付费会员功能设置</span>
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
        <el-menu-item v-if="canMenu('/marketing/coupon-records')" index="/marketing/coupon-records">
          <el-icon><Ticket /></el-icon>
          <span>用户领取记录</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/coupon-templates')" index="/marketing/coupon-templates">
          <el-icon><Ticket /></el-icon>
          <span>优惠券模板</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/activity')" index="/activity">
          <el-icon><Present /></el-icon>
          <span>营销活动</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/activity/seckill-statistics')" index="/activity/seckill-statistics">
          <el-icon><Present /></el-icon>
          <span>秒杀统计</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/activity/seckill-times')" index="/activity/seckill-times" aria-label="秒杀时段">
          <el-icon><Present /></el-icon>
          <span>秒杀时段</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/activity/seckill-activities')" index="/activity/seckill-activities" aria-label="秒杀父活动">
          <el-icon><Present /></el-icon>
          <span>秒杀父活动</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/activity/combinations')" index="/activity/combinations" aria-label="拼团商品">
          <el-icon><Present /></el-icon>
          <span>拼团商品</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/activity/combination-groups')" index="/activity/combination-groups" aria-label="全局拼团记录">
          <el-icon><Present /></el-icon>
          <span>全局拼团记录</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/activity/combination-statistics')" index="/activity/combination-statistics" aria-label="拼团统计">
          <el-icon><Present /></el-icon>
          <span>拼团统计</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/lottery')" index="/marketing/lottery">
          <el-icon><Trophy /></el-icon>
          <span>抽奖活动</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/lottery-records')" index="/marketing/lottery-records">
          <el-icon><Trophy /></el-icon>
          <span>抽奖记录</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/activity-frame')" index="/marketing/activity-frame">
          <el-icon><Present /></el-icon>
          <span>活动边框</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/activity-background')" index="/marketing/activity-background">
          <el-icon><Present /></el-icon>
          <span>活动背景</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/time-discounts')" index="/marketing/time-discounts">
          <el-icon><Present /></el-icon>
          <span>限时折扣</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/full-discounts')" index="/marketing/full-discounts">
          <el-icon><Present /></el-icon>
          <span>满减满折</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/nth-discounts')" index="/marketing/nth-discounts">
          <el-icon><Present /></el-icon>
          <span>第N件N折</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/full-gifts')" index="/marketing/full-gifts">
          <el-icon><Present /></el-icon>
          <span>满送活动</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/live')" index="/marketing/live">
          <el-icon><VideoCamera /></el-icon>
          <span>小程序直播</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/user-point')" index="/marketing/user-point">
          <el-icon><Tickets /></el-icon>
          <span>积分日志</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/point-statistic')" index="/marketing/point-statistic">
          <el-icon><DataLine /></el-icon>
          <span>积分统计</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/recharge-options')" index="/marketing/recharge-options" aria-label="充值金额档位">
          <el-icon><Wallet /></el-icon>
          <span>充值金额档位</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/integral-categories')" index="/marketing/integral-categories" aria-label="积分分类">
          <el-icon><Folder /></el-icon>
          <span>积分分类</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/activity/integral-batch')" index="/activity/integral-batch" aria-label="批量添加积分商品">
          <el-icon><Present /></el-icon>
          <span>批量添加积分商品</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/config')" index="/marketing/sign-rewards">
          <el-icon><Present /></el-icon>
          <span>签到奖励</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/marketing/sign-day-config')" index="/marketing/sign-day-config" aria-label="签到天数组">
          <el-icon><Present /></el-icon>
          <span>签到天数组</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/system/out')" index="/system/out">
          <el-icon><Key /></el-icon>
          <span>对外接口</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/kefu')" index="/kefu">
          <el-icon><ChatDotRound /></el-icon>
          <span>客服会话</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/kefu/feedback')" index="/kefu/feedback">
          <el-icon><ChatDotRound /></el-icon>
          <span>客服反馈</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/kefu/speechcraft')" index="/kefu/speechcraft">
          <el-icon><ChatDotRound /></el-icon>
          <span>客服话术</span>
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
        <el-menu-item v-if="canMenu('/system/legacy-staff')" index="/system/legacy-staff">
          <el-icon><UserFilled /></el-icon>
          <span>下级管理员</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/finance/extract')" index="/finance/extract">
          <el-icon><Wallet /></el-icon>
          <span>提现审核</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/finance/recharges')" index="/finance/recharges">
          <el-icon><Wallet /></el-icon>
          <span>充值订单</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/finance/commissions')" index="/finance/commissions">
          <el-icon><Wallet /></el-icon>
          <span>佣金记录</span>
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
        <el-menu-item v-if="canMenu('/finance/capital-flow')" index="/finance/capital-flow">
          <el-icon><Wallet /></el-icon>
          <span>平台资金流水</span>
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
        <el-menu-item v-if="canMenu('/agent/promoter-applications')" index="/agent/promoter-applications" aria-label="分销员申请审核">
          <el-icon><Share /></el-icon>
          <span>分销员申请审核</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/agent/agreement')" index="/agent/agreement" aria-label="分销说明">
          <el-icon><Share /></el-icon>
          <span>分销说明</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/division')" index="/division">
          <el-icon><Connection /></el-icon>
          <span>事业部管理</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/division/statistics')" index="/division/statistics">
          <el-icon><DataAnalysis /></el-icon>
          <span>事业部统计</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/notification')" index="/setting/notification">
          <el-icon><Bell /></el-icon>
          <span>通知配置</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/print')" index="/setting/print">
          <el-icon><Printer /></el-icon>
          <span>小票打印</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/shipping')" index="/setting/shipping" aria-label="发货设置">
          <el-icon><Tickets /></el-icon>
          <span>发货设置</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/city-delivery-settings')" index="/setting/city-delivery-settings" aria-label="同城配送设置">
          <el-icon><Tickets /></el-icon>
          <span>同城配送设置</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/city-delivery-records')" index="/setting/city-delivery-records" aria-label="同城配送记录">
          <el-icon><Tickets /></el-icon>
          <span>同城配送记录</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/pc-banner')" index="/setting/pc-banner" aria-label="PC首页轮播">
          <el-icon><Monitor /></el-icon>
          <span>PC首页轮播</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/product-category-style')" index="/setting/product-category-style" aria-label="商品分类页面">
          <el-icon><Tickets /></el-icon>
          <span>商品分类页面</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/product-detail-design')" index="/setting/product-detail-design" aria-label="商品详情设计">
          <el-icon><Tickets /></el-icon>
          <span>商品详情设计</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/user-center-design')" index="/setting/user-center-design" aria-label="个人中心设计">
          <el-icon><Tickets /></el-icon>
          <span>个人中心设计</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/theme-style')" index="/setting/theme-style" aria-label="主题风格">
          <el-icon><Tickets /></el-icon>
          <span>主题风格</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/fab')" index="/setting/fab" aria-label="悬浮按钮">
          <el-icon><Tickets /></el-icon>
          <span>悬浮按钮</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/distributor-levels')" index="/setting/distributor-levels" aria-label="分销等级">
          <el-icon><Tickets /></el-icon>
          <span>分销等级</span>
        </el-menu-item>
        <el-menu-item v-if="canMenu('/setting/distributor-levels/tasks')" index="/setting/distributor-levels/tasks" aria-label="分销等级任务">
          <el-icon><Tickets /></el-icon>
          <span>分销等级任务</span>
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
  if (path === "/order/offline") return "/order/offline";
  if (path === "/order/invoice") return "/order/invoice";
  if (path.startsWith("/order")) return "/order";
  if (path.startsWith("/user/groups")) return "/user/groups";
  if (path.startsWith("/user")) return "/user";
  if (path.startsWith("/community")) return "/community";
  if (path.startsWith("/member")) return "/member";
  if (path.startsWith("/supplier/applications")) return "/supplier/applications";
  if (path.startsWith("/supplier/menu-rules")) return "/supplier/menu-rules";
  if (path.startsWith("/supplier/bills")) return "/supplier/bills";
  if (path.startsWith("/supplier/capital-flow")) return "/supplier/capital-flow";
  if (path.startsWith("/supplier/order-statistics")) return "/supplier/order-statistics";
  if (path.startsWith("/refund")) return "/refund";
  if (path.startsWith("/operations/outbox")) return "/operations/outbox";
  if (path.startsWith("/operations/legacy-runtime")) return "/operations/legacy-runtime";
  if (path.startsWith("/operations/work")) return "/operations/work";
  if (path.startsWith("/operations/store")) return "/operations/store";
  if (path.startsWith("/operations/writeoff-orders")) return "/operations/writeoff-orders";
  if (path.startsWith("/config/newcomer")) return "/config/newcomer";
  if (path.startsWith("/config/level-activation")) return "/config/level-activation";
  if (path.startsWith("/config/paid-membership")) return "/config/paid-membership";
  if (path.startsWith("/config/runtime-content")) return "/config/runtime-content";
  if (path.startsWith("/config")) return "/config";
  if (path.startsWith("/assets")) return "/assets";
  if (path.startsWith("/category")) return "/category";
  if (path.startsWith("/coupon")) return "/coupon";
  if (path.startsWith("/marketing/coupon-records")) return "/marketing/coupon-records";
  if (path.startsWith("/marketing/coupon-templates")) return "/marketing/coupon-templates";
  if (path.startsWith("/activity/seckill-statistics")) return "/activity/seckill-statistics";
  if (path.startsWith("/activity/seckill-times")) return "/activity/seckill-times";
  if (path.startsWith("/activity/seckill-activities")) return "/activity/seckill-activities";
  if (path.startsWith("/activity/combinations")) return "/activity/combinations";
  if (path.startsWith("/activity/combination-groups")) return "/activity/combination-groups";
  if (path.startsWith("/activity/combination-statistics")) return "/activity/combination-statistics";
  if (path.startsWith("/activity/integral-batch")) return "/activity/integral-batch";
  if (path.startsWith("/activity")) return "/activity";
  if (path.startsWith("/marketing/lottery-records")) return "/marketing/lottery-records";
  if (path.startsWith("/marketing/lottery")) return "/marketing/lottery";
  if (path.startsWith("/marketing/activity-frame")) return "/marketing/activity-frame";
  if (path.startsWith("/marketing/activity-background")) return "/marketing/activity-background";
  if (path.startsWith("/marketing/time-discounts")) return "/marketing/time-discounts";
  if (path.startsWith("/marketing/full-discounts")) return "/marketing/full-discounts";
  if (path.startsWith("/marketing/nth-discounts")) return "/marketing/nth-discounts";
  if (path.startsWith("/marketing/full-gifts")) return "/marketing/full-gifts";
  if (path.startsWith("/marketing/live")) return "/marketing/live";
  if (path.startsWith("/marketing/user-point")) return "/marketing/user-point";
  if (path.startsWith("/marketing/point-statistic")) return "/marketing/point-statistic";
  if (path.startsWith("/marketing/recharge-options")) return "/marketing/recharge-options";
  if (path.startsWith("/marketing/integral-categories")) return "/marketing/integral-categories";
  if (path.startsWith("/marketing/sign-rewards")) return "/marketing/sign-rewards";
  if (path.startsWith("/marketing/sign-day-config")) return "/marketing/sign-day-config";
  if (path.startsWith("/system/out")) return "/system/out";
  if (path.startsWith("/kefu/feedback")) return "/kefu/feedback";
  if (path.startsWith("/kefu/speechcraft")) return "/kefu/speechcraft";
  if (path.startsWith("/kefu")) return "/kefu";
  if (path.startsWith("/reply")) return "/reply";
  if (path.startsWith("/brand")) return "/brand";
  if (path.startsWith("/system/log")) return "/system/log";
  if (path === "/system/legacy-staff") return "/system/legacy-staff";
  if (path.startsWith("/system")) return "/system";
  if (path.startsWith("/finance/supplier-extract")) return "/finance/supplier-extract";
  if (path.startsWith("/finance/recharges")) return "/finance/recharges";
  if (path.startsWith("/finance/commissions")) return "/finance/commissions";
  if (path.startsWith("/finance/capital-flow")) return "/finance/capital-flow";
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
  if (path.startsWith("/agent/promoter-applications")) return "/agent/promoter-applications";
  if (path.startsWith("/agent")) return "/agent";
  if (path.startsWith("/division/statistics")) return "/division/statistics";
  if (path.startsWith("/division")) return "/division";
  if (path.startsWith("/setting/shipping")) return "/setting/shipping";
  if (path.startsWith("/setting/city-delivery-records")) return "/setting/city-delivery-records";
  if (path.startsWith("/setting/city-delivery-settings") || path === "/admin/setting/city/delivery/setting") return "/setting/city-delivery-settings";
  if (path.startsWith("/setting/pc-banner")) return "/setting/pc-banner";
  if (path.startsWith("/setting/product-category-style") || path === "/admin/setting/pages/product_category") return "/setting/product-category-style";
  if (path.startsWith("/setting/product-detail-design") || path === "/admin/setting/pages/product_detail") return "/setting/product-detail-design";
  if (path.startsWith("/setting/user-center-design") || path === "/admin/setting/pages/home") return "/setting/user-center-design";
  if (path.startsWith("/setting/theme-style") || path === "/admin/setting/theme_style") return "/setting/theme-style";
  if (path.startsWith("/setting/fab")) return "/setting/fab";
  if (path.startsWith("/setting/distributor-levels/tasks")) return "/setting/distributor-levels/tasks";
  if (path.startsWith("/setting/distributor-levels")) return "/setting/distributor-levels";
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
