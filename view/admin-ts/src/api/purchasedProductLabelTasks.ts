import request, { getData } from '@/utils/request';
import { capturePurchasedLabelTaskList, capturePurchasedLabelReplayResult, purchasedLabelReplayReason, purchasedLabelTaskUuid,
  type PurchasedLabelTaskStatus, type PurchasedLabelTaskItem } from '../../../common/purchasedProductLabelTasks';
async function response<T>(promise: Parameters<typeof getData<T>>[0]):Promise<T> {
  try{return await getData<T>(promise);}catch(error){
    const message=(error as {response?:{data?:{msg?:unknown}}}|null)?.response?.data?.msg;
    if(typeof message==='string' && message.length<=300)throw Error(message);
    throw error;
  }
}
export async function apiPurchasedLabelTasks(params: { status?: PurchasedLabelTaskStatus; after_id?: string; task_id?: string; limit?: number } = {}, signal?: AbortSignal) {
  return capturePurchasedLabelTaskList(await response(request.get('/order/product-label-tasks',{params,signal})));
}
export async function apiPurchasedLabelTask(taskId: string, signal?: AbortSignal) {
  if (!purchasedLabelTaskUuid(taskId)) throw Error('任务编号无效');
  const result=await apiPurchasedLabelTasks({task_id:taskId,limit:1},signal);
  const item=result.items[0];
  if (!item || result.items.length!==1 || item.taskId!==taskId || result.nextAfterId!==null) throw Error('原购买标签任务不存在或响应不一致');
  return item;
}
export async function apiReplayPurchasedLabelTask(row: Pick<PurchasedLabelTaskItem,'taskId'|'eventKey'>, reason: string, signal?: AbortSignal) {
  if (!purchasedLabelTaskUuid(row.taskId)) throw Error('任务编号无效');
  const result=await response(request.post('/order/product-label-tasks/'+row.taskId+'/replay',
    {confirm:'REPLAY_PURCHASED_LABEL_TASK',reason:purchasedLabelReplayReason(reason)},{signal}));
  return capturePurchasedLabelReplayResult(result,row.taskId,row.eventKey);
}
