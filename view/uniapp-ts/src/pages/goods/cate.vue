<template>
  <ThemePage>
    <view class="cate-page" :class="['template-' + template, 'level-' + style.level]" :data-layout="`${style.level}/${style.index}`">
      <view class="search-bar"><button size="mini" @tap="search">搜索商品</button><button v-if="template === 'filter-products'" size="mini" @tap="openDrawer('filter')">筛选分类</button><button v-if="template === 'filter-products'" size="mini" @tap="goCart">购物车 {{ cart.count }}</button></view>
      <view v-if="styleError || !style.configured" class="notice" role="status">{{ styleError || '分类布局尚未有效配置，使用默认布局' }}</view>
      <view v-if="style.issues.length" class="notice">分类布局资料需管理员确认。</view>
      <view v-if="visible && tabbarError" class="tabbar-error" role="alert"><text>{{ tabbarError }}</text><button size="mini" @tap="retryNativeTabbar">重新调整底部导航</button></view>
      <view v-if="loading" class="empty" role="status">正在读取分类…</view>
      <view v-else-if="error" class="empty" role="alert">{{ error }}<button size="mini" @tap="load">重新读取分类</button></view>
      <view v-else-if="!tree.length" class="empty">暂无分类</view>
      <template v-else>
        <view v-if="template === 'top-products'" class="top-primary"><scroll-view scroll-x class="horizontal-nav"><button v-for="item in tree" :key="item.id" :class="{active: primary?.id === item.id}" @tap="choosePrimary(item.id)"><image v-if="item.pic" :src="item.pic" mode="aspectFill" /><text>{{ item.cate_name }}</text></button></scroll-view><button size="mini" @tap="openMore('primary')">更多</button></view>
        <view class="category-body" :class="{ 'with-cart-bar': miniCart }">
          <scroll-view v-if="template === 'tree' || template === 'side-products'" scroll-y class="side-nav"><button v-for="item in tree" :key="item.id" :class="{active: primary?.id === item.id}" @tap="choosePrimary(item.id)"><image v-if="item.pic" :src="item.pic" mode="aspectFill" /><text>{{ item.cate_name }}</text></button></scroll-view>
          <scroll-view v-if="template === 'top-products'" scroll-y class="side-nav secondary-nav"><button :class="{active: !scope.sid}" @tap="selectSecondary(0)">全部</button><button v-for="item in primary?.children || []" :key="item.id" :class="{active: scope.sid === item.id}" @tap="selectSecondary(item.id)">{{ item.cate_name }}</button></scroll-view>
          <view class="right-panel">
            <template v-if="template === 'tree'">
              <view v-if="style.level === 3" class="secondary-bar"><scroll-view scroll-x class="horizontal-nav"><button v-for="item in primary?.children || []" :key="item.id" :class="{active: treeSecondary?.id === item.id}" @tap="selectSecondary(item.id)">{{ item.cate_name }}</button></scroll-view><button size="mini" @tap="openMore('secondary')">更多</button></view>
              <scroll-view scroll-y class="tree-scroll" :scroll-into-view="scrollTarget" @scroll="treeScroll">
                <template v-if="style.level === 2"><view v-for="item in tree" :id="`cate-section-${item.id}`" :key="item.id" class="tree-section"><view class="section-title" @tap="navigateScope({cid:item.id})">{{ item.cate_name }} · 查看全部 ›</view><view class="category-grid"><view v-for="child in item.children" :key="child.id" class="category-tile" @tap="navigateScope({cid:item.id,sid:child.id})"><image v-if="child.pic" :src="child.pic" mode="aspectFill" /><text>{{ child.cate_name }}</text></view></view><view v-if="!item.children.length" class="notice">暂无子分类，可查看全部商品</view></view></template>
                <template v-else><view v-if="treeSecondary" class="tree-section"><view class="section-title" @tap="navigateScope({cid:primary?.id,sid:treeSecondary.id})">{{ treeSecondary.cate_name }} · 查看全部 ›</view><view class="category-grid"><view v-for="child in treeSecondary.children" :key="child.id" class="category-tile" @tap="navigateScope({cid:primary?.id,sid:treeSecondary.id,tid:child.id})"><image v-if="child.pic" :src="child.pic" mode="aspectFill" /><text>{{ child.cate_name }}</text></view></view><view v-if="!treeSecondary.children.length" class="notice">暂无三级分类，可查看全部商品</view></view><view v-else class="empty">该分类暂无子分类<button size="mini" @tap="navigateScope({cid:primary?.id})">查看商品</button></view></template>
              </scroll-view>
            </template>
            <template v-else>
              <view v-if="template === 'side-products'" class="secondary-bar"><scroll-view scroll-x class="horizontal-nav"><button :class="{active: !scope.sid}" @tap="selectSecondary(0)">全部</button><button v-for="item in primary?.children || []" :key="item.id" :class="{active: scope.sid === item.id}" @tap="selectSecondary(item.id)">{{ item.cate_name }}</button></scroll-view><button v-if="primary?.children.length" size="mini" @tap="openMore('secondary')">更多</button></view>
              <view v-if="style.level === 3 && template === 'top-products' && secondary" class="secondary-bar"><scroll-view scroll-x class="horizontal-nav"><button :class="{active: !scope.tid}" @tap="selectThird(0)">全部</button><button v-for="item in thirds" :key="item.id" :class="{active: scope.tid === item.id}" @tap="selectThird(item.id)">{{ item.cate_name }}</button></scroll-view><button v-if="thirds.length" size="mini" @tap="openMore('third')">更多</button></view>
              <view class="sort-bar"><button :class="{active:sort==='default'}" @tap="setSort('default')">综合</button><button :class="{active:sort==='sales'}" @tap="setSort('sales')">销量</button><button :class="{active:sort.startsWith('price')}" @tap="setSort(sort==='price_asc'?'price_desc':'price_asc')">价格 {{ sort==='price_desc'?'↓':'↑' }}</button></view>
              <scroll-view scroll-y class="products-scroll" @scrolltolower="readProducts()" @scroll="emitScroll">
                <view class="product-list" :class="{grid:template==='filter-products'}"><CategoryProductCard v-for="item in products" :key="item.id" :product="item" :layout="template==='filter-products'?'grid':bigCards?'big':'row'" :quantity="purchase.quantityInCart(item.id)" :disabled="purchase.locked.value || cart.updating || productLoading" @detail="purchase.goDetail(item)" @add="purchase.open(item,'cart',item.spec_type===0)" @buy="purchase.goDetail(item)" @step="diff=>purchase.changeCard(item,diff)" @quantity="value=>purchase.changeCard(item,1,value)" /></view>
                <view v-if="productLoading" class="empty" role="status">正在读取商品…</view><view v-else-if="productError" class="empty" role="alert">{{ productError }}<button size="mini" @tap="readProducts(products.length===0)">重试读取商品</button></view><view v-else-if="!products.length" class="empty">该分类暂无商品</view>
                <button v-if="hasMore && !productLoading && !productError" class="load-more" @tap="readProducts()">加载更多</button><view v-else-if="products.length && !productLoading && !productError" class="notice centered">没有更多商品了</view>
              </scroll-view>
            </template>
          </view>
        </view>
      </template>
      <view v-if="miniCart && !loading && tree.length" class="mini-cart"><button size="mini" @tap="showCart">购物车 {{ cart.count }}</button><view class="cart-total"><text>¥{{ cartSubtotal }}</text><text class="estimate">商品预估金额</text></view><button :disabled="purchase.locked.value || cart.updating || !auth.isLoggedIn" @tap="purchase.checkoutCart">去结算</button></view>
      <view v-if="purchase.error.value" class="purchase-error" role="alert">{{ purchase.error.value }}<button v-if="purchase.prepared.value" size="mini" :disabled="purchase.navigating.value" @tap="purchase.continueCheckout">继续结算</button><template v-else-if="purchase.needsRefresh.value"><button size="mini" @tap="purchase.reread">重新读取购物车</button><button size="mini" @tap="goCart">到购物车核对</button></template></view>
      <view v-if="drawer" class="drawer-mask" @tap="closeDrawer"><view class="category-drawer" :class="{filter:drawer==='filter'}" @tap.stop role="dialog" aria-label="选择分类"><view class="drawer-heading"><text>{{ drawer==='filter'?'筛选分类':'更多分类' }}</text><button size="mini" @tap="closeDrawer">关闭</button></view>
        <template v-if="drawer==='categories'"><view class="drawer-options"><button v-for="item in drawerChoices" :key="item.id" @tap="chooseMore(item.id)">{{ item.cate_name }}</button></view></template>
        <template v-else>
          <scroll-view v-if="style.level===3" scroll-x class="horizontal-nav"><button v-for="item in tree" :key="item.id" :class="{active:draft.cid===item.id}" @tap="selectPrimary(item.id,true)">{{ item.cate_name }}</button></scroll-view>
          <scroll-view scroll-y class="filter-scroll"><view v-for="group in filterGroups" :key="group.id" class="filter-group"><view class="filter-title"><text>{{ group.cate_name }}</text><button v-if="group.children.length>3" size="mini" @tap="toggleExpanded(group.id)">{{ expanded.includes(group.id)?'收起':'展开' }}</button></view><view class="drawer-options"><button :class="{active:style.level===2?draft.cid===group.id&&!draft.sid:draft.sid===group.id&&!draft.tid}" @tap="selectFilterAll(group.id)">全部</button><button v-for="item in expanded.includes(group.id)?group.children:group.children.slice(0,3)" :key="item.id" :class="{active:style.level===2?draft.sid===item.id:draft.tid===item.id}" @tap="selectFilterItem(group.id,item.id)">{{ item.cate_name }}</button></view></view></scroll-view>
          <view class="filter-footer"><button @tap="resetFilter">重置</button><button class="primary-button" @tap="applyFilter">确定</button></view>
        </template>
      </view></view>
      <view v-if="purchase.opened.value" class="sku-mask" @tap="purchase.close"><view class="sku-modal" @tap.stop><view v-if="purchase.loading.value" class="empty">正在读取规格…</view><CategorySkuSelection v-else-if="purchase.detail.value" :detail="purchase.detail.value" :selected="purchase.selected.value" :quantity="purchase.quantity.value" :maximum="purchase.maximum.value" :disabled="purchase.locked.value" :mode="purchase.mode.value" @choose="purchase.choose" @quantity="purchase.setQuantity" @step="purchase.step" @confirm="purchase.purchase" @close="purchase.close" /><view v-else class="empty">{{ purchase.error.value || '规格尚未读取' }}<button size="mini" @tap="purchase.close">关闭</button></view></view></view>
      <CategoryCartSheet v-if="purchase.cartOpen.value" :disabled="purchase.locked.value || cart.updating" @close="purchase.cartOpen.value=false" @clear="confirmClear" @quantity="purchase.changeCart" @remove="removeCart" @reload="reloadCart" @checkout="purchase.checkoutCart" />
    </view>
    <DiySuspendedNavigation />
  </ThemePage>
</template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import DiySuspendedNavigation from '@/components/diy/DiySuspendedNavigation.vue';
import CategorySkuSelection from '@/components/category/CategorySkuSelection.vue';
import CategoryCartSheet from '@/components/category/CategoryCartSheet.vue';
import CategoryProductCard from '@/components/category/CategoryProductCard.vue';
import { computed, getCurrentInstance, nextTick, ref, watch } from 'vue';
import { useCategoryCatalog } from '@/composables/useCategoryCatalog';
import { useCategoryPurchase } from '@/composables/useCategoryPurchase';
import { cartTotal } from '../../../../common/cartPrice';
const catalog = useCategoryCatalog();
const { auth, cart, visible, style, tree, products, loading, error, styleError, productError, productLoading, scope, draft, hasMore, sort, drawer, expanded, template, bigCards, primary, secondary, thirds, draftPrimary,
  load, readProducts, selectPrimary, selectSecondary, selectThird, openDrawer, closeDrawer, applyFilter, resetFilter, toggleExpanded, setSort, navigateScope, search, goCart, emitScroll } = catalog;
const purchase = useCategoryPurchase(visible), instance = getCurrentInstance(), scrollTarget = ref(''), moreLevel = ref<'primary'|'secondary'|'third'>('primary');
const miniCart = computed(() => template.value === 'top-products' || template.value === 'side-products');
// The page owns the native tabbar for all its modal surfaces. Keeping this in
// one place avoids one modal restoring the bar while another is still open.
const modalOpen = computed(() => drawer.value !== null || purchase.opened.value || purchase.cartOpen.value);
const tabbarError = ref(''), tabbarPending = ref(false);
let tabbarApplied = false, tabbarDesired = false, tabbarGeneration = 0;
function syncNativeTabbar(force = false) {
  const hide = visible.value && modalOpen.value, pending = tabbarPending.value;
  const generation = ++tabbarGeneration, owner = { visible: visible.value, version: auth.sessionVersion, token: auth.token, uid: auth.uid };
  tabbarDesired = hide; tabbarPending.value = false; tabbarError.value = '';
  if (!force && hide === tabbarApplied && !pending) return;
  const current = () => owner.visible && visible.value && generation === tabbarGeneration && hide === tabbarDesired
    && owner.version === auth.sessionVersion && owner.token === auth.token && owner.uid === auth.uid;
  const fail = () => { if (current()) { tabbarPending.value = false; tabbarError.value = hide ? '底部导航暂未收起，请重试后再操作弹层。' : '底部导航暂未恢复，请重试。'; } };
  tabbarPending.value = owner.visible;
  const api = hide ? uni.hideTabBar : uni.showTabBar;
  if (typeof api !== 'function') { fail(); return; }
  try { api({ animation: false, success: () => { if (current()) { tabbarApplied = hide; tabbarPending.value = false; tabbarError.value = ''; } }, fail }); }
  catch { fail(); }
}
function retryNativeTabbar() { if (visible.value) syncNativeTabbar(true); }
watch([visible, modalOpen, () => auth.sessionVersion], () => syncNativeTabbar(), { flush: 'sync' });
const treeSecondary = computed(() => secondary.value ?? primary.value?.children[0]);
const cartSubtotal = computed(() => cart.ready ? cartTotal(cart.items.map(item => ({ ...item, checked: item.isValid }))) : '—');
const drawerChoices = computed(() => moreLevel.value==='third' ? thirds.value : moreLevel.value==='secondary' ? primary.value?.children ?? [] : tree.value);
const filterGroups = computed(() => style.value.level===2 ? tree.value : draftPrimary.value?.children ?? []);
let sectionTops: Array<{id:number;top:number}> = [], scrollLock = false;
function scrollToPrimary(id:number){scrollLock=true;scrollTarget.value='';const measuredTree=tree.value;void nextTick(()=>{if(visible.value&&!loading.value&&tree.value===measuredTree)scrollTarget.value=`cate-section-${id}`;});}
function choosePrimary(id: number) { selectPrimary(id); if (template.value==='tree' && style.value.level===2) scrollToPrimary(id); }
function openMore(level:'primary'|'secondary'|'third'){moreLevel.value=level;openDrawer('categories');}
function chooseMore(id: number) { if (moreLevel.value==='secondary') selectSecondary(id); else if (moreLevel.value==='third') selectThird(id); else choosePrimary(id); closeDrawer(); }
function selectFilterAll(id: number) { if (style.value.level===2) selectPrimary(id,true); else selectSecondary(id,true); }
function selectFilterItem(parent: number, id: number) { if (style.value.level===2) { selectPrimary(parent,true); selectSecondary(id,true); } else selectThird(id,true,parent); }
function measureSections() {
  if (template.value!=='tree' || style.value.level!==2 || loading.value || !visible.value || !uni.createSelectorQuery) return;
  const measuredTree=tree.value, measuredStyle=style.value;
  const query=uni.createSelectorQuery(); if (instance?.proxy) query.in(instance.proxy);
  query.selectAll('.tree-section').boundingClientRect(); query.select('.tree-scroll').boundingClientRect();query.select('.tree-scroll').scrollOffset(()=>{});
  query.exec((result: unknown[])=>{if(!visible.value||loading.value||tree.value!==measuredTree||style.value!==measuredStyle)return;const rows=result[0] as Array<{top:number}>|undefined, scroll=result[1] as {top:number}|undefined, offset=result[2] as {scrollTop:number}|undefined; if(rows&&scroll) sectionTops=rows.map((row,index)=>({id:measuredTree[index]?.id??0,top:row.top-scroll.top+(offset?.scrollTop??0)}));});
}
function treeScroll(event: unknown) { if(!visible.value)return;emitScroll(); if(template.value!=='tree'||style.value.level!==2)return; if(scrollLock){scrollLock=false;return;} const top=(event as {detail?:{scrollTop?:number}}).detail?.scrollTop; if(typeof top!=='number')return; const selected=[...sectionTops].reverse().find(item=>item.top<=top+2); if(selected?.id)scope.value={cid:selected.id}; }
watch([tree,style,loading],()=>{sectionTops=[];void nextTick(measureSections);});
watch(loading,value=>{if(!value&&visible.value&&template.value==='tree'&&style.value.level===2&&primary.value)scrollToPrimary(primary.value.id);});
async function reloadCart(){if(visible.value&&auth.isLoggedIn)await cart.fetchList().then(()=>cart.fetchCount()).catch(()=>{});}
function showCart(){if(!auth.isLoggedIn){uni.navigateTo({url:'/pages/auth/login'});return;}purchase.cartOpen.value=true;void reloadCart();}
async function removeCart(id:number){if(visible.value&&!purchase.locked.value&&!cart.updating){const uid=auth.uid,epoch=auth.sessionVersion;await cart.removeItem(id);if(visible.value&&uid===auth.uid&&epoch===auth.sessionVersion)void cart.fetchCount();}}
function confirmClear(){if(!visible.value||purchase.locked.value||cart.updating)return;const owner={version:auth.sessionVersion,token:auth.token,uid:auth.uid};uni.showModal({title:'清空购物车',content:'将删除当前购物车中的全部商品，是否继续？',success:result=>{if(result.confirm&&visible.value&&owner.version===auth.sessionVersion&&owner.token===auth.token&&owner.uid===auth.uid)void purchase.clearCart();}});}
</script>
<style scoped>
.tabbar-error{position:fixed;left:12rpx;right:12rpx;top:calc(var(--window-top,0px) + 12rpx);z-index:150;display:flex;align-items:center;gap:16rpx;padding:16rpx;background:#fff4df;border:1px solid #d99b22;border-radius:10rpx;color:#775311;font-size:24rpx;line-height:1.5;}.tabbar-error text{flex:1;}.tabbar-error button{margin:0;flex-shrink:0;font-size:24rpx;line-height:1.7;}
.cate-page{display:flex;flex-direction:column;height:calc(100vh - var(--window-top,0px) - var(--window-bottom,50px));min-height:320px;position:relative;background:#f5f5f5;color:#333;overflow:hidden;}.search-bar{display:flex;gap:12rpx;padding:14rpx 18rpx;background:#fff;flex-shrink:0;}.search-bar button{margin:0;font-size:25rpx;line-height:2;padding:0 20rpx;}.search-bar button:first-child{flex:1;text-align:left;color:#777;background:#f5f5f5;}.notice{font-size:22rpx;color:#777;padding:10rpx 18rpx;line-height:1.5;flex-shrink:0;}.category-body{display:flex;flex:1;min-height:0;}.category-body.with-cart-bar{padding-bottom:100rpx;}.side-nav{width:170rpx;flex-shrink:0;background:#f7f7f7;height:100%;}.side-nav button{display:flex;flex-direction:column;align-items:center;gap:8rpx;padding:22rpx 12rpx;margin:0;font-size:24rpx;line-height:1.6;border-radius:0;background:transparent;white-space:normal;}.side-nav button::after,.horizontal-nav button::after,.sort-bar button::after{border:0;}.side-nav image,.horizontal-nav image{width:52rpx;height:52rpx;border-radius:8rpx;}.side-nav .active{border-left:5rpx solid var(--view-theme);background:#fff;color:var(--view-theme);font-weight:600;}.right-panel{min-width:0;flex:1;display:flex;flex-direction:column;overflow:hidden;}.horizontal-nav{white-space:nowrap;flex:1;min-width:0;background:#fff;}.horizontal-nav button{display:inline-flex;align-items:center;gap:8rpx;padding:18rpx;margin:0;font-size:24rpx;line-height:1.5;background:#fff;border-radius:0;}.horizontal-nav .active{color:var(--view-theme);border-bottom:3rpx solid var(--view-theme);}.top-primary,.secondary-bar{display:flex;min-width:0;align-items:center;background:#fff;flex-shrink:0;}.top-primary>.horizontal-nav button{flex-direction:column;}.top-primary>button,.secondary-bar>button{margin:0;font-size:22rpx;padding:0 14rpx;}.tree-scroll,.products-scroll{flex:1;min-height:0;height:100%;}.tree-scroll{background:#fff;}.tree-section{padding:24rpx 16rpx;}.section-title{font-size:27rpx;font-weight:600;margin-bottom:16rpx;}.category-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20rpx 10rpx;}.category-tile{display:flex;flex-direction:column;align-items:center;gap:12rpx;font-size:23rpx;text-align:center;overflow-wrap:anywhere;}.category-tile image{width:100rpx;height:100rpx;border-radius:12rpx;}.sort-bar{display:flex;flex-shrink:0;background:#fff;border-top:1px solid #eee;}.sort-bar button{flex:1;margin:0;padding:15rpx 0;font-size:23rpx;line-height:1.5;border-radius:0;background:#fff;}.sort-bar .active{color:var(--view-theme);}.product-list{display:flex;flex-direction:column;gap:16rpx;padding:16rpx;}.product-list.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16rpx;}.empty{padding:45rpx 20rpx;color:#777;font-size:26rpx;text-align:center;line-height:1.8;}.empty button{margin-top:20rpx;}.load-more{font-size:24rpx;margin:20rpx;}.centered{text-align:center;}.mini-cart{position:absolute;left:0;right:0;bottom:0;display:flex;gap:14rpx;align-items:center;background:#fff;padding:14rpx 18rpx;min-height:80rpx;box-sizing:border-box;border-top:1px solid #eee;z-index:10;}.mini-cart button{font-size:25rpx;margin:0;line-height:2.1;padding:0 18rpx;}.mini-cart>button:last-child,.primary-button{background:var(--view-theme);color:var(--view-bntColor);}.cart-total{flex:1;min-width:0;display:flex;flex-direction:column;font-size:28rpx;color:var(--view-priceColor);}.estimate{font-size:20rpx;color:#777;}.purchase-error{position:absolute;bottom:100rpx;left:12rpx;right:12rpx;background:#fff4df;border:1px solid #d99b22;color:#775311;z-index:125;font-size:24rpx;padding:16rpx;overflow-wrap:anywhere;}.purchase-error button{margin-top:8rpx;}.drawer-mask,.sku-mask{position:fixed;inset:0;z-index:110;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;}.category-drawer{background:#fff;width:100%;padding:24rpx;box-sizing:border-box;max-height:80vh;overflow-y:auto;}.category-drawer.filter{margin-left:auto;width:min(90vw,600px);height:100%;max-height:100%;display:flex;flex-direction:column;padding-bottom:calc(24rpx + env(safe-area-inset-bottom));}.drawer-heading{display:flex;align-items:center;justify-content:space-between;font-size:30rpx;}.drawer-heading button{margin:0;}.drawer-options{display:flex;flex-wrap:wrap;gap:14rpx;padding:22rpx 0;}.drawer-options button{margin:0;font-size:25rpx;line-height:1.6;padding:14rpx;white-space:normal;}.drawer-options .active{background:var(--view-minorColorT);color:var(--view-theme);border:1px solid var(--view-theme);}.filter-scroll{flex:1;min-height:0;}.filter-title{display:flex;align-items:center;justify-content:space-between;font-size:27rpx;margin-top:24rpx;}.filter-title button{margin:0;font-size:22rpx;}.filter-footer{display:flex;gap:20rpx;}.filter-footer button{flex:1;font-size:28rpx;}.sku-mask{z-index:115;}.sku-modal{width:100%;max-height:85vh;overflow-y:auto;background:#fff;border-radius:24rpx 24rpx 0 0;}@media(min-width:768px){.cate-page{max-width:1100px;margin:auto;}.product-list.grid{grid-template-columns:repeat(3,minmax(0,1fr));}.category-grid{gap:24px;}.category-tile image{width:100px;height:100px;}.sku-modal{max-width:600px;margin:auto;}.category-drawer:not(.filter){max-width:800px;margin:auto;}.product-list{gap:20px;}}
</style>
