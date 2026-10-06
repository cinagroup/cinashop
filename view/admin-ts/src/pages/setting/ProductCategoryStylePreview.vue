<template>
  <div class="phone" :class="[`template-${preset.template}`, compact ? 'compact-products' : 'large-products']" :data-layout="`${preset.level}/${preset.index}`" aria-hidden="true">
    <div class="status-bar"><span>9:41</span><span>▮▮ ▰</span></div>
    <div class="search"><span v-if="preset.template === 4" class="filter-icon">☰　▣</span><span>⌕　搜索商品</span></div>
    <div v-if="preset.template === 2" class="top-categories"><span v-for="(label, index) in roots.slice(0, 4)" :key="label" :class="{active:index === 0}"><i :class="`picture-${index}`" />{{ label }}</span><b>全部⌄</b></div>
    <div class="body">
      <aside v-if="preset.template !== 4" class="side-categories"><span v-for="(label,index) in preset.template === 2 ? seconds : roots" :key="label" :class="{active:index === 0}">{{ label }}</span></aside>
      <main>
        <div v-if="preset.template === 3 || preset.level === 3 && preset.template !== 4" class="chips"><span class="active">{{ preset.level === 3 && preset.template === 2 ? '休闲零食' : '精选好物' }}</span><span>人气推荐</span><span>全部⌄</span></div>
        <template v-if="preset.template === 1">
          <section v-for="group in preset.level === 2 ? roots.slice(0, 2) : seconds.slice(0, 2)" :key="group" class="directory">
            <strong>{{ group }} <span>›</span></strong>
            <div class="category-grid"><span v-for="(name,index) in ['休闲零食','坚果炒货','果蔬生鲜','茶饮咖啡','家居日用','品质生活']" :key="name"><i :class="`picture-${index % 4}`" />{{ name }}</span></div>
          </section>
        </template>
        <template v-else>
          <div v-if="preset.template === 4" class="hero-category"><span>{{ preset.level === 3 ? '三级分类筛选' : '二级分类筛选' }}</span><span>综合　销量　价格⌄</span></div>
          <section v-for="(product,index) in products.slice(0, preset.template === 4 ? 1 : compact ? 4 : 2)" :key="product.name" class="product">
            <div class="product-image" :class="`picture-${index % 4}`"><span>{{ product.icon }}</span></div>
            <div class="product-copy"><strong>{{ product.name }}</strong><small>精选品质 · 人气好物</small><div class="product-line"><b>¥{{ product.price }}</b><span v-if="compact" class="quantity">−　1　+</span><span v-else class="buy">{{ preset.template === 4 ? '▣　购买' : '加入购物车' }}</span></div></div>
          </section>
          <div v-if="preset.template === 4" class="pagination">下拉加载更多商品</div>
        </template>
      </main>
    </div>
    <div v-if="preset.template === 2 || preset.template === 3" class="shopping-bar"><span>▣　购物车 <b>2</b></span><strong>¥48.00</strong><span class="checkout">去结算</span></div>
    <div class="page-footer"><span>⌂<small>首页</small></span><span class="active">▦<small>分类</small></span><span>▣<small>购物车</small></span><span>♙<small>我的</small></span></div>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { PRODUCT_CATEGORY_STYLES, type ProductCategoryStyleValue } from '../../../../common/productCategoryStyle';
const props = defineProps<{ value: ProductCategoryStyleValue }>();
const preset = computed(() => PRODUCT_CATEGORY_STYLES.find(row => row.level === props.value.level && row.index === props.value.index) ?? PRODUCT_CATEGORY_STYLES[1]);
const compact = computed(() => props.value.level === 2 && [2,4].includes(props.value.index) || props.value.level === 3 && props.value.index === 2);
const roots = ['食品生鲜','家居生活','美妆护理','数码家电','服饰鞋包','母婴用品'];
const seconds = ['精选好物','休闲食品','水果鲜蔬','茶饮咖啡','粮油调味','更多分类'];
const products = [{ name:'精选坚果礼盒', price:'24.00', icon:'◒' }, { name:'当季鲜果组合', price:'32.00', icon:'●' }, { name:'品质咖啡豆', price:'18.00', icon:'◔' }, { name:'美味休闲零食', price:'12.00', icon:'◆' }];
</script>
<style scoped>
.phone{width:276px;height:470px;display:flex;flex-direction:column;overflow:hidden;border:1px solid #e8eaf0;border-radius:20px;background:#fff;box-shadow:0 5px 18px #1b2d4810;color:#333;font-size:9px;line-height:1.4;margin:auto;pointer-events:none}.status-bar{height:24px;display:flex;justify-content:space-between;align-items:center;padding:0 15px;font-size:10px;font-weight:600}.search{display:flex;gap:8px;align-items:center;margin:6px 10px 10px}.search>span:last-child{flex:1;border-radius:20px;background:#f5f5f5;padding:7px 10px;color:#888}.filter-icon{background:#f5f5f5;border-radius:20px;padding:7px}.top-categories{display:flex;gap:10px;padding:8px;border-bottom:1px solid #eee;align-items:center}.top-categories>span{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:44px}.top-categories i{width:28px;height:28px;border-radius:50%;display:block}.top-categories b{font-weight:400;font-size:8px}.active{color:#e44d4d!important}.body{flex:1;min-height:0;display:flex;overflow:hidden;background:#fafafa}.side-categories{flex:0 0 62px;background:#f4f4f4;display:flex;flex-direction:column}.side-categories>span{padding:15px 3px;text-align:center;color:#666}.side-categories>.active{background:#fff;position:relative;font-weight:600}.side-categories>.active:before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:3px;background:#e44d4d}.body main{flex:1;min-width:0;padding:7px;overflow:hidden}.chips{display:flex;gap:5px;margin-bottom:9px;white-space:nowrap}.chips span{background:#f0f0f0;border-radius:12px;font-size:8px;padding:5px}.chips .active{background:#fff0ed}.directory{background:#fff;padding:9px 5px;margin-bottom:8px;border-radius:8px}.directory strong{font-size:10px;display:flex;justify-content:space-between;margin-bottom:8px}.category-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 5px}.category-grid span{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:8px;white-space:nowrap}.category-grid i{width:38px;height:38px;border-radius:9px;display:block}.picture-0{background:linear-gradient(140deg,#f3dfc2,#d8a873)}.picture-1{background:linear-gradient(140deg,#e4f0d7,#9eb17b)}.picture-2{background:linear-gradient(140deg,#eaded7,#b28c74)}.picture-3{background:linear-gradient(140deg,#f2decd,#e8ad94)}.product{margin-bottom:9px;border-radius:8px;overflow:hidden;background:#fff}.product-image{height:129px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:70px;position:relative}.product-image:after{content:'';position:absolute;bottom:13px;width:48%;height:10px;border-radius:50%;background:#00000010}.product-copy{padding:7px}.product-copy strong{font-size:10px;display:block;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.product-copy small{color:#999;font-size:7px;display:block;margin-top:3px}.product-line{display:flex;justify-content:space-between;align-items:center;gap:4px;margin-top:7px}.product-line b{color:#e44d4d;font-size:13px}.buy,.checkout{background:#e44d4d;color:#fff;border-radius:14px;padding:5px 7px;font-size:8px}.compact-products .product{display:flex;align-items:stretch;min-height:76px}.compact-products .product-image{width:65px;flex:0 0 65px;height:76px;font-size:34px;border-radius:7px}.compact-products .product-copy{flex:1;min-width:0;padding:5px 7px}.compact-products .product-line{margin-top:8px}.compact-products .product-line b{font-size:12px}.quantity{font-size:9px;white-space:nowrap;color:#e44d4d}.shopping-bar{height:36px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;border-top:1px solid #eee;background:#fff;font-size:9px;box-shadow:0 -2px 7px #00000004}.shopping-bar>span b{border-radius:50%;background:#e44d4d;color:#fff;padding:1px 4px;font-size:7px}.shopping-bar>strong{color:#e44d4d}.page-footer{display:flex;justify-content:space-around;align-items:center;padding:6px 0 8px;border-top:1px solid #eee;background:#fff}.page-footer>span{display:flex;align-items:center;flex-direction:column;font-size:14px;color:#777}.page-footer small{font-size:8px}.hero-category{display:flex;justify-content:space-between;margin:1px 2px 8px;color:#777;font-size:8px}.template-4 .product-image{height:220px;font-size:104px}.template-4 .product-copy{padding:10px}.template-4 .product-copy strong{font-size:12px}.template-4 .product-line b{font-size:17px}.template-4 .buy{padding:6px 10px;font-size:10px}.pagination{text-align:center;font-size:10px;color:#777;margin:11px 0}.template-1 main{padding-top:12px}.template-1 .chips{margin-bottom:10px}
</style>
