<template>
  <main class="config-classes">
    <div v-for="screen in screens" :key="screen.key" class="screen">
      <header class="heading">
        <div><h2>配置分类</h2><p>维护系统与门店后台的配置目录、层级和显示方式。</p></div>
        <div class="actions"><el-button :disabled="!canView || state.busy || state.loading" @click="screen.refresh">{{ state.editor ? '重新读取（放弃本次编辑）' : '刷新目录' }}</el-button><el-button v-if="canManage" type="primary" :disabled="!model.writable() || (state.snapshot?.count ?? 0) >= 5000" @click="screen.create">添加分类</el-button></div>
      </header>
      <el-alert v-if="!canView || state.revoked" title="当前会话没有配置分类查看权限，请重新登录或联系管理员" type="warning" :closable="false" />
      <template v-else>
        <el-alert v-if="!canManage" title="当前仅有查看权限" type="info" :closable="false" />
        <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" />
        <el-alert v-if="state.notice" :title="state.notice" type="info" :closable="false" />
        <el-alert v-if="state.pendingError" :title="state.pendingError" type="error" :closable="false" />
        <el-alert v-if="state.pending" title="原操作结果尚未确认，已暂停新的编辑与提交" type="warning" :closable="false" show-icon>
          <p>本账号的原请求已保留。请先读取回执；确认未找到后，可主动原样重试。</p>
          <div class="actions"><el-button :disabled="state.busy || state.loading" @click="screen.receipt">读取原请求回执</el-button><el-button v-if="state.retryReady && canManage" :disabled="state.busy || state.loading" @click="screen.retry">原样重试</el-button></div>
        </el-alert>
        <el-alert v-if="state.ready && (state.snapshot?.count ?? 0) >= 5000" title="分类目录已达到5000项上限。可编辑现有分类，或删除无引用的分类后再添加。" type="info" :closable="false" />
        <div class="filters">
          <label>后台范围<el-select :model-value="filters.scope" aria-label="筛选后台范围" :disabled="viewLocked" @update:model-value="screen.scope"><el-option label="全部后台" :value="-1" /><el-option label="总后台" :value="0" /><el-option label="门店后台" :value="1" /></el-select></label>
          <label>显示状态<el-select :model-value="filters.status" aria-label="筛选显示状态" :disabled="viewLocked" @update:model-value="screen.status"><el-option label="全部状态" :value="-1" /><el-option label="显示" :value="1" /><el-option label="隐藏（列表）" :value="0" /><el-option label="隐藏（表单）" :value="2" /></el-select></label>
          <label class="search">分类名称<el-input :model-value="filters.title" aria-label="搜索分类名称" placeholder="输入分类名称" clearable :disabled="viewLocked" @update:model-value="screen.title" /></label>
        </div>
        <p class="hint">共 {{ state.snapshot?.count ?? 0 }} 个分类，筛选后 {{ filteredCount }} 个。父级选择包含完整目录。图标使用原有符号名称。</p>
        <p v-if="state.loading" role="status">正在读取完整分类目录…</p>
        <p v-else-if="state.ready && !filteredCount" class="empty">没有符合条件的分类</p>
        <div v-else-if="state.ready" class="rows" aria-label="配置分类列表">
          <article v-for="item in rows" :key="item.key" class="category" :class="{broken:item.issue}">
            <div class="category-main" :style="{paddingLeft:`${item.depth * 12}px`}">
              <div class="category-title"><el-button v-if="item.expandable" text :disabled="viewLocked" :aria-label="`${item.collapsed ? '展开' : '收起'}分类 ${item.row.title}`" @click="item.toggle">{{ item.collapsed ? '＋' : '－' }}</el-button><strong>{{ item.row.title || '未命名分类' }}</strong><el-tag size="small">{{ item.row.is_store === 1 ? '门店后台' : '总后台' }}</el-tag><el-tag size="small" :type="item.row.status === 1 ? 'success' : 'info'">{{ statusLabel(item.row.status) }}</el-tag></div>
              <p class="path">{{ item.path }}</p><p class="metadata">#{{ item.row.id }} · {{ item.row.eng_title }} · {{ typeLabel(item.row.type) }} · 排序 {{ item.row.sort }}<span v-if="item.row.icon"> · 图标 {{ item.row.icon }}</span></p>
              <p v-if="item.issue" class="issue">{{ item.issue }}，请编辑并重新选择有效父级。</p>
            </div>
            <div v-if="canManage" class="actions row-actions"><el-button :disabled="!model.writable()" @click="item.edit">编辑</el-button><el-button :disabled="!model.writable() || item.row.status === 1" @click="item.show">显示</el-button><el-button :disabled="!model.writable() || item.row.status === 0" @click="item.hide">隐藏</el-button><el-button type="danger" plain :disabled="!model.writable()" @click="item.remove">删除</el-button></div>
          </article>
        </div>
        <nav v-if="filteredCount" class="pagination" aria-label="分类分页"><span>第 {{ filters.page }} / {{ pageCount }} 页，每页 20 个</span><el-button :disabled="viewLocked || filters.page <= 1" @click="screen.previous">上一页</el-button><el-button :disabled="viewLocked || filters.page >= pageCount" @click="screen.next">下一页</el-button></nav>
      </template>
    </div>
    <el-dialog v-for="editor in editors" :key="editor.key" :model-value="true" :title="state.editor?.original ? '编辑配置分类' : '添加配置分类'" width="min(640px, calc(100vw - 24px))" class="category-dialog" :close-on-click-modal="false" :close-on-press-escape="false" :show-close="false" :destroy-on-close="true">
      <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" />
      <el-alert v-if="state.notice" :title="state.notice" type="warning" :closable="false" />
      <el-form label-position="top" :disabled="!model.writable()">
        <el-form-item v-for="field in editor.fields" :key="field.key" :label="fieldLabels[field.field]">
          <el-select v-if="field.field === 'is_store'" :model-value="field.value" aria-label="配置类型" @update:model-value="field.set"><el-option label="总后台" :value="0" /><el-option label="门店后台" :value="1" /></el-select>
          <el-select v-else-if="field.field === 'pid'" :model-value="field.value" aria-label="父级分类" filterable @update:model-value="field.set"><el-option v-for="parent in editor.parents" :key="parent.id" :label="parent.label" :value="parent.id" :disabled="parent.disabled" /></el-select>
          <el-select v-else-if="field.field === 'status'" :model-value="field.value" aria-label="分类状态" @update:model-value="field.set"><el-option label="显示" :value="1" /><el-option label="隐藏" :value="2" /><el-option v-if="![1,2].includes(Number(field.value))" :label="`保留历史状态（${field.value}）`" :value="field.value" /></el-select>
          <el-select v-else-if="field.field === 'type'" :model-value="field.value" aria-label="分类类型" @update:model-value="field.set"><el-option label="系统" :value="0" /><el-option label="其它" :value="3" /><el-option v-if="![0,3].includes(Number(field.value))" :label="`保留历史类型（${field.value}）`" :value="field.value" /></el-select>
          <el-input-number v-else-if="field.field === 'sort'" :model-value="Number(field.value)" aria-label="排序" :min="0" :max="2147483647" :precision="0" @update:model-value="field.set" />
          <el-input v-else :model-value="String(field.value)" :aria-label="fieldLabels[field.field]" :placeholder="field.field === 'icon' ? '例如 iconfont icon-setting，可留空' : ''" @update:model-value="field.set" />
        </el-form-item>
      </el-form>
      <p class="hint">表单的「隐藏」沿用值 2；列表的「隐藏」沿用值 0。保存前不会自动转换历史状态或类型。</p>
      <template #footer><div v-for="recovery in screens" :key="recovery.key" class="actions"><template v-if="state.pending"><el-button :disabled="state.busy || state.loading" @click="recovery.receipt">读取原请求回执</el-button><el-button v-if="state.retryReady && canManage" :disabled="state.busy || state.loading" @click="recovery.retry">原样重试</el-button></template><el-button :disabled="state.busy || !!state.pending" @click="editor.close">取消</el-button><el-button type="primary" :disabled="!model.writable()" :loading="state.busy" @click="editor.submit">保存分类</el-button></div></template>
    </el-dialog>
    <el-dialog v-for="confirmation in confirmations" :key="confirmation.key" :model-value="true" title="删除配置分类" width="min(440px, calc(100vw - 24px))" :close-on-click-modal="false" :close-on-press-escape="false" :show-close="false">
      <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" />
      <p>确认删除「{{ confirmation.row.title }}」（#{{ confirmation.row.id }}）？存在下级分类或配置字段时无法删除。</p>
      <template #footer><div v-for="recovery in screens" :key="recovery.key" class="actions"><template v-if="state.pending"><el-button :disabled="state.busy || state.loading" @click="recovery.receipt">读取原请求回执</el-button><el-button v-if="state.retryReady && canManage" :disabled="state.busy || state.loading" @click="recovery.retry">原样重试</el-button></template><el-button :disabled="state.busy || !!state.pending" @click="confirmation.cancel">取消</el-button><el-button type="danger" :disabled="!model.writable()" :loading="state.busy" @click="confirmation.confirm">确认删除</el-button></div></template>
    </el-dialog>
  </main>
</template>
<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,reactive,watch} from 'vue';
import {useAuthStore} from '@/stores/auth';
import {getAdminSession,getToken} from '@/utils/auth';
import {apiConfigClassCatalog,apiConfigClassWrite,apiConfigClassReceipt} from '@/api/configClasses';
import {configClassState} from '@/utils/configClassState';
import {configClassGraph,type ConfigClassAction,type ConfigClassRow} from '../../../../common/configClasses';
const auth=useAuthStore();
const canView=computed(()=>!!auth.token&&auth.token===getToken()&&!!auth.userInfo&&(auth.userInfo.level===0||auth.uniqueAuth.includes('config.view')));
const canManage=computed(()=>canView.value&&!!auth.userInfo&&(auth.userInfo.level===0||auth.uniqueAuth.includes('config.manage')));
let generation=0,alive=false,syncing=false,queued=false;
const pendingPrefix=(actor:number)=>`cinashop_config_class_pending_v1_${actor}_`;
function pendingKeys(actor:number){const keys:string[]=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(pendingPrefix(actor)))keys.push(key);}return keys.sort();}
const model=configClassState({identity:()=>`${generation}:${auth.token}:${auth.userInfo?.id}`,actor:()=>auth.userInfo?.id??0,view:()=>canView.value,manage:()=>canManage.value,
 read:apiConfigClassCatalog,write:apiConfigClassWrite,receipt:apiConfigClassReceipt,
 readPending:actor=>{const key=pendingKeys(actor)[0];if(!key)return null;const raw=localStorage.getItem(key);if(!raw||raw.length>65536)throw Error('本机未确认操作记录异常，请保留并核对');const value=JSON.parse(raw);if(key!==pendingPrefix(actor)+value?.input?.request_id)throw Error('本机未确认操作标识不一致，请保留并核对');return value;},
 persist:(actor:number,action:ConfigClassAction|null,expected?:ConfigClassAction)=>{
  const original=action??expected;if(!original)throw Error('缺少原分类操作标识');const key=pendingPrefix(actor)+original.input.request_id,raw=localStorage.getItem(key);
  if(action){if(pendingKeys(actor).some(item=>item!==key))throw Error('本账号另有未确认分类操作，请先核对原请求');if(raw&&raw!==JSON.stringify(action))throw Error('原分类请求记录不一致');localStorage.setItem(key,JSON.stringify(action));}
  else{if(raw&&raw!==JSON.stringify(expected))throw Error('原分类请求记录已变化，不能清除');localStorage.removeItem(key);}
 },
},value=>reactive(value) as typeof value);
const state=model.state,filters=reactive({scope:-1,status:-1,title:'',page:1}),collapsed=reactive(new Set<number>());
const viewLocked=computed(()=>state.busy||state.loading||!!state.pending||!!state.pendingError||!!state.editor||!!state.confirmation||!state.ready);
const graph=computed(()=>configClassGraph(state.snapshot?.list??[]));
const visible=computed(()=>{
 const catalog=state.snapshot?.list??[],g=graph.value,search=filters.title.trim().toLocaleLowerCase();
 const selected=(row:ConfigClassRow)=>(filters.scope<0||row.is_store===filters.scope)&&(filters.status<0||row.status===filters.status)&&(!search||row.title.toLocaleLowerCase().includes(search));
 if(filters.scope>=0||filters.status>=0||search)return catalog.filter(selected);
 const result:ConfigClassRow[]=[],by=new Map(catalog.map(row=>[row.id,row])),stack=catalog.filter(row=>row.pid===0&&!g.get(row.id)!.issue).reverse();
 while(stack.length){const row=stack.pop()!;result.push(row);if(!collapsed.has(row.id))for(const id of [...g.get(row.id)!.children].reverse()){const child=by.get(id)!;if(!g.get(id)!.issue)stack.push(child);}}
 return [...result,...catalog.filter(row=>g.get(row.id)!.issue)];
});
const filteredCount=computed(()=>visible.value.length),pageCount=computed(()=>Math.max(1,Math.ceil(filteredCount.value/20)));
const rows=computed(()=>visible.value.slice((filters.page-1)*20,filters.page*20).map(row=>{
 const control=model.rowControls(row),node=graph.value.get(row.id)!,epoch=state.epoch,source=state.sourceVersion;
 return {...control,...node,expandable:!node.issue&&node.children.length>0,collapsed:collapsed.has(row.id),toggle:()=>{if(epoch!==state.epoch||source!==state.sourceVersion||viewLocked.value||!model.retireView())return;if(collapsed.has(row.id))collapsed.delete(row.id);else collapsed.add(row.id);filters.page=1;}};
}));
function changeFilter(field:'scope'|'status'|'title',value:unknown,epoch:number,source:number){
 if(epoch!==state.epoch||source!==state.sourceVersion||viewLocked.value)return;
 if(field==='title'){if(typeof value!=='string')return;}else if(typeof value!=='number'||!Number.isInteger(value)||!(field==='scope'?[-1,0,1]:[-1,0,1,2]).includes(value))return;
 if(!model.retireView())return;(filters as Record<string,unknown>)[field]=value;filters.page=1;
}
const screens=computed(()=>model.pageControls().map(control=>{const epoch=state.epoch,source=state.sourceVersion;return {...control,scope:(v:unknown)=>changeFilter('scope',v,epoch,source),status:(v:unknown)=>changeFilter('status',v,epoch,source),title:(v:unknown)=>changeFilter('title',v,epoch,source),previous:()=>page(-1,epoch,source),next:()=>page(1,epoch,source)};}));
function page(direction:number,epoch:number,source:number){const value=filters.page+direction;if(epoch!==state.epoch||source!==state.sourceVersion||viewLocked.value||value<1||value>pageCount.value||!model.retireView())return;filters.page=value;}
const editors=computed(()=>model.editorControls()),confirmations=computed(()=>model.confirmationControls());
const fieldLabels={is_store:'配置类型',pid:'父级分类',title:'分类名称',eng_title:'分类字段',status:'分类状态',icon:'分类图标',type:'分类类型',sort:'排序'};
const statusLabel=(value:number)=>value===1?'显示':value===0?'隐藏（列表）':value===2?'隐藏（表单）':`历史状态 ${value}`;
const typeLabel=(value:number)=>value===0?'系统':value===3?'其它':`历史类型 ${value}`;
function schedule(){if(!alive||syncing)return;generation++;model.dispose();if(queued)return;queued=true;queueMicrotask(()=>{queued=false;if(alive)void model.activate();});}
function syncStored(event?:Event){if(syncing||event instanceof StorageEvent&&event.key!==null&&!['admin_token','admin_session'].includes(event.key))return;syncing=true;generation++;model.dispose();const session=getAdminSession();auth.$patch({token:getToken()??'',userInfo:session?.userInfo??null,menus:(session?.menus as typeof auth.menus)??[],uniqueAuth:session?.uniqueAuth??[]});syncing=false;schedule();}
watch(()=>[auth.token,auth.userInfo,auth.uniqueAuth,auth.menus],schedule,{deep:true,flush:'sync'});
watch(()=>state.sourceVersion,()=>{if(filters.page>pageCount.value)filters.page=1;});
onMounted(()=>{alive=true;window.addEventListener('storage',syncStored);window.addEventListener('admin-session-changed',syncStored);window.addEventListener('admin-auth-expired',syncStored);syncStored();});
onBeforeUnmount(()=>{alive=false;generation++;model.dispose();window.removeEventListener('storage',syncStored);window.removeEventListener('admin-session-changed',syncStored);window.removeEventListener('admin-auth-expired',syncStored);});
</script>
<style scoped>
.config-classes,.screen{display:grid;gap:16px;min-width:0}.heading,.actions,.category-title,.pagination{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.heading{justify-content:space-between}.heading h2{font-size:20px;margin:0}.heading p,.hint,.metadata,.path{font-size:13px;line-height:1.7;color:var(--el-text-color-secondary);margin:6px 0}.actions .el-button+.el-button{margin-left:0}.filters{display:grid;grid-template-columns:180px 180px minmax(180px,1fr);gap:16px}.filters label{display:grid;gap:8px;font-size:14px}.rows{border:1px solid var(--el-border-color);border-radius:6px;overflow:hidden}.category{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:16px;background:var(--el-bg-color)}.category+.category{border-top:1px solid var(--el-border-color-lighter)}.category-main{min-width:0;overflow-wrap:anywhere}.category-title strong{font-size:15px}.category-title .el-button{padding:4px;width:24px}.row-actions{flex-shrink:0}.broken{background:var(--el-color-warning-light-9)}.issue{color:var(--el-color-warning-dark-2);font-size:13px}.pagination{justify-content:flex-end;font-size:13px}.empty{padding:32px;text-align:center;color:var(--el-text-color-secondary)}.config-classes :deep(.el-select){width:100%}.config-classes :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}.config-classes :deep(.el-dialog){max-width:calc(100vw - 24px)}
@media(max-width:900px){.category{align-items:flex-start;flex-direction:column}.row-actions{padding-top:4px}.filters{grid-template-columns:1fr 1fr}.search{grid-column:1/-1}}@media(max-width:480px){.filters{grid-template-columns:1fr}.search{grid-column:auto}.category{padding:12px}.heading .actions{width:100%}.pagination{justify-content:flex-start}.category-main{padding-left:0!important}}
</style>
