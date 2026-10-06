<template>
  <CustomerWorkShell title="手机经营统计" :manager="manager" active="statistics">
    <view class="cw-card"><view class="cw-controls"><picker :range="periodLabels" :value="periodIndex" @change="choosePeriod"><view>周期：{{ periodLabels[periodIndex] }} ⌄</view></picker></view><template v-if="statistics">
      <text class="cw-scope">销售额、订单数、支付人数：全站履约订单 · 浏览量：全站商品浏览 · 同比比较紧邻的等长周期</text>
      <view class="cw-row"><text>销售额</text><text class="cw-money">¥{{ statistics.summary.after_price }}</text></view>
      <view class="cw-row"><text>订单数</text><text>{{ statistics.summary.after_number }}</text></view><view class="cw-row"><text>支付人数</text><text>{{ statistics.summary.after_pay_number }}</text></view>
      <view class="cw-row"><text>商品浏览量</text><text>{{ statistics.summary.today_visits }}</text></view><view class="cw-row"><text>较上一周期</text><text>{{ statistics.summary.increase_time_status===2?'下降':'增长' }} ¥{{ statistics.summary.increase_time }}（{{ statistics.summary.growth_rate.toFixed(2) }}%）</text></view>
    </template></view>
    <view v-if="trend" class="cw-card"><text class="cw-subtitle">每日销售趋势</text><text class="cw-scope">全站履约订单，零销售日期保留 · {{ trend.type }} 天</text><view class="cw-chart"><view v-for="point in trend.list" :key="point.date" class="cw-chart-item"><text class="cw-muted">¥{{ point.price }}</text><view class="cw-chart-bar" :style="{height:barHeight(point.price)}" /><text class="cw-muted">{{ point.time }}</text><text class="cw-muted">{{ point.num }} 单</text></view></view></view>
    <template v-if="statistics">
      <view class="cw-card"><text class="cw-subtitle">全站订单总览</text><text class="cw-scope">全站履约订单</text><view class="cw-row"><text>订单总数</text><text>{{ statistics.counters.order_count }}</text></view><view class="cw-row"><text>累计交易额</text><text>¥{{ statistics.counters.sum_price }}</text></view><view v-for="metric in salesTotals" :key="metric.label" class="cw-row"><text>{{ metric.label }}</text><text>¥{{ metric.price }} · {{ metric.count }} 单</text></view></view>
      <view class="cw-card"><text class="cw-subtitle">平台订单状态</text><text class="cw-scope">仅平台履约订单，排除门店与供应商订单</text><view v-for="metric in platformStates" :key="metric.label" class="cw-row"><text>{{ metric.label }}</text><text>{{ metric.count }}</text></view></view>
      <view class="cw-card"><text class="cw-subtitle">售后概况</text><text class="cw-scope">全站退款申请</text><view class="cw-row"><text>退款中</text><text>{{ statistics.counters.refunding_count }}</text></view><view class="cw-row"><text>已退款</text><text>{{ statistics.counters.refunded_count }}</text></view><view class="cw-row"><text>申请总数</text><text>{{ statistics.counters.refund_count }}</text></view></view>
    </template>
    <view class="cw-card"><text class="cw-subtitle">每日经营明细</text><text class="cw-scope">全站履约订单与商品浏览 · 日期从新到旧</text><view class="cw-table-row cw-table-head"><text>日期</text><text>销售额</text><text>订单</text><text>浏览</text></view><view v-for="row in rows" :key="row.date" class="cw-table-row"><text>{{ row.date }}</text><text>¥{{ row.price }}</text><text>{{ row.count }}</text><text>{{ row.visit }}</text></view><text v-if="!rows.length" class="cw-muted">当前周期暂无经营明细</text><button v-if="hasMore" class="cw-full" :disabled="paging" @tap="more">{{ paging?'读取中…':'加载更多日期' }}</button></view>
  </CustomerWorkShell>
</template>
<script setup lang="ts">
import { computed,ref } from 'vue';import { onReachBottom } from '@dcloudio/uni-app';import CustomerWorkShell from '@/components/customerWork/CustomerWorkShell.vue';
import { useCustomerWork } from '@/composables/useCustomerWork';import { isCustomerWorkStatistics,isCustomerWorkTrend,isCustomerWorkDaily,isCustomerWorkPaged } from '@/utils/customerWork';
import type { CustomerWorkStatistics,CustomerWorkTrend,CustomerWorkDailyRow } from '@/types/customerWork';
const periodLabels=['今天','近7天','近30天'],periodValues=[1,7,30] as const,periodIndex=ref(0),statistics=ref<CustomerWorkStatistics|null>(null),trend=ref<CustomerWorkTrend|null>(null),rows=ref<CustomerWorkDailyRow[]>([]),hasMore=ref(false),paging=ref(false);let page=1,start=0,stop=0;
function periodRange(){const now=new Date(Date.now()+8*3600000),end=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)/1000-8*3600;stop=Math.floor(Date.now()/1000);start=end-periodValues[periodIndex.value]!*86400;}
const manager=useCustomerWork({page:'statistics',query(query){periodIndex.value=periodValues.indexOf(Number(query.type||1) as 1|7|30);},clear(){statistics.value=null;trend.value=null;rows.value=[];hasMore.value=false;paging.value=false;page=1;},async load(controller){
  periodRange();const valid=controller.fence(),type=periodValues[periodIndex.value]!;
  const result=await controller.read('statistics',isCustomerWorkStatistics,{type});if(!valid())return;if(result.data.type!==type)throw Error('经营统计周期不匹配');
  const chart=await controller.read('trend',isCustomerWorkTrend,{type});if(!valid())return;if(chart.data.type!==type||chart.data.list.length!==(type===1?2:type))throw Error('经营趋势日期不完整');
  const daily=await controller.read('statistics/orders',isCustomerWorkPaged(isCustomerWorkDaily),{start,stop,page:1,limit:10});if(!valid())return;if(daily.data.page!==1||!descending(daily.data.list))throw Error('经营明细分页不匹配');
  statistics.value=result.data;trend.value=chart.data;rows.value=daily.data.list;hasMore.value=daily.data.has_more;
}});
function descending(list:CustomerWorkDailyRow[]){return list.every((row,index)=>index===0||list[index-1]!.date>row.date);}
const salesTotals=computed(()=>{const c=statistics.value?.counters;return c?[{label:'今日',price:c.todayPrice,count:c.todayCount},{label:'昨日',price:c.proPrice,count:c.proCount},{label:'本月',price:c.monthPrice,count:c.monthCount}]:[];});
const platformStates=computed(()=>{const c=statistics.value?.counters;return c?[{label:'待付款',count:c.unpaid_count},{label:'待发货',count:c.unshipped_count},{label:'待收货',count:c.received_count},{label:'待评价',count:c.evaluated_count},{label:'待核销',count:c.unwritoff_count},{label:'已完成',count:c.complete_count}]:[];});
function choosePeriod(event:{detail:{value:string|number}}){const index=Number(event.detail.value);if(!Number.isInteger(index)||index<0||index>=periodValues.length||manager.loading.value)return;periodIndex.value=index;void manager.load();}
function barHeight(price:string){const max=Math.max(0,...(trend.value?.list.map(point=>Number(point.price))||[]));return `${max?Math.max(1,Number(price)/max*65):1}%`;}
async function more(){if(!manager.current()||!manager.context.value||manager.loading.value||paging.value||!hasMore.value)return;const valid=manager.fence(),next=page+1;paging.value=true;try{const response=await manager.read('statistics/orders',isCustomerWorkPaged(isCustomerWorkDaily),{start,stop,page:next,limit:10});if(!valid())return;if(response.data.page!==next||!descending([...rows.value,...response.data.list]))throw Error('经营明细已变化，请刷新后读取');rows.value.push(...response.data.list);hasMore.value=response.data.has_more;page=next;}catch(failure){if(valid())manager.invalidate(failure);}finally{if(valid())paging.value=false;}}
onReachBottom(()=>void more());
</script>
