<script setup lang="ts">
import { onLaunch, onShow, onHide } from "@dcloudio/uni-app";

onLaunch(() => {
  console.log("CinaShop App Launch");
});

onShow(() => {
  console.log("App Show");
});

onHide(() => {
  console.log("App Hide");
});
</script>

<style>
/* 全局样式 */
page {
  background-color: #f5f5f5;
  font-size: 28rpx;
  color: #333;
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
  border-radius: 12rpx;
  margin-bottom: 20rpx;
  overflow: hidden;
}

.goods-image {
  width: 100%;
  height: 340rpx;
  background: #f8f8f8;
}

.goods-info {
  padding: 16rpx;
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
  color: #e93323;
  font-size: 32rpx;
  font-weight: 600;
}

.sales {
  color: #999;
  font-size: 22rpx;
}

/* 通用按钮 */
.btn-primary {
  background: #e93323;
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
