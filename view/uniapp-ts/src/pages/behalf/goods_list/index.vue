<template>
  <view class="assisted-page">
    <view class="eyebrow">管理员 · 代客下单</view><view class="title">选品与购物车</view>
    <view v-if="draft.checkoutLock" class="notice">本机有待核验订单，不能修改购物车或另建新单。<button @tap="recoverCheckout">恢复原订单结果</button></view>
    <view v-if="!canUse" class="panel notice">买家上下文缺失或身份已变化，请从选客页重新开始。链接中的 UID 不会直接授权购物车操作。
      <button @tap="chooseBuyer">前往选客</button></view>
    <template v-else>
      <view class="session"><text>管理员 {{ session.id }} · {{ draft.scope?.uid ? `会员 UID ${draft.scope.uid}` : '本次游客' }}</text><button size="mini" :disabled="draft.pending || draft.needsReview || confirming" @tap="chooseBuyer">更换买家</button></view>
      <view class="hint">目录和规格展示参考价；购物车按当前买家读取参考价，最终金额需以确认订单报价为准。预售不进入普通代客购物车。</view>
      <view class="panel"><text class="label">商品关键词</text><input v-model="keyword" aria-label="搜索代客商品" :maxlength="100" placeholder="搜索已上架商品" @confirm="load()" />
        <button class="primary" :disabled="loading || draft.pending || confirming" @tap="load()">查询商品</button></view>
      <view v-if="error" class="notice" role="alert">{{ error }}<button size="mini" @tap="load()">重新查询</button></view>
      <view v-if="loading" class="empty" role="status">正在读取商品…</view>
      <view v-else-if="loaded && !products.length && !error" class="empty">没有符合条件的上架商品</view>
      <view v-for="product in products" :key="product.id" class="panel">
        <view class="row"><image v-if="product.image" class="thumb" :src="product.image" mode="aspectFill" /><view class="grow"><view class="name">{{ product.name }}</view><view class="hint">参考价 ¥{{ product.price }} · 库存 {{ product.stock }}</view></view></view>
        <view v-if="product.presale" class="notice">预售商品暂不支持代客购买</view>
        <button :disabled="blocked || loading || !!error || product.presale || product.stock <= 0" @tap="selectProduct(product.id)">{{ selected?.id === product.id ? '重新读取规格' : '选择规格' }}</button>
        <view v-if="selected?.id === product.id" class="sku-section">
          <view v-if="skuLoading" role="status">正在读取规格…</view><view v-if="skuError" class="notice" role="alert">{{ skuError }}</view>
          <button v-for="sku in skus" :key="sku.unique" :class="{chosen: skuKey === sku.unique}" :disabled="blocked || skuLoading || sku.stock <= 0" @tap="selectSku(sku.unique)">{{ skuKey === sku.unique ? '已选 · ' : '' }}{{ sku.label }} · ¥{{ sku.price }} · 库存 {{ sku.stock }}</button>
          <template v-if="chosenSku"><text class="label">加购数量（最多 {{ maxQuantity }}）</text><input v-model.number="quantity" type="number" aria-label="加购数量" :disabled="blocked" />
            <button class="primary" :disabled="blocked || quantity < 1 || quantity > maxQuantity" @tap="add">加入当前买家购物车</button></template>
        </view>
      </view>
      <button v-if="hasMore" :disabled="loading || draft.pending" @tap="load(true)">{{ error ? '重试本页' : '加载更多商品' }}</button>
      <view class="panel cart-section"><view class="section-title">当前代客购物车</view>
        <view v-if="draft.pending" class="notice" role="status">操作正在处理，请勿重复提交或切换买家。</view>
        <view v-if="draft.needsReview && !draft.pending" class="notice" role="alert">有操作尚未完成核对。请重新读取购物车，确认商品及数量后再解锁。网络超时不代表服务器已取消处理，不要直接重复加购。</view>
        <view v-if="note" class="notice" role="status">{{ note }}</view>
        <button :disabled="draft.pending || cartLoading || confirming" @tap="refreshCart()">重新读取购物车</button>
        <view v-if="cartError" class="notice" role="alert">{{ cartError }}</view><view v-if="cartLoading" class="empty" role="status">正在核对服务器购物车…</view>
        <view v-else-if="cartLoaded && !cart.length" class="empty">当前购物车为空</view>
        <view v-for="item in cart" :key="item.id" class="cart-item">
          <view class="name">{{ item.name }}</view><view class="hint">{{ item.sku }} · 单价参考 ¥{{ item.price }}</view>
          <view v-if="!item.valid" class="notice">商品或规格失效，或库存不足；请移除后重新选品。</view>
          <view class="row controls"><button size="mini" :disabled="blocked || !item.valid || item.quantity <= 1" @tap="changeQuantity(item.id, -1)">减少</button><text>{{ item.quantity }} 件</text><button size="mini" :disabled="blocked || !item.valid || item.quantity >= Math.min(item.stock, 32767)" @tap="changeQuantity(item.id, 1)">增加</button><button size="mini" :disabled="blocked" @tap="remove(item.id)">移除</button></view>
        </view>
        <button v-if="draft.needsReview" :disabled="draft.pending || !reviewRead || cartLoading || !!cartError" @tap="acknowledgeReview">已人工核对以上商品与数量，解锁操作</button>
      </view>
      <button class="primary" :disabled="!canCheckout" @tap="checkout">前往确认订单</button>
      <view class="notice">加入购物车不锁定价格和库存。确认页重新报价并建单，不自动收款；收银页仍在迁移中。不同履约类型需分开结算。</view>
    </template>
    <DiySuspendedNavigation />
  </view>
</template>
<script setup lang="ts">
import { useAssistedShopping } from '@/composables/useAssistedShopping';
const { session, draft, canUse, blocked, keyword, products, loading, loaded, error, hasMore, selected, skus, skuKey, quantity,
  skuLoading, skuError, chosenSku, maxQuantity, cart, cartLoading, cartLoaded, cartError, note, reviewRead, confirming,
  canCheckout, checkout, recoverCheckout, load, selectProduct, selectSku, refreshCart, add, changeQuantity, remove, acknowledgeReview, chooseBuyer } = useAssistedShopping();
</script>
<style src="../selection.css" scoped></style>
