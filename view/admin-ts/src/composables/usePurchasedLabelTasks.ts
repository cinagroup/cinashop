import { computed, onMounted, onUnmounted, reactive, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/utils/auth';
import { apiPurchasedLabelTasks, apiPurchasedLabelTask, apiReplayPurchasedLabelTask } from '@/api/purchasedProductLabelTasks';
import { purchasedLabelReplayReason, purchasedLabelTaskUuid, type PurchasedLabelTaskItem,
  type PurchasedLabelTaskStatus } from '../../../common/purchasedProductLabelTasks';
interface Review {row:PurchasedLabelTaskItem;reason:string;busy:boolean;phase:'review'|'sending'|'uncertain'|'observed';error:string;notice:string}
// Session-local recovery markers survive panel destruction. They contain no
// credentials and are never persisted; a replacement account cannot view them.
const ledgers=new WeakMap<object,Map<number,Review>>();
export function usePurchasedLabelTasks() {
  const auth=useAuthStore();
  let ledger=ledgers.get(auth);if(!ledger){ledger=reactive(new Map<number,Review>());ledgers.set(auth,ledger);}const pending=ledger;
  const state=reactive({items:[] as PurchasedLabelTaskItem[],status:'' as PurchasedLabelTaskStatus|'',taskId:'',
    loading:false,error:'',observedAt:0,cursor:undefined as string|undefined,next:null as string|null,history:[] as Array<string|undefined>,
    modal:null as Review|null,notice:''});
  const owner=computed(()=>JSON.stringify([auth.userInfo?.id??0,auth.token,auth.userInfo?.level??null,...auth.uniqueAuth]));
  const canRead=computed(()=>!!auth.token && !!auth.userInfo && (auth.userInfo.level===0 || auth.uniqueAuth.includes('outbox.view') || auth.uniqueAuth.includes('outbox.manage') || auth.uniqueAuth.includes('*')));
  const canManage=computed(()=>canRead.value && (auth.userInfo?.level===0 || auth.uniqueAuth.includes('outbox.manage') || auth.uniqueAuth.includes('*')));
  const recovery=computed(()=>pending.get(auth.userInfo?.id??0)??null);
  const controllers=new Set<AbortController>();
  const controller=()=>{const c=new AbortController();controllers.add(c);return c;};
  let live=true,epoch=0,loadId=0;
  const owned=(key:string,generation:number)=>live && owner.value===key && epoch===generation && getToken()===auth.token;
  function clear() { epoch++;loadId++;for(const c of controllers)c.abort();controllers.clear();if(state.modal){if(state.modal.phase==='sending'){state.modal.phase='uncertain';state.modal.notice='操作会话已结束，请先读取原任务状态。';}state.modal.busy=false;}state.items=[];state.error='';state.notice='';state.loading=false;state.cursor=undefined;state.next=null;state.history=[];state.observedAt=0;state.modal=null;state.status='';state.taskId=''; }
  function reset() { state.cursor=undefined;state.history=[];state.next=null; }
  async function load() {
    if (!canRead.value || !live || getToken()!==auth.token) return;
    const key=owner.value,generation=epoch,id=++loadId;
    const c=controller();
    const taskId=state.taskId.trim();
    state.loading=true;state.error='';
    try {
      if (taskId && !purchasedLabelTaskUuid(taskId)) throw Error('请输入完整的小写任务 UUID');
      const result=await apiPurchasedLabelTasks({status:state.status||undefined,after_id:taskId?undefined:state.cursor,task_id:taskId||undefined,limit:20},c.signal);
      if (!owned(key,generation) || id!==loadId) return;
      state.items=result.items;state.next=result.nextAfterId;state.observedAt=result.observedAt;
    } catch(error) {
      if (!owned(key,generation) || id!==loadId) return;
      state.items=[];state.next=null;state.error=error instanceof Error ? error.message : '购买标签任务加载失败';
    } finally { controllers.delete(c);if (owned(key,generation) && id===loadId) state.loading=false; }
  }
  async function query() { reset();await load(); }
  async function next() { if(state.loading || state.next===null || state.taskId.trim())return;state.history.push(state.cursor);state.cursor=state.next;await load(); }
  async function previous() { if(state.loading || !state.history.length)return;state.cursor=state.history.pop();await load(); }
  function open(row:PurchasedLabelTaskItem) {
    if (!live || getToken()!==auth.token || state.modal || !canManage.value || row.recovery!=='eligible' || !state.items.includes(row) || state.loading) return;
    if(recovery.value){state.modal=recovery.value;return;}
    if(pending.size>=20){state.error='存在未核对的维护任务，请先完成原任务核对';return;}
    state.modal={row:{...row},reason:'',busy:false,phase:'review',error:'',notice:''};
  }
  function restore() {if(live && getToken()===auth.token && canRead.value && recovery.value && !state.modal)state.modal=recovery.value;}
  function close() { if (!state.modal?.busy) {if(state.modal?.phase==='observed')pending.delete(auth.userInfo?.id??0);state.modal=null;} }
  async function submit() {
    const modal=state.modal;
    if (!modal || modal.busy || modal.phase!=='review' || !canManage.value || !live || getToken()!==auth.token) return;
    let reason:string;
    try { reason=purchasedLabelReplayReason(modal.reason); } catch(error) { modal.error=(error as Error).message;return; }
    const key=owner.value,generation=epoch,c=controller(),actorId=auth.userInfo!.id;
    modal.busy=true;modal.phase='sending';modal.error='';
    pending.set(actorId,modal);
    try {
      const result=await apiReplayPurchasedLabelTask(modal.row,reason,c.signal);
      if (!owned(key,generation) || state.modal!==modal) return;
      modal.phase='observed';modal.notice=result.completed?'原任务已有完成回执，保留原授予记录':result.replayed?'原任务已受理重放，可刷新查看处理结果':'原任务已在自动处理流程中';
      state.notice=modal.notice;
      await load();
    } catch(error) {
      if (!owned(key,generation) || state.modal!==modal) return;
      // No resubmission from an unconfirmed dialog, including 503 or malformed
      // success receipts. Read the exact original task before a new decision.
      modal.phase='uncertain';modal.error=error instanceof Error?error.message:'重放响应未确认';
      modal.notice='本次结果暂未确认。请读取原任务状态；此窗口不会再次提交。';
    } finally {controllers.delete(c);if(owned(key,generation) && state.modal===modal)modal.busy=false;}
  }
  async function lookup() {
    const modal=state.modal;
    if (!modal || modal.busy || !canRead.value || !live || getToken()!==auth.token) return;
    const key=owner.value,generation=epoch,c=controller();modal.busy=true;modal.error='';
    try {
      const row=await apiPurchasedLabelTask(modal.row.taskId,c.signal);
      if (!owned(key,generation) || state.modal!==modal) return;
      const advanced=row.replayCount>modal.row.replayCount;
      modal.row=row;modal.phase='observed';
      modal.notice=row.receiptCompletedAt!==null?'原任务已有完成回执，保留原授予记录':advanced?'已查询到原任务的维护重放记录':'已读取原任务当前状态。关闭窗口并刷新列表后，可重新核对是否需要维护重放。';
      await load();
    } catch(error) {
      if (!owned(key,generation) || state.modal!==modal) return;
      modal.error=error instanceof Error?error.message:'原任务状态读取失败';
    } finally {controllers.delete(c);if(owned(key,generation) && state.modal===modal)modal.busy=false;}
  }
  const sessionChanged=()=>{clear();};
  const storageChanged=(event:StorageEvent)=>{if(event.key===null || event.key==='admin_token' || event.key==='admin_session')clear();};
  watch(owner,()=>{clear();if(canRead.value)void load();},{flush:'sync'});
  onMounted(()=>{window.addEventListener('admin-session-changed',sessionChanged);window.addEventListener('storage',storageChanged);window.addEventListener('admin-auth-expired',sessionChanged);void load();});
  onUnmounted(()=>{live=false;clear();window.removeEventListener('admin-session-changed',sessionChanged);window.removeEventListener('storage',storageChanged);window.removeEventListener('admin-auth-expired',sessionChanged);});
  return {state,canRead,canManage,recovery,restore,load,query,next,previous,open,close,submit,lookup};
}
