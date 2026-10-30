<template>
  <section class="profile-page">
    <header><h1>个人中心</h1><p>管理当前登录账号的个人资料与安全信息。</p></header>
    <el-alert v-if="message && !dialog" :title="message" type="warning" :closable="false" show-icon />
    <el-alert v-if="pending" title="上次保存结果尚待核对。请查询原操作；改密后请重新登录同一账号再返回此页。" type="warning" :closable="false">
      <div class="pending-actions">
        <el-button size="small" :disabled="busy" :onClick="recovery?.query">查询保存结果</el-button>
        <el-button size="small" :disabled="busy" :onClick="recovery?.seal">封存未完成操作</el-button>
      </div>
    </el-alert>
    <el-card v-loading="loading" class="profile-card">
      <template v-if="info">
        <div class="profile-row"><span>账号</span><strong>{{ info.account }}</strong><small>只读</small></div>
        <div class="profile-row"><span>头像</span><div><img v-if="avatarUrl" :src="avatarUrl" alt="当前头像" class="avatar" /><span v-else class="avatar placeholder" aria-label="默认头像">{{ info.real_name.slice(0,1) || '管' }}</span><small v-if="info.head_pic && !info.avatar_id">历史头像已保留，可上传替换。</small></div><el-button :disabled="blocked" @click="open('avatar')">更换头像</el-button></div>
        <div class="profile-row"><span>姓名</span><strong>{{ info.real_name || '未填写' }}</strong><el-button :disabled="blocked" @click="open('name')">修改姓名</el-button></div>
        <div class="profile-row"><span>登录密码</span><strong>••••••••</strong><el-button :disabled="blocked" @click="open('password')">修改密码</el-button></div>
        <div class="profile-row"><span>手机号</span><strong>{{ info.phone || '未绑定' }}</strong><el-button :disabled="blocked" @click="open('phone')">修改手机号</el-button></div>
      </template>
      <el-button v-else :disabled="loading" @click="load">重新读取资料</el-button>
    </el-card>
    <el-dialog v-if="dialog" :key="dialog.id" :model-value="true" :title="titles[dialog.kind]" width="min(460px, 94vw)" :close-on-click-modal="false" :before-close="dialog.close" :onUpdate:modelValue="dialog.dismiss">
      <form @submit.prevent :aria-label="titles[dialog.kind]">
        <el-alert v-if="message" :title="message" type="warning" :closable="false" show-icon />
        <el-form label-position="top">
          <el-form-item v-if="dialog.kind==='name'" label="姓名"><el-input :model-value="form.real_name" :onUpdate:modelValue="dialog.name" maxlength="16" autocomplete="name" /></el-form-item>
          <template v-if="dialog.kind==='password'">
            <el-form-item label="原密码"><el-input :model-value="form.pwd" :onUpdate:modelValue="dialog.oldPassword" type="password" autocomplete="current-password" show-password /></el-form-item>
            <el-form-item label="新密码"><el-input :model-value="form.new_pwd" :onUpdate:modelValue="dialog.newPassword" type="password" autocomplete="new-password" show-password /></el-form-item>
            <el-form-item label="确认新密码"><el-input :model-value="form.conf_pwd" :onUpdate:modelValue="dialog.confirmPassword" type="password" autocomplete="new-password" show-password /></el-form-item>
            <p class="hint">新密码至少12字符、最多72字节。保存成功后需要重新登录。</p>
          </template>
          <el-form-item v-if="dialog.kind==='avatar'" label="上传头像"><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" :disabled="busy" :onChange="dialog.file" /><p class="hint">JPEG、PNG、WebP 或 GIF，最大2 MiB。</p></el-form-item>
          <template v-if="dialog.kind==='phone'">
            <el-form-item label="新手机号"><el-input :model-value="form.phone" :onUpdate:modelValue="dialog.phone" maxlength="11" inputmode="tel" autocomplete="tel" /></el-form-item>
            <el-button :disabled="busy || cooldown>0 || !!challenge" :onClick="dialog.send">{{ cooldown>0 ? `${cooldown}秒后可重试` : '获取验证码' }}</el-button>
            <iframe v-if="challenge" ref="challengeFrame" :src="challengeUrl" title="手机号人机验证" class="challenge" referrerpolicy="no-referrer" />
            <p v-if="queued" role="status" class="hint">验证码任务已提交，请等待短信。排队成功不代表已经送达。</p>
            <el-form-item label="短信验证码"><el-input :model-value="form.code" :onUpdate:modelValue="dialog.code" maxlength="6" inputmode="numeric" autocomplete="one-time-code" /></el-form-item>
          </template>
        </el-form>
      </form>
      <template #footer><el-button :disabled="busy" :onClick="dialog.close">取消</el-button><el-button type="primary" :disabled="busy || !!pending" :loading="busy" :onClick="dialog.submit">保存</el-button></template>
    </el-dialog>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { getToken, getAdminSession, setAdminSession } from '@/utils/auth';
import { apiProfileInfo, apiProfileCommit, apiProfileReceipt, apiProfileResolve, apiProfileUpload, apiProfileAvatar, apiProfileChallenge, apiProfileChallengeStatus, apiProfileSend, type ProfileInfo, type ProfileKind } from '@/api/profile';
const route=useRoute(),router=useRouter(),auth=useAuthStore();
const titles:Record<ProfileKind,string>={name:'修改姓名',avatar:'更换头像',password:'修改登录密码',phone:'修改手机号'};
const info=ref<ProfileInfo|null>(null),loading=ref(false),busy=ref(false),message=ref(''),avatarUrl=ref('');
const form=reactive({real_name:'',pwd:'',new_pwd:'',conf_pwd:'',phone:'',code:''});
interface Pending {operation_id:string;actor_id:number;operation:ProfileKind}
const recovery=shallowRef<null|{query:()=>Promise<void>;seal:()=>Promise<void>}>(null);
const pending=ref<Pending|null>(null),challenge=ref(''),queued=ref(false),cooldown=ref(0),challengeFrame=ref<HTMLIFrameElement|null>(null);
let publishingDisplay=false;
let alive=true,epoch=0,timer:ReturnType<typeof setInterval>|undefined,controller=new AbortController(),chosen:File|null=null;
const challengeUrl=computed(()=>challenge.value?`/api/admin-profile/challenge?key=${encodeURIComponent(challenge.value)}`:'');
const blocked=computed(()=>busy.value||loading.value||!!pending.value);
const dialog=shallowRef<null|{id:number;kind:ProfileKind;close:()=>void;dismiss:(v:boolean)=>void;submit:()=>Promise<void>;send:()=>Promise<void>;file:(e:Event)=>void;name:(v:string)=>void;oldPassword:(v:string)=>void;newPassword:(v:string)=>void;confirmPassword:(v:string)=>void;phone:(v:string)=>void;code:(v:string)=>void}>(null);
function owner(){return getAdminSession()?.userInfo.id??0;}
function lease(){const version=epoch,token=getToken(),id=owner(),path=route.fullPath;return ()=>alive&&epoch===version&&route.fullPath===path&&getToken()===token&&owner()===id&&id>0;}
function clearSecrets(){Object.assign(form,{real_name:'',pwd:'',new_pwd:'',conf_pwd:'',phone:'',code:''});chosen=null;challenge.value='';queued.value=false;cooldown.value=0;if(timer)clearInterval(timer);timer=undefined;}
function retire(){epoch++;controller.abort();controller=new AbortController();dialog.value=null;clearSecrets();busy.value=false;loading.value=false;bindRecovery();}
function bindRecovery(){const row=pending.value,valid=lease();recovery.value=row?{query:()=>recover(false,row,valid),seal:()=>recover(true,row,valid)}:null;}
function key(){return `admin-profile-pending:${owner()}`;}
function readPending(){
  try {const row=JSON.parse(sessionStorage.getItem(key())??'null');pending.value=row&&row.actor_id===owner()&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.operation_id)&&['name','avatar','password','phone'].includes(row.operation)&&Object.keys(row).length===3?row:null;}catch{pending.value=null;}bindRecovery();
}
function keepPending(row:Pending|null){pending.value=row;bindRecovery();try{if(row)sessionStorage.setItem(key(),JSON.stringify(row));else sessionStorage.removeItem(key());}catch{if(row)throw new Error('无法保存操作标识，请启用会话存储后重试');}}
function safeError(e:unknown,fallback:string){return e instanceof Error&&e.name==='AdminResponseError'?e.message:fallback;}
async function load(){
  if(!alive||!getToken())return;const valid=lease();loading.value=true;message.value='';
  try{const result=await apiProfileInfo(controller.signal);if(!valid())return;if(result.id!==owner())throw new Error('资料账号不匹配');info.value=result;
    if(avatarUrl.value)URL.revokeObjectURL(avatarUrl.value);avatarUrl.value='';
    if(result.avatar_id){try{const blob=await apiProfileAvatar(result.avatar_id,controller.signal);if(valid())avatarUrl.value=URL.createObjectURL(blob);}catch{if(valid())message.value='头像暂时无法加载，已保留原资料。';}}
  }catch(e){if(valid())message.value=safeError(e,'资料读取失败，请重试');}finally{if(valid())loading.value=false;}
}
function syncDisplay(){const stored=getAdminSession();if(!stored||!info.value||stored.userInfo.id!==info.value.id)return;
  const userInfo={...stored.userInfo,real_name:info.value.real_name,head_pic:info.value.head_pic};
  publishingDisplay=true;try{auth.$patch({userInfo});setAdminSession({...stored,userInfo});}finally{publishingDisplay=false;}
}
function open(kind:ProfileKind){
  if(!alive||!getToken()||blocked.value||!info.value)return;retire();message.value='';form.real_name=info.value.real_name;
  const valid=lease(),id=epoch;
  const set=(field:keyof typeof form)=>(value:string)=>{if(valid()&&!busy.value)form[field]=value;};
  const close=()=>{if(valid()&&!busy.value)retire();};
  const send=async()=>{
    if(!valid()||busy.value||cooldown.value||challenge.value)return;
    if(!/^1[3-9]\d{9}$/.test(form.phone)){message.value='请输入有效的新手机号';return;}
    busy.value=true;try{const result=await apiProfileChallenge(form.phone,controller.signal);if(valid())challenge.value=result.key;}
    catch(e){if(valid())message.value=safeError(e,'无法创建验证，请稍后重试');}finally{if(valid())busy.value=false;}
  };
  const submit=async()=>{
    if(!valid()||busy.value||pending.value||!info.value)return;
    const payload:Record<string,string>=kind==='name'?{real_name:form.real_name}:kind==='password'?{pwd:form.pwd,new_pwd:form.new_pwd,conf_pwd:form.conf_pwd}:kind==='phone'?{phone:form.phone,code:form.code}:{};
    if(kind==='name'&&(!form.real_name.trim()||[...form.real_name].length>16)){message.value='姓名须为1至16字符';return;}
    if(kind==='password'&&(!form.pwd||[...form.new_pwd].length<12||new TextEncoder().encode(form.new_pwd).length>72||form.new_pwd!==form.conf_pwd)){message.value='请填写原密码，并确认新密码至少12字符、最多72字节且两次一致';return;}
    if(kind==='phone'&&(!/^1[3-9]\d{9}$/.test(form.phone)||!/^\d{6}$/.test(form.code))){message.value='请填写新手机号和6位短信验证码';return;}
    if(kind==='avatar'&&!chosen){message.value='请选择头像文件';return;}
    busy.value=true;let started=false;
    try{
      if(kind==='avatar'){const uploaded=await apiProfileUpload(crypto.randomUUID(),chosen!,controller.signal);if(!valid())return;payload.head_pic=uploaded.head_pic;}
      const operation_id=crypto.randomUUID();keepPending({operation_id,actor_id:owner(),operation:kind});started=true;
      const result=await apiProfileCommit({operation_id,operation:kind,revision:info.value.revision,payload},controller.signal);
      if(!valid())return;if(result.operation_id!==operation_id||result.actor_id!==owner()||result.operation!==kind||result.state!=='committed')throw new Error('回执不匹配');
      keepPending(null);clearSecrets();
      if(kind==='password'){retire();auth.logout();await router.push('/login');return;}
      retire();const refreshed=lease();await load();if(refreshed())syncDisplay();
    }catch(e){if(valid())message.value=started?(kind==='phone'?'保存结果待核对，请查询原操作。验证码可能已消费；请勿直接重复提交。':'保存结果待核对，请查询原操作，勿重复提交。'):safeError(e,'上传未确认，请重新读取资料后重试');}
    finally{if(valid()){busy.value=false;form.pwd='';form.new_pwd='';form.conf_pwd='';form.code='';}}
  };
  dialog.value={id,kind,close,dismiss:v=>{if(!v)close();},submit,send,file:e=>{if(valid()&&!busy.value){const file=(e.target as HTMLInputElement).files?.[0];if(file&&file.size<=2097152&&['image/jpeg','image/png','image/webp','image/gif'].includes(file.type))chosen=file;else{chosen=null;message.value='请选择2 MiB内的图片';}}},name:set('real_name'),oldPassword:set('pwd'),newPassword:set('new_pwd'),confirmPassword:set('conf_pwd'),phone:v=>{if(valid()&&!busy.value&&form.phone!==v){form.phone=v;form.code='';challenge.value='';queued.value=false;}},code:set('code')};
}
async function challengeMessage(event:MessageEvent){
  const current=dialog.value;if(!current||current.kind!=='phone'||!challenge.value||event.origin!==location.origin||event.source!==challengeFrame.value?.contentWindow||event.data?.type!=='cinashop:admin-profile-challenge'||event.data.key!==challenge.value||busy.value)return;
  const valid=lease(),key=challenge.value,phone=form.phone;busy.value=true;
  try{const status=await apiProfileChallengeStatus(key,controller.signal);if(!valid()||challenge.value!==key||form.phone!==phone)return;if(!status.verified)throw new Error();
    const result=await apiProfileSend(phone,key,controller.signal);if(!valid()||challenge.value!==key||form.phone!==phone)return;if(result.queued!==true)throw new Error();
    challenge.value='';queued.value=true;cooldown.value=60;timer=setInterval(()=>{if(!valid()){if(timer)clearInterval(timer);return;}cooldown.value=Math.max(0,cooldown.value-1);if(!cooldown.value&&timer){clearInterval(timer);timer=undefined;}},1000);
  }catch(e){if(valid()){challenge.value='';message.value=safeError(e,'验证码任务未确认，请重新验证后重试');}}finally{if(valid())busy.value=false;}
}
async function recover(seal:boolean,row:Pending,valid:()=>boolean){
  if(!valid()||pending.value!==row||row.actor_id!==owner()||busy.value)return;busy.value=true;
  try{const result=await(seal?apiProfileResolve(row.operation_id,row.operation,controller.signal):apiProfileReceipt(row.operation_id,row.operation,controller.signal));if(!valid())return;
    if(result.actor_id!==owner()||result.operation_id!==row.operation_id||result.operation!==row.operation)throw new Error();
    if(!['committed','not_applied','unknown'].includes(result.state))throw new Error('回执状态无效');
    if(result.state==='unknown'){message.value='尚无持久回执。可封存原操作，确认未应用后重新填写。';return;}
    keepPending(null);retire();const refreshed=lease();await load();if(refreshed()){syncDisplay();if(!message.value)message.value=result.state==='committed'?'原操作已保存，资料已重新读取。':(row.operation==='phone'?'原操作已封存为未应用，请重新填写并获取新的验证码。':'原操作已封存为未应用，请重新填写。');}
  }catch(e){if(valid())message.value=safeError(e,'暂时无法核对，请稍后查询原操作');}finally{if(valid())busy.value=false;}
}
function sessionChanged(){if(publishingDisplay)return;retire();info.value=null;if(avatarUrl.value)URL.revokeObjectURL(avatarUrl.value);avatarUrl.value='';readPending();void load();}
function storageChanged(event:StorageEvent){if(event.key===null||event.key==='admin_token'||event.key==='admin_session')sessionChanged();}
const stopAuthAction=auth.$onAction(({name,after})=>{if(name==='login'||name==='logout')after(()=>{if(alive)sessionChanged();});});
watch(()=>route.fullPath,()=>{retire();readPending();void load();},{flush:'sync'});
onMounted(()=>{window.addEventListener('storage',storageChanged);window.addEventListener('message',challengeMessage);window.addEventListener('admin-session-changed',sessionChanged);window.addEventListener('admin-auth-expired',sessionChanged);readPending();void load();});
onBeforeUnmount(()=>{alive=false;stopAuthAction();window.removeEventListener('storage',storageChanged);retire();window.removeEventListener('message',challengeMessage);window.removeEventListener('admin-session-changed',sessionChanged);window.removeEventListener('admin-auth-expired',sessionChanged);if(avatarUrl.value)URL.revokeObjectURL(avatarUrl.value);});
</script>
<style scoped>
.pending-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.pending-actions .el-button{margin-left:0}.profile-page{max-width:880px;margin:auto;padding:12px}.profile-page h1{font-size:24px;margin:0 0 8px}.profile-page header p,.hint{color:#667085;font-size:13px;line-height:1.6}.profile-card,.el-alert{margin-top:20px}.profile-row{display:grid;grid-template-columns:100px minmax(0,1fr) auto;align-items:center;gap:18px;padding:24px 0;border-bottom:1px solid #edf0f3}.profile-row:last-child{border-bottom:0}.profile-row strong{overflow-wrap:anywhere}.profile-row small{display:block;color:#667085}.avatar{width:64px;height:64px;border-radius:50%;object-fit:cover}.placeholder{display:inline-grid;place-items:center;background:#edf4ff;color:#2456a6;font-size:24px}.challenge{display:block;border:0;width:100%;height:180px;margin:12px 0}input[type=file]{max-width:100%}@media(max-width:520px){.profile-page{padding:0}.profile-row{grid-template-columns:72px minmax(0,1fr);gap:12px}.profile-row .el-button{grid-column:2;justify-self:start}.profile-page h1{font-size:21px}}
</style>
