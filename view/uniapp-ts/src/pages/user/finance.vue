<template>
  <ThemePage>
  <view class="finance-page">
    <!-- 佣金总览 -->
    <view class="balance-card">
      <view class="balance-label">可提现佣金 (元)</view>
      <view class="balance-num">{{ info.withdrawable ?? "0.00" }}</view>
      <view class="balance-sub">
        <view class="sub-item">
          <text class="sub-val">{{ info.totalCommission ?? "0.00" }}</text>
          <text class="sub-label">累计佣金</text>
        </view>
        <view class="sub-item">
          <text class="sub-val">{{ info.frozenCommission ?? "0.00" }}</text>
          <text class="sub-label">冻结佣金</text>
        </view>
        <view class="sub-item">
          <text class="sub-val">{{ info.spreadCount ?? 0 }}</text>
          <text class="sub-label">推广人数</text>
        </view>
      </view>
    </view>

    <!-- 操作 -->
    <view class="action-row">
      <view class="action-btn" @tap="openExtract">
        <text class="action-icon">💸</text>
        <text class="action-text">提现</text>
      </view>
      <view class="action-btn" @tap="showBind = true">
        <text class="action-icon">🔗</text>
        <text class="action-text">绑定推广人</text>
      </view>
      <view class="action-btn" @tap="openPeople">
        <text class="action-icon">👥</text>
        <text class="action-text">我的推广</text>
      </view>
      <view class="action-btn" @tap="openDistributionLevel">
        <text class="action-icon">🏅</text>
        <text class="action-text">分销等级</text>
      </view>
    </view>

    <view class="explanation-entry"><button @tap="openAgentExplanation"><image src="/static/php-agent-explanation/spread_sm.png" mode="aspectFit" aria-hidden="true" /><text>分销说明</text><text class="arrow">›</text></button></view>

    <view class="ranking-links ledger-links"><button @tap="openLedger(1)">佣金记录 <text>›</text></button><button @tap="openLedger(4)">提现记录 <text>›</text></button></view>
    <view class="order-entry"><button @tap="openPromoterOrders">分销订单 <text>›</text></button></view>
    <view class="ranking-links"><button @tap="openRanking('promoterRank')">推广人排行 <text>›</text></button><button @tap="openRanking('commissionRank')">佣金排行 <text>›</text></button></view>

    <view v-if="uncertain" class="notice" @tap="openExtract">上一笔提现结果待确认，点击查询或重试同一申请。请勿重复发起新申请。</view>
    <view v-if="pageError" class="notice">{{ pageError }}</view>

    <!-- 明细 tab -->
    <view class="list-card">
      <view class="tabs">
        <view
          v-for="(t, i) in tabs"
          :key="t.type"
          class="tab"
          :class="{ active: activeTab === t.type }"
          @tap="switchTab(t.type)"
        >
          {{ t.name }}
        </view>
      </view>
      <view v-if="list.length" class="items">
        <view v-for="item in list" :key="item.id" class="item">
          <view class="item-left">
            <view class="item-title">{{ item.title }}</view>
            <view class="item-time">{{ formatTime(item.addTime) }}</view>
          </view>
          <view class="item-right" :class="{ income: item.pm === 1 }">
            {{ item.pm === 1 ? "+" : "-" }}¥{{ item.number }}
          </view>
        </view>
      </view>
      <view v-else class="empty">{{ listLoading ? "加载中…" : "暂无佣金明细" }}</view>
      <button v-if="listMore" class="more-btn" :disabled="listLoading" @tap="loadList(true)">{{ listLoading ? "加载中…" : "加载更多明细" }}</button>
    </view>

    <!-- 绑定推广人弹窗 -->
    <view v-if="showBind" class="mask" @tap="showBind = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">绑定推广人</view>
        <input v-model="bindUid" class="sheet-input" type="number" placeholder="推广人 UID" />
        <view class="sheet-btn" @tap="doBind">确认绑定</view>
      </view>
    </view>


  </view>
  <DiySuspendedNavigation />
  </ThemePage>
</template>

<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import {onScopeDispose,ref,watch} from 'vue';
import {onShow,onHide,onUnload} from '@dcloudio/uni-app';
import {resolveRegisteredPageRoute} from '@/config/navigation';
import {type CommissionInfo,type CommissionItem} from '@/api/finance';
import {createUserCenterRequests,type UserCenterRequests} from '@/api/userCenter';
import {useAuthStore} from '@/stores/auth';
import {withdrawalStorageKey} from '@/utils/withdrawal';
const auth=useAuthStore(),emptyInfo=():CommissionInfo=>({yesterdayCommission:'0.00',totalCommission:'0.00',frozenCommission:'0.00',withdrawable:'0.00',spreadCount:0});
const info=ref(emptyInfo()),list=ref<CommissionItem[]>([]),showBind=ref(false),bindUid=ref(''),activeTab=ref(1),uncertain=ref(false),pageError=ref(''),listLoading=ref(false),listMore=ref(false);
const tabs=[{type:1,name:'一级佣金'},{type:2,name:'二级佣金'},{type:3,name:'提现记录'}];
let visible=false,disposed=false,generation=0,listGeneration=0,listPage=1,infoLoading=false;const requests=new Set<UserCenterRequests>();
function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
const current=()=>visible&&!disposed&&auth.isLoggedIn&&persisted();
function request(currentRead=()=>true){const ticket=generation,s=createUserCenterRequests(()=>current()&&ticket===generation&&currentRead());requests.add(s);return s;}
function finish(s:UserCenterRequests){s.abort();requests.delete(s);}
function clear(){generation++;listGeneration++;for(const s of requests)s.abort();requests.clear();info.value=emptyInfo();list.value=[];showBind.value=false;bindUid.value='';uncertain.value=false;pageError.value='';listLoading.value=false;listMore.value=false;infoLoading=false;listPage=1;}
function formatTime(ts:number){if(!ts)return '';const d=new Date(ts*1000),p=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;}
async function loadInfo(){if(!current()||infoLoading)return;const s=request();infoLoading=true;try{const value=await s.request<CommissionInfo>('commission','GET',{},true);if(s.active())info.value=value;}catch(cause){if(s.active())pageError.value=cause instanceof Error?cause.message:'财务概览读取失败';}finally{if(s.active())infoLoading=false;finish(s);}}
async function loadList(more:boolean){if(!current()||more&&listLoading.value)return;const ticket=++listGeneration,page=more?listPage+1:1,s=request(()=>ticket===listGeneration);listLoading.value=true;pageError.value='';try{const rows=await s.request<CommissionItem[]>('user/commission/list/'+activeTab.value,'GET',{page,limit:20},true);if(!s.active())return;if(!Array.isArray(rows))throw Error('佣金明细响应无效');list.value=more?[...list.value,...rows]:rows;listPage=page;listMore.value=rows.length===20;}catch(cause){if(s.active())pageError.value=cause instanceof Error?cause.message:'明细读取失败';}finally{if(s.active())listLoading.value=false;finish(s);}}
async function switchTab(type:number){if(!current())return;activeTab.value=type;list.value=[];await loadList(false);}
async function doBind(){if(!current())return;if(!/^[1-9]\d{0,9}$/.test(bindUid.value)||Number(bindUid.value)>2147483647){uni.showToast({title:'请输入推广人 UID',icon:'none'});return;}const s=request();try{await s.request('user/spread','POST',{spread_uid:Number(bindUid.value)},true);if(!s.active())return;uni.showToast({title:'绑定成功',icon:'success'});showBind.value=false;void loadInfo();}catch(cause){if(s.active())uni.showToast({title:cause instanceof Error?cause.message:'绑定失败',icon:'none'});}finally{finish(s);}}
function openExtract(){if(!current()){if(visible&&!disposed&&!auth.isLoggedIn)uni.navigateTo({url:'/pages/auth/login'});return;}const url=resolveRegisteredPageRoute('/pages/users/user_cash/index');if(url)uni.navigateTo({url});}
function openLedger(type:1|4){const url=resolveRegisteredPageRoute('/pages/users/user_spread_money/index','type='+type);if(current()&&url)uni.navigateTo({url});}
function openAgentExplanation(){
  if(!visible||disposed)return;
  try{const token=uni.getStorageSync('uni_token')||'',uid=Number(uni.getStorageSync('uni_uid'))||0;
    if(typeof token!=='string'||!Number.isSafeInteger(uid)||uid<0||!!token!==(uid>0)||token!==auth.token||uid!==auth.uid)return;
  }catch{return;}
  const url=resolveRegisteredPageRoute('/pages/users/user_distribution_info/index');if(url)uni.navigateTo({url});
}
function openPeople(){if(current())uni.navigateTo({url:'/pages/user/promoterPeople'});}
function openDistributionLevel():void{if(current())uni.navigateTo({ url: '/pages/users/user_distribution_level/index' });}
function openPromoterOrders(){if(current())uni.navigateTo({url:'/pages/user/promoterOrders'});}
function openRanking(page:'promoterRank'|'commissionRank'){if(current())uni.navigateTo({url:'/pages/user/'+page});}
function enter(){if(!current()||infoLoading||listLoading.value)return;try{uncertain.value=!!uni.getStorageSync(withdrawalStorageKey(auth.uid));}catch{pageError.value='设备中的待确认申请读取失败，请进入提现页核对';}void loadInfo();void loadList(false);}
function sync(){let token:unknown,uid=0;try{token=uni.getStorageSync('uni_token')||'';uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{clear();return;}if(typeof token!=='string'||!Number.isSafeInteger(uid)||uid<0||!!token!==(uid>0)){clear();return;}if(token!==auth.token||uid!==auth.uid)auth.$patch({token,uid,sessionVersion:auth.sessionVersion+1});}
watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();void Promise.resolve().then(enter);},{flush:'sync'});
const changed=()=>{sync();enter();};onShow(()=>{if(disposed)return;visible=true;sync();clear();enter();
// #ifdef H5
if(typeof window!=='undefined'){window.addEventListener('focus',changed);window.addEventListener('storage',changed);}
// #endif
});function leave(){visible=false;clear();
// #ifdef H5
if(typeof window!=='undefined'){window.removeEventListener('focus',changed);window.removeEventListener('storage',changed);}
// #endif
}onHide(leave);onUnload(()=>{leave();disposed=true;});onScopeDispose(()=>{leave();disposed=true;});
</script>

<style scoped>
.finance-page {
  padding: 20rpx;
}

.balance-card {
  background: linear-gradient(135deg, var(--view-theme, #e93323), var(--view-gradient, #FF7931));
  border-radius: 16rpx;
  padding: 40rpx 30rpx;
  color: #fff;
}

.balance-label {
  font-size: 24rpx;
  opacity: 0.9;
}

.balance-num {
  font-size: 64rpx;
  font-weight: 700;
  margin: 12rpx 0 30rpx;
}

.balance-sub {
  display: flex;
  justify-content: space-between;
}

.sub-item {
  text-align: center;
}

.sub-val {
  display: block;
  font-size: 30rpx;
  font-weight: 600;
}

.sub-label {
  display: block;
  font-size: 22rpx;
  opacity: 0.85;
  margin-top: 6rpx;
}

.explanation-entry{margin-bottom:20rpx}.explanation-entry button{display:flex;align-items:center;gap:20rpx;margin:0;padding:20rpx 26rpx;background:#fff;border-radius:16rpx;color:#333;font-size:28rpx;line-height:52rpx;text-align:left}.explanation-entry button::after{border:0}.explanation-entry image{width:52rpx;height:52rpx;flex:none}.explanation-entry .arrow{margin-left:auto;color:#aaa}
.order-entry{margin-bottom:20rpx}.order-entry button{margin:0;background:#fff;border-radius:16rpx;text-align:left;font-size:28rpx;padding:0 24rpx;line-height:90rpx}.order-entry button::after{border:0}.order-entry text{float:right;color:#999}
.ranking-links{display:flex;gap:20rpx;margin:0 0 24rpx}.ranking-links button{flex:1;margin:0;background:white;text-align:left;padding:0 24rpx;font-size:28rpx;line-height:90rpx;border-radius:16rpx}.ranking-links button::after{border:0}.ranking-links text{float:right;color:#999}
.action-row {
  display: flex;
  gap: 20rpx;
  margin: 24rpx 0;
}

.action-btn {
  flex: 1;
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx 0;
  text-align: center;
}

.action-icon {
  display: block;
  font-size: 40rpx;
}

.action-text {
  display: block;
  font-size: 24rpx;
  color: #555;
  margin-top: 8rpx;
}

.list-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 20rpx;
}

.tabs {
  display: flex;
  border-bottom: 1rpx solid #f0f0f0;
  margin-bottom: 16rpx;
}

.tab {
  flex: 1;
  text-align: center;
  padding: 16rpx 0;
  font-size: 26rpx;
  color: #888;
}

.tab.active {
  color: var(--view-theme, #e93323);
  font-weight: 600;
  border-bottom: 4rpx solid var(--view-theme, #e93323);
}

.items {
  max-height: 600rpx;
  overflow-y: auto;
}

.item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f7f7f7;
}

.item-title {
  font-size: 26rpx;
  color: #333;
}

.item-time {
  font-size: 22rpx;
  color: #999;
  margin-top: 6rpx;
}

.item-right {
  font-size: 28rpx;
  color: #999;
}

.item-right.income {
  color: #e93323;
  font-weight: 600;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 24rpx;
  padding: 60rpx 0;
}

.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;
  z-index: 99;
}

.sheet {
  width: 100%;
  max-width: 640px;
  max-height: 85vh;
  overflow-y: auto;
  margin: 0 auto;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 30rpx;
  box-sizing: border-box;
}

.sheet-title {
  font-size: 30rpx;
  font-weight: 600;
  text-align: center;
  margin-bottom: 24rpx;
}

.sheet-input {
  background: #f7f7f7;
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  font-size: 26rpx;
  margin-bottom: 16rpx;
}

.sheet-btn {
  background: var(--view-theme, #e93323);
  color: #fff;
  text-align: center;
  border-radius: 12rpx;
  padding: 22rpx 0;
  font-size: 28rpx;
  margin-top: 10rpx;
}

.sheet-btn[disabled] { opacity: 0.55; }
.notice { margin: 16rpx 0; padding: 18rpx; border-radius: 12rpx; background: #fff4df; color: #805000; font-size: 24rpx; line-height: 1.6; }
.form-hint { color: #666; font-size: 24rpx; line-height: 1.7; margin: 16rpx 0; }
.method-row { display: flex; gap: 12rpx; flex-wrap: wrap; margin-bottom: 20rpx; }
.method-row button { margin: 0; }
.method-row .selected { color: var(--view-theme, #e93323); border: 1px solid var(--view-theme, #e93323); }
.more-btn { margin: 20rpx 0 0; font-size: 24rpx; background: #fff; color: #666; }

</style>
