<template>
  <section class="preview-shell" aria-label="会员权益组件实际字段预览">
    <p class="hint">375 设计宽度预览，页面链接和领取、签到等动作在编辑器中不执行。会员数据由用户端当前登录账号读取。</p>
    <div class="state-author-preview" :data-kind="p.kind" :data-style="p.style" :style="px(p.wrapperStyle)">
      <div class="panel" :style="px(p.panelStyle)">
        <p v-if="!p.enabled" class="hint">发布时隐藏此组件</p>
        <p v-if="loading" role="status">正在读取当前公开内容…</p>
        <p v-else-if="error" role="alert">{{error}}</p>
        <template v-else-if="p.kind==='userInfor'">
          <div class="member" :class="{inline:p.style===1}">
            <div class="identity"><img v-if="p.avatar" :src="p.avatar" alt="会员默认头像预览" /><span v-else class="avatar-empty">人</span><div><strong>会员信息</strong><p class="hint">用户端显示当前账号昵称与等级</p><div class="progress" :style="px(p.progressTrackStyle)"><div :style="{...px(p.progressFillStyle),width:'100%'}" /></div><p class="hint">进度条样式 · 实际进度由会员经验计算</p></div></div>
            <span v-if="p.style===0 && p.checks.includes(3)" class="member-code">▦ 会员码</span>
            <div class="metrics" :class="{inline:p.style===1}"><div v-for="metric in metrics" :key="metric.id"><strong>{{metric.id===3?'▦':'—'}}</strong><span>{{metric.label}}</span></div></div>
          </div>
        </template>
        <template v-else-if="loaded">
          <template v-if="p.kind==='newVip' && data.newcomer">
            <div class="heading"><strong>新人专享福利</strong><span :style="px(p.moreStyle)">{{p.more}} ›</span></div>
            <div :class="{modern:p.style===1}">
              <div v-if="p.checks.includes(0)" class="bonus" :style="px(p.bonusStyle)"><div><span>新人赠送积分</span><strong>{{points}}</strong></div><span class="sample-button" :style="px(p.buttonStyle)">查看新人权益</span></div>
              <template v-if="p.checks.includes(1)"><h4>新人优惠券</h4><div class="coupon-scroll" :style="px(p.couponListStyle)"><article v-for="coupon in data.newcomer.newcomer_coupon" :key="coupon.id" class="coupon" :style="px(p.couponStyle)"><strong :style="px(p.couponMoneyStyle)">{{couponLabel(coupon)}}</strong><span>{{coupon.coupon_title||'新人优惠券'}}</span><span :style="px(p.couponTypeStyle)">{{couponScope(coupon)}}</span><span class="coupon-info" :style="px(p.couponInfoStyle)">满{{coupon.use_min_price}}元可用</span><span>{{couponStatus(coupon)}}</span></article><p v-if="!data.newcomer.newcomer_coupon.length" class="hint">暂无新人优惠券</p></div><div class="coupon-station" :style="px(p.couponStationStyle)"><span>新人优惠券专区</span><span class="sample-button" :style="px(p.couponButtonStyle)">查看优惠券</span></div></template>
              <template v-if="p.checks.includes(2)"><h4>新人商品专区</h4><div class="products"><article v-for="product in data.newcomer.newcomer_products" :key="product.id"><img v-if="image(product.image)" :src="image(product.image)" alt="新人商品预览" /><strong>{{product.store_name}}</strong><span :style="px(p.priceStyle)">¥{{product.price}}</span></article><p v-if="!data.newcomer.newcomer_products.length" class="hint">暂无新人商品</p></div></template>
            </div>
          </template>
          <template v-else-if="p.kind==='signIn' && data.sign">
            <div class="sign" :class="{reward:p.style===1}"><template v-if="p.style===1"><strong>签到立即获取</strong><span class="points" :style="px(p.rewardStyle)">+{{data.sign.sign_give_point}} 积分</span><p>连续签到{{nextReward.days}}天，额外获得{{nextReward.point}}积分<span v-if="nextReward.exp">、{{nextReward.exp}}经验</span></p></template><div v-else class="week"><div v-for="(day,index) in data.sign.signList[0]" :key="index" :class="{signed:day.is_sign,today:day.sign_day}"><span>周{{weekdays[index]}}</span><strong>{{day.day}}</strong><span>{{day.is_sign?'已签':day.type===2?'经验':'积分'}}</span></div></div><span class="sample-button sign-button" :style="px(p.buttonStyle)">前往签到页</span></div>
          </template>
          <template v-else-if="p.kind==='ranking' && data.ranks">
            <div class="heading"><img v-if="p.titleMode==='image' && p.titleImage" class="rank-title-image" :src="p.titleImage" alt="排行榜标题图片预览" /><strong v-else-if="p.titleMode==='text'" :style="px(p.titleStyle)">{{p.title}}</strong><span :style="px(p.moreStyle)">{{p.more}} ›</span></div>
            <div class="ranks" :class="{collage:p.style===1}"><article v-for="group in ranks" :key="group.key" class="rank-card" :style="px(p.rankCardStyle)"><strong :style="px(p.rankLabelStyle)">{{group.label}}</strong><div class="rank-products"><div v-for="(product,index) in group.items" :key="product.id" class="rank-product" :class="{first:index===0}"><div class="rank-picture"><img v-if="image(product.image)" :src="image(product.image)" :style="px(p.rankImageStyle)" alt="榜单商品预览" /><span>{{index+1}}</span></div><div><strong>{{product.store_name}}</strong><span :style="px(p.priceStyle)">¥{{product.price}}</span><del v-if="p.style===1 && index===0 && product.ot_price!==undefined">¥{{product.ot_price}}</del></div></div></div><p v-if="!group.items.length" class="hint">暂无榜单商品</p></article></div>
          </template>
        </template>
        <p v-else class="hint">点击“读取当前公开内容预览”查看当前公开的积分、优惠券、签到与榜单信息。</p>
      </div>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { normalizeDiyStateWidget, statePreviewTheme, diyCouponLabel as couponLabel, diyCouponScope as couponScope, diyCouponStatus as couponStatus, type DiyStateData } from '@/utils/diyStateProjection';
import { statePreviewBlock, statePixelStyle as px, type StateRecord } from '@/utils/diyStateEditor';
import { presentationPreviewUrl as image } from '@/utils/diyPresentationEditor';
const props=defineProps<{block:StateRecord;previews:Record<string,string>;data:DiyStateData;loaded:boolean;loading:boolean;error:string}>();
const p=computed(()=>normalizeDiyStateWidget(statePreviewBlock(props.block,props.previews),statePreviewTheme));
const metrics=computed(()=>[{id:1,label:'积分'},{id:2,label:'余额'},{id:0,label:'优惠券'},{id:3,label:'会员码'},{id:4,label:'收藏'},{id:5,label:'浏览'}].filter(item=>p.value.checks.includes(item.id)&&(p.value.style===1||item.id!==3)));
const points=computed(()=>Array.isArray(props.data.newcomer?.newcomer_integral)?0:props.data.newcomer?.newcomer_integral??0);
const nextReward=computed(()=>props.data.sign?.nextContinuousSignRewardList[0]??{days:0,point:0,exp:0});
const weekdays=['一','二','三','四','五','六','日'];
const ranks=computed(()=>(p.value.style===0?['sales','collect','star']as const:['sales','star','collect']as const).map(key=>({key,label:{sales:'销量榜',collect:'收藏榜',star:'好评榜'}[key],items:props.data.ranks?.[key]??[]})));
</script>
<style scoped>
.preview-shell{width:100%;overflow:auto}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary)}.state-author-preview{width:375px;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere}.panel{padding:12px;box-sizing:border-box;overflow:hidden}.heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}.heading>span{flex-shrink:0}.identity{display:flex;gap:10px;align-items:center;min-width:0;flex:1}.identity>img,.avatar-empty{width:48px;height:48px;border-radius:50%;flex-shrink:0;object-fit:cover}.avatar-empty{display:grid;place-items:center;background:#eee;color:#888}.identity>div{min-width:0;flex:1}.identity p{margin:4px 0}.progress{height:6px;border-radius:6px;overflow:hidden}.progress>div{height:100%;border-radius:6px}.member{display:flex;flex-wrap:wrap;gap:12px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;width:100%}.metrics.inline{width:48%;min-width:110px}.metrics>div{display:flex;flex-direction:column;gap:4px;align-items:center;font-size:11px}.metrics strong{font-size:14px}.bonus{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:10px;border-radius:6px;font-size:12px}.bonus>div{display:flex;flex-direction:column;gap:6px}.bonus strong{font-size:16px}.sample-button{display:inline-block;padding:5px 9px;border-radius:14px;white-space:nowrap;font-size:11px}.coupon-scroll,.products,.ranks{display:flex;overflow-x:auto;gap:0}.coupon{width:110px;flex-shrink:0;padding:9px;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;border:1px solid #ddd;border-radius:6px;font-size:11px}.coupon>strong{font-size:18px}.coupon-info{padding:3px 4px;border-radius:4px}.coupon-station{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:9px;font-size:11px}.modern .coupon-station{flex-direction:column;align-items:flex-start}.products>article{width:90px;flex-shrink:0;margin-right:10px;display:flex;flex-direction:column;font-size:12px}.products img{width:90px;height:90px;object-fit:cover;border-radius:6px}.products strong{font-weight:normal;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.products span{font-size:14px}.week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px}.week>div{display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 0;border-radius:6px;font-size:10.5px;color:#888}.week .signed{background:var(--diy-theme);color:#fff}.week .today{outline:1px solid var(--diy-theme)}.sign-button{display:block;text-align:center;margin-top:11px}.points{display:inline-block;padding:3px 7px;margin:6px;border-radius:6px;font-size:15px}.sign p{font-size:12px}.rank-title-image{width:51px;height:16px;object-fit:contain}.ranks{gap:10px}.rank-card{width:160px;flex-shrink:0;padding:9px;box-sizing:border-box;font-size:14px}.rank-product{display:flex;align-items:center;gap:6px;margin-top:8px;min-width:0}.rank-picture{position:relative;flex-shrink:0}.rank-picture img{width:48px;height:48px;object-fit:cover;display:block}.rank-picture>span{position:absolute;left:0;top:0;background:#f7b23a;color:white;font-size:10px;padding:0 3px}.rank-product>div:last-child{min-width:0;display:flex;flex-direction:column}.rank-product strong{font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:normal}.rank-product span{font-size:14px}.rank-product del{font-size:11px;color:#999}.collage .rank-card{width:225px}.collage .rank-products{display:grid;grid-template-columns:2fr 1fr;gap:5px}.collage .rank-product{display:block;margin-top:7px}.collage .rank-product.first{grid-row:span 2}.collage .rank-picture img{width:100%;height:45px}.collage .first .rank-picture img{height:100px}h4{font-size:13.5px;margin:11px 0 8px}
</style>
