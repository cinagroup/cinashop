<script setup lang="ts">
import { useThemeStore } from "@/stores/theme";
import { useShareReferral } from '@/composables/useShareReferral';
import { onLaunch, onShow, onHide } from "@dcloudio/uni-app";
// #ifdef H5
import { loadStatisticsScript } from '../../common/statisticsScript';
import { API_BASE } from '@/utils/request';
// #endif

import { useDiyFooterStore } from '@/stores/diyFooter';
const footer = useDiyFooterStore();
const theme = useThemeStore();
const referrals = useShareReferral();
onLaunch((options) => {
  footer.resume();
  referrals.captureInbound(options);
  theme.syncPlatform();
  void theme.refresh();
  // #ifdef H5
  loadStatisticsScript(API_BASE);
  // #endif
  console.log("CinaShop App Launch");
});

onShow((options) => {
  footer.resume();
  referrals.captureInbound(options);
  theme.syncPlatform();
  void theme.refresh();
  console.log("App Show");
});

onHide(() => {
  footer.pause();
  theme.pause();
  console.log("App Hide");
});
</script>

<style>
/* The original UniApp registers this same local D-DIN 600 font. */
@font-face {
  font-family: "CinaShop DIN";
  src: url("/static/php-assets/fonts/D-DIN-PRO-600-SemiBold.ttf") format("truetype");
  font-weight: 600;
  font-style: normal;
  font-display: swap;
  /* Price digits and symbols only; Chinese and full-width ￥ keep system glyphs. */
  unicode-range: U+0020, U+0024-0025, U+0028-003A, U+00A0, U+00A3, U+00A5, U+20AC;
}

/* 全局样式 */
page {
  background-color: #f5f5f5;
  font-size: 28rpx;
  color: #333;
  font-family: "PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}

.container {
  padding: 20rpx;
}

/* 商品网格 */
.goods-grid {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
}

.goods-card {
  width: 48%;
  background: #fff;
  border-radius: 20rpx;
  margin-bottom: 20rpx;
  overflow: hidden;
}

.goods-image {
  width: 100%;
  height: 340rpx;
  background: #f8f8f8;
}

.goods-info {
  padding: 16rpx 20rpx;
}

.goods-name {
  font-size: 26rpx;
  line-height: 1.4;
  height: 72rpx;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.goods-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10rpx;
}

.price {
  font-family: "CinaShop DIN", "PingFang SC", -apple-system, BlinkMacSystemFont,
    "Segoe UI", "Microsoft YaHei", sans-serif;
  color: var(--view-priceColor, #e93323);
  font-size: 32rpx;
  font-weight: 600;
}

.sales {
  color: #999;
  font-size: 22rpx;
}

/* 通用按钮 */
.btn-primary {
  background: var(--view-theme, #e93323);
  color: #fff;
  border-radius: 40rpx;
  font-size: 30rpx;
}

/* 空状态 */
.empty {
  text-align: center;
  color: #999;
  padding: 120rpx 0;
  font-size: 28rpx;
}
</style>
