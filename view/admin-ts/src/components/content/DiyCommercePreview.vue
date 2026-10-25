<template>
<section class="commerce-preview" aria-label="商城组件实际字段预览"><p class="preview-hint">375 设计宽度。只读展示公开内容；领取、购买和跳转按钮仅展示外观。直播对应小程序显示风格。</p>

  <div v-if="config.enabled" class="diy-commerce" :data-kind="config.kind" :data-component-key="config.identity" :data-style="config.style" :data-layout="config.layout" :style="config.wrapperStyle">
    <div class="commerce-panel" :style="config.panelStyle">
      <div v-if="config.kind === 'promotionList'" class="promotion-nav" :class="{sticky:config.stickyTabs}">
        <div data-scroll-x class="promotion-tabs">
          <button v-for="(tab,index) in config.tabs" :key="index" class="promotion-tab" :data-tab="index" :class="{active:index===selectedTab}" :style="index===selectedTab?config.promotionActiveStyle:undefined" @click="selectPromotion(index)">
            <img v-if="config.style===4 && tab.image" :src="tab.image" />
            <span>{{tab.label}}</span><span v-if="config.style===0 && tab.description" class="promotion-description" :style="index===selectedTab?config.promotionDecorationStyle:undefined">{{tab.description}}</span>
            <div v-if="[1,2].includes(config.style) && index===selectedTab" class="promotion-line" :style="config.promotionDecorationStyle" />
          </button>
        </div>
        <div v-if="config.tabs[selectedTab]?.configuredLimit > 100" class="commerce-notice">当前分组预览最多显示100项</div>
      </div>
      <div v-else-if="!['coupon','liveBroadcast'].includes(config.kind || '')" class="commerce-heading" :style="config.headerStyle">
        <div class="commerce-heading-main">
          <span v-if="config.titleMode==='text'" class="commerce-section-title" :style="config.titleStyle">{{config.title}}</span>
          <img v-else-if="config.titleImage" class="commerce-heading-image" :src="config.titleImage" />
          <div v-if="config.kind==='combination' && pink" class="commerce-pink" :style="config.tipStyle"><span :style="config.dividerStyle">|</span><img v-for="(avatar,index) in pink.avatars" :key="index" :src="avatar" /><span>{{pink.pink_count}}人拼团成功</span></div>
          <div v-else-if="config.kind==='seckill' && selectedStop" class="commerce-countdown"><span :style="config.tipStyle">距离结束</span><span class="commerce-countdown-number" :style="config.countdownStyle">{{countdown}}</span></div>
          <span v-else-if="config.tip" class="commerce-tip" :style="config.tipStyle">{{config.tip}}</span>
        </div>
        <button class="commerce-more" :style="config.moreStyle" disabled>{{config.more}} ›</button>
      </div>
      <div v-if="loading" class="commerce-status" role="status">正在加载商城内容…</div>
      <div v-else-if="error" class="commerce-error" role="alert">{{error}}</div>
      <template v-else-if="loaded">
        <div v-if="config.kind==='promotionList'" class="promotion-products commerce-grid">
          <div v-for="product in products" :key="product.id" class="commerce-card" :data-product-id="product.id" disabled>
            <img v-if="product.image" class="commerce-image" :style="config.imageStyle" :src="product.image" />
            <div class="commerce-copy"><span class="commerce-title" :style="config.nameStyle">{{product.store_name}}</span>
              <div class="promotion-labels"><div v-for="label in product.labels" :key="label.id" class="promotion-label" :style="{color:label.color,background:label.background,borderColor:label.border}"><img v-if="label.icon" :src="label.icon" />{{label.name}}</div></div>
              <span class="commerce-price" :style="config.priceStyle">¥{{product.price}}</span><span v-if="product.offer" class="promotion-vip">{{product.offer.label}} ¥{{product.offer.price}}</span>
              <div class="commerce-meta">已售{{product.sales}}{{product.unit_name}} · 评分{{product.star}}</div>
              <button v-if="config.showAction" class="promotion-action" :data-cart-style="config.cartStyle" :style="config.buttonStyle" :aria-label="config.cartMode?'选择规格加入购物车':'查看商品'" disabled>{{config.cartStyle===0?'购买':config.cartStyle===1?'＋':'购物车'}}</button>
            </div>
          </div>
          <div v-if="!products.length" class="commerce-empty">当前分组暂无商品</div>
        </div>
        <div v-else-if="config.kind==='coupon'" class="commerce-coupons" :data-coupon-layout="config.style">
          <div data-scroll-x class="coupon-scroll"><div class="coupon-items">
            <div v-for="coupon in coupons" :key="coupon.id" class="commerce-coupon" :data-coupon-id="coupon.id" :style="config.style===4?config.couponButtonStyle:config.couponStyle">
              <span v-if="[1,3].includes(config.style)" class="coupon-scope">{{['通用券','品类券','商品券','品牌券'][coupon.type]}}</span>
              <div class="coupon-copy"><span class="coupon-money" :style="config.couponMoneyStyle">{{coupon.coupon_type===2?`${Number(coupon.coupon_price)/10}折`:`¥${coupon.coupon_price}`}}</span><span class="coupon-condition">{{Number(coupon.use_min_price)>0?`满${coupon.use_min_price}可用`:'无门槛券'}}</span></div>
              <button v-if="config.style!==3" class="coupon-claim" :style="config.couponButtonStyle" disabled>{{couponLabel(coupon)}}</button>
            </div>
          </div></div>
          <div v-if="config.style===3 && coupons.length" class="coupon-station" :style="config.couponButtonStyle"><span>先领券 再购物</span><span>领券下单·享购物优惠</span><button class="coupon-centre" disabled>立即领取</button></div>
          <div v-if="!coupons.length" class="commerce-empty">暂无可展示的优惠券</div>



        </div>
        <div v-else-if="config.kind==='liveBroadcast'" class="commerce-live" :data-live-layout="config.style">
          <div v-if="config.style===2" data-scroll-x class="live-strip"><div class="live-strip-content"><div v-for="room in rooms" :key="room.id" class="live-card" :data-room-id="room.id" :style="config.liveCardStyle" disabled><img class="live-cover" :style="config.imageStyle" :src="room.cover_img" /><span class="live-status" :style="config.liveStatusStyles[room.live_status]">{{liveLabel(room.live_status)}}{{room.live_status===102?` ${room.show_time}`:''}}</span><span v-if="config.checks.includes(0)" class="live-title">{{room.name}}</span><div v-if="config.checks.includes(1)" class="live-anchor"><img v-if="room.anchor_img" :src="room.anchor_img" /><span>主播：{{room.anchor_name}}</span></div></div></div></div>
          <div v-else v-for="(room,index) in rooms" :key="room.id" class="live-card" :class="{'live-compact':config.style===3 && index>0}" :data-room-id="room.id" :style="config.liveCardStyle" disabled>
            <img v-if="config.style!==3 || index===0" class="live-cover" :style="config.imageStyle" :src="room.cover_img" />
            <div class="live-copy"><span class="live-status" :style="config.liveStatusStyles[room.live_status]">{{liveLabel(room.live_status)}}{{room.live_status===102?` ${room.show_time}`:''}}</span><span v-if="config.checks.includes(0)" class="live-title">{{room.name}}</span>
              <div v-if="config.style===1" class="live-goods"><div v-for="goods in room.goods" :key="goods.id" :data-live-goods-id="goods.id"><img :src="goods.cover_img" /><span>¥{{goods.price}}</span></div></div>
              <div v-else-if="config.checks.includes(1)" class="live-anchor"><img v-if="room.anchor_img" :src="room.anchor_img" /><span>主播：{{room.anchor_name}}</span></div>
            </div>
          </div>
          <div v-if="!rooms.length" class="commerce-empty">暂无直播间</div>
        </div>
        <template v-else>
          <div v-if="config.kind==='seckill' && slots.length" data-scroll-x class="commerce-slots"><button v-for="slot in slots" :key="slot.id" class="commerce-slot" :class="{active:slot.id===selectedSlot}" :data-slot-id="slot.id" @click="selectSeckill(slot.id)">{{slot.start_time}} {{slot.state}}</button></div>
          <div class="commerce-cards" :class="`commerce-layout-${config.layout}`" :data-points="config.kind==='pointsMall'">
            <div v-for="card in cards" :key="card.id" class="commerce-card" :data-card-id="card.id" disabled>
              <img v-if="card.image" class="commerce-image" :src="card.image" :style="config.imageStyle" />
              <div class="commerce-copy">
                <span v-if="config.kind==='combination' && config.layout>=2" class="commerce-group-badge" :style="config.labelStyle">{{card.people}}人团</span>
                <span v-if="config.kind==='pointsMall'?config.layout!==0:config.checks.includes(0)" class="commerce-title" :style="config.nameStyle">{{card.title}}</span>
                <div v-if="config.kind==='seckill' && config.layout===0" class="commerce-progress"><div :style="{...config.progressStyle,width:`${card.percent}%`}" /><span :style="config.priceStyle">{{card.percent}}%</span></div>
                <div v-if="config.kind==='combination' && config.checks.includes(1) && config.layout===0" class="commerce-combination-count" :style="config.labelStyle">{{card.people}}人团 · 已拼{{card.count}}份</div>
                <span v-if="config.kind==='bargain' && (config.layout===0?config.checks.includes(1):config.layout===3 && config.checks.includes(0))" class="commerce-bargain-count" :style="config.layout===3?config.bargainSuccessStyle:config.joinStyle">{{card.people}}人{{config.layout===3?'已砍成功':'参与'}}</span>
                <div v-if="config.kind==='pointsMall'" class="commerce-points-price" :style="config.pointsPriceStyle"><span :style="config.pointsNumberStyle">{{card.integral}}</span><span>积分 + </span><span :style="config.pointsNumberStyle">{{card.price}}</span><span>元</span></div>
                <span v-else-if="config.checks.includes(2)" class="commerce-price" :style="config.priceStyle">¥{{card.price}}</span>
                <span v-if="config.kind!=='pointsMall' && config.checks.includes(3) && !(config.layout===3 && ['combination','bargain'].includes(config.kind || ''))" class="commerce-old-price" :style="config.oldPriceStyle">¥{{card.oldPrice}}</span>
                <span v-if="config.kind==='presale'" class="commerce-presale-status">{{['预售','即将开始','预售中','已结束'][card.status]}}</span>
                <button v-if="config.showAction && (config.layout<2 || config.kind==='seckill' && config.layout===3)" class="commerce-card-action" :style="config.buttonStyle" disabled>{{actionLabel}}</button>
              </div>
            </div>
          </div>
          <div v-if="!cards.length" class="commerce-empty">{{config.kind==='seckill' && !selectedSlot?'暂无可展示的秒杀时段':'当前暂无活动商品'}}</div>
        </template>
        <div v-if="config.limitNotice" class="commerce-notice">{{config.limitNotice}}</div>
      </template>
    </div>
  </div>
<p v-if="!loaded&&!loading&&!error" class="preview-hint">读取公开商城预览后显示真实内容。</p></section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { normalizeDiyCommerce } from '@/utils/diyCommerceProjection';
import { themePreset } from '../../../../common/theme';
import { listPixelStyle } from '@/utils/diyListEditor';
import type { CommerceRecord } from '@/utils/diyCommerceEditor';
import type { CommercePreview } from '@/api/diyCommerceAuthor';
const props=defineProps<{block:CommerceRecord;data:CommercePreview|null;loading:boolean;loaded:boolean;error:string;selectedTab:number;selectedSlot:number}>(),emit=defineEmits<{tab:[index:number];slot:[id:number]}>();
function styles(raw:Record<string,string>){return listPixelStyle(raw) as Record<string,string>;}
const config=computed(()=>{const cfg=normalizeDiyCommerce(props.block,themePreset(3));for(const key of Object.keys(cfg)){const value=cfg[key as keyof typeof cfg];if(key.endsWith('Style')&&value&&typeof value==='object'&&!Array.isArray(value))(cfg as unknown as Record<string,unknown>)[key]=styles(value as Record<string,string>);}cfg.liveStatusStyles=Object.fromEntries(Object.entries(cfg.liveStatusStyles).map(([key,value])=>[key,styles(value)]));return cfg;});
const cards=computed(()=>props.data?.cards??[]),coupons=computed(()=>props.data?.coupons??[]),rooms=computed(()=>props.data?.rooms??[]),slots=computed(()=>props.data?.slots??[]),pink=computed(()=>props.data?.pink??null);
const products=computed(()=>(props.data?.products??[]).map(row=>({...row,store_name:row.title,unit_name:row.unit})));
const selectedStop=computed(()=>slots.value.find(row=>row.id===props.selectedSlot)?.stop??0),countdown=computed(()=>{const seconds=Math.max(0,selectedStop.value-Math.floor(Date.now()/1000));return[String(Math.floor(seconds/3600)).padStart(2,'0'),String(Math.floor(seconds/60)%60).padStart(2,'0'),String(seconds%60).padStart(2,'0')].join(':');});
const actionLabel=computed(()=>({seckill:config.value.layout===3?'抢':'去抢购',combination:'去拼团',bargain:'去砍价',presale:'立即预定'} as Record<string,string>)[config.value.kind??'']??'查看详情');
const liveLabel=(status:number)=>status===101?'直播中':status===102?'预告':'回放';
const couponLabel=(coupon:{is_use:boolean|2})=>coupon.is_use===true?'已领取':coupon.is_use===2?'已领完':'立即领取';
const selectPromotion=(index:number)=>emit('tab',index),selectSeckill=(id:number)=>emit('slot',id);
</script>
<style scoped>
.commerce-preview{width:375px;max-width:100%;overflow:auto}.preview-hint{font-size:12px;color:#777;line-height:1.6}.commerce-preview button{font-family:inherit;border:0;cursor:default;opacity:1}.commerce-preview img{object-fit:cover}
.diy-commerce{width:100%;min-width:0;box-sizing:border-box}.commerce-panel{overflow:hidden;min-width:0}.commerce-heading{display:flex;align-items:center;justify-content:space-between;padding:12px;gap:5px;background-size:100% 100%;background-repeat:no-repeat;min-height:45px;box-sizing:border-box}.commerce-heading-main{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;flex:1}.commerce-section-title{overflow-wrap:anywhere}.commerce-heading-image{width:88px;height:16px;flex-shrink:0}.commerce-tip{font-size:12px}.commerce-more{margin:0;padding:0;background:transparent;white-space:nowrap;flex-shrink:0;line-height:1.5}.commerce-more::after,.promotion-tab::after{border:0}.commerce-pink,.commerce-countdown{display:flex;align-items:center;font-size:11px;gap:4px}.commerce-pink img{width:18px;height:18px;border-radius:50%;margin-right:-8px}.commerce-pink span:last-child{margin-left:6px}.commerce-countdown-number{padding:2px 4px;border-radius:2px;font-variant-numeric:tabular-nums}.commerce-status,.commerce-error,.commerce-empty,.commerce-notice,.coupon-notice{padding:10px;font-size:12px;line-height:1.6;white-space:normal;overflow-wrap:anywhere}.commerce-error,.commerce-purchase-error{color:#a33}.commerce-refresh{font-size:11.5px;line-height:2.2;margin:6px 10px}.commerce-cards,.commerce-grid{padding:12px 10px;box-sizing:border-box}.commerce-cards{display:grid;gap:11px;grid-template-columns:repeat(2,minmax(0,1fr))}.commerce-card{min-width:0;overflow:hidden;background:#fff;border-radius:6px;white-space:normal}.commerce-image{display:block;width:100%;height:150px;background:#f5f5f5;flex-shrink:0}.commerce-copy{padding:6px;min-width:0;position:relative}.commerce-title{display:-webkit-box;overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:13.5px;line-height:19px;overflow-wrap:anywhere}.commerce-price{display:inline-block;font-size:16px;font-weight:600;margin-top:5px}.commerce-old-price{display:block;font-size:11.5px;text-decoration:line-through;color:#999;margin-top:4px}.commerce-meta,.promotion-vip{font-size:11px;color:#777;margin-top:5px;overflow-wrap:anywhere}.promotion-vip{display:block;color:#8c6622}.commerce-layout-0{display:flex;flex-direction:column}.commerce-layout-0 .commerce-card{display:flex}.commerce-layout-0 .commerce-image{width:120px;height:120px}.commerce-layout-0 .commerce-copy{flex:1}.commerce-layout-2{grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.commerce-layout-2 .commerce-image{height:102px}.commerce-layout-2 .commerce-price{font-size:12.5px}.commerce-layout-3{display:flex;overflow-x:auto;flex-wrap:nowrap}.commerce-layout-3>.commerce-card{width:112px;flex-shrink:0}.commerce-layout-3 .commerce-image{height:112px}.commerce-card-action,.promotion-action{font-size:11.5px;line-height:2;margin:6px 0 0;padding:0 8px;width:max-content;max-width:100%;border-radius:14px}.commerce-progress{position:relative;margin:9px 0;width:100%;height:10px;background:#eee;border-radius:6px}.commerce-progress>div{height:100%;border-radius:6px}.commerce-progress>span{font-size:10px;position:absolute;right:0;top:10px}.commerce-combination-count,.commerce-bargain-count{display:block;font-size:11px;margin-top:6px;border-radius:4px;overflow-wrap:anywhere}.commerce-combination-count{border:1px solid;padding:2px}.commerce-presale-status{display:block;font-size:11px;color:#777;margin-top:4px}.commerce-points-price{font-size:11.5px;line-height:1.8;display:flex;flex-wrap:wrap;gap:1.5px;margin-top:6px}.commerce-points-price>span:first-child{font-size:15px;font-weight:600}.commerce-cards[data-points=true].commerce-layout-0{display:flex;flex-direction:row;overflow-x:auto}.commerce-cards[data-points=true].commerce-layout-0>.commerce-card{display:block;width:112px;flex-shrink:0}.commerce-cards[data-points=true].commerce-layout-0 .commerce-image{width:112px;height:112px}.commerce-cards[data-points=true].commerce-layout-1{grid-template-columns:repeat(3,minmax(0,1fr))}.commerce-cards[data-points=true].commerce-layout-1 .commerce-image{height:102px}.commerce-cards[data-points=true].commerce-layout-2{grid-template-columns:repeat(2,minmax(0,1fr))}.commerce-cards[data-points=true].commerce-layout-2 .commerce-image{height:150px}.commerce-slots{white-space:nowrap;padding:6px;box-sizing:border-box}.commerce-slot{display:inline-block;font-size:11px;margin:0 5px 0 0;line-height:2;padding:0 7px}.commerce-slot.active{color:var(--diy-theme);background:#f7f7f7}.promotion-nav.sticky{position:sticky;top:var(--window-top,0px);z-index:2;background:#fff}.promotion-tabs{overflow-x:auto;white-space:nowrap;padding:6px;box-sizing:border-box}.promotion-tab{position:relative;display:inline-flex;flex-direction:column;align-items:center;vertical-align:top;margin:0 5px 0 0;background:transparent;padding:5px 10px;border-radius:15px;font-size:14px;line-height:1.6;min-width:50px;max-width:110px}.promotion-tab img{width:36px;height:36px;border-radius:50%}.promotion-description{font-size:10px;padding:0.5px 5px;border-radius:10px}.promotion-line{height:2.5px;width:50%;position:absolute;bottom:0;left:25%}.promotion-products{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-items:start}.promotion-products>.commerce-card{width:100%;min-width:0}.promotion-products .commerce-image{height:140px}.promotion-labels{display:flex;gap:3px;flex-wrap:wrap;margin-top:5px}.promotion-label{font-size:10px;line-height:1.3;border:1px solid;padding:1px 2.5px;display:flex;align-items:center;border-radius:3px}.promotion-label img{width:10px;height:10px}.promotion-action[data-cart-style='1'],.promotion-action[data-cart-style='2']{min-width:22px;padding:0 6px}.commerce-coupons{position:relative}.coupon-scroll{width:100%;overflow-x:auto}.coupon-items{display:flex;white-space:nowrap;padding:10px;box-sizing:border-box}.commerce-coupon{display:flex;align-items:center;flex-shrink:0;min-width:130px;max-width:300px;border-radius:6px;overflow:hidden;white-space:normal}.coupon-copy{display:flex;flex-direction:column;align-items:center;padding:10px;flex:1}.coupon-money{font-size:20px;font-weight:700}.coupon-condition{font-size:10.5px;color:#777;white-space:nowrap}.coupon-claim{font-size:11.5px;line-height:2.2;padding:0 9px;flex-shrink:0;margin:5px;border-radius:12px}.coupon-claim[disabled]{opacity:.65}.coupon-scope{font-size:11px;padding:4px}.commerce-coupons[data-coupon-layout='0'] .commerce-coupon{flex-direction:column;min-width:110px}.commerce-coupons[data-coupon-layout='1'] .commerce-coupon{flex-direction:column;min-width:100px;background:#fff!important}.commerce-coupons[data-coupon-layout='2'] .commerce-coupon{border:1px dashed var(--diy-theme);background:#fff!important}.commerce-coupons[data-coupon-layout='2'] .coupon-claim{writing-mode:vertical-rl;line-height:1.3;width:28px;white-space:normal;word-break:break-all}.commerce-coupons[data-coupon-layout='3']{display:flex;align-items:stretch}.commerce-coupons[data-coupon-layout='3'] .coupon-scroll{width:66%;flex:1;min-width:0}.commerce-coupons[data-coupon-layout='3'] .commerce-coupon{flex-direction:column;min-width:100px;background:#fff!important}.coupon-station{width:32%;min-width:0;padding:8px 4px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;align-items:center;font-size:11.5px;gap:6px}.coupon-station>span:nth-child(2){font-size:9px}.coupon-centre{font-size:11px;margin:0;padding:0 6px;line-height:2;white-space:nowrap}.commerce-coupons[data-coupon-layout='4'] .commerce-coupon{min-width:150px}.coupon-reconcile,.coupon-wallet{font-size:11.5px;line-height:2.2;margin:6px 10px}.commerce-live{padding:8px;box-sizing:border-box}.live-card{position:relative;overflow:hidden;white-space:normal}.live-cover{display:block;width:100%;height:200px;object-fit:cover}.live-copy{padding:8px}.live-title{display:block;font-size:14px;line-height:1.5;overflow-wrap:anywhere}.live-status{display:inline-block;font-size:11px;color:#fff;padding:2px 5px;border-radius:5px;max-width:100%;box-sizing:border-box}.live-anchor{display:flex;align-items:center;gap:4px;font-size:11.5px;color:#777;margin-top:5px}.live-anchor img{width:20px;height:20px;border-radius:50%}.commerce-live[data-live-layout='1']>.live-card{display:flex}.commerce-live[data-live-layout='1'] .live-cover{width:50%;height:118px}.commerce-live[data-live-layout='1'] .live-copy{flex:1;min-width:0}.live-goods{display:flex;gap:4px;overflow:hidden}.live-goods>div{width:48px;flex-shrink:0;display:flex;flex-direction:column;font-size:10px}.live-goods img{width:48px;height:48px}.live-strip-content{display:flex}.live-strip-content>.live-card{width:140px;flex-shrink:0}.live-strip-content .live-cover{height:100px}.commerce-live[data-live-layout='3'] .live-cover{height:335px}.live-compact{padding:7px}.commerce-sku-mask{position:fixed;inset:0;z-index:125;background:rgba(0,0,0,.45);display:flex;align-items:flex-end}.commerce-sku-modal{width:100%;background:#fff;max-height:80vh;overflow-y:auto;border-radius:12px 12px 0 0}.commerce-purchase-error{padding:10px;font-size:12px;overflow-wrap:anywhere}
.diy-commerce[data-kind='promotionList'] .commerce-panel{overflow:visible}.commerce-layout-1 .commerce-image{height:162px}.commerce-layout-2 .commerce-image{height:106px}.diy-commerce[data-kind='bargain'] .commerce-layout-0 .commerce-image{width:140px;height:140px}.commerce-cards[data-points=true].commerce-layout-1 .commerce-image{height:106px}.commerce-cards[data-points=true].commerce-layout-2 .commerce-image{height:162px}.commerce-coupons[data-coupon-layout='0'] .coupon-copy,.commerce-coupons[data-coupon-layout='4'] .coupon-copy{background:rgba(255,255,255,.95);border-radius:6px;margin:2px}.commerce-group-badge{font-size:11px;display:block;border:1px solid;padding:1px 3px;border-radius:4px;max-width:100%;box-sizing:border-box}

</style>
