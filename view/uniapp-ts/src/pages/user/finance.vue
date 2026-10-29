<template>
  <ThemePage>
  <view class="finance-page">
    <view class="header-glow" aria-hidden="true"></view>
    <view class="price-wrapper">
      <button class="level-entry" @tap="openDistributionLevel">查看分销等级 <text>›</text></button>
      <view class="balance-card">
        <button class="balance-label" @tap="openExtract">可提现</button>
        <button class="balance-num" @tap="openLedger(1)">{{ info.withdrawable ?? "0.00" }}</button>
        <view class="balance-sub">
          <view class="sub-item"><text class="sub-label">累计佣金(元)</text><text class="sub-val">{{ info.totalCommission ?? "0.00" }}</text></view>
          <view class="sub-item"><text class="sub-label">冻结佣金(元)</text><text class="sub-val">{{ info.frozenCommission ?? "0.00" }}</text></view>
        </view>
        <view class="withdraw-wrap"><button class="withdraw-button" @tap="openExtract">立即提现</button></view>
      </view>
    </view>

    <view class="statistics">
      <button class="menu-item" @tap="openPromoterOrders"><image v-if="!iconFailed('spread_dd')" src="/static/php-finance-center/spread_dd.png" mode="aspectFit" aria-hidden="true" @error="failIcon('spread_dd')" /><view v-else class="menu-icon-placeholder" aria-hidden="true"></view><text>分销订单</text></button>
      <button class="menu-item" @tap="openPeople"><image v-if="!iconFailed('spread_td')" src="/static/php-finance-center/spread_td.png" mode="aspectFit" aria-hidden="true" @error="failIcon('spread_td')" /><view v-else class="menu-icon-placeholder" aria-hidden="true"></view><text>我的团队</text></button>
      <button class="menu-item" @tap="openRanking('commissionRank')"><image v-if="!iconFailed('spread_ph')" src="/static/php-finance-center/spread_ph.png" mode="aspectFit" aria-hidden="true" @error="failIcon('spread_ph')" /><view v-else class="menu-icon-placeholder" aria-hidden="true"></view><text>佣金排行</text></button>
      <button class="menu-item" @tap="openLedger(1)"><image v-if="!iconFailed('spread_yj')" src="/static/php-finance-center/spread_yj.png" mode="aspectFit" aria-hidden="true" @error="failIcon('spread_yj')" /><view v-else class="menu-icon-placeholder" aria-hidden="true"></view><text>佣金记录</text></button>
      <button class="menu-item" @tap="openRanking('promoterRank')"><image v-if="!iconFailed('spread_tgr')" src="/static/php-finance-center/spread_tgr.png" mode="aspectFit" aria-hidden="true" @error="failIcon('spread_tgr')" /><view v-else class="menu-icon-placeholder" aria-hidden="true"></view><text>推广人排行</text></button>
      <button class="menu-item" @tap="openSpread"><image v-if="!iconFailed('spread_yq')" src="/static/php-finance-center/spread_yq.png" mode="aspectFit" aria-hidden="true" @error="failIcon('spread_yq')" /><view v-else class="menu-icon-placeholder" aria-hidden="true"></view><text>邀请好友</text></button>
      <button class="menu-item" @tap="openDistributionLevel"><image v-if="!iconFailed('spread_dj')" src="/static/php-finance-center/spread_dj.png" mode="aspectFit" aria-hidden="true" @error="failIcon('spread_dj')" /><view v-else class="menu-icon-placeholder" aria-hidden="true"></view><text>分销等级</text></button>
      <button class="menu-item" @tap="openAgentExplanation"><image v-if="!iconFailed('spread_sm')" src="/static/php-agent-explanation/spread_sm.png" mode="aspectFit" aria-hidden="true" @error="failIcon('spread_sm')" /><view v-else class="menu-icon-placeholder" aria-hidden="true"></view><text>分销说明</text></button>
    </view>

    <button v-if="failedIcons.length" class="icon-retry" @tap="retryIcons">重新加载菜单图标</button>
    <view class="account-tools">
      <button @tap="openBind">绑定推广人 <text>›</text></button>
      <button @tap="openLedger(4)">提现记录 <text>›</text></button>
      <view class="spread-count">推广人数 <text>{{ info.spreadCount ?? 0 }}</text></view>
    </view>
    <view v-if="uncertain" class="notice" @tap="openExtract">上一笔提现结果待确认，点击查询或重试同一申请。请勿重复发起新申请。</view>
    <view v-if="summaryError || pageError" class="notice" role="alert">{{ summaryError || pageError }}<button @tap="retryInfo">重新读取</button></view>

    <!-- Preserve the existing modern ledger preview below the PHP menu. -->
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
        <view class="sheet-heading"><text class="sheet-title">绑定推广人</text><button @tap="showBind = false">关闭</button></view>
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
const failedIcons=ref<string[]>([]),summaryError=ref('');
function retryIcons(){if(visible&&!disposed)failedIcons.value=[];}
function iconFailed(name:string){return failedIcons.value.includes(name);}
function failIcon(name:string){if(!iconFailed(name))failedIcons.value.push(name);}
const tabs=[{type:1,name:'一级佣金'},{type:2,name:'二级佣金'},{type:3,name:'提现记录'}];
let visible=false,disposed=false,generation=0,listGeneration=0,listPage=1,infoLoading=false;const requests=new Set<UserCenterRequests>();
function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
const current=()=>visible&&!disposed&&auth.isLoggedIn&&persisted();
function request(currentRead=()=>true){const ticket=generation,s=createUserCenterRequests(()=>current()&&ticket===generation&&currentRead());requests.add(s);return s;}
function finish(s:UserCenterRequests){s.abort();requests.delete(s);}
function clear(){generation++;listGeneration++;for(const s of requests)s.abort();requests.clear();info.value=emptyInfo();failedIcons.value=[];list.value=[];showBind.value=false;bindUid.value='';uncertain.value=false;pageError.value='';summaryError.value='';listLoading.value=false;listMore.value=false;infoLoading=false;listPage=1;}
function formatTime(ts:number){if(!ts)return '';const d=new Date(ts*1000),p=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;}
async function loadInfo(){if(!current()||infoLoading)return;const s=request();infoLoading=true;try{const value=await s.request<CommissionInfo>('commission','GET',{},true);if(s.active()){info.value=value;summaryError.value='';}}catch(cause){if(s.active())summaryError.value=cause instanceof Error?cause.message:'财务概览读取失败';}finally{if(s.active())infoLoading=false;finish(s);}}
async function loadList(more:boolean){if(!current()||more&&listLoading.value)return;const ticket=++listGeneration,page=more?listPage+1:1,s=request(()=>ticket===listGeneration);listLoading.value=true;pageError.value='';try{const rows=await s.request<CommissionItem[]>('user/commission/list/'+activeTab.value,'GET',{page,limit:20},true);if(!s.active())return;if(!Array.isArray(rows))throw Error('佣金明细响应无效');list.value=more?[...list.value,...rows]:rows;listPage=page;listMore.value=rows.length===20;}catch(cause){if(s.active())pageError.value=cause instanceof Error?cause.message:'明细读取失败';}finally{if(s.active())listLoading.value=false;finish(s);}}
async function switchTab(type:number){if(!current())return;activeTab.value=type;list.value=[];await loadList(false);}
async function doBind(){if(!current())return;if(!/^[1-9]\d{0,9}$/.test(bindUid.value)||Number(bindUid.value)>2147483647){uni.showToast({title:'请输入推广人 UID',icon:'none'});return;}const s=request();try{await s.request('user/spread','POST',{spread_uid:Number(bindUid.value)},true);if(!s.active())return;uni.showToast({title:'绑定成功',icon:'success'});showBind.value=false;void loadInfo();}catch(cause){if(s.active())uni.showToast({title:cause instanceof Error?cause.message:'绑定失败',icon:'none'});}finally{finish(s);}}
function openBind(){if(current())showBind.value=true;}
function openSpread(){const url=resolveRegisteredPageRoute('/pages/users/user_spread_code/index');if(current()&&url)uni.navigateTo({url});}
function retryInfo(){if(!current())return;pageError.value='';summaryError.value='';failedIcons.value=[];void loadInfo();void loadList(false);}
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
.finance-page{position:relative;min-height:100vh;padding:24rpx 20rpx 40rpx;background:#f5f5f5;box-sizing:border-box}
.finance-page button::after{border:0}
.header-glow{position:absolute;inset:0 0 auto;height:428rpx;background:linear-gradient(360deg,rgba(233,51,35,0),rgba(233,51,35,.2));pointer-events:none}
.price-wrapper{position:relative}
.level-entry{position:absolute;z-index:1;top:8rpx;right:6rpx;max-width:70%;margin:0;padding:0 22rpx;line-height:50rpx;border-radius:0 28rpx 0 28rpx;background:linear-gradient(270deg,#f6c363,#fef8e2);color:#b33f1b;font-size:22rpx}
.level-entry text{margin-left:12rpx}
.balance-card{position:relative;min-height:370rpx;padding:70rpx 0 70rpx;box-sizing:border-box;background:#222431 url('/static/php-finance-center/spread_bg.png') center/100% 100% no-repeat;border-radius:32rpx;color:white}
.balance-label,.balance-num{display:block;width:100%;padding:0;margin:0;border:0;border-radius:0;background:transparent;text-align:center;color:white}
.balance-label{font-size:30rpx;line-height:42rpx;color:rgba(255,255,255,.6)}
.balance-num{margin-top:16rpx;font-size:76rpx;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.balance-sub{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin-top:42rpx}
.sub-item{text-align:center;padding:0 12rpx;min-width:0}
.sub-label,.sub-val{display:block}.sub-label{font-size:24rpx;line-height:34rpx;color:rgba(255,255,255,.6)}
.sub-val{font-size:34rpx;line-height:40rpx;font-weight:600;overflow-wrap:anywhere}
.withdraw-wrap{position:absolute;top:100%;left:50%;padding:16rpx;background:#f5f5f5;border-radius:60rpx;transform:translate(-50%,-50%)}
.withdraw-button{width:256rpx;margin:0;padding:0;line-height:72rpx;border-radius:44rpx;background:var(--view-theme,#e93323);color:white;font-size:30rpx}
.statistics{position:relative;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20rpx;margin:66rpx 0 20rpx}
.menu-item{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:224rpx;min-width:0;margin:0;padding:20rpx 10rpx;background:white;border-radius:24rpx;box-sizing:border-box;line-height:36rpx;color:#333;font-size:26rpx}
.menu-item image,.menu-icon-placeholder{display:block;width:80rpx;height:80rpx;flex:none}
.menu-icon-placeholder{border-radius:50%;background:linear-gradient(135deg,#fff0df,#ffd8bc)}
.menu-item text{margin-top:20rpx}
.icon-retry{margin:0 0 20rpx;background:white;color:#805000;font-size:24rpx;line-height:64rpx}
.account-tools{position:relative;display:flex;flex-wrap:wrap;gap:1rpx;margin:0 0 20rpx;border-radius:16rpx;background:white;overflow:hidden}
.account-tools button,.spread-count{flex:1 1 200rpx;margin:0;padding:20rpx;font-size:24rpx;line-height:44rpx;background:white;text-align:center;color:#555}
.account-tools button text{margin-left:12rpx;color:#999}.spread-count text{margin-left:10rpx;color:#333}
.sheet-heading{display:flex;align-items:center;justify-content:space-between;gap:20rpx}.sheet-heading button{margin:0;padding:0 20rpx;line-height:56rpx;background:transparent;color:#777;font-size:26rpx}
.notice button{display:block;margin:12rpx 0 0;padding:0 20rpx;line-height:60rpx;font-size:26rpx;color:#a33;background:white}
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
