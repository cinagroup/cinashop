<template>
  <ThemePage>
  <view class="goods-detail">
    <view v-if="loading" class="empty" role="status">正在加载商品…</view>
    <view v-else-if="loadError" class="empty" role="alert">
      <view>{{ loadError }}</view>
      <button @tap="load">重新加载商品</button>
    </view>
    <view v-else-if="detail">
      <view v-if="preparedCart || purchaseNeedsRefresh || ordinaryRecovery || ordinaryRecoveryInvalid" class="purchase-recovery" role="status">
        <view>{{ preparedCart ? '购买记录已创建，继续结算不会重复加购。' : ordinaryRecovery || ordinaryRecoveryInvalid ? '本账号上次加购结果尚未确认，当前暂停普通商品加购，请到购物车核对。' : '本次操作结果未确认，请重新加载商品后再选择。' }}</view>
        <view v-if="checkoutError" role="alert">{{ checkoutError }}</view>
        <button v-if="preparedCart" :disabled="navigating" @tap="resumeCheckout">继续结算</button>
        <button v-if="ordinaryRecovery?.state==='unknown' || ordinaryRecoveryInvalid" :disabled="navigating || buying" @tap="goCart">到购物车核对</button>
        <button v-else :disabled="navigating || buying || packageBuying" @tap="restartPurchase">{{ preparedCart ? '重新选择商品' : '重新加载商品' }}</button>
      </view>
      <view class="detail-top-nav">
        <button v-for="entry in navEntries" :key="entry.id" size="mini" @tap="openNav(entry.id)">{{entry.name}}</button>
        <button v-if="design.openShare" size="mini" @tap="openShare">分享</button>
      </view>
      <view v-if="display.issues.length" class="design-notice">{{display.configured?'部分商品展示资料需核对':'当前使用默认商品详情布局'}}<button size="mini" @tap="load">重新读取</button></view>
      <ProductMedia :images="mediaImages" :video="skuMedia ? '' : display.video" :picture-config="design.pictureConfig" :dots="design.swiperDot" :active="visible" />
      <button v-if="skuMedia" size="mini" @tap="skuMedia=false">查看商品全部图片与视频</button>

      <!-- 价格区 -->
      <view class="price-section">
        <view class="price-row">
          <text class="price">¥{{ displayPrice }}</text>
          <text v-if="displayPriceLabel" class="member-label">{{ displayPriceLabel }}</text>
          <text v-if="design.isOpen.includes(0) && displayOriginalPrice !== null" class="ot-price">¥{{ displayOriginalPrice }}</text>
          <text v-if="displayVipPrice !== null" class="vip-tag">SVIP专享 ¥{{ displayVipPrice }}</text>
        </view>
        <view class="meta-row">
          <text v-if="design.isOpen.includes(1)">已售 {{ detail.fsales }}</text>
          <text v-if="design.isOpen.includes(2)">库存 {{ selectedSku?.stock ?? detail.stock }}</text>
        </view>
      </view>

      <!-- 商品信息 -->
      <view class="info-section">
        <view class="goods-name">{{ detail.store_name }}</view>
        <view class="goods-subtitle">{{ detail.store_info }}</view>
        <!-- 规格入口 -->
        <view v-if="design.showService.includes(1)" class="spec-entry" @tap="openSku('buy')">
          <text class="spec-label">{{ detail.is_presale_product ? '预售' : '已选' }}</text>
          <text class="spec-value">{{ detail.is_presale_product ? '查看预售规则并选择规格' : selectedSku?.suk || "请选择规格" }}</text>
          <text class="spec-arrow">›</text>
        </view>
      </view>

      <view v-if="design.showSvip && displayVipPrice && selectedSku?.price_type!=='level'" class="detail-module svip-card" @tap="navigate('/pages/user/vipOpen')">开通 SVIP，所选规格专享 ¥{{displayVipPrice}} ›</view>
      <view v-if="design.showRank && display.rank>0 && display.rankType>0" class="detail-module rank-card" @tap="goRank">{{display.rankName || '商品排行榜'}} · 第 {{display.rank}} 名 ›</view>
      <view v-if="design.showService.includes(0)" class="detail-module service-entry" @tap="marketingVisible=true">优惠与促销 <text>{{coupons.length?`${coupons.length}张可领优惠券`:'查看活动'}} ›</text></view>
      <view v-if="design.showService.includes(2) && display.ensure.length" class="detail-module service-entry" @tap="servicePanel='ensure'">保障 <text>{{display.ensure.map(item=>item.name).join(' · ')}} ›</text></view>
      <view v-if="design.showService.includes(3) && display.specs.length" class="detail-module service-entry" @tap="servicePanel='specs'">商品参数 ›</view>

      <!-- 商品评价 -->
      <view v-if="design.showReply" class="reply-section">
        <view class="reply-head">
          <text class="reply-title">商品评价</text>
          <text class="reply-count" v-if="replyStats.total > 0">
            ({{ replyStats.total }}) · {{ replyStats.avgScore }}分 · 好评率{{ replyStats.goodRate }}%
          </text>
          <text class="reply-more" v-if="replyStats.total > 0" @tap="goAllComments">全部 ›</text>
        </view>
        <view v-if="replyError" role="alert" class="module-error">{{replyError}}<button size="mini" @tap="retryReplies">重试评价</button></view>
        <view v-else-if="replies.length" class="reply-list">
          <view v-for="r in replies" :key="r.id" class="reply-item" @tap="goCommentDetail(r.id)">
            <view class="reply-user">
              <text class="reply-avatar">{{ (r.nickname || "用")[0] }}</text>
              <text class="reply-name">{{ r.nickname || "用户" }}</text>
              <text class="reply-stars">{{ starText(r.product_score) }}</text>
            </view>
            <view class="reply-comment">{{ r.comment }}</view>
            <view v-if="r.pics.length" class="reply-pics">
              <image
                v-for="(p, i) in r.pics"
                :key="i"
                class="reply-pic"
                :src="p"
                mode="aspectFill" @tap.stop="previewReply(r.pics,p)"
              />
            </view>
            <view class="reply-meta">
              <text class="reply-sku">{{ r.sku || "默认规格" }}</text>
              <text class="reply-time">{{ r.add_time }}</text>
            </view>
          </view>
        </view>
        <view v-else class="reply-empty">暂无评价, 快来抢沙发</view>
      </view>

      <view v-if="design.showCommunity" class="detail-module community-section">
        <view class="module-heading" @tap="goCommunity">商品晒单（{{display.communityCount}}）<text>全部 ›</text></view>
        <scroll-view scroll-x><view class="community-row"><view v-for="post in display.community.slice(0,design.communityNum)" :key="post.id" class="community-card" @tap="goCommunityDetail(post.id,post.contentType)"><image v-if="post.image" :src="post.image" mode="aspectFill"/><view>{{post.title || '商品晒单'}}</view></view></view></scroll-view>
        <view v-if="!display.community.length" class="reply-empty">暂无商品晒单</view>
      </view>
      <view v-if="design.showMatch && !detail.is_presale_product && discountPackages.length" class="package-section">
        <view class="package-heading">搭配购</view>
        <view
          v-for="item in discountPackages.slice(0,design.matchNum)"
          :key="item.id"
          class="package-card"
          @tap="openPackage(item)"
        >
          <view>
            <view class="package-name">{{ item.title }}</view>
            <view class="package-meta">{{ item.type === 0 ? "固定套餐" : "任选套餐" }} · {{ item.products.length }}件可选</view>
          </view>
          <view class="package-price">¥{{ item.min_price }} 起 ›</view>
        </view>
      </view>

      <view v-if="design.showRecommend" class="detail-module recommend-section">
        <view class="module-heading">为你推荐</view>
        <view v-if="recommendError" role="alert">{{recommendError}}<button size="mini" @tap="retryRecommend">重试推荐</button></view>
        <view v-else-if="design.recommendNum<=6" class="recommend-grid"><view v-for="card in recommendations" :key="card.id" class="recommend-card" @tap="goProduct(card.id)"><image :src="card.image" mode="aspectFill"/><view>{{card.name}}</view><text class="detail-price">¥{{card.price}}</text></view></view>
        <scroll-view v-else scroll-x class="recommend-scroll"><view class="recommend-columns"><view v-for="column in recommendationColumns" :key="column[0].id" class="recommend-column"><view v-for="card in column" :key="card.id" class="recommend-card" @tap="goProduct(card.id)"><image :src="card.image" mode="aspectFill"/><view>{{card.name}}</view><text class="detail-price">¥{{card.price}}</text></view></view></view></scroll-view>
        <view v-if="!recommendations.length && !recommendError" class="reply-empty">暂无推荐商品</view>
      </view>
      <view class="detail-module product-description"><view class="module-heading">商品详情</view><rich-text v-if="display.description" :nodes="display.description"/><view v-else class="reply-empty">暂无商品介绍</view></view>
      <view v-if="collectionError" class="detail-module module-error" role="alert">{{collectionError}}<button size="mini" @tap="load">重新读取收藏状态</button></view>
      <view v-if="referralNotice" class="detail-module design-notice">{{referralNotice}}</view>

      <!-- 底部操作栏 -->
      <view class="action-bar">
        <template v-for="entry in footerEntries" :key="entry.id">
          <!-- #ifdef MP-WEIXIN --><button v-if="entry.id===2 && display.contactType===1" class="action-btn contact-btn" open-type="contact" :show-message-card="true" :send-message-title="detail.store_name" :send-message-path="sharePath" :send-message-img="detail.image">客服</button><view v-else class="action-btn" :aria-disabled="entry.id===3 && collectionSaving" @tap="footerAction(entry.id)"><text class="action-icon">{{entry.icon}}</text><text class="action-text">{{entry.id===3 && collected?'已收藏':entry.name}}<text v-if="entry.id===4 && cartCount">({{cartCount}})</text></text></view><!-- #endif -->
          <!-- #ifndef MP-WEIXIN --><view class="action-btn" :aria-disabled="entry.id===3 && collectionSaving" @tap="footerAction(entry.id)"><text class="action-icon">{{entry.icon}}</text><text class="action-text">{{entry.id===3 && collected?'已收藏':entry.name}}<text v-if="entry.id===4 && cartCount">({{cartCount}})</text></text></view><!-- #endif -->
        </template>
        <button v-if="detail.is_presale_product" class="buy-btn" :disabled="purchaseLocked" @tap="goPresale">查看预售规则</button>
        <template v-else-if="preparedCart">
          <view class="add-btn" :aria-disabled="navigating" @tap="restartPurchase">重新选择商品</view>
          <view class="buy-btn" :aria-disabled="navigating" @tap="resumeCheckout">继续结算</view>
        </template>
        <view v-else-if="purchaseNeedsRefresh" class="buy-btn" @tap="restartPurchase">{{ ordinaryRecovery || ordinaryRecoveryInvalid ? '到购物车核对' : '重新加载商品' }}</view>
        <template v-else>
          <view v-if="design.showCart && detail.cart_button===1" class="add-btn" :aria-disabled="ordinaryLocked" @tap="openSku('cart')">加入购物车</view>
          <view class="buy-btn" :aria-disabled="ordinaryLocked" @tap="openSku('buy')">立即购买</view>
        </template>
      </view>

      <view v-if="servicePanel" class="mask" @tap="servicePanel='' "><view class="sheet service-sheet" @tap.stop><view class="module-heading">{{servicePanel==='ensure'?'服务保障':'商品参数'}}<button size="mini" @tap="servicePanel=''">关闭</button></view><scroll-view scroll-y class="service-scroll"><template v-if="servicePanel==='ensure'"><view v-for="entry in display.ensure" :key="entry.id" class="ensure-row"><image v-if="entry.image" :src="entry.image"/><view><text>{{entry.name}}</text><view>{{entry.desc}}</view></view></view></template><view v-else v-for="(entry,i) in display.specs" :key="i" class="spec-row"><text>{{entry.name}}</text><text>{{entry.value}}</text></view></scroll-view></view></view>
      <view v-if="marketingVisible" class="mask" @tap="marketingVisible=false"><view class="sheet" @tap.stop><view class="module-heading">优惠与促销<button size="mini" @tap="marketingVisible=false">关闭</button></view><view v-if="marketingError" role="alert">{{marketingError}}<button size="mini" @tap="retryMarketing">重新读取活动</button></view><view v-for="promotion in promotions" :key="promotion.id" class="promotion-row"><view>{{promotion.name}}</view><view>{{promotion.desc}}</view></view><view v-for="coupon in coupons" :key="coupon.id" class="coupon-row"><view>{{coupon.title}} · ¥{{coupon.price}}<view>满 ¥{{coupon.minimum}} 可用</view></view><button size="mini" :disabled="couponLoading===coupon.id || receivedCoupons.includes(coupon.id)" @tap="receiveCoupon(coupon.id)">{{receivedCoupons.includes(coupon.id)?'已处理领取':'领取'}}</button></view><view v-if="!coupons.length&&!promotions.length&&!marketingError" class="reply-empty">暂无可用优惠</view></view></view>
      <view v-if="shareVisible" class="mask" @tap="shareVisible=false"><view class="sheet share-sheet" @tap.stop><view class="module-heading">分享商品<button size="mini" @tap="shareVisible=false">关闭</button></view>
        <!-- #ifdef MP-WEIXIN --><button open-type="share">发送给微信好友</button><!-- #endif -->
        <!-- #ifdef APP-PLUS --><button :disabled="sharing" @tap="appShare('WXSceneSession')">微信好友</button><button :disabled="sharing" @tap="appShare('WXSceneTimeline')">朋友圈</button><!-- #endif -->
        <button @tap="copyShare">复制商品链接</button><button :disabled="officialCodeLoading" @tap="togglePoster">{{posterVisible?'收起海报':'生成商品海报'}}</button><view v-if="shareNotice" role="status">{{shareNotice}}</view>
        <!-- #ifdef H5 --><button v-if="ordinaryWechatBrowser()" :disabled="sharing" @tap="wechatShare">重新准备微信菜单分享</button><!-- #endif -->
        <view v-if="officialCodeLoading" role="status">正在生成微信商品码…</view><view v-if="officialCodeError" class="module-error" role="alert">{{officialCodeError}}<button v-if="authStore.isLoggedIn" size="mini" :disabled="officialCodeLoading" @tap="loadOfficialCode">重新生成微信商品码</button><button v-else size="mini" @tap="navigate('/pages/auth/login')">登录</button></view>
        <ProductSharePoster v-if="posterVisible && (!officialCodeKind() || officialCode) && (shareUrl || officialCode) && displayPrice" :url="shareUrl" :title="detail.store_name" :image="selectedSku?.image || detail.image" :price="displayPrice" :price-label="displayPriceLabel" :site-name="display.siteName" :tagline="display.posterTitle" :qr-image="officialCode"/>
      </view></view>

      <!-- SKU 规格弹窗 -->
      <view v-if="skuVisible" class="mask" @tap="skuVisible = false">
        <view class="sheet" @tap.stop>
          <view class="sku-head">
            <image
              class="sku-img"
              :src="selectedSku?.image || detail.image || placeholder"
              mode="aspectFill"
            />
            <view class="sku-info">
              <text class="sku-price">¥{{ displayPrice }}</text>
              <text v-if="displayPriceLabel" class="member-label">{{ displayPriceLabel }}</text>
              <text v-if="displayOriginalPrice !== null" class="ot-price">¥{{ displayOriginalPrice }}</text>
              <text v-if="displayVipPrice !== null" class="vip-tag">SVIP专享 ¥{{ displayVipPrice }}</text>
              <text class="sku-stock" v-if="selectedSku">库存 {{ selectedSku.stock }}</text>
              <text class="sku-name">{{ selectedSku?.suk || "请选择规格" }}</text>
            </view>
          </view>

          <view class="sku-options" v-if="skuList.length">
            <view class="sku-opt-title">规格</view>
            <view class="sku-opt-grid">
              <view
                v-for="sku in skuList"
                :key="sku.unique"
                class="sku-opt"
                :class="{ active: selectedSku?.unique === sku.unique, soldout: sku.stock <= 0 }"
                @tap="pickSku(sku)"
              >
                {{ sku.suk }}{{ sku.stock <= 0 ? '（售罄）' : '' }}
              </view>
            </view>
          </view>

          <view class="sku-num-row">
            <text>购买数量</text>
            <view class="num-ctrl">
              <view class="num-btn" @tap="!purchaseLocked && num > 1 && num--">−</view>
              <text class="num-val">{{ num }}</text>
              <view class="num-btn" @tap="!purchaseLocked && num < maxNum && num++">＋</view>
            </view>
          </view>

          <button class="sheet-btn" :disabled="ordinaryLocked || maxNum <= 0" :loading="buying" @tap="confirmSku">
            {{ buying ? "处理中…" : maxNum <= 0 ? "暂无库存" : skuMode === "buy" ? "立即购买" : "加入购物车" }}
          </button>
        </view>
      </view>

      <view v-if="packageVisible" class="mask" @tap="packageVisible = false">
        <view class="sheet package-sheet" @tap.stop>
          <view class="package-sheet-title">{{ selectedPackage?.title }}</view>
          <scroll-view scroll-y class="package-scroll">
            <view
              v-for="entry in selectedPackage?.products || []"
              :key="entry.id"
              class="package-product"
            >
              <view class="package-select" @tap="togglePackageProduct(entry)">
                <text :class="{ active: packageChoices[entry.id]?.selected }">
                  {{ packageChoices[entry.id]?.selected ? "✓" : "○" }}
                </text>
                <text>{{ isRequiredPackageEntry(entry) ? "必选" : "可选" }}</text>
              </view>
              <image class="package-image" :src="entry.image || placeholder" mode="aspectFill" />
              <view class="package-product-info">
                <view class="package-product-name">{{ entry.title }}</view>
                <view class="package-skus">
                  <view
                    v-for="sku in entry.productValue.filter((item) => item.stock > 0)"
                    :key="sku.unique"
                    class="package-sku"
                    :class="{ active: packageChoices[entry.id]?.unique === sku.unique }"
                    @tap="pickPackageSku(entry.id, sku.unique)"
                  >
                    {{ sku.suk }} ¥{{ sku.price }}
                  </view>
                </view>
              </view>
            </view>
          </scroll-view>
          <view class="package-total">
            <text>已选 {{ selectedPackageCount }} 件</text>
            <text>套餐价 ¥{{ selectedPackageTotal }}</text>
          </view>
          <view class="sheet-btn" :class="{ disabled: purchaseLocked }" :aria-disabled="purchaseLocked" @tap="buyPackage">
            {{ packageBuying ? "处理中..." : "立即结算套餐" }}
          </view>
        </view>
      </view>
    </view>
    <view v-else class="empty">商品不存在或已下架</view>
  </view>
  </ThemePage>
</template>

<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import ProductMedia from '@/components/productDetail/ProductMedia.vue';
import ProductSharePoster from '@/components/productDetail/ProductSharePoster.vue';
import { ref, computed, watch } from "vue";
import { onLoad, onShow, onHide, onUnload, onShareAppMessage, onShareTimeline } from "@dcloudio/uni-app";
import { apiGoodsDetail } from "@/api/product";
import {
  apiCartAdd,
  apiDiscountCartAdd,
  apiDiscountPackages,
  apiCartCount,
} from "@/api/order";
import { apiReplyConfig, apiReplyList } from "@/api/reply";
import type { ProductReviewListItem } from "@/api/reply";
import { useAuthStore } from "@/stores/auth";
import type { GoodsDetail, GoodsSku as SkuItem } from "@/types/product";
import type { DiscountPackage, DiscountPackageProduct } from "@/types/order";
import { skuDisplayPrice, skuPriceLabel, skuVipOffer } from "../../../../common/skuMembershipPrice";
import { productDetailId, productDetailHashId } from "../../../../common/productDetailRoute";
import { prepareProductCart, type PreparedProductCart } from '../../../../common/preparedProductCart';
import { ordinaryRecoveryKey, parseOrdinaryRecovery, type OrdinaryCartRecovery } from '../../../../common/categoryCatalog';
import { cloneProductDetailDesign } from '../../../../common/productDetailDesign';
import { quoteMoney } from '../../../../common/checkoutQuote';
import { apiProductMarketing, apiProductShareCode, parseProductDetailDesignData } from '@/api/productDetailDesign';
import { apiCouponReceive } from '@/api/activity';
import { useOrdinaryCollection } from '@/composables/useOrdinaryCollection';
import { useOrdinaryReferral } from '@/composables/useOrdinaryReferral';
import { ordinaryReferral, ordinaryShareRoute, ordinarySharePath, ordinaryShareUrl, shareOrdinaryInApp } from '@/utils/ordinaryShare';
import { configureOrdinaryWechatShare, ordinaryWechatBrowser } from '@/utils/ordinaryWechatShare';

const detail = ref<GoodsDetail | null>(null);
const authStore = useAuthStore();
const loading = ref(false), loadError = ref(''), visible = ref(false), navigating = ref(false);
const routeProductId=ref(0),referral=ref(0);
const {collected,collectionSaving,collectionError,toggleCollection}=useOrdinaryCollection(detail,visible);
const {referralNotice,disposeReferral}=useOrdinaryReferral(routeProductId,referral,visible);
const display=computed(()=>detail.value?.display??parseProductDetailDesignData({id:0}));
const design=computed(()=>display.value.design??cloneProductDetailDesign());
const navNames=['首页','搜索','购物车','收藏','我的'],footerNames=['首页','分享','客服','收藏','购物车'],footerIcons=['⌂','↗','☏','♡','🛒'];
const navEntries=computed(()=>design.value.navList.map(id=>({id,name:navNames[id]})));
const footerEntries=computed(()=>design.value.menuList.map(id=>({id,name:footerNames[id],icon:footerIcons[id]})));
const skuMedia=ref(false),mediaImages=computed(()=>skuMedia.value&&selectedSku.value?.image?[selectedSku.value.image]:detail.value?.slider_image??[]);
const servicePanel=ref<''|'ensure'|'specs'>(''),marketingVisible=ref(false),marketingError=ref(''),replyError=ref(''),recommendError=ref('');
const coupons=ref<Array<{id:number;title:string;price:string;minimum:string}>>([]),promotions=ref<Array<{id:number;name:string;desc:string}>>([]),receivedCoupons=ref<number[]>([]),couponLoading=ref(0),cartCount=ref(0);
const shareVisible=ref(false),posterVisible=ref(false),shareNotice=ref(''),sharing=ref(false);
const officialCode=ref(''),officialCodeLoading=ref(false),officialCodeError=ref('');let shareGeneration=0,codeGeneration=0;
watch(()=>[shareVisible.value,posterVisible.value],()=>{if(!shareVisible.value){shareGeneration++;sharing.value=false;}if(!shareVisible.value||!posterVisible.value){codeGeneration++;officialCode.value='';officialCodeLoading.value=false;officialCodeError.value='';}},{flush:'sync'});
const sharePath=computed(()=>ordinarySharePath(productId,authStore.isLoggedIn?authStore.uid:0));
const shareUrl=computed(()=>ordinaryShareUrl(sharePath.value,display.value.siteUrl));
const recommendations=computed(()=>display.value.recommend.slice(0,design.value.recommendNum));
const recommendationColumns=computed(()=>{const list=recommendations.value,columns=[];for(let i=0;i<list.length;i+=2)columns.push(list.slice(i,i+2));return columns;});
let productId = 0, revision = 0, disposed = false, authRefreshQueued = false;
const replies = ref<ProductReviewListItem[]>([]);
const replyStats = ref({ total: 0, avgScore: "0.0", goodRate: 100 });
const discountPackages = ref<DiscountPackage[]>([]);
const selectedPackage = ref<DiscountPackage | null>(null);
const packageVisible = ref(false);
const packageBuying = ref(false);
const packageChoices = ref<Record<number, { selected: boolean; unique: string }>>({});
const selectedPackageCount = computed(() =>
  Object.values(packageChoices.value).filter((choice) => choice.selected).length,
);
const selectedPackageTotal = computed(() => {
  if (!selectedPackage.value) return "0.00";
  const cents = selectedPackage.value.products.reduce((sum, entry) => {
    const choice = packageChoices.value[entry.id];
    if (!choice?.selected) return sum;
    const price = entry.productValue.find((sku) => sku.unique === choice.unique)?.price ?? "0";
    return sum + BigInt(quoteMoney(price).replace('.',''));
  }, 0n);
  return `${cents/100n}.${String(cents%100n).padStart(2,'0')}`;
});
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

// ─── SKU 弹窗状态 ───
const skuVisible = ref(false);
const skuMode = ref<"cart" | "buy">("cart");
const skuList = ref<SkuItem[]>([]);
const selectedSku = ref<SkuItem | null>(null);
const num = ref(1);
const buying = ref(false);
const preparedCart = ref<PreparedProductCart | null>(null), checkoutError = ref(''), purchaseNeedsRefresh = ref(false);
const ordinaryRecovery = ref<OrdinaryCartRecovery | null>(null), ordinaryRecoveryInvalid = ref(false);
const purchaseLocked = computed(() => buying.value || packageBuying.value || navigating.value || !!preparedCart.value || purchaseNeedsRefresh.value && !ordinaryRecovery.value);
const ordinaryLocked = computed(() => purchaseLocked.value || ordinaryRecovery.value !== null || ordinaryRecoveryInvalid.value);
let navigationGeneration = 0;
const maxNum = computed(() => Math.min(selectedSku.value?.stock ?? 0, detail.value?.stock ?? 0, 32767));
// A selected SKU is authoritative for display; absent SKU prices must not inherit another price.
const displayPrice = computed(() => selectedSku.value ? selectedSku.value.display_price?.price ?? skuDisplayPrice(selectedSku.value) : detail.value?.price);
const displayPriceLabel = computed(() => {const hint=selectedSku.value?.display_price;if(hint)return hint.enabled?(hint.price_type==='member'?'SVIP价':hint.price_type==='level'?`${hint.level_name||'会员'}价`:''):'';return skuPriceLabel(selectedSku.value);});
const displayOriginalPrice = computed(() => selectedSku.value?.ot_price && displayPrice.value && BigInt(quoteMoney(selectedSku.value.ot_price).replace('.','')) > BigInt(quoteMoney(displayPrice.value).replace('.','')) ? selectedSku.value.ot_price : null);
const displayVipPrice = computed(() => skuVipOffer(selectedSku.value, detail.value?.is_vip === 1&&design.value.showPrice.includes(1)));

function goPresale() {
  if (!visible.value || disposed || !detail.value?.is_presale_product || loading.value || purchaseLocked.value) return;
  navigate(`/pages/activity/presaleDetail?id=${detail.value.id}`);
}
function openSku(mode: "cart" | "buy") {
  if (!visible.value || disposed || !detail.value || loading.value || ordinaryLocked.value) return;
  if (detail.value.is_presale_product) return goPresale();
  if(mode==='cart'&&(!design.value.showCart||detail.value.cart_button!==1))return uni.showToast({title:'此商品请通过立即购买填写所需资料',icon:'none'});
  if (!authStore.isLoggedIn) return navigate('/pages/auth/login');
  skuMode.value = mode;
  num.value = 1;
  skuVisible.value = true;
}

function pickSku(sku: SkuItem) {
  if (!visible.value || disposed || ordinaryLocked.value || !skuList.value.includes(sku)) return;
  selectedSku.value = sku;
  skuMedia.value=!!sku.image;
  num.value = Math.max(1, Math.min(num.value, maxNum.value));
}

async function confirmSku() {
  if (detail.value?.is_presale_product) return goPresale();
  if (preparedCart.value?.type === 0) return resumeCheckout();
  if (!visible.value || disposed || !detail.value || loading.value || ordinaryLocked.value) return;
  if (!authStore.isLoggedIn) return navigate('/pages/auth/login');
  if(skuMode.value==='cart'&&(!design.value.showCart||detail.value.cart_button!==1))return;
  if (!selectedSku.value) return uni.showToast({ title: "请选择规格", icon: "none" });
  const sku = selectedSku.value;
  if (!Number.isSafeInteger(num.value) || num.value < 1 || num.value > Math.min(sku.stock, detail.value.stock, 32767)) return uni.showToast({ title: "数量无效或库存不足", icon: "none" });

  buying.value = true;
  const current = currentView();
  const mode = skuMode.value;
  const frozen: OrdinaryCartRecovery = {version:1,actor:authStore.uid,state:'unknown',mode,productId:detail.value.id,unique:sku.unique,quantity:num.value,cartId:null};
  if (uni.getStorageSync(ordinaryRecoveryKey(authStore.uid))) { buying.value=false; restoreOrdinaryRecovery(); return; }
  try { uni.setStorageSync(ordinaryRecoveryKey(frozen.actor),JSON.stringify(frozen)); ordinaryRecovery.value=frozen; }
  catch { buying.value=false; checkoutError.value='无法保存购买恢复资料，本次尚未提交'; return; }
  try {
    const cart = await apiCartAdd({
      productId: detail.value.id,
      unique: sku.unique,
      cartNum: num.value,
      new: mode === "buy" ? 1 : 0,
    });
    if (!current()) return;
    const prepared = prepareProductCart(cart, 0);
    const acknowledged: OrdinaryCartRecovery = {...frozen,state:'acknowledged',cartId:prepared.ids[0]};
    ordinaryRecovery.value=acknowledged;
    if(mode==='buy')preparedCart.value=prepared;
    uni.setStorageSync(ordinaryRecoveryKey(frozen.actor),JSON.stringify(acknowledged));
    skuVisible.value = false;
    if (mode === "buy") {
      // 立即购买 → 确认订单页 (buy 模式, 仅结算当前加购的商品)
      preparedCart.value = prepared;
      resumeCheckout();
    } else {
      uni.removeStorageSync(ordinaryRecoveryKey(frozen.actor)); ordinaryRecovery.value=null;
      uni.showToast({ title: "已加入购物车", icon: "success" });
    }
  } catch (e) {
    if (current()) { purchaseNeedsRefresh.value = true; checkoutError.value = e instanceof Error ? e.message : '购买记录未确认'; skuVisible.value = false; }
  } finally { if (current()) buying.value = false; }
}

function isRequiredPackageEntry(entry: DiscountPackageProduct): boolean {
  return selectedPackage.value?.type === 0 || entry.type === 1;
}

function openPackage(item: DiscountPackage) {
  if (detail.value?.is_presale_product) return;
  if (!visible.value || disposed || !detail.value || loading.value || purchaseLocked.value || !discountPackages.value.includes(item)) return;
  if (!authStore.isLoggedIn) return navigate('/pages/auth/login');
  selectedPackage.value = item;
  packageChoices.value = Object.fromEntries(item.products.map((entry) => [
    entry.id,
    {
      selected: item.type === 0 || entry.type === 1,
      unique: entry.productValue.find((sku) => sku.stock > 0)?.unique ?? "",
    },
  ]));
  packageVisible.value = true;
}

function togglePackageProduct(entry: DiscountPackageProduct) {
  if (!visible.value || disposed || purchaseLocked.value) return;
  if (isRequiredPackageEntry(entry)) return;
  const choice = packageChoices.value[entry.id];
  if (choice) choice.selected = !choice.selected;
}

function pickPackageSku(entryId: number, unique: string) {
  if (!visible.value || disposed || purchaseLocked.value) return;
  const choice = packageChoices.value[entryId];
  if (choice) choice.unique = unique;
}

async function buyPackage() {
  if (detail.value?.is_presale_product) return;
  if (preparedCart.value?.type === 5) return resumeCheckout();
  const item = selectedPackage.value;
  if (!visible.value || disposed || !detail.value || !item || purchaseLocked.value || !discountPackages.value.includes(item)) return;
  if (!authStore.isLoggedIn) return navigate('/pages/auth/login');
  const current = currentView();
  const selected = item.products.filter((entry) => packageChoices.value[entry.id]?.selected);
  if (selected.length < 2) return uni.showToast({ title: "套餐至少选择两件商品", icon: "none" });
  if (selected.some((entry) => !packageChoices.value[entry.id]?.unique)) {
    return uni.showToast({ title: "请选择全部已选商品的规格", icon: "none" });
  }
  packageBuying.value = true;
  try {
    const result = await apiDiscountCartAdd({
      discountId: item.id,
      discountInfos: selected.map((entry) => ({
        id: entry.id,
        product_id: entry.product_id,
        unique: packageChoices.value[entry.id].unique,
      })),
    });
    if (!current()) return;
    preparedCart.value = prepareProductCart(result, 5, selected.length);
    packageVisible.value = false;
    resumeCheckout();
  } catch (error) {
    if (current()) { purchaseNeedsRefresh.value = true; checkoutError.value = error instanceof Error ? error.message : '套餐购买记录未确认'; packageVisible.value = false; }
  } finally {
    if (current()) packageBuying.value = false;
  }
}

function starText(score: number): string {
  const n = Math.min(5, Math.max(1, Number(score) || 5));
  return "★".repeat(n);
}

async function loadReplies(id: number, current: () => boolean) {
  replyError.value='';
  try {
    const stats = await apiReplyConfig(id);
    if (!current()) return;
    replyStats.value = stats;
  } catch {if(current())replyError.value='评价统计暂不可用，请重试';}
  try {
    if (!current()) return;
    const rows = await apiReplyList(id,1,design.value.replyNum);
    if (current()) replies.value = rows;
  } catch {
    if (current()) {replies.value = [];replyError.value='商品评价读取失败，请重试';}
  }
}
function retryReplies(){if(visible.value&&detail.value)void loadReplies(detail.value.id,currentView());}
function retryRecommend(){recommendError.value='';void load();}
async function retryMarketing(){if(!visible.value||!detail.value||!design.value.showService.includes(0))return;const current=currentView();marketingError.value='';try{const data=await apiProductMarketing(detail.value.id);if(current()){coupons.value=data.coupons;promotions.value=data.promotions;}}catch{if(current())marketingError.value='优惠活动读取失败，请重试';}}
async function receiveCoupon(id:number){if(!visible.value||!detail.value||couponLoading.value||!coupons.value.some(row=>row.id===id)||receivedCoupons.value.includes(id))return;
  if(!authStore.isLoggedIn)return navigate('/pages/auth/login');const current=currentView();couponLoading.value=id;
  try{await apiCouponReceive(id);if(current()){receivedCoupons.value.push(id);uni.showToast({title:'优惠券领取已处理',icon:'success'});}}
  catch{if(current())marketingError.value='优惠券领取未确认，可在优惠券页面核对后重新读取';}finally{if(current())couponLoading.value=0;}
}
function previewReply(urls:string[],current:string){if(visible.value&&urls.includes(current))uni.previewImage({urls:[...urls],current});}
function goProduct(id:number){if(recommendations.value.some(row=>row.id===id))navigate(`/pages/goods/detail?id=${id}`);}
function goRank(){if(display.value.rank>0&&display.value.rankType>0)navigate(`/pages/columnGoods/rank/index?type=${display.value.rankType}`);}
function goCommunity(){if(detail.value)navigate(`/pages/goods/productCommunity?productId=${detail.value.id}`);}
function goCommunityDetail(id:number,type:number){if(display.value.community.some(row=>row.id===id))navigate(type===2?`/pages/discover/discoverVideo/index?id=${id}`:`/pages/discover/index?id=${id}`);}
function openNav(id:number){if(!design.value.navList.includes(id))return;if(id===0)return switchPage('/pages/index/index');if(id===2)return goCart();if(id===4)return switchPage('/pages/user/index');navigate(id===1?'/pages/goods/search':'/pages/user/collect');}
function footerAction(id:number){if(!design.value.menuList.includes(id))return;if(id===0)return switchPage('/pages/index/index');if(id===1)return openShare();if(id===2)return navigate(`/pages/user/kefu?productId=${detail.value?.id}`);if(id===3){void toggleCollection();return;}if(id===4)goCart();}
function switchPage(url:string){if(!visible.value||disposed||navigating.value)return;const current=currentView();try{uni.switchTab({url,fail:()=>{if(current())uni.showToast({title:'页面未打开，请重试',icon:'none'});}});}catch{if(current())uni.showToast({title:'页面未打开，请重试',icon:'none'});}}
function openShare(){if(visible.value&&detail.value){shareVisible.value=true;shareNotice.value='';if(ordinaryWechatBrowser())void wechatShare();}}
function copyShare(){if(!shareUrl.value){shareNotice.value='商家尚未配置可分享的商品网页';return;}const current=currentView();uni.setClipboardData({data:shareUrl.value,success:()=>{if(current())shareNotice.value='商品链接已复制';},fail:()=>{if(current())shareNotice.value='链接复制失败，请重试';}});}
function appShare(scene:'WXSceneSession'|'WXSceneTimeline'){if(!detail.value||sharing.value)return;const current=currentView();sharing.value=true;shareOrdinaryInApp({url:shareUrl.value,title:detail.value.store_name,image:selectedSku.value?.image||detail.value.image,summary:display.value.posterTitle},scene,message=>{if(current()){sharing.value=false;shareNotice.value=message;}},current);}
async function wechatShare(){if(!detail.value||!shareVisible.value||sharing.value)return;const owner=currentView(),epoch=++shareGeneration,current=()=>owner()&&shareVisible.value&&epoch===shareGeneration;
  sharing.value=true;shareNotice.value='正在准备微信分享…';await configureOrdinaryWechatShare({url:shareUrl.value,title:detail.value.store_name,image:selectedSku.value?.image||detail.value.image,summary:display.value.posterTitle},current,message=>{if(current())shareNotice.value=message;});if(current())sharing.value=false;
}
function officialCodeKind():''|'wechat'|'routine'{
  // #ifdef H5
  if(typeof window!=='undefined')return ordinaryWechatBrowser()&&display.value.shareQrcode===1?'wechat':'';
  // #endif
  // #ifdef MP-WEIXIN
  return 'routine';
  // #endif
  return '';
}
async function loadOfficialCode(){const kind=officialCodeKind();if(!kind||!posterVisible.value||!shareVisible.value||!detail.value||officialCodeLoading.value)return;
  officialCode.value='';officialCodeError.value='';if(!authStore.isLoggedIn){officialCodeError.value='登录后才能生成微信官方商品码';return;}
  const owner=currentView(),epoch=++codeGeneration,id=detail.value.id,current=()=>owner()&&shareVisible.value&&posterVisible.value&&epoch===codeGeneration&&officialCodeKind()===kind;
  officialCodeLoading.value=true;try{const code=await apiProductShareCode(id,kind);if(current())officialCode.value=code;}
  catch(error){if(current())officialCodeError.value=error instanceof Error?error.message:'微信商品码生成失败，请重试';}finally{if(current())officialCodeLoading.value=false;}
}
function togglePoster(){if(!shareVisible.value||!detail.value)return;posterVisible.value=!posterVisible.value;if(posterVisible.value)void loadOfficialCode();}

function goCart() {
  if (!visible.value || disposed || navigating.value) return;
  switchPage('/pages/cart/index');
}

function goAllComments() {
  if (!detail.value) return;
  navigate(`/pages/goods/commentList?productId=${detail.value.id}`);
}

function goCommentDetail(id: number) {
  if (!visible.value || disposed || navigating.value || !replies.value.some(row => row.id === id)) return;
  navigate(`/pages/goods/commentDetail?id=${id}`);
}

function currentView() {
  const current = revision, owner = { version: authStore.sessionVersion, token: authStore.token, uid: authStore.uid }, id = productId;
  return () => !disposed && visible.value && revision === current && productId === id
    && owner.version === authStore.sessionVersion && owner.token === authStore.token && owner.uid === authStore.uid;
}
function clearView() {
  revision++; detail.value = null; skuList.value = []; selectedSku.value = null; num.value = 1; skuVisible.value = false;
  discountPackages.value = []; selectedPackage.value = null; packageChoices.value = {}; packageVisible.value = false;
  replies.value = []; replyStats.value = { total: 0, avgScore: '0.0', goodRate: 100 };
  loading.value = false; loadError.value = ''; buying.value = false; packageBuying.value = false; navigating.value = false;
  navigationGeneration++; preparedCart.value = null; checkoutError.value = ''; purchaseNeedsRefresh.value = false;
  ordinaryRecovery.value=null;ordinaryRecoveryInvalid.value=false;
  servicePanel.value='';marketingVisible.value=false;marketingError.value='';replyError.value='';recommendError.value='';coupons.value=[];promotions.value=[];receivedCoupons.value=[];couponLoading.value=0;cartCount.value=0;
  shareGeneration++;codeGeneration++;shareVisible.value=false;posterVisible.value=false;shareNotice.value='';sharing.value=false;officialCode.value='';officialCodeError.value='';officialCodeLoading.value=false;skuMedia.value=false;
}
function restoreOrdinaryRecovery(){
  if(!visible.value||disposed||!authStore.isLoggedIn||authStore.uid<1)return;
  const raw=uni.getStorageSync(ordinaryRecoveryKey(authStore.uid));if(raw===undefined||raw===null||raw==='')return;
  try{const row=parseOrdinaryRecovery(raw,authStore.uid);ordinaryRecovery.value=row;
    if(row.state==='acknowledged'&&row.mode==='buy'){if(row.productId===productId)preparedCart.value=prepareProductCart({id:row.cartId},0);checkoutError.value=row.productId===productId?'已创建购买记录，可继续同一笔结算':'另一个商品的购买记录已创建；可返回其详情继续结算，或明确重新选择商品';}
    else if(row.state==='acknowledged'){uni.removeStorageSync(ordinaryRecoveryKey(row.actor));ordinaryRecovery.value=null;}
    else{purchaseNeedsRefresh.value=true;checkoutError.value='读取商品或购物车不能证明上次提交失败，继续保留购买保护';}}
  catch{ordinaryRecoveryInvalid.value=true;checkoutError.value='购买恢复资料异常，请在购物车核对';}
}
function navigate(url: string, onFailure?: () => void) {
  if (!visible.value || disposed || navigating.value) return;
  const current = currentView(), generation = ++navigationGeneration; navigating.value = true;
  const fail = () => { if (current() && generation === navigationGeneration) { navigating.value = false; if (onFailure) onFailure(); else uni.showToast({ title: '页面打开失败，请重试', icon: 'none' }); } };
  try { uni.navigateTo({ url, fail }); } catch { fail(); }
}
function resumeCheckout() {
  const prepared = preparedCart.value;
  if (!visible.value || disposed || !detail.value || !prepared || navigating.value || !authStore.isLoggedIn) return;
  checkoutError.value = '';
  navigate(prepared.type === 5 ? `/pages/order/confirm?mode=buy&cartIds=${prepared.ids.join(',')}&type=5`
    : `/pages/order/confirm?mode=buy&cartId=${prepared.ids[0]}&from=sku`, () => { if (preparedCart.value === prepared) checkoutError.value = '结算页面未打开，请点击继续结算'; });
}
function restartPurchase() {
  if (!visible.value || disposed || navigating.value || buying.value || packageBuying.value) return;
  if(ordinaryRecovery.value?.state==='unknown'||ordinaryRecoveryInvalid.value){goCart();return;}
  if(ordinaryRecovery.value?.state==='acknowledged'){uni.removeStorageSync(ordinaryRecoveryKey(ordinaryRecovery.value.actor));ordinaryRecovery.value=null;}
  void load();
}
async function load() {
  if (!visible.value || disposed || !productId) return;
  clearView(); loading.value = true;
  restoreOrdinaryRecovery();
  const id = productId, current = currentView();
  try {
    const [goods, packages] = await Promise.all([
      apiGoodsDetail(id),
      apiDiscountPackages(id).catch(() => []),
    ]);
    if (!current()) return;
    if (goods.id !== id) throw new Error('商品详情标识不匹配，请重新加载');
    detail.value = goods;
    discountPackages.value = goods.is_presale_product||!design.value.showMatch ? [] : packages.slice(0,design.value.matchNum);
    if(design.value.showReply){replies.value=(goods.display?.replies??[]).slice(0,design.value.replyNum);replyStats.value={total:goods.display?.replyCount??0,avgScore:'0.0',goodRate:goods.display?.replyChance??0};if(!goods.display?.configured)void loadReplies(id,current);}
    if(design.value.showService.includes(0))void retryMarketing();
    if(authStore.isLoggedIn)void apiCartCount().then(row=>{if(current()&&Number.isSafeInteger(row.count)&&row.count>=0)cartCount.value=row.count;}).catch(()=>{});
    skuList.value = goods.skus;
    selectedSku.value = goods.skus.find((sku) => sku.stock > 0) ?? goods.skus[0] ?? null;
  } catch (e) {
    if (current()) loadError.value = e instanceof Error ? e.message : '商品详情加载失败';
  } finally { if (current()) loading.value = false; }
}
function setRoute(id: unknown,spid:unknown=undefined) {
  if (disposed) return;
  clearView(); productId = 0;
  try {const nextId=productDetailId(id),nextReferral=ordinaryReferral(spid);productId=nextId;routeProductId.value=nextId;referral.value=nextReferral;if (visible.value) void load(); }
  catch (e) {productId=0;routeProductId.value=0;referral.value=0;loadError.value = e instanceof Error ? e.message : '商品链接无效'; }
}
function readHashRoute(): boolean {
  // #ifdef H5
  if (typeof window !== 'undefined') {
    try { const id = productDetailHashId(window.location.hash); if (id !== null) {const params=new URLSearchParams(window.location.hash.split('?')[1]??'');if(params.getAll('spid').length>1)throw Error('推荐人链接重复');setRoute(String(id),params.get('spid')??undefined); return true; } }
    catch (e) { clearView(); productId = 0; loadError.value = e instanceof Error ? e.message : '商品链接无效'; return true; }
  }
  // #endif
  return false;
}
function hashChanged() {
  if (!visible.value || disposed) return;
  if (!readHashRoute()) { clearView(); productId = 0; }
}
watch(() => authStore.sessionVersion, () => {
  clearView();
  // setLogin publishes its epoch before token/UID. Clear synchronously, then
  // fetch only after the complete store action; coalesce repeated changes.
  if (authRefreshQueued) return;
  authRefreshQueued = true;
  void Promise.resolve().then(() => { authRefreshQueued = false; if (visible.value && !disposed) void load(); });
}, { flush: 'sync' });
onLoad(options => {try{const route=ordinaryShareRoute(options);setRoute(route.id,route.spid);}catch(error){clearView();productId=0;routeProductId.value=0;referral.value=0;loadError.value=error instanceof Error?error.message:'商品分享链接无效';}});
onShow(() => { if (disposed) return; visible.value = true; if (!readHashRoute()) void load(); });
onHide(() => { visible.value = false; clearView(); });
// #ifdef H5
if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
// #endif
onUnload(() => {
  disposed = true; visible.value = false; clearView();
  disposeReferral();
  // #ifdef H5
  if (typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
  // #endif
});
onShareAppMessage(()=>({title:detail.value?.store_name||'商品详情',path:sharePath.value,imageUrl:selectedSku.value?.image||detail.value?.image||''}));
onShareTimeline(()=>({title:detail.value?.store_name||'商品详情',query:sharePath.value.split('?')[1]||'',imageUrl:selectedSku.value?.image||detail.value?.image||''}));
</script>

<style scoped>
.detail-top-nav{display:flex;gap:12rpx;flex-wrap:wrap;padding:20rpx;background:#fff}.detail-top-nav button{margin:0}.design-notice{padding:16rpx 24rpx;color:#666;font-size:24rpx}.detail-module{background:#fff;padding:24rpx;margin:16rpx 0}.module-heading{font-size:30rpx;font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:14rpx;margin-bottom:18rpx}.module-heading button{font-size:24rpx;margin:0}.module-heading>text{font-size:24rpx;color:#888}.service-entry{display:flex;justify-content:space-between;gap:18rpx;font-size:26rpx}.service-entry>text{color:#777;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%}.svip-card{background:#fdf4df;color:#885e19}.rank-card{color:var(--view-theme)}.community-row,.recommend-columns{display:flex;gap:18rpx}.community-card{width:200rpx;flex-shrink:0}.community-card image{width:200rpx;height:200rpx}.recommend-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16rpx}.recommend-card{font-size:24rpx;overflow:hidden}.recommend-card image{width:100%;height:210rpx}.recommend-card>view{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.recommend-column{width:210rpx;flex-shrink:0;display:flex;flex-direction:column;gap:20rpx}.detail-price{color:var(--view-priceColor);display:block;margin-top:8rpx}.service-scroll{max-height:55vh}.ensure-row{display:flex;gap:18rpx;padding:20rpx 0}.ensure-row image{width:50rpx;height:50rpx;flex-shrink:0}.ensure-row>view{flex:1}.spec-row{display:flex;gap:24rpx;padding:20rpx 0;border-bottom:1rpx solid #eee}.spec-row>text:first-child{width:180rpx;flex-shrink:0;color:#777}.spec-row>text:last-child{flex:1;white-space:pre-wrap}.promotion-row,.coupon-row{padding:20rpx 0;border-bottom:1rpx solid #eee}.coupon-row{display:flex;justify-content:space-between;gap:18rpx}.module-error{color:#a72823}.share-sheet{max-height:80vh;overflow-y:auto}.product-description{overflow-x:auto}.product-description :deep(img){max-width:100%}.action-btn{min-width:66rpx;flex-shrink:0}.action-bar{gap:8rpx}.buy-btn,.add-btn{min-width:0;flex:1}.sheet{max-height:80vh;overflow-y:auto}
.purchase-recovery { margin: 20rpx; padding: 24rpx; background: #fff6e9; border: 1rpx solid #efd6b3; border-radius: 12rpx; }
.purchase-recovery button { margin-top: 12rpx; font-size: 28rpx; }
.action-bar [aria-disabled="true"] { opacity: 0.5; }
.goods-detail {
  max-width:960px;margin:0 auto;
  padding-bottom: 140rpx;
}

.swiper {
  height: 750rpx;
}

.swiper-img {
  width: 100%;
  height: 100%;
}

.price-section {
  background: #fff;
  padding: 24rpx;
}

.price-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 16rpx;
}

.member-label { color: #9b5717; font-size: 24rpx; }

.price {
  color: var(--view-priceColor, #e93323);
  font-size: 44rpx;
  font-weight: 700;
}

.ot-price {
  color: #999;
  text-decoration: line-through;
  font-size: 26rpx;
}

.vip-tag {
  align-self: flex-start;
  background: linear-gradient(90deg, #d4a94e, #f5d97a);
  color: #fff;
  border-radius: 6rpx;
  padding: 4rpx 12rpx;
  font-size: 22rpx;
}

.meta-row {
  display: flex;
  gap: 40rpx;
  color: #999;
  font-size: 24rpx;
  margin-top: 12rpx;
}

.info-section {
  background: #fff;
  padding: 24rpx;
  margin-top: 20rpx;
}

.package-section {
  background: #fff;
  padding: 24rpx;
  margin-top: 20rpx;
}

.package-heading,
.package-sheet-title {
  font-size: 30rpx;
  font-weight: 600;
  margin-bottom: 16rpx;
}

.package-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: 2rpx solid var(--view-minorColor, rgba(233, 51, 35, 0.5));
  background: #fff8f7;
  border-radius: 12rpx;
  padding: 18rpx;
  margin-top: 12rpx;
}

.package-name {
  font-size: 27rpx;
  font-weight: 600;
}

.package-meta {
  color: #999;
  font-size: 22rpx;
  margin-top: 6rpx;
}

.package-price {
  color: var(--view-priceColor, #e93323);
  font-size: 25rpx;
}

.package-sheet {
  max-height: 78vh;
}

.package-scroll {
  max-height: 760rpx;
}

.package-product {
  display: flex;
  gap: 16rpx;
  padding: 18rpx 0;
  border-bottom: 1rpx solid #f2f2f2;
}

.package-select {
  width: 76rpx;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: #999;
  font-size: 22rpx;
}

.package-select .active {
  color: var(--view-theme, #e93323);
  font-size: 30rpx;
}

.package-image {
  width: 100rpx;
  height: 100rpx;
  border-radius: 10rpx;
  flex-shrink: 0;
}

.package-product-info {
  flex: 1;
  min-width: 0;
}

.package-product-name {
  font-size: 26rpx;
  margin-bottom: 12rpx;
}

.package-skus {
  display: flex;
  flex-wrap: wrap;
  gap: 10rpx;
}

.package-sku {
  border: 2rpx solid #eee;
  border-radius: 8rpx;
  padding: 8rpx 12rpx;
  color: #666;
  font-size: 22rpx;
}

.package-sku.active {
  border-color: var(--view-theme, #e93323);
  color: var(--view-theme, #e93323);
  background: var(--view-minorColorT, rgba(233, 51, 35, 0.1));
}

.package-total {
  display: flex;
  justify-content: space-between;
  color: var(--view-priceColor, #e93323);
  font-size: 28rpx;
  padding-top: 20rpx;
}

.sheet-btn.disabled {
  opacity: 0.6;
}

.spec-entry {
  display: flex;
  align-items: center;
  margin-top: 16rpx;
  padding-top: 16rpx;
  border-top: 1rpx solid #f5f5f5;
}

.spec-label {
  font-size: 26rpx;
  color: #999;
  margin-right: 16rpx;
}

.spec-value {
  flex: 1;
  font-size: 26rpx;
  color: #333;
}

.spec-arrow {
  color: #bbb;
  font-size: 32rpx;
}

.reply-section {
  background: #fff;
  padding: 24rpx;
  margin-top: 20rpx;
}

.reply-head {
  display: flex;
  align-items: baseline;
  margin-bottom: 16rpx;
}

.reply-title {
  font-size: 30rpx;
  font-weight: 600;
}

.reply-count {
  font-size: 22rpx;
  color: #999;
  margin-left: 12rpx;
}

.reply-more {
  font-size: 22rpx;
  color: var(--view-theme, #e93323);
  margin-left: auto;
}

.reply-item {
  border-top: 1rpx solid #f7f7f7;
  padding: 20rpx 0;
}

.reply-user {
  display: flex;
  align-items: center;
  margin-bottom: 10rpx;
}

.reply-avatar {
  width: 44rpx;
  height: 44rpx;
  background: var(--view-theme, #e93323);
  color: #fff;
  border-radius: 50%;
  font-size: 24rpx;
  text-align: center;
  line-height: 44rpx;
  margin-right: 12rpx;
}

.reply-name {
  font-size: 24rpx;
  color: #333;
  flex: 1;
}

.reply-stars {
  font-size: 20rpx;
  color: #ff9900;
}

.reply-comment {
  font-size: 26rpx;
  color: #444;
  line-height: 1.6;
}

.reply-pics {
  display: flex;
  gap: 12rpx;
  margin-top: 12rpx;
}

.reply-pic {
  width: 140rpx;
  height: 140rpx;
  border-radius: 8rpx;
}

.reply-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 12rpx;
}

.reply-sku,
.reply-time {
  font-size: 22rpx;
  color: #bbb;
}

.reply-empty {
  text-align: center;
  color: #999;
  font-size: 24rpx;
  padding: 40rpx 0;
}

.goods-name {
  font-size: 32rpx;
  font-weight: 600;
}

.goods-subtitle {
  font-size: 26rpx;
  color: #999;
  margin-top: 8rpx;
}

.action-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #fff;
  display: flex;
  align-items: center;
  padding: 16rpx 20rpx;
  padding-bottom: calc(16rpx + env(safe-area-inset-bottom));
  box-shadow: 0 -2rpx 10rpx rgba(0, 0, 0, 0.05);
}

.action-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-right: 20rpx;
}

.action-icon {
  font-size: 40rpx;
}

.action-text {
  font-size: 20rpx;
  color: #555;
}

.add-btn {
  flex: 1;
  background: var(--view-bntColor, #FE960F);
  color: #fff;
  text-align: center;
  padding: 20rpx;
  border-radius: 40rpx 0 0 40rpx;
  font-size: 28rpx;
}

.buy-btn {
  flex: 1;
  background: var(--view-theme, #e93323);
  color: #fff;
  text-align: center;
  padding: 20rpx;
  border-radius: 0 40rpx 40rpx 0;
  font-size: 28rpx;
}

/* ─── SKU 弹窗 ─── */
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
  display: flex;
  align-items: flex-end;
}

.sheet {
  background: #fff;
  width: 100%;
  border-radius: 24rpx 24rpx 0 0;
  padding: 30rpx;
}

.sku-head {
  display: flex;
  gap: 20rpx;
  margin-bottom: 24rpx;
}

.sku-img {
  width: 140rpx;
  height: 140rpx;
  border-radius: 12rpx;
  flex-shrink: 0;
}

.sku-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.sku-price {
  color: var(--view-priceColor, #e93323);
  font-size: 36rpx;
  font-weight: 700;
}

.sku-stock {
  color: #999;
  font-size: 24rpx;
  margin-top: 6rpx;
}

.sku-name {
  color: #333;
  font-size: 26rpx;
  margin-top: 6rpx;
}

.sku-opt-title {
  font-size: 26rpx;
  color: #999;
  margin-bottom: 16rpx;
}

.sku-opt-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
  margin-bottom: 24rpx;
}

.sku-opt {
  border: 2rpx solid #e5e5e5;
  border-radius: 10rpx;
  padding: 12rpx 30rpx;
  font-size: 26rpx;
  color: #333;
  background: #fff;
}

.sku-opt.active {
  border-color: var(--view-theme, #e93323);
  color: var(--view-theme, #e93323);
  background: var(--view-minorColorT, rgba(233, 51, 35, 0.1));
}

.sku-opt.soldout:not(.active) {
  color: #ccc;
  border-color: #eee;
  background: #fafafa;
}

.sku-num-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24rpx;
  font-size: 26rpx;
  color: #333;
}

.num-ctrl {
  display: flex;
  align-items: center;
  gap: 24rpx;
}

.num-btn {
  width: 52rpx;
  height: 52rpx;
  border: 2rpx solid #ddd;
  border-radius: 8rpx;
  text-align: center;
  line-height: 48rpx;
  font-size: 30rpx;
  color: #555;
}

.num-val {
  font-size: 30rpx;
  min-width: 40rpx;
  text-align: center;
}

.sheet-btn {
  background: var(--view-theme, #e93323);
  color: #fff;
  text-align: center;
  padding: 22rpx;
  border-radius: 44rpx;
  font-size: 30rpx;
}
</style>
