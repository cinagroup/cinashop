<template>
  <div class="user-center container">
    <div class="user-card">
      <div class="avatar">👤</div>
      <div class="user-info">
        <div class="nickname">{{ userInfo.nickname || "PC 用户" }}</div>
        <div class="uid">UID: {{ authStore.uid }}</div>
        <div class="uid">余额: ¥{{ userInfo.now_money ?? "0.00" }} · 积分: {{ userInfo.integral ?? 0 }}</div>
      </div>
      <el-button link type="danger" class="logout" @click="handleLogout">退出登录</el-button>
    </div>

    <div class="menu-grid">
      <router-link to="/order" class="menu-item">
        <span class="icon">📦</span>
        <span>我的订单</span>
      </router-link>
      <router-link to="/user/address" class="menu-item">
        <span class="icon">📍</span>
        <span>收货地址</span>
      </router-link>
      <router-link to="/user/phone" class="menu-item">
        <span class="icon">📱</span>
        <span>手机号管理</span>
      </router-link>
      <router-link to="/user/collect" class="menu-item">
        <span class="icon">⭐</span>
        <span>我的收藏</span>
      </router-link>
      <router-link to="/user/coupon" class="menu-item">
        <span class="icon">🎫</span>
        <span>我的优惠券</span>
      </router-link>
      <router-link to="/user/balance" class="menu-item">
        <span class="icon">💰</span>
        <span>余额明细</span>
      </router-link>
      <router-link to="/user/spread" class="menu-item">
        <span class="icon">📣</span>
        <span>分销中心</span>
      </router-link>
      <router-link to="/user/invoice" class="menu-item">
        <span class="icon">🧾</span>
        <span>我的发票</span>
      </router-link>
      <router-link to="/user/level" class="menu-item">
        <span class="icon">🏅</span>
        <span>会员等级</span>
      </router-link>
      <router-link to="/user/recharge" class="menu-item">
        <span class="icon">💳</span>
        <span>余额充值</span>
      </router-link>
      <router-link to="/bargain" class="menu-item">
        <span class="icon">🔨</span>
        <span>砍价专区</span>
      </router-link>
      <router-link to="/combination" class="menu-item">
        <span class="icon">👥</span>
        <span>拼团专区</span>
      </router-link>
      <router-link to="/community" class="menu-item">
        <span class="icon">💬</span>
        <span>社区</span>
      </router-link>
      <router-link to="/goods" class="menu-item">
        <span class="icon">🛒</span>
        <span>去购物</span>
      </router-link>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { apiUserInfo } from "@/api/user";

const router = useRouter();
const authStore = useAuthStore();
const userInfo = ref<Record<string, unknown>>({});

onMounted(async () => {
  try {
    userInfo.value = (await apiUserInfo()) as Record<string, unknown>;
  } catch {
    // 未登录或接口异常时静默
  }
});

async function handleLogout() {
  await authStore.logout();
  ElMessage.success("已退出登录");
  router.push("/");
}
</script>

<style scoped>
.user-center {
  padding-top: 20px;
}

.user-card {
  background: linear-gradient(135deg, #e64340, #ff7a45);
  border-radius: 12px;
  padding: 24px;
  color: #fff;
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.avatar {
  width: 64px;
  height: 64px;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
}

.nickname {
  font-size: 18px;
  font-weight: 600;
}

.uid {
  font-size: 13px;
  opacity: 0.85;
  margin-top: 4px;
}

.logout {
  margin-left: auto;
  color: #fff;
}

.menu-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.menu-item {
  background: #fff;
  border-radius: 8px;
  padding: 24px;
  text-align: center;
  transition: box-shadow 0.2s;
}

.menu-item:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}

.icon {
  display: block;
  font-size: 28px;
  margin-bottom: 8px;
}

.menu-item span:last-child {
  font-size: 14px;
  color: #555;
}
</style>
