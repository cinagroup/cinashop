<template>
  <ThemePage>
  <view class="kefu-page">
    <view v-if="productContext" class="product-context"><image v-if="productContext.image" :src="productContext.image" mode="aspectFill"/><view><view>{{productContext.store_name}}</view><button size="mini" @tap="consultProduct">发送此商品咨询</button></view></view>
    <view v-if="contextError" class="context-error" role="alert">{{contextError}}<button size="mini" @tap="loadProductContext">重新读取商品</button></view>
    <button class="feedback-link" @tap="openFeedback">客服离线？提交反馈</button>
    <view v-if="kfAdv" class="kf-adv">
      <rich-text :nodes="kfAdv" />
    </view>
    <view v-if="serviceUid" class="service-status">
      <image v-if="serviceAvatar" class="service-avatar" :src="serviceAvatar" mode="aspectFill" />
      <view>
        <view class="service-name">{{ serviceNickname || "在线客服" }}</view>
        <view class="service-presence">{{ serviceOnline ? "在线" : "暂时离线，消息会保留" }}</view>
      </view>
    </view>
    <view v-if="chatLoading" class="chat-state" role="status">正在读取客服会话…</view>
    <view v-if="chatError" class="chat-state chat-error" role="alert">{{ chatError }}</view>
    <button v-if="requestedService && !authStore.isLoggedIn" class="feedback-link" @tap="loginConversation">登录后查看此会话</button>
    <button v-else-if="chatError && targetValid" class="feedback-link" @tap="loadRecord">重新读取会话</button>
    <!-- 消息列表 -->
    <scroll-view scroll-y class="msg-scroll" :scroll-into-view="lastMsgId">
      <view v-if="messages.length" class="msg-list">
        <view
          v-for="m in messages"
          :key="m.id"
          :id="`msg-${m.id}`"
          class="msg-item"
          :class="{ mine: m.mine }"
        >
          <view v-if="m.msnType === 3" class="bubble image-bubble" @tap="previewImage(m.msn)">
            <image class="chat-image" :src="resolveAssetUrl(m.msn)" mode="widthFix" />
          </view>
          <view v-else class="bubble">{{ m.msn }}</view>
          <view class="msg-time">{{ formatTime(m.addTime) }}</view>
        </view>
      </view>
      <view v-else class="empty">联系客服, 我们会尽快回复您</view>
    </scroll-view>

    <!-- 输入栏 -->
    <view class="input-bar">
      <view class="image-btn" :class="{ disabled: uploadingImage }" @tap="chooseAndSendImage">
        {{ uploadingImage ? "上传中" : "图片" }}
      </view>
      <input
        v-model="inputText"
        class="msg-input"
        type="text"
        placeholder="请输入消息..."
        confirm-type="send"
        @confirm="send"
      />
      <view class="send-btn" @tap="send">发送</view>
    </view>
  </view>
  </ThemePage>
</template>

<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import {onLoad,onShow,onHide,onUnload} from '@dcloudio/uni-app';
import {createUserCenterRequests,type UserCenterRequests} from '@/api/userCenter';
import {kefuConversationTarget,decodeKefuConversation} from '@/utils/kefuConversationTarget';
import {memberLevelImage} from '@/api/memberLevels';
import {apiGoodsDetail} from '@/api/product';
import type {GoodsDetail} from '@/types/product';
import {productDetailId} from '../../../../common/productDetailRoute';
import { useAuthStore } from "@/stores/auth";
import { API_BASE, getFormType, http } from "@/utils/request";
import { apiKfAdv } from "@/api/legacyContent";

interface ChatMessage {
  id: number | string;
  uid: number;
  to_uid: number;
  msn: string;
  add_time?: number;
  addTime?: number;
  msn_type?: number;
  msnType?: number;
}

interface ServiceRecord {
  serviceList: ChatMessage[];
  uid: number;
  nickname: string;
  avatar: string;
  online: number;
}

interface VisitorBootstrap {
  uid: number;
  nickname: string;
  avatar: string;
  online: number;
  tourist_uid: number;
  visitor_token: string;
  expires_in: number;
}

interface DisplayMessage {
  id: number | string;
  msn: string;
  addTime: number;
  mine: boolean;
  msnType: number;
}

const authStore = useAuthStore();
const productContext=ref<GoodsDetail|null>(null),contextError=ref('');let contextProductId=0,contextVisible=false,contextGeneration=0;
async function loadProductContext(){if(!contextVisible||disposed||!contextProductId)return;const current=++contextGeneration,owner={version:authStore.sessionVersion,token:authStore.token,uid:authStore.uid};contextError.value='';
  try{const product=await apiGoodsDetail(contextProductId);if(contextVisible&&!disposed&&current===contextGeneration&&owner.version===authStore.sessionVersion&&owner.token===authStore.token&&owner.uid===authStore.uid)productContext.value=product;}
  catch{if(contextVisible&&!disposed&&current===contextGeneration)contextError.value='咨询商品暂不可读取，请重新读取';}
}
function consultProduct(){if(!contextVisible||disposed||!productContext.value)return;inputText.value=`咨询商品：${productContext.value.store_name}（商品编号 ${productContext.value.id}） /pages/goods/detail?id=${productContext.value.id}`;void send();}
onLoad(query=>{if(query?.productId===undefined)return;try{contextProductId=productDetailId(query.productId);}catch{contextProductId=0;contextError.value='咨询商品链接无效';}});
onShow(()=>{contextVisible=true;void loadProductContext();});onHide(()=>{contextVisible=false;contextGeneration++;productContext.value=null;contextError.value='';});
watch(()=>[authStore.sessionVersion,authStore.token,authStore.uid],()=>{contextGeneration++;productContext.value=null;contextError.value='';Promise.resolve().then(()=>{void loadProductContext();});},{flush:'sync'});
function openFeedback() { uni.navigateTo({ url: "/pages/extension/customer_list/feedback" }); }
const messages = ref<DisplayMessage[]>([]);
const inputText = ref("");
const uploadingImage = ref(false);
const kfAdv = ref("");
const serviceUid = ref(0);
const serviceNickname = ref("");
const serviceAvatar = ref("");
const serviceOnline = ref(false);
const visitorUid = ref(0);
const visitorToken = ref("");
const VISITOR_TOKEN_STORAGE_KEY = "cinashop_kefu_visitor_token";
let socket: UniApp.SocketTask | null = null;
let socketReady = false;
let disposed = false;
const requestedService=ref(0),targetValid=ref(true),chatLoading=ref(false),chatError=ref('');
let chatVisible=false,chatGeneration=0,chatRequest:UserCenterRequests|undefined,acceptedCurrent:()=>boolean=()=>false,chatPreviewOpen=false;
const chatWrites=new Set<UserCenterRequests>();
async function conversationPost<T>(data:Record<string,unknown>,current:()=>boolean):Promise<T>{const scope=createUserCenterRequests(current);chatWrites.add(scope);try{return await scope.request<T>('service/send','POST',data,true);}finally{scope.abort();chatWrites.delete(scope);}}
function conversationOwner(){const owner={uid:authStore.uid,token:authStore.token,version:authStore.sessionVersion},generation=chatGeneration;return()=>{if(!chatVisible||disposed||generation!==chatGeneration||owner.uid!==authStore.uid||owner.token!==authStore.token||owner.version!==authStore.sessionVersion)return false;try{return String(uni.getStorageSync('uni_token')||'')===owner.token&&(Number(uni.getStorageSync('uni_uid'))||0)===owner.uid;}catch{return false;}};}
function resetConversation(){chatGeneration++;acceptedCurrent=()=>false;chatRequest?.abort();chatRequest=undefined;for(const write of [...chatWrites])write.abort();chatWrites.clear();if(chatPreviewOpen){chatPreviewOpen=false;uni.closePreviewImage?.({success:()=>{},fail:()=>{}});}socketReady=false;const old=socket;socket=null;old?.close({success:()=>{},fail:()=>{}});messages.value=[];inputText.value='';serviceUid.value=0;serviceNickname.value='';serviceAvatar.value='';serviceOnline.value=false;visitorUid.value=0;visitorToken.value='';uploadingImage.value=false;chatLoading.value=false;chatError.value='';}
function loginConversation(){if(chatVisible&&!disposed&&!authStore.isLoggedIn)uni.navigateTo({url:'/pages/auth/login'});}
onLoad(query=>{try{requestedService.value=kefuConversationTarget(query?.to_uid);}catch(error){targetValid.value=false;chatError.value=(error as Error).message;}});
onShow(()=>{if(disposed)return;let token='',uid=0;try{token=String(uni.getStorageSync('uni_token')||'');uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{}if(token!==authStore.token||uid!==authStore.uid){if(token&&uid>0)authStore.setLogin(token,uid);else authStore.clear();}chatVisible=true;void loadRecord();});
onHide(()=>{chatVisible=false;resetConversation();});
onUnload(()=>{chatVisible=false;disposed=true;resetConversation();});
watch(()=>[authStore.uid,authStore.token,authStore.sessionVersion],()=>{resetConversation();void Promise.resolve().then(()=>{if(chatVisible&&!disposed)void loadRecord();});},{flush:'sync'});


const lastMsgId = computed(() => {
  const last = messages.value[messages.value.length - 1];
  return last ? `msg-${last.id}` : "";
});

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function appendMessage(message: ChatMessage) {
  if (messages.value.some((item) => String(item.id) === String(message.id))) return;
  messages.value.push({
    id: message.id,
    msn: message.msn,
    addTime: message.add_time ?? message.addTime ?? Math.floor(Date.now() / 1000),
    mine: message.uid === (authStore.uid || visitorUid.value),
    msnType: message.msn_type ?? message.msnType ?? 1,
  });
}

function kefuGet<T>(path: string, token = ""): Promise<T> {
  return new Promise((resolve, reject) => {
    const header: Record<string, string> = { "Form-type": getFormType() };
    if (token) header["X-Visitor-Token"] = token;
    uni.request({
      url: `${API_BASE}/kefuapi/${path.replace(/^\/+/, "")}`,
      method: "GET",
      header,
      success: (response) => {
        const body = response.data as { status?: number; msg?: string; data?: T };
        if (body?.status === 200) resolve(body.data as T);
        else reject(new Error(body?.msg ?? "游客客服请求失败"));
      },
      fail: (error) => reject(new Error(error.errMsg ?? "网络错误")),
    });
  });
}

async function loadVisitorRecord(active:()=>boolean) {
  let stored = String(uni.getStorageSync(VISITOR_TOKEN_STORAGE_KEY) || "");
  let bootstrap: VisitorBootstrap;
  try {
    bootstrap = await kefuGet<VisitorBootstrap>("tourist/user", stored);
  } catch (error) {
    if(!active())return;
    if (!stored) throw error;
    uni.removeStorageSync(VISITOR_TOKEN_STORAGE_KEY);
    stored = "";
    bootstrap = await kefuGet<VisitorBootstrap>("tourist/user");
  }
  if(!active())return;
  visitorToken.value = bootstrap.visitor_token;
  visitorUid.value = bootstrap.tourist_uid;
  uni.setStorageSync(VISITOR_TOKEN_STORAGE_KEY, bootstrap.visitor_token);
  serviceUid.value = bootstrap.uid;
  serviceNickname.value = bootstrap.nickname;
  serviceAvatar.value = bootstrap.avatar;
  serviceOnline.value = bootstrap.online === 1;
  const history = await kefuGet<ChatMessage[]>("tourist/chat?limit=50", bootstrap.visitor_token);
  if(!active())return;
  messages.value = history.map((record) => ({
    id: record.id,
    msn: record.msn,
    addTime: record.add_time ?? record.addTime ?? 0,
    mine: record.uid === bootstrap.tourist_uid,
    msnType: record.msn_type ?? record.msnType ?? 1,
  }));
}

async function loadRecord() {
  if(!chatVisible||disposed||chatLoading.value)return;
  resetConversation();
  if(!targetValid.value){chatError.value='客服会话链接无效，请从消息中心重新进入';return;}
  const active=conversationOwner(),scope=createUserCenterRequests(active);chatRequest=scope;chatLoading.value=true;
  try {
    if (!authStore.uid || !authStore.token) {
      if(requestedService.value)throw Error('登录后查看此客服会话');
      await loadVisitorRecord(active);
    }else{
      const result=decodeKefuConversation(await scope.request('user/service/record','GET',{limit:50,...(requestedService.value?{to_uid:requestedService.value}:{})},true),scope.owner.uid,requestedService.value);
      if(!active())return;
      serviceUid.value=result.uid;serviceNickname.value=result.nickname;serviceAvatar.value=memberLevelImage(result.avatar);serviceOnline.value=result.online===1;
      messages.value=result.serviceList.map(r=>({id:r.id,msn:r.msn,addTime:r.add_time,mine:r.uid===scope.owner.uid,msnType:r.msn_type}));
    }
    if(active()){acceptedCurrent=active;connect();}
  } catch (error) {
    if(active()){messages.value=[];serviceUid.value=0;serviceNickname.value='';serviceAvatar.value='';serviceOnline.value=false;visitorUid.value=0;visitorToken.value='';chatError.value=error instanceof Error?error.message:'客服暂不可用';}
  }finally{if(active())chatLoading.value=false;scope.abort();if(chatRequest===scope)chatRequest=undefined;}
}

function websocketBase(): string {
  if (API_BASE) return API_BASE.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  if (typeof location !== "undefined" && location.origin) {
    return location.origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  }
  return "";
}

function connect() {
  const active=acceptedCurrent;if(!active())return;
  const registered = Boolean(authStore.uid && authStore.token);
  if ((!registered && !visitorToken.value) || !serviceUid.value || socket) return;
  const base = websocketBase();
  if (!base) return;
  const task = uni.connectSocket({
    url: registered
      ? `${base}/api/ws/kefu?type=1&to_uid=${serviceUid.value}`
      : `${base}/kefuapi/tourist/ws`,
    protocols: registered
      ? ["cinashop", `cinashop-auth.${authStore.token}`]
      : ["cinashop", `cinashop-visitor.${visitorToken.value}`],
    success: () => undefined,
    fail: () => {
      if(!active())return;
      socketReady = false;
      socket = null;
    },
  });
  socket = task;
  task.onOpen(() => {
    if(!active()||socket!==task){task.close({success:()=>{},fail:()=>{}});return;}
    socketReady = true;
    task.send({
      data: JSON.stringify({ type: "to_chat", data: { to_uid: serviceUid.value } }),
    });
  });
  task.onMessage((res) => {
    if(!active()||socket!==task)return;
    try {
      const msg = JSON.parse(res.data as string) as {
        type?: string;
        data?: Partial<ChatMessage> & {
          msg?: string;
          uid?: number;
          online?: number;
          toUid?: number;
          nickname?: string;
          avatar?: string;
        };
      };
      if ((msg.type === "chat" || msg.type === "reply") && msg.data?.msn) {
        appendMessage(msg.data as ChatMessage);
      } else if (msg.type === "online" && msg.data?.uid === serviceUid.value) {
        serviceOnline.value = msg.data.online === 1;
      } else if (msg.type === "to_transfer" && msg.data?.toUid) {
        serviceUid.value = msg.data.toUid;
        serviceNickname.value = msg.data.nickname || "在线客服";
        serviceAvatar.value = msg.data.avatar || "";
        serviceOnline.value = msg.data.online === 1;
        uni.showToast({ title: `已为您转接至${serviceNickname.value}`, icon: "none" });
      } else if (msg.type === "err_tip") {
        uni.showToast({ title: msg.data?.msg || "消息发送失败", icon: "none" });
      }
    } catch {
      // Ignore protocol frames that are not JSON envelopes.
    }
  });
  task.onClose(() => {
    if(!active()||socket!==task)return;
    socketReady = false;
    socket = null;
  });
  task.onError(() => {
    if(!active()||socket!==task)return;
    socketReady = false;
  });
}

function sendOverSocket(text: string, messageType = 1): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!acceptedCurrent() || !socket || !socketReady) {
      reject(new Error("socket unavailable"));
      return;
    }
    socket.send({
      data: JSON.stringify({
        type: "chat",
        data: {
          to_uid: serviceUid.value,
          msn: text,
          msn_type: messageType,
          is_tourist: authStore.uid && authStore.token ? 0 : 1,
        },
      }),
      success: () => resolve(),
      fail: () => reject(new Error("socket send failed")),
    });
  });
}

function resolveAssetUrl(value: string): string {
  if (/^(?:https:\/\/|data:)/i.test(value)) return value;
  return value.startsWith("/") ? `${API_BASE}${value}` : value;
}

function previewImage(current: string) {
  if(!acceptedCurrent())return;
  const urls = messages.value
    .filter((message) => message.msnType === 3)
    .map((message) => resolveAssetUrl(message.msn));
  if(!urls.includes(resolveAssetUrl(current)))return;
  const active=acceptedCurrent;chatPreviewOpen=true;
  uni.previewImage({ current: resolveAssetUrl(current), urls,fail:()=>{if(active())chatPreviewOpen=false;} });
}

function uploadChatImage(filePath: string): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    uni.uploadFile({
      url: authStore.uid && authStore.token
        ? `${API_BASE}/api/upload/image`
        : `${API_BASE}/kefuapi/tourist/upload`,
      filePath,
      name: "file",
      formData: { pid: "0" },
      header: authStore.uid && authStore.token
        ? { "Authori-zation": `Bearer ${authStore.token}`, "Form-type": getFormType() }
        : { "X-Visitor-Token": visitorToken.value, "Form-type": getFormType() },
      success: (response) => {
        let parsed: unknown = null;
        try { parsed = JSON.parse(response.data) as unknown; } catch { parsed = null; }
        const body = parsed && typeof parsed === "object"
          ? parsed as { status?: number; msg?: string; data?: { url: string } }
          : null;
        if (body?.status === 200 && body.data?.url) resolve(body.data);
        else reject(new Error(body?.msg ?? "图片上传失败"));
      },
      fail: (error) => reject(new Error(error.errMsg ?? "图片上传失败")),
    });
  });
}

async function chooseAndSendImage() {
  const active=acceptedCurrent,target=serviceUid.value;
  if (!active() || uploadingImage.value || !target) return;
  let selected: { tempFilePaths: string[]; tempFiles?: Array<{ size?: number }> };
  try {
    selected = await new Promise((resolve, reject) => uni.chooseImage({
      count: 1,
      sizeType: ["compressed", "original"],
      sourceType: ["album", "camera"],
      success: (result) => resolve({
        tempFilePaths: Array.isArray(result.tempFilePaths) ? result.tempFilePaths : [result.tempFilePaths],
        tempFiles: result.tempFiles as Array<{ size?: number }> | undefined,
      }),
      fail: reject,
    }));
  } catch {
    return;
  }
  if(!active()||serviceUid.value!==target)return;
  if ((selected.tempFiles?.[0]?.size ?? 0) > 10 * 1024 * 1024) {
    uni.showToast({ title: "图片不能超过10 MiB", icon: "none" });
    return;
  }
  uploadingImage.value = true;
  try {
    const attachment = await uploadChatImage(selected.tempFilePaths[0]);
    if(!active()||serviceUid.value!==target)return;
    if (socketReady) {
      await sendOverSocket(attachment.url, 3);
    } else if (authStore.uid && authStore.token) {
      const persisted = await conversationPost<ChatMessage>({
        to_uid: target,
        msn: attachment.url,
        msn_type: 3,
      },active);
      if(active()&&serviceUid.value===target)appendMessage(persisted);
    } else {
      throw new Error("游客实时连接尚未就绪，请稍后重试");
    }
  } catch (error) {
    if(!active()||serviceUid.value!==target)return;
    uni.showToast({
      title: error instanceof Error ? error.message : "图片发送失败",
      icon: "none",
    });
  } finally {
    if(active())uploadingImage.value = false;
  }
}

async function send() {
  const active=acceptedCurrent,target=serviceUid.value;if(!active())return;
  const text = inputText.value.trim();
  if (!text || !serviceUid.value) return;
  inputText.value = "";
  try {
    if (socketReady) {
      await sendOverSocket(text);
      return;
    }
    if (!authStore.uid || !authStore.token) {
      throw new Error("游客实时连接尚未就绪，请稍后重试");
    }
    const persisted = await conversationPost<ChatMessage>({
      to_uid: target,
      msn: text,
      msn_type: 1,
    },active);
    if(active()&&serviceUid.value===target)appendMessage(persisted);
  } catch (error) {
    if(!active()||serviceUid.value!==target)return;
    inputText.value = text;
    uni.showToast({
      title: error instanceof Error ? error.message : "消息发送失败",
      icon: "none",
    });
  }
}

onMounted(async () => {
  void apiKfAdv().then((result) => {
    kfAdv.value = result.content;
  }).catch(() => {});

});

onUnmounted(() => {
  contextVisible=false;contextGeneration++;productContext.value=null;
  chatVisible=false;disposed=true;resetConversation();
});
</script>

<style scoped>
.chat-state{padding:16rpx 24rpx;font-size:26rpx;line-height:40rpx;color:#999}.chat-error{color:#b34428}
.product-context{display:flex;gap:16rpx;background:#fff;padding:20rpx;font-size:26rpx}.product-context image{width:120rpx;height:120rpx;flex-shrink:0}.product-context>view{flex:1}.context-error{color:#a72823;padding:20rpx;font-size:24rpx}
.kefu-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.feedback-link { align-self: flex-end; margin: 10rpx 20rpx; color: #2768ca; background: transparent; font-size: 24rpx; }
.feedback-link::after { border: 0; }

.kf-adv {
  flex-shrink: 0;
  max-height: 240rpx;
  overflow-y: auto;
  margin: 20rpx 20rpx 0;
  padding: 20rpx;
  border-radius: 12rpx;
  background: #fff8ed;
  color: #8a5a20;
  font-size: 24rpx;
  line-height: 1.6;
}

.service-status {
  display: flex;
  align-items: center;
  gap: 16rpx;
  margin: 16rpx 20rpx 0;
  padding: 16rpx 20rpx;
  border-radius: 12rpx;
  background: #fff;
}

.service-avatar {
  width: 64rpx;
  height: 64rpx;
  border-radius: 50%;
}

.service-name {
  color: #333;
  font-size: 27rpx;
}

.service-presence {
  margin-top: 4rpx;
  color: #999;
  font-size: 22rpx;
}

.msg-scroll {
  flex: 1;
  padding: 20rpx;
  box-sizing: border-box;
}

.msg-list {
  display: flex;
  flex-direction: column;
}

.msg-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  margin-bottom: 20rpx;
}

.msg-item.mine {
  align-items: flex-end;
}

.bubble {
  max-width: 70%;
  background: #fff;
  border-radius: 12rpx;
  padding: 16rpx 20rpx;
  font-size: 28rpx;
  color: #333;
  word-break: break-all;
}

.msg-item.mine .bubble {
  background: var(--view-theme, #e93323);
  color: #fff;
}

.image-bubble {
  max-width: 520rpx;
  padding: 8rpx;
  overflow: hidden;
  line-height: 0;
}

.chat-image {
  display: block;
  width: 420rpx;
  max-height: 620rpx;
  border-radius: 9rpx;
}

.msg-time {
  font-size: 20rpx;
  color: #ccc;
  margin-top: 6rpx;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 100rpx 0;
}

.input-bar {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 20rpx 30rpx;
  background: #fff;
  padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
}

.image-btn {
  flex-shrink: 0;
  padding: 14rpx 18rpx;
  border-radius: 30rpx;
  color: #666;
  background: #f0f1f3;
  font-size: 24rpx;
}

.image-btn.disabled {
  opacity: .55;
}

.msg-input {
  flex: 1;
  background: #f7f7f7;
  border-radius: 36rpx;
  padding: 16rpx 28rpx;
  font-size: 28rpx;
}

.send-btn {
  background: var(--view-theme, #e93323);
  color: #fff;
  font-size: 28rpx;
  padding: 14rpx 36rpx;
  border-radius: 36rpx;
}
</style>
