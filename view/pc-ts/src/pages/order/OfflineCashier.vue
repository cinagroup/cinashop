<template>
  <main class="offline-cashier">
    <h1>{{ resultOnly ? '原消费支付结果' : '线下消费收银' }}</h1>
    <p class="note">这是无商品的独立消费，不是商城订单的线下付款。</p>
    <p v-if="resultOnly" class="note">此页只核对原订单，不会发起付款。支付平台返回页面不代表已经到账。</p>
    <section v-if="!resultOnly && !cashier.linked" class="card history" aria-label="找回已有消费">
      <h2>找回已有消费</h2>
      <p class="note">换设备或本地记录丢失后，请先查询原消费。列表不是付款凭据；恢复只核对原单，不会另建或自动付款。</p>
      <p v-if="state.intent?.version === 2" class="note order-id">已保留原消费 {{ state.intent.orderId }}，请在下方查看服务器核验结果。</p>
      <label for="offline-history-search">原订单号（可留空查看最近记录）</label>
      <input id="offline-history-search" class="history-search" maxlength="32" :value="state.history.query" :disabled="state.busy || !loggedIn"
        @input="cashier.searchHistory(($event.target as HTMLInputElement).value)" />
      <div class="actions">
        <button :disabled="state.busy || !loggedIn" @click="cashier.loadHistory()">{{ state.history.pageCursor ? '重新读取本页' : '查询已有消费' }}</button>
        <button v-if="state.history.nextCursor" :disabled="state.busy" @click="cashier.loadHistory(true)">下一页消费记录</button>
        <button v-if="state.history.pageCursor" :disabled="state.busy" @click="cashier.searchHistory(''); cashier.loadHistory()">返回最近记录</button>
      </div>
      <p v-if="state.error && state.errorSource === 'history'" class="error" role="alert">{{ state.error }}</p>
      <p v-if="state.history.loaded && !state.history.items.length" class="note">本次查询没有记录。请核对账号或订单号；这不代表其他账号或尚未确认的请求没有消费。</p>
      <ul v-if="state.history.items.length">
        <li v-for="item in state.history.items" :key="item.order_id">
          <p class="order-id">{{ item.order_id }}</p>
          <p>原价 ¥{{ item.money }} · 应付 ¥{{ item.pay_price }}</p>
          <p class="note">{{ new Date(item.created_at * 1000).toLocaleString() }} · {{ item.channel }}{{ item.hidden ? ' · 已隐藏，仍需核对' : '' }} · 收款状态需核对</p>
          <button :disabled="state.busy || !loggedIn" @click="cashier.recover(item.order_id)">恢复并核对这笔消费</button>
        </li>
      </ul>
    </section>
    <section v-if="!resultOnly" class="card" aria-label="消费确认">
      <label for="offline-money">消费金额（元）</label>
      <p class="note">折扣后应付须至少0.01元；不足时请调整消费金额，不会自动加价或零元结算。</p>
      <input id="offline-money" inputmode="decimal" maxlength="11" placeholder="0.00" :value="state.money"
        :disabled="state.busy || !!state.intent || !!route.query.orderId || !loggedIn"
        @input="cashier.edit(($event.target as HTMLInputElement).value)" />
      <p v-if="state.quote">本次确认应付 <strong>¥{{ state.quote }}</strong></p>
      <div v-if="!state.intent && !route.query.orderId" class="actions">
        <button :disabled="state.busy || !loggedIn" @click="cashier.quote()">查询应付金额</button>
        <button class="primary" :disabled="state.busy || !state.quote || state.quote === '0.00' || !loggedIn" @click="cashier.create()">确认金额并建单</button>
      </div>
      <p v-if="state.quote === '0.00' || state.reprice === '0.00'" class="note">线下消费应付须至少0.01元，原零元记录仅可核对，不能付款。</p>
      <div v-if="state.intent && !state.intent.orderId" class="actions">
        <p class="note">原建单请求已保存。刷新、超时或重新登录后，仍使用同一请求，不会自动新建消费。</p>
        <button :disabled="state.busy || !loggedIn || state.intent.draft?.expected_pay_price === '0.00'" @click="cashier.create()">重试原建单请求</button>
        <button v-if="state.reprice" :disabled="state.busy || state.reprice === '0.00'" @click="cashier.create(true)">重新确认应付 ¥{{ state.reprice }}</button>
      </div>
    </section>
    <section class="card" aria-label="原消费支付状态">
      <h2 role="status">{{ state.busy ? '正在核对，请稍候…' : offlineStatus(state.detail) }}</h2>
      <p v-if="state.intent?.orderId || state.detail" class="order-id">原订单号：{{ state.intent?.orderId || state.detail?.order_id }}</p>
      <p v-if="state.detail">原价 ¥{{ state.detail.money }} · 应付 ¥{{ state.detail.pay_price }}</p>
      <p v-if="state.detail?.state === 'PAID'">服务器已核验本次收款。请保留原订单号。</p>
      <p v-else class="note">未确认到账不代表支付失败。取消、刷新或返回页面都不会重新发起支付，也不会自动更换支付方式。</p>
      <div v-if="!resultOnly && state.detail?.state === 'UNSELECTED'" class="actions">
        <p v-if="!state.capabilities" class="note">支付方式尚未核验，请重新读取原消费后再付款。</p>
        <template v-else>
          <p class="note">当前余额 ¥{{ state.capabilities.now_money }}。付款前会再次核验；可用方式不代表已经收款。</p>
          <button v-for="item in methods" :key="item.value" :disabled="state.busy || state.capabilities.methods[item.value] !== 'available'" @click="cashier.pay(item.value)">{{ item.label }} ¥{{ state.detail.pay_price }} · {{ offlineMethodMessage(state.capabilities.methods[item.value]) }}</button>
        </template>
      </div>
      <div class="actions">
        <button v-if="!resultOnly && state.detail?.state === 'READY'" class="primary" :disabled="state.busy" @click="cashier.open(launchOfflineBrowserTicket)">继续原支付入口</button>
        <button v-if="state.intent?.orderId || route.query.orderId" :disabled="state.busy || !loggedIn" @click="cashier.refresh()">重新读取原消费</button>
        <button v-if="!resultOnly && state.detail?.state === 'PAID' && state.intent && !route.query.orderId" :disabled="state.busy" @click="cashier.newPurchase()">已核对，开始另一笔消费</button>
      </div>
      <p v-if="state.error && state.errorSource !== 'history'" class="error" role="alert">{{ state.error }}</p>
      <router-link v-if="!loggedIn" :to="{path:'/login',query:{redirect:route.fullPath}}">登录后恢复原消费</router-link>
      <router-link v-else-if="resultOnly || (state.error && !state.intent)" to="/user/offline-pay">返回收银入口恢复原记录</router-link>
    </section>
  </main>
</template>
<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { captureAuthSession, getUid, isCurrentAuthSession, isLoggedIn, onAuthChange } from '@/utils/auth';
import { offlineApi } from '@/api/offline';
import { OfflineCashier, OfflineJournal, offlineStatus, offlineMethodMessage, emptyOfflineHistory, type OfflineMethod, type OfflineView } from '../../../../common/offlineCashier';
import { offlineBrowserKey, offlineBrowserExclusive, launchOfflineBrowserTicket } from '../../../../common/offlineBrowser';
const route = useRoute(), loggedIn = ref(isLoggedIn());
const { resultOnly = false } = defineProps<{ resultOnly?: boolean }>();
const state = shallowRef<OfflineView>({money:'',quote:'',intent:null,detail:null,capabilities:null,busy:false,error:'',errorSource:'cashier',reprice:'',history:emptyOfflineHistory()});
const methods: { value:OfflineMethod; label:string }[] = [{value:'yue',label:'余额支付'},{value:'weixin',label:'微信支付'},{value:'alipay',label:'支付宝支付'}];
const cashier = new OfflineCashier({ ...offlineApi, key:offlineBrowserKey, channel:()=>'h5', readOnly:resultOnly,
  journal:new OfflineJournal({get:key=>localStorage.getItem(key),set:(key,value)=>localStorage.setItem(key,value),remove:key=>localStorage.removeItem(key)}),
  exclusive:work=>offlineBrowserExclusive(getUid(),work),
  owner:()=>{const auth=captureAuthSession(),uid=getUid();return {uid,current:()=>!!auth.token && uid>0 && getUid()===uid && isCurrentAuthSession(auth)};},
  publish:value=>{state.value=value;},
});
let mounted = false;
function show() { if (mounted && !document.hidden) void cashier.show(route.query.orderId); }
function visibility() { if (document.hidden) cashier.hide(); else show(); }
const unlisten = onAuthChange(()=>{loggedIn.value=isLoggedIn();cashier.hide();show();});
watch(()=>route.fullPath,()=>{cashier.hide();show();});
onMounted(()=>{mounted=true;document.addEventListener('visibilitychange',visibility);show();});
onUnmounted(()=>{mounted=false;unlisten();document.removeEventListener('visibilitychange',visibility);cashier.hide();});
</script>
<style scoped>
.offline-cashier{max-width:720px;margin:32px auto;padding:0 20px 48px;color:#282828}.offline-cashier h1{font-size:28px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;margin-top:20px}.card h2{font-size:20px;margin:0 0 16px}.card label{display:block;margin-bottom:12px}input{box-sizing:border-box;width:100%;padding:14px;font-size:28px;border:1px solid #aaa;border-radius:8px}strong{font-size:24px;color:#d52b20}.note{font-size:14px;line-height:1.7;color:#666}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:18px}.actions p{flex-basis:100%;margin:0}button{padding:12px 16px;background:#fff;border:1px solid #bbb;border-radius:8px;font:inherit;cursor:pointer;line-height:1.5}button.primary{background:#e93323;border-color:#e93323;color:white}button:disabled{opacity:.5;cursor:not-allowed}.error{padding:14px;background:#fff4e8;color:#934312;line-height:1.6}.order-id,.error{overflow-wrap:anywhere}a{display:inline-block;margin-top:12px;color:#b6291c}@media(max-width:600px){.offline-cashier{margin:20px auto;padding:0 12px 32px}.card{padding:18px}.actions button{width:100%}.offline-cashier h1{font-size:24px}}
</style>
<style scoped>
.offline-cashier button:disabled{opacity:1;color:#606266;background:#f5f6f7;border-color:#d1d5db}
.history .history-search{font-size:16px}.history ul{list-style:none;padding:0}.history li{padding:16px 0;border-bottom:1px solid #ddd}.history .order-id{font-size:14px}
</style>
